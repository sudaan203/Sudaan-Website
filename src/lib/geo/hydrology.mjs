/**
 * D8 terrain hydrology: fill, route, accumulate, order, delineate.
 *
 * What this is for. `docs/dashboard-tools-plan.md` phase B0 says validate before
 * building, and this is the engine under that validation. It is a reference
 * implementation, not the production one: `hydro-validate.mjs` checks it against
 * the SAGA outputs Malhar sent, and B1 puts WhiteboxTools in a container for
 * real work. Keeping both is deliberate. Two independent implementations agreeing
 * with a third party GIS is a far stronger claim than one, and this one runs
 * today on a laptop with no GDAL, no Docker and no network.
 *
 * The scale limit is honest and worth stating: everything here holds several
 * typed arrays over the whole grid at once. Kherwada at 491 x 302 is 148,282
 * cells and runs in milliseconds. Dang Forest at 450 km2 and 1 m is 450 million
 * cells, roughly 1.8 GB per Float32 grid, which this machine cannot hold. That is
 * the container's job, and it is why B1 exists.
 *
 * Why 1 m and not native resolution. Running D8 on a 2.5 cm photogrammetric
 * surface is not more accurate, it is less: every rut and vegetation artefact
 * becomes a spurious pit and the stream network turns into noise driven braiding.
 * Their own run used 1 m from a 2.5 cm ortho. Cell size is a parameter of the
 * pipeline, surfaced in the UI, not an accident of the input.
 */

import { Grid } from "./raster.mjs";

/**
 * Neighbour offsets, E then clockwise. Index into these is the D8 code used
 * throughout this file. -1 means "does not flow anywhere", which happens only at
 * an outlet or on a nodata cell.
 */
export const D8_DCOL = Int8Array.from([1, 1, 0, -1, -1, -1, 0, 1]);
export const D8_DROW = Int8Array.from([0, 1, 1, 1, 0, -1, -1, -1]);
const SQRT2 = Math.SQRT2;
const D8_DIST = Float64Array.from([1, SQRT2, 1, SQRT2, 1, SQRT2, 1, SQRT2]);

/** ESRI's power-of-two encoding, for anyone opening our output in ArcGIS. */
const ESRI_CODE = Int16Array.from([1, 2, 4, 8, 16, 32, 64, 128]);

/**
 * Binary min-heap keyed on elevation.
 *
 * Priority-Flood needs to always pop the lowest unprocessed cell on the growing
 * boundary. A sort per step would make the fill quadratic; this keeps it at
 * n log n, which is the difference between milliseconds and minutes even at
 * Kherwada's size.
 *
 * Ties are broken by insertion order so the fill is deterministic. Without that,
 * two runs over a flat plateau can produce different but equally valid drainage,
 * and a validation harness that cannot reproduce its own last answer is not
 * measuring anything.
 */
class MinHeap {
  constructor(capacity) {
    this.key = new Float64Array(capacity);
    this.idx = new Int32Array(capacity);
    this.seq = new Int32Array(capacity);
    this.size = 0;
    this.counter = 0;
  }

