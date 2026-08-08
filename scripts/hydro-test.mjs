/**
 * Known-answer tests for the hydrology engine.
 *
 * Every case here has an answer that can be worked out on paper, because
 * `docs/portal-map-architecture.md` section 11 is right that a wrong number looks
 * exactly like a right one. Agreement with SAGA on the Kherwada fixture, which
 * `hydro-validate.mjs` measures, proves we match somebody else's implementation.
 * It does not prove either of us is correct. These do that half.
 *
 * The synthetic surfaces are chosen so the expected result is exact rather than
 * approximate: a tilted plane has one obvious flow direction and an arithmetic
 * accumulation, a dug pit has a fill depth equal to what was dug out, and a
 * disconnected hollow at the same level as a flooded basin must stay dry.
 *
 * Run:
 *   node scripts/hydro-test.mjs
 */

import { Grid, resample } from "./lib/raster.mjs";
import { polygonize, ringArea, vectoriseStreams } from "./lib/vectorise.mjs";
import {
  fillDepressions,
  d8Pointer,
  d8Accumulation,
  streamCells,
  strahlerOrder,
  watershedFrom,
  slopeDegrees,
  connectedFlood,
  snapToChannel,
} from "./lib/hydrology.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function makeGrid(width, height, fn, { cellSize = 1, nodata = -99999 } = {}) {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) data[row * width + col] = fn(col, row);
  }
  return new Grid({
    width, height, cellSize, originX: 0, originY: height * cellSize, data, nodata,
  });
}

// ---------------------------------------------------------------------------
console.log("\nA plane tilted due east, where every answer is arithmetic");
// z falls by 0.1 m per cell towards +col. The east neighbour is 0.1 m down at a
// distance of 1; the diagonals are the same 0.1 m down but 1.414 away, so east
// must win outright. Each row then drains independently along itself.
{
  const W = 20, H = 8;
  const dem = makeGrid(W, H, (col) => 100 - 0.1 * col);
  const { filled, raisedCells } = fillDepressions(dem);
  check("a surface with no pits is not raised anywhere", raisedCells === 0);

  const dir = d8Pointer(filled);
  let allEast = true;
  for (let row = 0; row < H; row += 1) {
    for (let col = 0; col < W - 1; col += 1) if (dir.get(col, row) !== 0) allEast = false;
  }
  check("every cell flows due east, diagonals correctly lose on distance", allEast);
  check("the downslope edge drains off the grid", dir.get(W - 1, 0) === -1);

  const accum = d8Accumulation(dir, filled);
  check("accumulation at the ridge is 1, the cell itself", accum.get(0, 3) === 1);
  check("accumulation grows by one per cell downslope", accum.get(7, 3) === 8);
  check(`accumulation at the outlet is the whole row (${W})`, accum.get(W - 1, 3) === W);

  // Conservation: everything leaving the grid must add up to everything on it.
  let leaving = 0;
  for (let i = 0; i < dir.length; i += 1) if (dir.data[i] === -1) leaving += accum.data[i];
  check("total outflow equals the cell count, so no water is lost or invented",
    leaving === W * H, `${leaving} vs ${W * H}`);

  const slope = slopeDegrees(filled);
  const expected = (Math.atan(0.1) * 180) / Math.PI;
  check(`slope is atan(0.1) = ${expected.toFixed(4)} degrees`,
    near(slope.get(10, 4), expected, 1e-4), `got ${slope.get(10, 4).toFixed(4)}`);

  // Each row is its own catchment on this surface, so the watershed of the
  // outlet cell is exactly that row and nothing from its neighbours.
  const shed = watershedFrom(dir, W - 1, 3);
  let cells = 0, strayRow = false;
  for (let row = 0; row < H; row += 1) {
    for (let col = 0; col < W; col += 1) {
      if (!shed.get(col, row)) continue;
      cells += 1;
      if (row !== 3) strayRow = true;
    }
  }
  check("the watershed of an outlet is exactly its own row", cells === W && !strayRow,
    `${cells} cells`);
}

// ---------------------------------------------------------------------------
console.log("\nA single dug pit, where the fill depth is what was dug");
{
  // Flat ground, so the cell's own elevation and the level it can spill at are
  // the same number and the expected depth is unambiguous.
  const W = 15, H = 15;
  const DUG = 3.25;
  const dem = makeGrid(W, H, (col, row) => (col === 7 && row === 7 ? 50 - DUG : 50));
  const { filled, sinks, raisedCells } = fillDepressions(dem, { epsilon: 1e-5 });
  check("exactly one cell was raised", raisedCells === 1, `${raisedCells}`);

  const depth = sinks.get(7, 7);
  check(`the sink depth is the ${DUG} m that was dug out`, near(depth, DUG, 1e-3),
    `got ${depth.toFixed(4)}`);
  check("cells that were never raised are nodata, not a field of zeros",
    sinks.isNoDataAt(3, 3));

  // The filled cell must now drain rather than sit in a hole of its own.
  const dir = d8Pointer(filled);
  check("the filled cell has somewhere to send water", dir.get(7, 7) >= 0);
  d8Accumulation(dir, filled); // throws if any cell is stuck in a cycle
  check("no flow cycles survive the fill", true);
}

