/**
 * Known-answer and agreement tests for the merge tree.
 *
 * There are two things to prove and they are not the same thing.
 *
 * The first is that the structure is *correct*: on surfaces whose answer can be
 * worked out on paper — a cone, two bowls behind a ridge, a staircase, a ragged
 * nodata footprint — the flooded area at a level is a number this file states
 * rather than a number the engine reports.
 *
 * The second is that it agrees with `connectedFlood` **exactly**, because the
 * point of the whole exercise is to replace that function's answer, and an
 * approximate replacement is worthless: a client comparing a flood polygon
 * against Global Mapper cannot tell a rounding difference from a bug. So the
 * comparison is cell for cell, not area against area, over a sweep of levels
 * and seeds on real survey rasters as well as synthetic ones.
 *
 * Volume is compared as a relative difference rather than an equality. Both
 * implementations sum the same numbers; the merge tree sums them in elevation
 * order via a prefix, `connectedFlood` sums them in flood-fill order, and IEEE
 * addition is not associative. The tolerance below is 1e-9 relative and the
 * observed difference is reported so a regression shows up as a number changing
 * rather than a check going quiet.
 *
 * Run:
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/merge-tree-test.mjs
 */

import { Grid } from "../src/lib/geo/raster.mjs";
import { connectedFlood } from "../src/lib/geo/hydrology.mjs";
import { fileSource, cached } from "../src/lib/geo/raster-source.mjs";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import {
  buildMergeTree,
  floodFrom,
  floodFromMany,
  floodLadder,
  componentCellsOnGrid,
  orderByElevation,
  structureBytes,
} from "../src/lib/geo/merge-tree.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

function makeGrid(width, height, fn, { cellSize = 1, nodata = -99999 } = {}) {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) data[row * width + col] = fn(col, row);
  }
  return new Grid({
    width, height, cellSize, originX: 0, originY: height * cellSize, data, nodata, epsg: 32643,
  });
}

/** The set of cells `connectedFlood` marks wet, which is where its depth is not nodata. */
function referenceCells(dem, level, seeds) {
  const flood = connectedFlood(dem, level, seeds);
  const set = new Set();
  for (let i = 0; i < flood.depth.length; i += 1) {
    if (!flood.depth.isNoData(flood.depth.data[i])) set.add(i);
  }
  return { set, flood };
}

/**
 * Sweep levels and seeds, comparing the merge tree against `connectedFlood`
 * cell for cell. Returns the worst relative volume difference seen, which the
 * caller reports rather than hides.
 */
function sweep(label, dem, tree, seeds, levels, { masks = true } = {}) {
  let mismatches = 0;
  let worstVolume = 0;
  let firstDetail = "";
  for (const seed of seeds) {
    const cell = seed.row * dem.width + seed.col;
    const z = dem.data[cell];
    for (const level of levels) {
      const got = floodFrom(tree, cell, level, z);
      const { set, flood } = referenceCells(dem, level, [seed]);
      let bad = null;
      if (got.cells !== set.size) bad = `cells ${got.cells} vs ${set.size}`;
      if (!bad) {
        const denom = Math.max(1, Math.abs(flood.volume));
        const rel = Math.abs(got.volume_m3 - flood.volume) / denom;
        if (rel > worstVolume) worstVolume = rel;
        if (rel > 1e-9) bad = `volume ${got.volume_m3} vs ${flood.volume}`;
      }
      if (!bad && masks) {
        const mask = componentCellsOnGrid(tree, dem, cell, level, z);
        if (mask.size !== set.size) bad = `mask ${mask.size} vs ${set.size}`;
        else for (const i of set) if (!mask.has(i)) { bad = `mask misses cell ${i}`; break; }
      }
      if (!bad && got.extent && set.size > 0) {
        let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
        for (const i of set) {
          const c = i % dem.width;
          const r = (i - c) / dem.width;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
        }
        if (got.extent.col0 !== minC || got.extent.col1 !== maxC ||
            got.extent.row0 !== minR || got.extent.row1 !== maxR) {
          bad = `extent [${got.extent.col0},${got.extent.row0},${got.extent.col1},${got.extent.row1}] ` +
                `vs [${minC},${minR},${maxC},${maxR}]`;
        }
      }
      if (bad) {
        mismatches += 1;
        if (!firstDetail) firstDetail = `seed ${seed.col},${seed.row} at ${level}: ${bad}`;
      }
    }
  }
  const runs = seeds.length * levels.length;
  check(
    `${label}: ${runs} floods agree with connectedFlood cell for cell`,
    mismatches === 0,
    mismatches === 0
      ? `worst volume difference ${worstVolume.toExponential(2)} relative`
      : `${mismatches} mismatched, first ${firstDetail}`,
  );
  return worstVolume;
}