  push(key, idx) {
    let i = this.size;
    this.size += 1;
    this.key[i] = key;
    this.idx[i] = idx;
    this.seq[i] = this.counter;
    this.counter += 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  pop() {
    const topIdx = this.idx[0];
    const topKey = this.key[0];
    this.size -= 1;
    if (this.size > 0) {
      this.key[0] = this.key[this.size];
      this.idx[0] = this.idx[this.size];
      this.seq[0] = this.seq[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let small = i;
        if (l < this.size && this.less(l, small)) small = l;
        if (r < this.size && this.less(r, small)) small = r;
        if (small === i) break;
        this.swap(i, small);
        i = small;
      }
    }
    return { key: topKey, idx: topIdx };
  }

  less(a, b) {
    return this.key[a] < this.key[b] || (this.key[a] === this.key[b] && this.seq[a] < this.seq[b]);
  }

  swap(a, b) {
    let t = this.key[a]; this.key[a] = this.key[b]; this.key[b] = t;
    t = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = t;
    t = this.seq[a]; this.seq[a] = this.seq[b]; this.seq[b] = t;
  }
}

/**
 * Priority-Flood depression filling with an epsilon gradient.
 * Barnes, Lehman and Mulla 2014.
 *
 * Water starts at the edge of the data and floods inwards, always from the
 * lowest point on the boundary. Any cell reached below the water level is raised
 * to it. That fills every pit in one pass without ever having to find pits first.
 *
 * `epsilon` is the reason this is usable rather than merely correct. Filling a
 * depression exactly level leaves a flat with no drainage direction, and D8 then
 * has nowhere to send water. Raising each successive cell by a hair imposes a
 * gradient across the flat towards the outlet. The default, 0.00001 m, is four
 * orders of magnitude below the survey's own accuracy: even a thousand cell flat
 * accumulates a centimetre, which is inside the noise and never inside a
 * reported number.
 *
 * Nodata is treated as outside: it seeds the flood like the grid edge, so a
 * survey with a ragged footprint drains through its real boundary rather than
 * being dammed by it.
 */
export function fillDepressions(dem, { epsilon = 1e-5 } = {}) {
  const { width, height } = dem;
  const filled = dem.clone();
  // Two surfaces come out of one pass, and conflating them is a real bug rather
  // than a tidiness point. `filled` carries the epsilon gradient and exists so
  // D8 always has somewhere to send water. `trueLevel` is the fill with epsilon
  // set to zero: the actual level a pit would pond to. Sink depth has to be
  // measured against the second, or the epsilon drift across a flat reads as
  // thousands of shallow depressions that are not there. A perfectly flat plane
  // reported 121 filled cells before this was split out.
  const trueLevel = new Float64Array(dem.length);
  const done = new Uint8Array(dem.length);
  const heap = new MinHeap(dem.length);

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      if (dem.isNoData(dem.data[i])) {
        done[i] = 1;
        continue;
      }
      let seed = row === 0 || col === 0 || row === height - 1 || col === width - 1;
      if (!seed) {
        for (let k = 0; k < 8; k += 1) {
          const nc = col + D8_DCOL[k];
          const nr = row + D8_DROW[k];
          if (dem.isNoData(dem.data[nr * width + nc])) { seed = true; break; }
        }
      }
      if (seed) {
        done[i] = 1;
        trueLevel[i] = dem.data[i];
        heap.push(dem.data[i], i);
      }
    }
  }

  let raised = 0;
  let maxRaise = 0;
  while (heap.size > 0) {
    const { key, idx } = heap.pop();
    const col = idx % width;
    const row = (idx - col) / width;
    const poppedLevel = trueLevel[idx];
    for (let k = 0; k < 8; k += 1) {
      const nc = col + D8_DCOL[k];
      const nr = row + D8_DROW[k];
      if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
      const n = nr * width + nc;
      if (done[n]) continue;
      done[n] = 1;
      const own = dem.data[n];

      // The level this cell would pond to with no epsilon at all: its own
      // ground, or the water already standing against it, whichever is higher.
      const level = own > poppedLevel ? own : poppedLevel;
      trueLevel[n] = level;
      if (level > own) {
        raised += 1;
        if (level - own > maxRaise) maxRaise = level - own;
      }

      const floor = key + epsilon;
      const next = own > floor ? own : floor;
      filled.data[n] = next;
      heap.push(next, n);
    }
  }

  // Sink depth falls straight out of the second surface, exactly, with no
  // threshold needed to filter epsilon noise back out.
  const sinks = dem.like(Float32Array, 0, -99999);
  for (let i = 0; i < dem.length; i += 1) {
    if (dem.isNoData(dem.data[i])) { sinks.data[i] = sinks.nodata; continue; }
    const d = trueLevel[i] - dem.data[i];
    sinks.data[i] = d > 0 ? d : sinks.nodata;
  }

  return { filled, sinks, raisedCells: raised, maxRaise };
}

/**
 * D8 flow direction: each cell drains to its steepest downslope neighbour.
 *
 * Steepest means the largest drop divided by distance, so a diagonal has to fall
 * sqrt(2) times as far to beat an orthogonal neighbour. Skipping that weighting
 * is a common shortcut and it biases every drainage line towards the diagonals.
 *
 * Returns an Int8 grid of neighbour indices, with -1 where water leaves the grid
 * or the cell is nodata.
 */
export function d8Pointer(dem) {
  const { width, height } = dem;
  const dir = dem.like(Int8Array, 0, -1);
  dir.data.fill(-1);

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const z = dem.data[i];
      if (dem.isNoData(z)) continue;
      let best = -1;
      let bestSlope = 0;
      for (let k = 0; k < 8; k += 1) {
        const nc = col + D8_DCOL[k];
        const nr = row + D8_DROW[k];
        if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
        const nz = dem.data[nr * width + nc];
        if (dem.isNoData(nz)) continue;
        const slope = (z - nz) / D8_DIST[k];
        if (slope > bestSlope) { bestSlope = slope; best = k; }
      }
      dir.data[i] = best;
    }
  }
  return dir;
}