// ---------------------------------------------------------------------------
console.log("\nThe same pit on a slope, where the fill stops at the spill point");
{
  // Worth its own case because the intuitive answer is wrong. A pit fills to the
  // lowest point on its rim, not back to the surface it was cut from. On ground
  // falling 0.01 m per cell the rim is already below the cell's original height,
  // so the recovered depth is less than what was dug, and that is correct.
  const W = 15, H = 15;
  const DUG = 3.25;
  const dem = makeGrid(W, H, (col, row) => (col === 7 && row === 7 ? 50 - 0.07 - DUG : 50 - 0.01 * col));
  const { filled, sinks } = fillDepressions(dem, { epsilon: 1e-5 });

  const spill = 50 - 0.01 * 8; // the downslope neighbour, the lowest way out
  check("the pit fills exactly to its spill elevation, not to its old surface",
    near(filled.get(7, 7), spill, 1e-4), `filled to ${filled.get(7, 7).toFixed(4)}, spill ${spill.toFixed(4)}`);

  const depth = sinks.get(7, 7);
  check("so the reported depth is measured to the rim, 0.01 m short of the dug depth",
    near(depth, DUG - 0.01, 1e-3), `got ${depth.toFixed(4)}, dug ${DUG}`);
}

// ---------------------------------------------------------------------------
console.log("\nA V-shaped valley, where two hillslopes must meet in the channel");
{
  const W = 21, H = 12;
  const MID = 10;
  // Fall towards the centre column, and a gentle fall south along it.
  const dem = makeGrid(W, H, (col, row) => 100 + Math.abs(col - MID) * 0.5 - row * 0.05);
  const { filled } = fillDepressions(dem);
  const dir = d8Pointer(filled);
  const accum = d8Accumulation(dir, filled);

  check("the channel carries far more than the hillslope beside it",
    accum.get(MID, H - 1) > accum.get(MID - 4, H - 1) * 10,
    `${accum.get(MID, H - 1)} vs ${accum.get(MID - 4, H - 1)}`);

  let leaving = 0;
  for (let i = 0; i < dir.length; i += 1) if (dir.data[i] === -1) leaving += accum.data[i];
  check("outflow still equals the cell count on a two-sided catchment",
    leaving === W * H, `${leaving} vs ${W * H}`);

  const streams = streamCells(accum, 20);
  check("thresholding accumulation puts the channel on the valley floor",
    streams.get(MID, H - 2) === 1 && streams.get(MID - 5, H - 2) === 0);

  const snapped = snapToChannel(accum, MID - 3, H - 2, 5);
  check("a pour point digitised off the channel snaps back onto it",
    snapped.col === MID, `snapped to column ${snapped.col}`);
}

