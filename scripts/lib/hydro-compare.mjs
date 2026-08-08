/**
 * Measuring agreement between our hydrology and somebody else's.
 *
 * The metrics live apart from both the engine and the validation script on
 * purpose. An engine that scores its own homework is not evidence, and these
 * functions know nothing about D8: they take masks and lines and return numbers.
 *
 * What each metric is for, and what it cannot tell you:
 *
 * - **IoU** on two catchment masks. Symmetric, punishes both misses and
 *   overreach, and is the honest single number for "is this the same basin".
 *   A catchment that agrees on 95% of its area but leaks over a ridge will show
 *   it here, where a plain "percent of cells matching" would not, because the
 *   background dominates that ratio and flatters everything.
 *
 * - **Precision and recall** against a reference stream network, with a distance
 *   tolerance. Two implementations will never put a channel on exactly the same
 *   cells, so a strict cell-for-cell comparison of lines reports near zero
 *   agreement for networks that are visually identical. The tolerance is stated
 *   in metres and reported with the result, because an agreement figure without
 *   its tolerance is not a measurement.
 *
 * Neither of these says who is right. That is what `hydro-test.mjs` is for.
 */

/** Confusion counts between two 0/1 masks over the same grid. */
export function confusion(a, b) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    const x = a.data[i] ? 1 : 0;
    const y = b.data[i] ? 1 : 0;
    if (x && y) tp += 1;
    else if (x && !y) fp += 1;
    else if (!x && y) fn += 1;
    else tn += 1;
  }
  const union = tp + fp + fn;
  return {
    tp, fp, fn, tn,
    iou: union === 0 ? 1 : tp / union,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
  };
}

/**
 * Burn polylines onto a grid with Bresenham, so a vector reference can be
 * compared against a raster result.
 *
 * Segments are stepped rather than only their endpoints marked: a line crossing
 * twenty cells has to mark twenty cells, or the reference network comes out as a
 * dotted line and every distance measured from it is wrong.
 */
export function rasterizeLines(lines, grid) {
  const mask = grid.like(Uint8Array, 0, 0);
  const plot = (col, row) => {
    if (grid.inside(col, row)) mask.data[row * grid.width + col] = 1;
  };

  for (const parts of lines) {
    if (!parts) continue;
    for (const part of parts) {
      for (let i = 1; i < part.length; i += 1) {
        const a = grid.cellAt(part[i - 1][0], part[i - 1][1]);
        const b = grid.cellAt(part[i][0], part[i][1]);
        // cellAt returns null off grid; fall back to unclamped indices so a
        // segment that leaves and re-enters still draws its inside portion.
        const x0 = a ? a.col : Math.floor((part[i - 1][0] - grid.originX) / grid.cellSize);
        const y0 = a ? a.row : Math.floor((grid.originY - part[i - 1][1]) / grid.cellSize);
        const x1 = b ? b.col : Math.floor((part[i][0] - grid.originX) / grid.cellSize);
        const y1 = b ? b.row : Math.floor((grid.originY - part[i][1]) / grid.cellSize);
        bresenham(x0, y0, x1, y1, plot);
      }
    }
  }
  return mask;
}

function bresenham(x0, y0, x1, y1, plot) {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * Distance in metres from every cell to the nearest set cell of a mask.
 *
 * Chamfer 3-4 in two passes. Exact Euclidean would need more work for an answer
 * that differs by under 2%, which is far inside the tolerance any of this is
 * compared at. Distances are scaled back to metres by cell size at the end, so
 * the caller never has to think in cell counts.
 */
export function distanceTransform(mask, grid) {
  const { width, height } = grid;
  const BIG = 1e9;
  const d = new Float64Array(width * height);
  for (let i = 0; i < d.length; i += 1) d[i] = mask.data[i] ? 0 : BIG;

  const relax = (i, j, cost) => {
    if (d[j] + cost < d[i]) d[i] = d[j] + cost;
  };

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      if (row > 0) {
        relax(i, i - width, 3);
        if (col > 0) relax(i, i - width - 1, 4);
        if (col < width - 1) relax(i, i - width + 1, 4);
      }
      if (col > 0) relax(i, i - 1, 3);
    }
  }
  for (let row = height - 1; row >= 0; row -= 1) {
    for (let col = width - 1; col >= 0; col -= 1) {
      const i = row * width + col;
      if (row < height - 1) {
        relax(i, i + width, 3);
        if (col < width - 1) relax(i, i + width + 1, 4);
        if (col > 0) relax(i, i + width - 1, 4);
      }
      if (col < width - 1) relax(i, i + 1, 3);
    }
  }

  const out = grid.like(Float32Array, 0, -1);
  for (let i = 0; i < d.length; i += 1) out.data[i] = (d[i] / 3) * grid.cellSize;
  return out;
}

/**
 * How well two stream networks agree, allowing for a positional tolerance.
 *
 * recall  = share of the reference network with one of ours within tolerance
 * precision = share of ours with a reference channel within tolerance
 *
 * Reported together and never averaged into one number, because they fail in
 * opposite and diagnostic directions: high recall with low precision means we
 * drew too many streams, so the accumulation threshold is too low; the reverse
 * means too few.
 */
export function networkAgreement(ours, referenceMask, grid, toleranceM) {
  const toReference = distanceTransform(referenceMask, grid);
  const toOurs = distanceTransform(ours, grid);

  let ourCells = 0;
  let ourMatched = 0;
  let refCells = 0;
  let refMatched = 0;
  for (let i = 0; i < grid.length; i += 1) {
    if (ours.data[i]) {
      ourCells += 1;
      if (toReference.data[i] <= toleranceM) ourMatched += 1;
    }
    if (referenceMask.data[i]) {
      refCells += 1;
      if (toOurs.data[i] <= toleranceM) refMatched += 1;
    }
  }
  return {
    toleranceM,
    ourCells,
    refCells,
    precision: ourCells === 0 ? 0 : ourMatched / ourCells,
    recall: refCells === 0 ? 0 : refMatched / refCells,
  };
}

/** Percentage, to one decimal, for a report table. */
export const pct = (x) => `${(x * 100).toFixed(1)}%`;