/** The same directions in ESRI's power-of-two codes, for export. */
export function toEsriCodes(dir) {
  const out = dir.like(Int16Array, 0, 0);
  for (let i = 0; i < dir.length; i += 1) {
    out.data[i] = dir.data[i] < 0 ? 0 : ESRI_CODE[dir.data[i]];
  }
  return out;
}

/**
 * ESRI codes back to this engine's internal direction indices.
 *
 * The inverse of `toEsriCodes`, and it has to exist because the two
 * representations serve different masters. What gets written to disk is ESRI
 * (1, 2, 4 ... 128), because that is what QGIS and Global Mapper understand and
 * the whole argument for exporting our grids is that a client can check our
 * answer in their own software. What the traversals here use is an index into
 * `D8_DCOL` and `D8_DROW`, because that is what makes them a table lookup rather
 * than a switch.
 *
 * Reading a written grid back therefore needs decoding, and forgetting to is a
 * silent failure rather than a loud one: `D8_DCOL[16]` is `undefined`, the
 * neighbour test never matches, and a watershed trace returns the one cell it
 * started from. A perfectly plausible polygon, no error, wrong answer.
 */
export function fromEsriCodes(grid) {
  const out = grid.like(Int8Array, 0, -1);
  for (let i = 0; i < grid.length; i += 1) {
    const code = grid.data[i];
    if (!(code > 0) || grid.isNoData(code)) {
      out.data[i] = -1;
      continue;
    }
    // The codes are powers of two by construction, so the index is the exponent.
    const index = Math.log2(code);
    out.data[i] = Number.isInteger(index) && index >= 0 && index < 8 ? index : -1;
  }
  return out;
}

/** Index of the cell a given cell drains into, or -1. */
export function downstreamOf(dir, i) {
  const k = dir.data[i];
  if (k < 0) return -1;
  const col = i % dir.width;
  const row = (i - col) / dir.width;
  const nc = col + D8_DCOL[k];
  const nr = row + D8_DROW[k];
  if (nc < 0 || nr < 0 || nc >= dir.width || nr >= dir.height) return -1;
  return nr * dir.width + nc;
}

/**
 * D8 flow accumulation, in cells.
 *
 * Kahn's topological order rather than recursion: repeatedly drain the cells
 * that nothing flows into, and push their load downstream. Linear time, no call
 * stack to overflow on a long channel, and the in-degree hitting zero for every
 * cell is a free proof that the pointer grid is acyclic.
 *
 * Each cell counts itself, so a ridge top reads 1 and not 0. Multiply by
 * `grid.cellArea` for contributing area in square metres. At 1 m cells those are
 * the same number, which is convenient here and a trap anywhere else.
 */
export function d8Accumulation(dir, dem) {
  const n = dir.length;
  const indegree = new Int32Array(n);
  const down = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i += 1) {
    if (dem.isNoData(dem.data[i])) continue;
    const d = downstreamOf(dir, i);
    down[i] = d;
    if (d >= 0) indegree[d] += 1;
  }

  const accum = dem.like(Float32Array, 0, -99999);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    if (dem.isNoData(dem.data[i])) { accum.data[i] = accum.nodata; continue; }
    accum.data[i] = 1;
    if (indegree[i] === 0) queue[tail++] = i;
  }

  let processed = 0;
  while (head < tail) {
    const i = queue[head++];
    processed += 1;
    const d = down[i];
    if (d < 0) continue;
    accum.data[d] += accum.data[i];
    indegree[d] -= 1;
    if (indegree[d] === 0) queue[tail++] = d;
  }

  // Every data cell must drain. If some did not, the pointer grid has a cycle,
  // which means the fill left a flat the epsilon gradient did not break. Better
  // to say so than to return an accumulation grid that is quietly missing water.
  const dataCells = accum.stats().count;
  if (processed !== dataCells) {
    throw new Error(
      `d8Accumulation: ${dataCells - processed} of ${dataCells} cells are in a flow cycle. ` +
        `The DEM was probably not filled, or epsilon was too small for a large flat.`,
    );
  }

  return accum;
}

/**
 * Stream cells: everywhere accumulation reaches a threshold.
 *
 * The threshold is the single free parameter of a drainage network and it is
 * what decides whether a map shows four streams or four hundred. It has no
 * physically correct value, which is why `hydro-validate.mjs` sweeps it against
 * the reference network rather than assuming one, and why it belongs in the UI.
 */
