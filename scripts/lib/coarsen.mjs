/**
 * Area-weighted coarsening of a raster larger than memory, one band at a time.
 *
 * Lifted out of `coarsen-dtm.mjs` unchanged when the spill surface needed the
 * same thing in-process. Two callers now — the CLI that writes a coarser DTM to
 * disk, and `spill-run.mjs`, which wants the coarse grid in memory and never on
 * disk at all — and a second copy of this arithmetic would be a second place
 * for a catchment boundary to move.
 *
 * ## Why area-weighted averaging rather than sampling
 *
 * Taking every Nth cell keeps whichever cells happen to land on the lattice, so
 * a one-cell channel either survives at full depth or vanishes entirely
 * depending on its phase. Averaging carries it through as a shallower channel,
 * which is what a coarser model of the same ground should look like.
 *
 * ## Why the accumulators are Float64
 *
 * A 734M cell survey summing into 4M output cells puts tens of thousands of
 * additions through each accumulator, and Float32 loses the low bits of a
 * running total long before that. The result is written as Float32 because that
 * is what the format holds; the arithmetic getting there is not.
 *
 * nodata is carried by weight: an output cell with no valid source coverage is
 * nodata rather than zero, because zero is an elevation and would read as a
 * hole at sea level.
 */

import { Grid } from "../../src/lib/geo/raster.mjs";

/** Source rows per band. Bounded by memory, not by correctness. */
function defaultBandRows(width) {
  return Math.max(1, Math.floor((32 * 1024 * 1024) / (width * 4)));
}

/**
 * @param raster an open raster from `openRaster` — file or R2 backed
 * @param {number} cell target cell size in projected metres
 * @param {{ bandRows?: number, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<Grid>} the coarsened grid, resident
 */
export async function coarsenRaster(raster, cell, { bandRows, onProgress } = {}) {
  const { width, height, cellSize, originX, originY, epsg, nodata } = raster;

  if (cell < cellSize - 1e-12) {
    throw new Error(
      `Refusing to upsample from ${cellSize} m to ${cell} m: that would invent ` +
        `detail the survey does not contain.`,
    );
  }

  const outWidth = Math.max(1, Math.round((width * cellSize) / cell));
  const outHeight = Math.max(1, Math.round((height * cellSize) / cell));
  const sums = new Float64Array(outWidth * outHeight);
  const weights = new Float64Array(outWidth * outHeight);

  const rowsPerBand = bandRows ?? defaultBandRows(width);
  const ratio = cellSize / cell;

  for (let top = 0; top < height; top += rowsPerBand) {
    const rows = Math.min(rowsPerBand, height - top);
    const window = raster.windowFor([
      originX,
      originY - (top + rows) * cellSize,
      originX + width * cellSize,
      originY - top * cellSize,
    ]);
    if (!window) continue;
    const band = await raster.readWindow(window);
    if (!band) continue;

    for (let r = 0; r < band.height; r += 1) {
      const y0 = (top + r) * ratio;
      const y1 = (top + r + 1) * ratio;
      const outR0 = Math.max(0, Math.floor(y0));
      const outR1 = Math.min(outHeight - 1, Math.ceil(y1) - 1);

      for (let c = 0; c < band.width; c += 1) {
        const v = band.data[r * band.width + c];
        if (band.isNoData(v)) continue;
        const x0 = c * ratio;
        const x1 = (c + 1) * ratio;
        const outC0 = Math.max(0, Math.floor(x0));
        const outC1 = Math.min(outWidth - 1, Math.ceil(x1) - 1);

        for (let outR = outR0; outR <= outR1; outR += 1) {
          const hy = Math.min(y1, outR + 1) - Math.max(y0, outR);
          if (hy <= 0) continue;
          for (let outC = outC0; outC <= outC1; outC += 1) {
            const hx = Math.min(x1, outC + 1) - Math.max(x0, outC);
            if (hx <= 0) continue;
            const at = outR * outWidth + outC;
            const w = hx * hy;
            sums[at] += v * w;
            weights[at] += w;
          }
        }
      }
    }
    onProgress?.(Math.min(height, top + rows), height);
  }

  const NODATA = Number.isFinite(nodata) ? nodata : -9999;
  const data = new Float32Array(outWidth * outHeight);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = weights[i] > 0 ? sums[i] / weights[i] : NODATA;
  }

  return new Grid({
    width: outWidth,
    height: outHeight,
    cellSize: cell,
    originX,
    originY,
    data,
    nodata: NODATA,
    epsg,
  });
}

/**
 * The analysis cell a survey should be routed and flooded at.
 *
 * Connectivity — flow routing, and which ground water can reach — cannot be
 * windowed: water arrives from outside whatever box you draw, so the grid has
 * to be seen whole. The only way a large survey fits is coarser, and this is
 * the rule that decides how much coarser, so that it is a property of the
 * survey rather than a judgement someone made once and did not write down.
 *
 * Kiru's 5 m grid was exactly that: produced by hand, recorded only as a
 * filename inside a manifest, and not reproducible from this repository.
 *
 * The budget is in cells because that is what the work is, and it is set so the
 * surveys that already work keep working **exactly**: Kotba at 2.2M and
 * Ektanagar 1 at 42.8M both stay native and build their spill surface at the
 * survey's own resolution, as they do today. Only the two that cannot be held
 * whole are coarsened at all.
 *
 * 50 million is about 1.2 GB resident for Priority-Flood plus 800 MB of
 * coarsening accumulators, comfortable on an 8 GB laptop with the machine still
 * usable; Ektanagar 1 builds inside that in 8.3 s.
 *
 * The ladder of round numbers exists because a cell size that reads as 0.37 m
 * invites the question "why" and has no answer better than "arithmetic". It
 * lands Ektanagar 2 on 0.5 m and Kiru on 2 m, finer than the 1 m and 5 m their
 * hydrology uses, because routing and flooding are different questions and only
 * routing needed that much coarsening.
 *
 * Measured error from coarsening this way, on Ektanagar 1 against its own
 * native spill surface: under 0.5% of flooded area at 13x, under 1% at 26x, and
 * wrongly-wet — flooding ground that should be dry — at 0.001%. Shoreline and
 * depth are not affected at all; they come from the native DTM.
 */
export const CONNECTIVITY_CELL_BUDGET = 50_000_000;

export function analysisCellFor({ width, height, cellSize }) {
  const cells = width * height;
  if (cells <= CONNECTIVITY_CELL_BUDGET) return cellSize;
  const needed = cellSize * Math.sqrt(cells / CONNECTIVITY_CELL_BUDGET);
  for (const step of [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50]) {
    if (step >= needed) return step;
  }
  return Math.ceil(needed);
}