// ---------------------------------------------------------------------------
console.log("\nThe sort the whole construction rests on");
{
  // Ascending order has to be exact, including across zero, because the tree is
  // built by processing cells in that order and nothing downstream re-checks it.
  const dem = makeGrid(40, 40, (c, r) => ((c * 37 + r * 91) % 211) / 7 - 15);
  const order = orderByElevation(dem);
  let sorted = true;
  for (let k = 1; k < order.length; k += 1) {
    if (dem.data[order[k]] < dem.data[order[k - 1]]) sorted = false;
  }
  check("cells come out in non-decreasing elevation order, negatives included",
    sorted && order.length === dem.length, `${order.length} cells`);

  // Stability is what makes two builds of the same grid produce the same tree.
  const flat = makeGrid(10, 10, () => 42);
  const flatOrder = orderByElevation(flat);
  let inIndexOrder = true;
  for (let k = 0; k < flatOrder.length; k += 1) if (flatOrder[k] !== k) inIndexOrder = false;
  check("a perfectly flat grid keeps ascending cell order, so the build is deterministic",
    inIndexOrder);

  const holed = makeGrid(12, 12, (c, r) => (c === 5 ? -99999 : 10 + r));
  check("nodata cells are left out of the ordering entirely",
    orderByElevation(holed).length === 12 * 11, `${orderByElevation(holed).length}`);
}

// ---------------------------------------------------------------------------
console.log("\nA square pyramid, where the flooded area is arithmetic");
{
  // z = max(|c - 10|, |r - 10|), so the sublevel set at level L is exactly the
  // square of side 2L + 1 centred on the apex. The area is a number this test
  // knows before the engine runs.
  const dem = makeGrid(21, 21, (c, r) => Math.max(Math.abs(c - 10), Math.abs(r - 10)));
  const tree = buildMergeTree(dem);
  const apex = 10 * 21 + 10;
  let allExact = true;
  for (let L = 0; L <= 10; L += 1) {
    const expected = (2 * L + 1) ** 2;
    if (floodFrom(tree, apex, L, 0).cells !== expected) allExact = false;
  }
  check("every level from the apex floods exactly (2L+1)^2 cells", allExact);

  // Volume of the same square: sum over the square of (L - max(|dc|,|dr|)), which
  // is a ring sum. Ring k has 8k cells at depth L - k, for k = 1..L, plus the apex.
  const L = 6;
  let expectedVolume = L;
  for (let k = 1; k <= L; k += 1) expectedVolume += 8 * k * (L - k);
  const got = floodFrom(tree, apex, L, 0);
  check(`storage volume at level ${L} is the ring sum, ${expectedVolume} m3`,
    Math.abs(got.volume_m3 - expectedVolume) < 1e-9, `got ${got.volume_m3}`);

  check("the extent of the level-6 flood is the 13x13 square around the apex",
    got.extent.col0 === 4 && got.extent.col1 === 16 &&
    got.extent.row0 === 4 && got.extent.row1 === 16);

  // The seed's own ground is the lowest level at which anything floods at all,
  // and below it the answer is nothing, not one cell.
  check("a source above the water floods nothing",
    floodFrom(tree, apex, -1, 0).cells === 0);

  // A cone is one basin all the way up: one local minimum and no saddles, so the
  // tree is a single node with every cell in its run. This is the case the run
  // representation exists for.
  check("a single-basin surface builds one node, not one node per cell",
    tree.nodes === 1, `${tree.nodes} nodes for ${tree.cells} cells`);
}