export function streamCells(accum, thresholdCells) {
  const streams = accum.like(Uint8Array, 0, 0);
  for (let i = 0; i < accum.length; i += 1) {
    if (accum.isNoData(accum.data[i])) continue;
    streams.data[i] = accum.data[i] >= thresholdCells ? 1 : 0;
  }
  return streams;
}

/**
 * Strahler stream order, per stream cell.
 *
 * A headwater is order 1. Where two channels of equal order n meet, the result
 * is n+1; where they differ, the larger wins. Computed in the same topological
 * order as accumulation, so each cell is resolved after everything upstream of it.
 */
export function strahlerOrder(dir, streams) {
  const n = streams.length;
  const order = streams.like(Int16Array, 0, 0);
  const indegree = new Int32Array(n);
  const down = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i += 1) {
    if (!streams.data[i]) continue;
    const d = downstreamOf(dir, i);
    if (d >= 0 && streams.data[d]) { down[i] = d; indegree[d] += 1; }
  }

  // Highest incoming order at each cell, and how many inputs carried it.
  const topOrder = new Int16Array(n);
  const topCount = new Int32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i += 1) if (streams.data[i] && indegree[i] === 0) queue[tail++] = i;

  while (head < tail) {
    const i = queue[head++];
    const own = topCount[i] === 0 ? 1 : topCount[i] >= 2 ? topOrder[i] + 1 : topOrder[i];
    order.data[i] = own;
    const d = down[i];
    if (d >= 0) {
      if (own > topOrder[d]) { topOrder[d] = own; topCount[d] = 1; }
      else if (own === topOrder[d]) topCount[d] += 1;
      indegree[d] -= 1;
      if (indegree[d] === 0) queue[tail++] = d;
    }
  }
  return order;
}

/**
 * Everything draining to a point, as a 0/1 mask.
 *
 * The reverse of the pointer grid: start at the outlet and walk upstream to
 * every cell that eventually points at it. This is tool 26, and it is
 * interactive precisely because the pointer grid was precomputed in batch. On
 * its own it is a graph walk over a few tens of thousands of cells, which is why
 * clicking the map can answer in well under a second while the analysis that
 * made it possible took minutes.
 *
 * An explicit stack, not recursion: a long channel is tens of thousands of cells
 * deep and would overflow the call stack.
 */
export function watershedFrom(dir, col, row) {
  const mask = dir.like(Uint8Array, 0, 0);
  const start = row * dir.width + col;
  const stack = [start];
  mask.data[start] = 1;

  while (stack.length > 0) {
    const i = stack.pop();
    const c = i % dir.width;
    const r = (i - c) / dir.width;
    for (let k = 0; k < 8; k += 1) {
      const nc = c + D8_DCOL[k];
      const nr = r + D8_DROW[k];
      if (nc < 0 || nr < 0 || nc >= dir.width || nr >= dir.height) continue;
      const n = nr * dir.width + nc;
      if (mask.data[n]) continue;
      if (downstreamOf(dir, n) !== i) continue;
      mask.data[n] = 1;
      stack.push(n);
    }
  }
  return mask;
}

/**
 * Label every cell with the outlet it eventually drains to.
 *
 * This partitions the survey into basins without needing pour points: each
 * terminal cell, one that sends water off the grid or into nodata, is the outlet
 * of everything upstream of it. SAGA writes the same thing as `basins.shp`.
 *
 * Follows each chain downstream once and then back-fills the whole path with the
 * answer, so a cell is never walked twice and a long channel costs the same as a
 * short one. An explicit path array rather than recursion, for the same reason
 * `watershedFrom` uses a stack: these chains are tens of thousands of cells long.
 */
export function basinLabels(dir, dem) {
  const label = new Int32Array(dem.length).fill(-1);
  const path = [];

  for (let start = 0; start < dem.length; start += 1) {
    if (dem.isNoData(dem.data[start]) || label[start] >= 0) continue;
    path.length = 0;
    let current = start;
    for (;;) {
      if (label[current] >= 0) break;
      path.push(current);
      const next = downstreamOf(dir, current);
      if (next < 0) { label[current] = current; break; } // an outlet labels itself
      current = next;
    }
    const root = label[current];
    for (const cell of path) label[cell] = root;
  }
  return label;
}

/**
 * Move a pour point onto the channel before delineating from it.
 *
 * A point digitised by hand, or taken from someone else's shapefile, almost
 * never lands exactly on the modelled channel. One cell off and the catchment
 * comes back as a hillslope sliver instead of the basin, which looks like a
 * catastrophic disagreement when it is really a snapping problem. Search a small
 * window and take the largest accumulation in it.
 */