// ---------------------------------------------------------------------------
console.log("\nStrahler on a network built by hand, where every order is known");
{
  // Deriving a network from a DEM and a threshold tangles three things together
  // and cannot isolate the ordering rule, so the network is written out directly:
  // two Y junctions, each joining a pair of first order branches into a second
  // order trunk, and those two trunks joining into a third. A single first order
  // tributary then joins the third order channel, which must NOT promote it.
  const W = 21, H = 12;
  const dir = new Grid({
    width: W, height: H, cellSize: 1, originX: 0, originY: H,
    data: new Int8Array(W * H).fill(-1), nodata: -1,
  });
  const streams = new Grid({
    width: W, height: H, cellSize: 1, originX: 0, originY: H,
    data: new Uint8Array(W * H), nodata: 0,
  });
  const SE = 1, SW = 3, S = 2;
  const run = (cells, code) => {
    for (const [c, r] of cells) { dir.set(c, r, code); streams.set(c, r, 1); }
  };
  run([[1, 0], [2, 1], [3, 2]], SE);            // branch A, order 1
  run([[7, 0], [6, 1], [5, 2]], SW);            // branch B, order 1
  run([[4, 3], [5, 4], [6, 5], [7, 6], [8, 7], [9, 8]], SE);   // left trunk
  run([[13, 0], [14, 1], [15, 2]], SE);         // branch C, order 1
  run([[19, 0], [18, 1], [17, 2]], SW);         // branch D, order 1
  run([[16, 3], [15, 4], [14, 5], [13, 6], [12, 7], [11, 8]], SW); // right trunk
  run([[10, 9], [10, 10]], S);                  // the joined channel
  run([[13, 8], [12, 9], [11, 10]], SW);        // late first order tributary
  streams.set(10, 11, 1);                       // outlet, dir stays -1

  const order = strahlerOrder(dir, streams);
  check("a headwater branch is order 1", order.get(3, 2) === 1, `got ${order.get(3, 2)}`);
  check("two order 1 branches meeting make order 2", order.get(4, 3) === 2, `got ${order.get(4, 3)}`);
  check("the order 2 trunk stays order 2 along its length", order.get(7, 6) === 2,
    `got ${order.get(7, 6)}`);
  check("the second Y independently makes order 2", order.get(16, 3) === 2, `got ${order.get(16, 3)}`);
  check("two order 2 trunks meeting make order 3", order.get(10, 9) === 3, `got ${order.get(10, 9)}`);
  check("an order 1 tributary joining order 3 does NOT promote it",
    order.get(10, 11) === 3, `got ${order.get(10, 11)}`);

  let maxOrder = 0;
  for (let i = 0; i < order.length; i += 1) if (streams.data[i]) maxOrder = Math.max(maxOrder, order.data[i]);
  check("nothing anywhere exceeds order 3", maxOrder === 3, `max ${maxOrder}`);

  // The same network, split into segments. Counting on paper: five sources, two
  // Y junctions, the joined channel, and the late tributary make eight runs
  // between nodes. The outlet itself starts nothing, having nowhere to go.
  const segments = vectoriseStreams(dir, streams, order, dir);
  check("the network splits into 8 segments between nodes", segments.length === 8,
    `${segments.length}`);
  const bySegOrder = segments.map((s) => s.order).sort((a, b) => a - b);
  check("segment orders are five 1s, two 2s and one 3",
    JSON.stringify(bySegOrder) === JSON.stringify([1, 1, 1, 1, 1, 2, 2, 3]),
    JSON.stringify(bySegOrder));
  const trunk = segments.find((s) => s.order === 3);
  check("the order 3 segment runs from the second junction to the outlet",
    trunk.cells === 3, `${trunk.cells} cells`);
}

// ---------------------------------------------------------------------------
console.log("\nResampling, which is what makes hydrology tractable and cleaner");
{
  // A 4 x 4 grid of known values collapsed to 2 x 2. Each output cell is the
  // mean of its four inputs, and those means can be checked by hand.
  const dem = makeGrid(4, 4, (col, row) => col + row * 4);
  const half = resample(dem, 2);
  check("halving the resolution halves both dimensions",
    half.width === 2 && half.height === 2, `${half.width}x${half.height}`);
  // Top left block is 0,1,4,5 -> mean 2.5
  check("each output cell is the mean of the block it covers",
    half.get(0, 0) === 2.5 && half.get(1, 0) === 4.5, `${half.get(0, 0)}, ${half.get(1, 0)}`);
  check("the origin does not move when resampling",
    half.originX === dem.originX && half.originY === dem.originY);
  check("cell size is what was asked for", half.cellSize === 2);

  // Nodata must not be averaged in as if it were ground at zero.
  const holed = makeGrid(4, 4, (col, row) => (col === 0 && row === 0 ? -99999 : 10));
  const filledOut = resample(holed, 2);
  check("nodata is excluded from the average rather than counted as zero",
    filledOut.get(0, 0) === 10, `got ${filledOut.get(0, 0)}`);

  const allGone = resample(makeGrid(2, 2, () => -99999), 2);
  check("a block with no data at all comes back as nodata", allGone.isNoDataAt(0, 0));

  let refused = false;
  try { resample(dem, 0.5); } catch { refused = true; }
  check("upsampling is refused rather than inventing detail", refused);
  check("resampling to the same size is a no-op", resample(dem, 1) === dem);
}

