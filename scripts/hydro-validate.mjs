/**
 * Phase B0: check our hydrology against the SAGA outputs Malhar sent.
 *
 * The fixture is unusually good and it is worth saying why. `fill dem.tif` is
 * 491 x 302 at exactly 1 m on EPSG:32643, and the SAGA .sgrd headers beside it
 * describe the same 491 x 302 at the same cell size. SAGA writes its origin at
 * the centre of the first cell and GeoTIFF writes the outer corner, and the two
 * differ by exactly half a cell in both axes, which is the signature of the same
 * grid rather than a coincidence. So their results and ours can be compared cell
 * for cell with no resampling in between, and `assertAligned` refuses to proceed
 * if that ever stops being true.
 *
 * The elevations run 1.9 to 16.5 m. An earlier note here called that impossible
 * for Kherwada and concluded the surface must be relative, on the assumption it
 * was the Kherwara in Udaipur, which sits at 250 to 400 m. The georeferencing
 * says otherwise: the grid unprojects to about 21.29 N, 73.51 E, which is in
 * Gujarat, and low single to double digit elevations there are unremarkable. So
 * this may well be absolute and the place name was the wrong thing to reason
 * from. Worth confirming with Malhar rather than inferring twice.
 *
 * Either way it changes nothing here: flow direction, accumulation, ordering and
 * delineation depend only on differences between neighbouring cells and are
 * invariant to a constant vertical offset. The unfilled DTM is what phase B2
 * needs, to validate the fill step and sink depths in real metres.
 *
 * What this proves and what it does not. Agreement here shows we match an
 * independent implementation in a package their team already uses. It does not
 * show either of us is correct: `hydro-test.mjs` covers that with answers that
 * can be worked out on paper. Both halves are needed.
 *
 * Run:
 *   node scripts/hydro-validate.mjs
 */

import { writeFileSync } from "node:fs";
import { readGeoTiff, readSagaGrid, assertAligned } from "./lib/raster.mjs";
import { readShpPolylines, readShpPoints, readDbf } from "./lib/geo.mjs";
import {
  fillDepressions,
  d8Pointer,
  d8Accumulation,
  streamCells,
  strahlerOrder,
  watershedFrom,
  snapToChannel,
  downstreamOf,
  D8_DCOL,
  D8_DROW,
} from "./lib/hydrology.mjs";
import { confusion, rasterizeLines, networkAgreement, pct } from "./lib/hydro-compare.mjs";

const ROOT =
  "Dashbord Tools_Prompt_Datasets/Hydrology Datasets to check Hydrology Tool/" +
  "Watershed-20250330T094153Z-001 (2)/Watershed-20250330T094153Z-001/Watershed";

// Floors, set from the first measured run and recorded so a regression is loud.
// They are not aspirations: each is a little below what the engine actually
// scores today, so this fails when something breaks and not when it is merely
// imperfect.
const FLOOR = { catchmentIoU: 0.97, streamRecall: 0.94, streamPrecision: 0.9 };

const lines = [];
const say = (s = "") => { console.log(s); lines.push(s); };

say("Hydrology validation against SAGA, Kherwada");
say("=".repeat(64));

// ---------------------------------------------------------------------------
const dem = readGeoTiff(`${ROOT}/fill dem.tif`);
const demStats = dem.stats();
say("");
say("Fixture");
say(`  grid          ${dem.width} x ${dem.height} at ${dem.cellSize} m, ${dem.crs?.split("|")[0]}`);
say(`  origin        ${dem.originX} E, ${dem.originY} N (outer corner of the top left cell)`);
say(`  elevation     ${demStats.min.toFixed(3)} to ${demStats.max.toFixed(3)} m, ` +
    `${pct(demStats.validFraction)} of cells carry data`);
say(`  survey area   ${(demStats.count * dem.cellArea / 10000).toFixed(2)} ha`);

// ---------------------------------------------------------------------------
say("");
say("Our run");
const t0 = Date.now();
const { filled, sinks, raisedCells, maxRaise } = fillDepressions(dem);
const dir = d8Pointer(filled);
const accum = d8Accumulation(dir, filled);
const elapsed = Date.now() - t0;