// ---------------------------------------------------------------------------
console.log("\nTwo bowls behind a ridge, where the merge level is known");
{
  /*
   * Two 5 m deep square bowls at 100 m, separated by a wall at 103 m in an
   * otherwise 105 m plain. Below 103 the two floods are separate and each is
   * exactly its own bowl; at 103 they join. That merge level is the one number
   * a merge tree exists to record, so it is checked directly rather than
   * inferred from an area.
   */
  const W = 31, H = 11;
  const inBowl = (c, r, cx) => c >= cx - 3 && c <= cx + 3 && r >= 2 && r <= 8;
  const dem = makeGrid(W, H, (c, r) => {
    if (inBowl(c, r, 7)) return 100;
    if (inBowl(c, r, 23)) return 100;
    if (c === 15) return 103;
    return 105;
  });
  const tree = buildMergeTree(dem);
  const left = 5 * W + 7;
  const right = 5 * W + 23;

  check("at 102 m the left bowl floods only itself, 49 cells",
    floodFrom(tree, left, 102, 100).cells === 49,
    `${floodFrom(tree, left, 102, 100).cells}`);
  check("at 102 m the right bowl is a separate flood of 49 cells",
    floodFrom(tree, right, 102, 100).cells === 49);
  check("at 102 m the two floods are different components",
    floodFrom(tree, left, 102, 100).node !== floodFrom(tree, right, 102, 100).node);

  // At 103 the wall is at the water line, so both bowls plus the wall's 11 cells.
  const joined = floodFrom(tree, left, 103, 100);
  check("at 103 m the ridge is submerged and the two bowls are one flood of 109 cells",
    joined.cells === 49 + 49 + 11, `${joined.cells}`);
  check("at 103 m both seeds land on the same component",
    joined.node === floodFrom(tree, right, 103, 100).node);

  // Two seeds in one lake must be counted once. Summing per seed would report
  // 218 cells for a 109 cell lake, and the number would look entirely plausible.
  const many = floodFromMany(tree, [
    { cell: left, elevation: 100 }, { cell: right, elevation: 100 },
  ], 103);
  check("two seeds in the same lake are counted once, not twice",
    many.cells === 109 && many.components === 1, `${many.cells} cells, ${many.components} components`);

  const separate = floodFromMany(tree, [
    { cell: left, elevation: 100 }, { cell: right, elevation: 100 },
  ], 102);
  check("two seeds in disjoint lakes add up",
    separate.cells === 98 && separate.components === 2,
    `${separate.cells} cells, ${separate.components} components`);

  sweep("two bowls", dem, tree, [
    { col: 7, row: 5 }, { col: 23, row: 5 }, { col: 15, row: 5 }, { col: 0, row: 0 },
  ], [99, 100, 100.5, 101, 102, 102.999, 103, 103.001, 104, 104.5, 105, 106]);
}

// ---------------------------------------------------------------------------
console.log("\nA hilltop hollow, the bathtub trap connectedFlood exists to avoid");
{
  // A pit at 90 m on top of a 200 m plateau, and a valley at 90 m beside it.
  // A plain elevation threshold floods both. A connected flood from the valley
  // must leave the hilltop pit dry, and so must the merge tree — they are
  // different components of the same sublevel set, which is exactly what the
  // tree stores.
  const W = 40, H = 20;
  const dem = makeGrid(W, H, (c, r) => {
    if (c >= 30 && c <= 33 && r >= 8 && r <= 11) return 90;   // hilltop hollow
    if (c >= 20) return 200;                                  // the hill
    return 90 + c * 0.1;                                      // the valley floor
  });
  const tree = buildMergeTree(dem);
  const valley = 10 * W + 0;
  const hollow = 9 * W + 31;

  const flooded = floodFrom(tree, valley, 91, 90);
  const { set } = referenceCells(dem, 91, [{ col: 0, row: 10 }]);
  check("the valley flood matches connectedFlood exactly and excludes the hilltop hollow",
    flooded.cells === set.size && !componentCellsOnGrid(tree, dem, valley, 91, 90).has(hollow),
    `${flooded.cells} cells`);
  check("the hilltop hollow is its own component, 16 cells, at the same level",
    floodFrom(tree, hollow, 91, 90).cells === 16,
    `${floodFrom(tree, hollow, 91, 90).cells}`);
  check("the two are genuinely different nodes of the tree",
    floodFrom(tree, valley, 91, 90).node !== floodFrom(tree, hollow, 91, 90).node);
}