// ---------------------------------------------------------------------------
console.log("\nPolygonising a mask, where the area is countable");
{
  const grid = makeGrid(9, 9, () => 0);
  const mask = grid.like(Uint8Array, 0, 0);
  for (let row = 2; row <= 4; row += 1) for (let col = 2; col <= 4; col += 1) mask.set(col, row, 1);

  const rings = polygonize(mask, grid);
  check("a solid 3 x 3 block traces exactly one ring", rings.length === 1, `${rings.length}`);
  check("the ring closes on itself",
    rings[0][0][0] === rings[0][rings[0].length - 1][0] &&
    rings[0][0][1] === rings[0][rings[0].length - 1][1]);
  check("collinear staircase points are dropped, leaving 4 corners",
    rings[0].length === 5, `${rings[0].length} points`);
  check("the enclosed area is 9 m2 and the ring is counter clockwise",
    near(ringArea(rings[0]), 9, 1e-9), `${ringArea(rings[0])}`);

  // Punch a hole. The outer ring keeps its area, and the hole comes back wound
  // the other way, which is what makes it render as a hole and not a patch.
  mask.set(3, 3, 0);
  const holed = polygonize(mask, grid);
  check("a block with a hole traces two rings", holed.length === 2, `${holed.length}`);
  const areas = holed.map(ringArea).sort((a, b) => a - b);
  check("outer ring is +9 m2 and the hole is -1 m2, so the net area is 8",
    near(areas[1], 9, 1e-9) && near(areas[0], -1, 1e-9), `${areas.join(", ")}`);

  // Two separate blocks are two separate rings, not one that jumps the gap.
  const two = grid.like(Uint8Array, 0, 0);
  two.set(1, 1, 1);
  two.set(7, 7, 1);
  check("two disconnected cells give two rings", polygonize(two, grid).length === 2);

  // Coordinates must land in projected space, on cell corners.
  const single = grid.like(Uint8Array, 0, 0);
  single.set(0, 0, 1);
  const ring = polygonize(single, grid)[0];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  check("the ring sits on the cell's own corners",
    Math.min(...xs) === grid.originX && Math.max(...xs) === grid.originX + grid.cellSize &&
    Math.max(...ys) === grid.originY && Math.min(...ys) === grid.originY - grid.cellSize);
}

// ---------------------------------------------------------------------------
console.log("\nFlooding, where the bathtub answer and the right answer differ");
{
  // One basin reachable from the river, and a second hollow of identical depth
  // sitting on high ground with a rim between them. A naive "everything below
  // the level" flood fills both. Only the first one can actually hold water.
  const W = 40, H = 12;
  const dem = makeGrid(W, H, (col, row) => {
    if (col >= 4 && col <= 9 && row >= 4 && row <= 7) return 10; // basin by the river
    if (col >= 26 && col <= 31 && row >= 4 && row <= 7) return 10; // hollow on the hill
    if (col >= 20) return 60; // the high ground, and the rim
    return 14; // the floodplain
  });

  const level = 12;
  const { depth, volume, cells, area } = connectedFlood(dem, level, [{ col: 6, row: 6 }]);

  check("the connected basin floods", depth.get(6, 6) === level - 10);
  check("the isolated hollow on the hill stays dry, which a bathtub fill gets wrong",
    depth.isNoDataAt(28, 6));

  // 6 x 4 basin cells at 2 m deep. Everything else nearby sits above the level.
  check(`the flooded area is the basin, ${6 * 4} m2`, cells === 24 && area === 24, `${cells} cells`);
  check(`storage volume is 24 m2 x 2 m = 48 m3`, near(volume, 48, 1e-6), `${volume} m3`);

  // Same DEM, same level, seeded on the hill: now the other hollow fills instead.
  const hill = connectedFlood(dem, level, [{ col: 28, row: 6 }]);
  check("seeding on the hill floods only the hollow up there", hill.cells === 24);
}

// ---------------------------------------------------------------------------
console.log("\nNodata, which must behave like the edge of the world");
{
  const W = 12, H = 12;
  // A bowl that would be a giant pit, but its western side is nodata, so water
  // drains out through the missing data rather than ponding to the rim.
  const dem = makeGrid(W, H, (col, row) => {
    if (col < 3) return -99999;
    return 20 + (col - 3) * 0.5 + Math.abs(row - 6) * 0.1;
  });
  const { filled } = fillDepressions(dem);
  check("nodata cells are left as nodata by the fill", filled.isNoDataAt(1, 6));

  const dir = d8Pointer(filled);
  const accum = d8Accumulation(dir, filled);
  check("no cell drains into nodata", dir.get(3, 6) === -1 || !filled.isNoDataAt(3 + [1,1,0,-1,-1,-1,0,1][dir.get(3,6)], 6));

  const stats = accum.stats();
  check("accumulation is nodata exactly where the DEM is",
    stats.count === filled.stats().count, `${stats.count} vs ${filled.stats().count}`);
}

// ---------------------------------------------------------------------------
console.log("\nDeterminism, because a harness that cannot repeat itself measures nothing");
{
  const W = 30, H = 30;
  const dem = makeGrid(W, H, (col, row) =>
    50 + Math.sin(col / 3) * 2 + Math.cos(row / 4) * 3 - row * 0.05);
  const run = () => {
    const { filled } = fillDepressions(dem);
    const dir = d8Pointer(filled);
    return d8Accumulation(dir, filled);
  };
  const a = run();
  const b = run();
  let identical = true;
  for (let i = 0; i < a.length; i += 1) if (a.data[i] !== b.data[i]) identical = false;
  check("two runs over the same surface are bit for bit identical", identical);
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