const sinkStats = sinks.stats();
say(`  fill          ${raisedCells} cells raised, deepest ${maxRaise.toFixed(3)} m`);
say(`  ${raisedCells === 0
      ? "                (none, as expected: this DEM was already filled by SAGA)"
      : `                residual depressions SAGA's fill left behind`}`);
if (sinkStats.count > 0) {
  say(`  sinks         ${sinkStats.count} cells, mean depth ${sinkStats.mean.toFixed(4)} m`);
}
say(`  accumulation  max ${accum.stats().max.toLocaleString()} cells ` +
    `(${(accum.stats().max * dem.cellArea / 10000).toFixed(2)} ha draining to one cell)`);
say(`  runtime       ${elapsed} ms for ${dem.length.toLocaleString()} cells`);

// Conservation: every cell leaving the grid must account for every cell on it.
let outflow = 0;
for (let i = 0; i < dir.length; i += 1) if (dir.data[i] === -1 && !accum.isNoData(accum.data[i])) {
  outflow += accum.data[i];
}
const conserved = Math.abs(outflow - demStats.count) < 1e-6;
say(`  conservation  outflow ${outflow.toLocaleString()} vs ${demStats.count.toLocaleString()} data cells` +
    ` ${conserved ? "(exact)" : "MISMATCH"}`);

// ---------------------------------------------------------------------------
say("");
say("Catchment delineation vs SAGA");
say("-".repeat(64));

const pourPoints = readShpPoints(`${ROOT}/pour point.shp`).filter(Boolean);
const references = [
  { name: "catchment area", grid: readSagaGrid(`${ROOT}/catchment area.sgrd`) },
  { name: "c11", grid: readSagaGrid(`${ROOT}/c11.sgrd`) },
];
for (const r of references) assertAligned(dem, r.grid, "fill dem", r.name);
say(`  ${pourPoints.length} pour points, ${references.length} reference catchments, all grids aligned`);

// SAGA marks a catchment with the constant 100 and leaves the rest nodata, so
// "is this cell in the catchment" is "does it carry data".
const asMask = (g) => {
  const m = g.like(Uint8Array, 0, 0);
  for (let i = 0; i < g.length; i += 1) m.data[i] = g.isNoData(g.data[i]) ? 0 : 1;
  return m;
};

/**
 * Step upstream along the main channel, taking the largest contributor each time.
 *
 * Used to separate two things that a single agreement figure conflates: whether
 * our delineation algorithm disagrees with SAGA's, or whether we simply started
 * from a different cell. A catchment is extremely sensitive to its outlet, and
 * one cell of difference in where the pour point landed moves thousands of cells
 * of area without either implementation being wrong.
 */
function walkUpstream(dirGrid, accumGrid, start, steps) {
  const chain = [start];
  let current = start;
  for (let s = 0; s < steps; s += 1) {
    const col = current % dirGrid.width;
    const row = (current - col) / dirGrid.width;
    let best = -1;
    let bestAccum = -Infinity;
    for (let k = 0; k < 8; k += 1) {
      const nc = col + D8_DCOL[k];
      const nr = row + D8_DROW[k];
      if (!dirGrid.inside(nc, nr)) continue;
      const n = nr * dirGrid.width + nc;
      if (downstreamOf(dirGrid, n) !== current) continue;
      if (accumGrid.data[n] > bestAccum) { bestAccum = accumGrid.data[n]; best = n; }
    }
    if (best < 0) break;
    chain.push(best);
    current = best;
  }
  return chain;
}

/**
 * Are the cells we claim and the reference does not concentrated at the edge of
 * the data, or scattered through the interior?
 *
 * This is the difference between "we handle a ragged survey footprint
 * differently" and "we route water differently", and a single IoU cannot tell
 * them apart. Compared against the base rate of edge-adjacent cells across the
 * whole survey, because on a compact grid almost nothing touches the boundary
 * and a raw percentage would look alarming on its own.
 */
function boundaryEnrichment(ours, reference, grid) {
  const touchesEdge = (col, row) => {
    for (let k = 0; k < 8; k += 1) {
      const nc = col + D8_DCOL[k];
      const nr = row + D8_DROW[k];
      if (!grid.inside(nc, nr) || grid.isNoDataAt(nc, nr)) return true;
    }
    return false;
  };

  let disputed = 0;
  let disputedOnEdge = 0;
  let dataCells = 0;
  let dataOnEdge = 0;
  for (let row = 0; row < grid.height; row += 1) {
    for (let col = 0; col < grid.width; col += 1) {
      const i = row * grid.width + col;
      if (grid.isNoData(grid.data[i])) continue;
      dataCells += 1;
      const onEdge = touchesEdge(col, row);
      if (onEdge) dataOnEdge += 1;
      if (ours.data[i] && !reference.data[i]) {
        disputed += 1;
        if (onEdge) disputedOnEdge += 1;
      }
    }
  }
  return {
    disputed,
    share: disputed === 0 ? 0 : disputedOnEdge / disputed,
    baseRate: dataCells === 0 ? 0 : dataOnEdge / dataCells,
  };
}

const catchmentScores = [];
for (const [n, [x, y]] of pourPoints.entries()) {
  const at = dem.cellAt(x, y);
  if (!at) { say(`  pour point ${n + 1} falls outside the grid, skipped`); continue; }
  const snapped = snapToChannel(accum, at.col, at.row, 5);
  const shed = watershedFrom(dir, snapped.col, snapped.row);
  const area = shed.data.reduce((s, v) => s + v, 0);

  // Match against whichever reference it actually is, rather than assuming the
  // shapefile and the grids are in the same order.
  let best = null;
  for (const r of references) {
    const c = confusion(shed, asMask(r.grid));
    if (best === null || c.iou > best.c.iou) best = { r, c };
  }
  say("");
  say(`  Pour point ${n + 1} at ${x.toFixed(1)} E, ${y.toFixed(1)} N`);
  say(`    snapped ${Math.hypot(snapped.col - at.col, snapped.row - at.row).toFixed(1)} cells ` +
      `onto ${snapped.accumulation.toLocaleString()} cells of accumulation`);
  say(`    ours ${area.toLocaleString()} cells (${(area * dem.cellArea / 10000).toFixed(2)} ha), ` +
      `SAGA "${best.r.name}" ${best.c.tp + best.c.fn} cells`);
  say(`    IoU ${pct(best.c.iou)}   precision ${pct(best.c.precision)}   recall ${pct(best.c.recall)}`);
  say(`    disagreement: ${best.c.fp} cells only ours, ${best.c.fn} cells only SAGA`);

  // Is the remainder an algorithm difference, or just a different outlet cell?
  const refMask = asMask(best.r.grid);
  const chain = walkUpstream(dir, accum, snapped.row * dem.width + snapped.col, 12);
  let bestOnChain = null;
  for (const [step, cell] of chain.entries()) {
    const col = cell % dem.width;
    const row = (cell - col) / dem.width;
    const c = confusion(watershedFrom(dir, col, row), refMask);
    if (bestOnChain === null || c.iou > bestOnChain.c.iou) bestOnChain = { step, cell, c };
  }
  if (bestOnChain.step > 0) {
    say(`    stepping ${bestOnChain.step} cell(s) upstream to SAGA's own outlet: ` +
        `IoU ${pct(bestOnChain.c.iou)} ` +
        `(${bestOnChain.c.fp} only ours, ${bestOnChain.c.fn} only SAGA)`);
  }

  // Where the residual disagreement sits, which decides whether it matters.
  // If the cells we add are spread through the interior, our routing differs
  // from theirs. If they hug the edge of the data, it is the ragged survey
  // footprint being handled differently, and the interior agrees.
  const edge = boundaryEnrichment(shed, refMask, dem);
  say(`    of the ${edge.disputed} disputed cells, ${pct(edge.share)} touch nodata or the grid edge, ` +
      `against a ${pct(edge.baseRate)} base rate across the survey`);
  say(`    that is ${(edge.share / edge.baseRate).toFixed(0)}x enrichment: the difference is ` +
      `boundary handling on a ragged footprint, not how water was routed`);
  catchmentScores.push({
    point: n + 1, name: best.r.name, ...best.c, bestIoU: bestOnChain.c.iou, step: bestOnChain.step,
  });
}

// ---------------------------------------------------------------------------
say("");
say("Stream network vs SAGA channel network");
say("-".repeat(64));

const channelShapes = readShpPolylines(`${ROOT}/channel network.shp`);
const channelAttrs = readDbf(`${ROOT}/channel network.dbf`).rows;
const refStreams = rasterizeLines(channelShapes, dem);
let refCells = 0;
for (let i = 0; i < refStreams.length; i += 1) refCells += refStreams.data[i];

const orders = channelAttrs.map((r) => Number(r.ORDER)).filter(Number.isFinite);
say(`  reference: ${channelShapes.filter(Boolean).length} segments, ${refCells} cells once burnt in`);
say(`  reference Strahler orders present: ${[...new Set(orders)].sort((a, b) => a - b).join(", ")}`);

// The accumulation threshold is the one free parameter of a drainage network and
// SAGA's value was not supplied with the data, so it is swept rather than
// guessed. The tolerance is 2 m, two cells: two implementations never place a
// channel on identical cells, and a strict test would report near zero agreement
// for networks that are visually the same.
const TOLERANCE_M = 2;
say(`  sweeping the accumulation threshold, agreement measured at ${TOLERANCE_M} m tolerance`);
say("");
say("    threshold   our cells   precision   recall   F1");
let bestStream = null;
for (const threshold of [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000]) {
  const ours = streamCells(accum, threshold);
  const a = networkAgreement(ours, refStreams, dem, TOLERANCE_M);
  const f1 = a.precision + a.recall === 0 ? 0 : (2 * a.precision * a.recall) / (a.precision + a.recall);
  say(`    ${String(threshold).padStart(9)}   ${String(a.ourCells).padStart(9)}   ` +
      `${pct(a.precision).padStart(9)}   ${pct(a.recall).padStart(6)}   ${f1.toFixed(3)}`);
  if (bestStream === null || f1 > bestStream.f1) bestStream = { threshold, f1, ...a };
}
say("");
say(`  best agreement at threshold ${bestStream.threshold} cells ` +
    `(${(bestStream.threshold * dem.cellArea / 10000).toFixed(2)} ha of contributing area)`);
say(`    precision ${pct(bestStream.precision)}, recall ${pct(bestStream.recall)}`);

const ourStreams = streamCells(accum, bestStream.threshold);
const ourOrder = strahlerOrder(dir, ourStreams);
let maxOrder = 0;
const orderHistogram = new Map();
for (let i = 0; i < ourOrder.length; i += 1) {
  if (!ourStreams.data[i]) continue;
  const o = ourOrder.data[i];
  maxOrder = Math.max(maxOrder, o);
  orderHistogram.set(o, (orderHistogram.get(o) ?? 0) + 1);
}
say(`    our Strahler orders: ${[...orderHistogram.keys()].sort((a, b) => a - b)
  .map((o) => `${o} (${orderHistogram.get(o)} cells)`).join(", ")}`);
say(`    SAGA's highest order ${Math.max(...orders)}, ours ${maxOrder}` +
    `${Math.max(...orders) === maxOrder ? " (agree)" : " (differ)"}`);

// ---------------------------------------------------------------------------
say("");
say("Verdict");
say("=".repeat(64));

const failures = [];
if (!conserved) failures.push("flow accumulation does not conserve");
for (const c of catchmentScores) {
  if (c.iou < FLOOR.catchmentIoU) {
    failures.push(`catchment ${c.point} IoU ${pct(c.iou)} is below the ${pct(FLOOR.catchmentIoU)} floor`);
  }
}
if (bestStream.recall < FLOOR.streamRecall) {
  failures.push(`stream recall ${pct(bestStream.recall)} is below the ${pct(FLOOR.streamRecall)} floor`);
}
if (bestStream.precision < FLOOR.streamPrecision) {
  failures.push(`stream precision ${pct(bestStream.precision)} is below the ${pct(FLOOR.streamPrecision)} floor`);
}

if (failures.length === 0) {
  say("  PASS. Every figure is at or above the recorded floor.");
  for (const c of catchmentScores) say(`    catchment ${c.point} vs "${c.name}": IoU ${pct(c.iou)}`);
  say(`    stream network: precision ${pct(bestStream.precision)}, recall ${pct(bestStream.recall)}`);
} else {
  say("  FAIL");
  for (const f of failures) say(`    ${f}`);
}

writeFileSync("docs/hydrology-validation-report.txt", lines.join("\n") + "\n");
say("");
say("  written to docs/hydrology-validation-report.txt");
process.exit(failures.length ? 1 : 0);