// ---------------------------------------------------------------------------
console.log("\nA staircase, the shape that makes the tree a chain");
{
  // Every cell is a merge of exactly one component, so the classical component
  // tree would be 4000 nodes deep and the ancestor walk would be 4000 steps.
  // The run representation collapses it to one node, which is the point.
  const dem = makeGrid(200, 20, (c) => c * 0.5);
  const tree = buildMergeTree(dem);
  check("a monotone ramp is a single node with every cell in its run",
    tree.nodes === 1 && tree.runLen[0] === tree.cells, `${tree.nodes} nodes`);
  const got = floodFrom(tree, 0, 10, 0);
  check("flooding the ramp to 10 m covers columns 0..20, 420 cells",
    got.cells === 21 * 20, `${got.cells}`);
  sweep("ramp", dem, tree, [{ col: 0, row: 0 }, { col: 100, row: 10 }],
    [0, 0.5, 3, 10, 25.25, 60, 99.5, 200]);
}

// ---------------------------------------------------------------------------
console.log("\nA ragged nodata footprint, which is what a drone survey actually is");
{
  // Nodata must be a wall, not a bridge: two basins that touch only across a
  // gap in the survey are two floods, however close they look on the map.
  const W = 25, H = 11;
  const dem = makeGrid(W, H, (c, r) => {
    if (c === 12) return -99999;
    if (r === 0 || r === H - 1) return -99999;
    return 100 + Math.abs(r - 5) * 0.5;
  });
  const tree = buildMergeTree(dem);
  check("nodata cells are absent from the tree",
    tree.cells === (W - 1) * (H - 2), `${tree.cells} of ${dem.length}`);
  const west = 5 * W + 3;
  const east = 5 * W + 20;
  check("water cannot cross a nodata gap",
    floodFrom(tree, west, 105, 100).node !== floodFrom(tree, east, 105, 100).node);
  sweep("ragged footprint", dem, tree,
    [{ col: 3, row: 5 }, { col: 20, row: 5 }, { col: 11, row: 1 }],
    [99, 100, 100.25, 100.5, 101, 102, 102.5, 103]);
}