export function snapToChannel(accum, col, row, radiusCells = 5) {
  let best = null;
  let bestAccum = -Infinity;
  for (let r = row - radiusCells; r <= row + radiusCells; r += 1) {
    for (let c = col - radiusCells; c <= col + radiusCells; c += 1) {
      if (!accum.inside(c, r)) continue;
      const v = accum.get(c, r);
      if (accum.isNoData(v)) continue;
      if (v > bestAccum) { bestAccum = v; best = { col: c, row: r }; }
    }
  }
  return best === null ? null : { ...best, accumulation: bestAccum };
}

/**
 * Slope, by Horn's method over the 3x3 window, in degrees.
 *
 * Horn rather than a simple two cell difference because it is what GDAL, SAGA,
 * ArcGIS and QGIS all use, and a slope map that disagrees with the client's own
 * software is worse than no slope map. Percent is `tan(degrees) * 100`, and the
 * two are not interchangeable: 15 degrees is 27 percent. Malhar's three
 * documents give three different classifications, one of them in percent, so the
 * unit travels with the number everywhere.
 */
export function slopeDegrees(dem) {
  const { width, height } = dem;
  const out = dem.like(Float32Array, 0, -99999);
  const cs = dem.cellSize;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      if (dem.isNoData(dem.data[i])) { out.data[i] = out.nodata; continue; }
      const z = (dc, dr) => {
        const c = Math.min(width - 1, Math.max(0, col + dc));
        const r = Math.min(height - 1, Math.max(0, row + dr));
        const v = dem.data[r * width + c];
        return dem.isNoData(v) ? dem.data[i] : v;
      };
      const dzdx =
        (z(1, -1) + 2 * z(1, 0) + z(1, 1) - z(-1, -1) - 2 * z(-1, 0) - z(-1, 1)) / (8 * cs);
      const dzdy =
        (z(-1, 1) + 2 * z(0, 1) + z(1, 1) - z(-1, -1) - 2 * z(0, -1) - z(1, -1)) / (8 * cs);
      out.data[i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }
  return out;
}

/**
 * Connected flood at a water level, from one or more seed cells.
 *
 * The distinction that matters, and the reason this is not two lines of code:
 * colouring every cell below a level is a "bathtub" flood, and it is wrong in a
 * way that looks completely right. It fills hilltop depressions that no water
 * can reach, and a client cannot tell from the picture. This grows the flood
 * outwards from real water instead, so only hydraulically connected ground is
 * inundated.
 *
 * Returns depth per cell and the storage volume, which is a real volume in cubic
 * metres because depth is summed against cell area in a projected CRS.
 */
export function connectedFlood(dem, level, seeds) {
  const depth = dem.like(Float32Array, 0, -99999);
  depth.data.fill(depth.nodata);
  const seen = new Uint8Array(dem.length);
  const stack = [];

  for (const { col, row } of seeds) {
    if (!dem.inside(col, row)) continue;
    const i = row * dem.width + col;
    const z = dem.data[i];
    if (dem.isNoData(z) || z > level) continue;
    seen[i] = 1;
    stack.push(i);
  }

  let volume = 0;
  let cells = 0;
  while (stack.length > 0) {
    const i = stack.pop();
    const d = level - dem.data[i];
    depth.data[i] = d;
    volume += d * dem.cellArea;
    cells += 1;
    const c = i % dem.width;
    const r = (i - c) / dem.width;
    for (let k = 0; k < 8; k += 1) {
      const nc = c + D8_DCOL[k];
      const nr = r + D8_DROW[k];
      if (!dem.inside(nc, nr)) continue;
      const n = nr * dem.width + nc;
      if (seen[n]) continue;
      const nz = dem.data[n];
      if (dem.isNoData(nz) || nz > level) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }

  return { depth, volume, cells, area: cells * dem.cellArea };
}

/**
 * The whole batch in one call, in the order each step depends on the last.
 *
 * This is the shape `hydro-run` takes in B1, so the pipeline is defined here
 * once and the CLI is only argument parsing and file writing.
 */
export function runHydrology(dem, { epsilon = 1e-5, streamThresholdCells = 500 } = {}) {
  const { filled, sinks, raisedCells, maxRaise } = fillDepressions(dem, { epsilon });
  const dir = d8Pointer(filled);
  const accum = d8Accumulation(dir, filled);
  const streams = streamCells(accum, streamThresholdCells);
  const order = strahlerOrder(dir, streams);
  const slope = slopeDegrees(filled);
  return { filled, sinks, dir, accum, streams, order, slope, raisedCells, maxRaise };
}

export { Grid };