// ---------------------------------------------------------------------------
console.log("\nRandom noise, where nothing can be reasoned about and everything is compared");
{
  // A deterministic pseudo-random surface, quantised to a handful of distinct
  // elevations so ties are frequent. Ties are where a merge tree goes wrong:
  // several cells at the same level joining several components at once.
  let seed = 20260904;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const values = new Float32Array(80 * 60);
  for (let i = 0; i < values.length; i += 1) values[i] = Math.round(rnd() * 8) / 2;
  const dem = makeGrid(80, 60, (c, r) => values[r * 80 + c]);
  const tree = buildMergeTree(dem);
  console.log(`  (${tree.nodes} nodes over ${tree.cells} cells, ` +
    `${structureBytes(tree).bytesPerCell.toFixed(1)} bytes per cell)`);
  const seeds = [];
  for (let k = 0; k < 12; k += 1) {
    seeds.push({ col: Math.floor(rnd() * 80), row: Math.floor(rnd() * 60) });
  }
  sweep("noise with many ties", dem, tree, seeds, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
}

// ---------------------------------------------------------------------------
console.log("\nA ladder of levels, which is what the tool actually asks for");
{
  const dem = makeGrid(60, 60, (c, r) => 100 + Math.hypot(c - 30, r - 30) * 0.2);
  const tree = buildMergeTree(dem);
  const cell = 30 * 60 + 30;
  const levels = Array.from({ length: 12 }, (_, i) => 100 + i * 0.5);
  const ladder = floodLadder(tree, cell, levels, dem.data[cell]);
  let same = true;
  for (let i = 0; i < levels.length; i += 1) {
    if (ladder[i].cells !== floodFrom(tree, cell, levels[i], dem.data[cell]).cells) same = false;
  }
  check("a sorted ladder walked once gives the same answers as twelve separate queries", same);

  // Out of order on purpose: the ladder sorts internally and must put the
  // answers back where the caller asked for them.
  const shuffled = [104, 100, 102.5, 101, 105.5];
  const out = floodLadder(tree, cell, shuffled, dem.data[cell]);
  let placed = true;
  for (let i = 0; i < shuffled.length; i += 1) {
    if (out[i].level_m !== shuffled[i]) placed = false;
    if (out[i].cells !== floodFrom(tree, cell, shuffled[i], dem.data[cell]).cells) placed = false;
  }
  check("an unsorted ladder comes back in the caller's order", placed);
}

// ---------------------------------------------------------------------------
console.log("\nReal terrain: the Kotba DTM at native resolution");
{
  const path = "portal-data/terrain/kotba-survey/dtm.tif";
  const raster = await openRaster(cached(await fileSource(path)));
  const dem = await raster.readWindow({ col0: 0, row0: 0, cols: raster.width, rows: raster.height });
  await raster.close();

  const t0 = Date.now();
  const tree = buildMergeTree(dem);
  const build = Date.now() - t0;
  const bytes = structureBytes(tree);
  console.log(`  (${dem.width} x ${dem.height} = ${(tree.cells / 1e6).toFixed(2)}M data cells, ` +
    `${tree.nodes.toLocaleString()} nodes, built in ${build} ms, ` +
    `${(bytes.total / 1e6).toFixed(1)} MB, ${bytes.bytesPerCell.toFixed(1)} bytes per cell)`);

  const stats = dem.stats();
  // Seeds spread across the survey rather than chosen: a hand-picked seed in a
  // basin is the easy case, and the interesting failures are on ridges and at
  // the ragged edge of the footprint.
  const seeds = [];
  for (let k = 0; k < 8; k += 1) {
    const col = Math.floor(((k * 7 + 3) % 8) / 8 * dem.width) + 3;
    const row = Math.floor(((k * 5 + 1) % 8) / 8 * dem.height) + 3;
    if (!dem.isNoDataAt(col, row)) seeds.push({ col, row });
  }
  // Plus the lowest cell in the survey, which is where standing water actually is.
  let lowest = Infinity;
  let lowestAt = null;
  for (let i = 0; i < dem.length; i += 1) {
    const z = dem.data[i];
    if (dem.isNoData(z) || z >= lowest) continue;
    lowest = z;
    lowestAt = i;
  }
  seeds.push({ col: lowestAt % dem.width, row: (lowestAt - (lowestAt % dem.width)) / dem.width });

  const levels = [];
  for (let k = 0; k <= 10; k += 1) levels.push(stats.min + ((stats.max - stats.min) * k) / 10);
  // Masks are compared on a subset: the full cell-for-cell comparison is a
  // whole-grid scan per flood and would dominate this file's runtime.
  sweep("Kotba, whole survey", dem, tree, seeds, levels, { masks: false });
  sweep("Kotba, cell-for-cell masks", dem, tree, [seeds[seeds.length - 1]],
    levels.slice(0, 6), { masks: true });

  // The claim that makes the structure worth anything: a query is a lookup.
  const cell = lowestAt;
  const ladder = Array.from({ length: 12 }, (_, i) => lowest + i * 0.5);
  const tq = process.hrtime.bigint();
  let acc = 0;
  for (let rep = 0; rep < 200; rep += 1) {
    for (const r of floodLadder(tree, cell, ladder, lowest)) acc += r.cells;
  }
  const perLadder = Number(process.hrtime.bigint() - tq) / 1e6 / 200;
  console.log(`  (a 12 level ladder answers in ${(perLadder * 1000).toFixed(0)} us, ` +
    `checksum ${acc})`);
  check("a twelve level ladder over 2.2M cells answers in under a millisecond",
    perLadder < 1, `${perLadder.toFixed(4)} ms`);
}

// ---------------------------------------------------------------------------
const total = pass + fail;
console.log(`\n${fail === 0 ? `all ${total} checks passed` : `${fail} of ${total} checks FAILED`}\n`);
process.exit(fail === 0 ? 0 : 1);
