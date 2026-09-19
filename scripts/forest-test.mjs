/**
 * Known-answer tests for the forest engine.
 *
 * Same discipline `hydro-test.mjs` holds hydrology to, for the same reason:
 * agreement with a reference implementation (deferred to Phase F6, per
 * `docs/forest-tools-plan.md` §8) proves this engine matches somebody else's.
 * It does not prove either of us is correct. These synthetic fixtures — cones
 * and rectangles with hand-computed answers — do that half, and they run with
 * no terrain file, no candidate-boxes file and no point cloud on disk.
 *
 * Every fixture below builds its DSM and DTM on the SAME grid (same cell
 * size, same origin) except the one test that exists to prove the opposite
 * case works: `chmFrom` sampling two genuinely different grids, the way
 * Kotba's DSM and DTM actually are. On a shared grid, `chmFrom`'s bilinear
 * sample lands exactly on existing cell centres (see `Grid.cellAt`'s own
 * comment on why that matters), so the CHM this produces is not merely close
 * to the hand-computed cone, it is bit-for-bit equal to it up to floating
 * point noise, and the assertions below hold it to that.
 *
 * Run:
 *   node scripts/forest-test.mjs
 */

import { Grid } from "../src/lib/geo/raster.mjs";
import {
  chmFrom,
  crownFromBox,
  crownMetrics,
  rejectNonTree,
  confidenceScore,
  estimateDbh,
  heightClass,
  DEFAULT_HEIGHT_CLASSES,
  DBH_NOT_RELIABLE,
} from "../src/lib/geo/forest.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function makeGrid(width, height, fn, { cellSize = 0.25, originX = 0, epsg = 32643 } = {}) {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) data[row * width + col] = fn(col, row);
  }
  return new Grid({
    width, height, cellSize, originX, originY: height * cellSize, data, nodata: -99999, epsg,
  });
}

/** A cone in world coordinates, apex at (apexX, apexY), peak height H, base radius R. */
function coneAt(apexX, apexY, H, R) {
  return (x, y) => {
    const d = Math.hypot(x - apexX, y - apexY);
    return d >= R ? 0 : H * (1 - d / R);
  };
}

// ---------------------------------------------------------------------------
console.log("\ncrownMetrics on a known square, where every answer is arithmetic");
{
  // A 4 x 4 m square. Side 4, so: area 16, perimeter 16, max diameter the
  // diagonal (4*sqrt2), min diameter the side itself (a square's narrowest
  // calliper width is flush with a side, never the diagonal), avg diameter
  // the equivalent-circle figure.
  const ring = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const m = crownMetrics({ rings: [ring] });
  check("area is exactly 16 m2", near(m.area, 16, 1e-9), `${m.area}`);
  check("perimeter is exactly 16 m", near(m.perimeter, 16, 1e-9), `${m.perimeter}`);
  check("max diameter is the diagonal, 4*sqrt(2)", near(m.maxDiameter, 4 * Math.SQRT2, 1e-9), `${m.maxDiameter}`);
  check("min diameter is the side length, 4", near(m.minDiameter, 4, 1e-9), `${m.minDiameter}`);
  check("avg (equivalent-circle) diameter is 2*sqrt(16/pi)",
    near(m.avgDiameter, 2 * Math.sqrt(16 / Math.PI), 1e-9), `${m.avgDiameter}`);
  check("the min-area bounding rectangle of a rectangle is itself, area 16",
    near(m.minAreaRectArea, 16, 1e-9), `${m.minAreaRectArea}`);
}

// ---------------------------------------------------------------------------
console.log("\nchmFrom on two grids that do not share an origin or a cell size");
{
  // Kotba's own situation: DSM and DTM are on different grids entirely. Both
  // uniform surfaces here so the expected difference is unambiguous however
  // they are sampled, which is exactly what makes this case checkable without
  // also depending on chmFrom's bilinear correctness at a boundary.
  const dsm = makeGrid(50, 50, () => 105, { cellSize: 0.157, originX: 1000 });
  const dtm = makeGrid(30, 30, () => 100, { cellSize: 0.241, originX: 1000.5 });
  const chm = chmFrom(dsm, dtm, { cellSize: 0.3 });
  const stats = chm.stats();
  check("misaligned uniform surfaces still difference to a uniform 5 m CHM",
    near(stats.min, 5, 1e-3) && near(stats.max, 5, 1e-3), `min ${stats.min}, max ${stats.max}`);
  check("the CHM covers most of the overlap, not a sliver",
    stats.validFraction > 0.5, `${(stats.validFraction * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
console.log("\nA single cone, where crown area and diameter are known in advance");
let coneApexX;
let coneApexY;
{
  const W = 80, H = 80;
  const dtm = makeGrid(W, H, () => 100);
  coneApexX = dtm.xOf(40);
  coneApexY = dtm.yOf(40);
  const PEAK = 10;
  const BASE_R = 5;
  const cone = coneAt(coneApexX, coneApexY, PEAK, BASE_R);
  const dsm = makeGrid(W, H, (col, row) => 100 + cone(dtm.xOf(col), dtm.yOf(row)));

  const chm = chmFrom(dsm, dtm, { cellSize: 0.25 });
  check("the apex cell reads the cone's own peak height, exactly",
    near(chm.get(40, 40), PEAK, 1e-3), `${chm.get(40, 40)}`);
  check("a cell outside the base radius reads zero, not negative",
    chm.get(5, 5) === 0);

  const box = {
    minX: coneApexX - (BASE_R + 1), maxX: coneApexX + (BASE_R + 1),
    minY: coneApexY - (BASE_R + 1), maxY: coneApexY + (BASE_R + 1),
    boxId: 1, score: 0.9,
  };
  const segment = crownFromBox(box, chm, { padRadius: 2, thresholdFraction: 0.4, minHeight: 2, maxCrownRadius: 6 });
  check("a crown was found and nothing was rejected", segment && segment.rejected === null,
    segment?.rejected ?? "null segment");
  check("the apex the engine finds is the cell the cone peaks at",
    segment.apex.col === 40 && segment.apex.row === 40, `${segment.apex.col},${segment.apex.row}`);
  check("apex height matches the cone's peak", near(segment.apexHeight, PEAK, 1e-3), `${segment.apexHeight}`);
  check("threshold is 40% of the apex (above the 2 m floor)",
    near(segment.threshold, PEAK * 0.4, 1e-6), `${segment.threshold}`);

  // Threshold 4 m on a cone of peak 10 m and base radius 5 m crosses at
  // radius 0.6*5 = 3 m, so the expected disc has area pi*9 and diameter 6.
  // Grid discretisation of a circle at 0.25 m cells costs a ring of area
  // roughly perimeter*cellSize/2, so the tolerance is generous on purpose.
  const metrics = crownMetrics(segment.polygon);
  const expectedArea = Math.PI * 3 * 3;
  const expectedDiameter = 6;
  check(`crown area is close to the cone's own geometry (${expectedArea.toFixed(1)} m2)`,
    near(metrics.area, expectedArea, expectedArea * 0.25), `got ${metrics.area.toFixed(2)}`);
  check("max and min diameter are both close to 6 m, because a cone's crown is round",
    near(metrics.maxDiameter, expectedDiameter, 1.5) && near(metrics.minDiameter, expectedDiameter, 1.5),
    `max ${metrics.maxDiameter.toFixed(2)}, min ${metrics.minDiameter.toFixed(2)}`);
  check("min and max diameter stay close to each other on a round crown, unlike a rectangle",
    metrics.minDiameter / metrics.maxDiameter > 0.75,
    `ratio ${(metrics.minDiameter / metrics.maxDiameter).toFixed(3)}`);

  const combined = { ...segment, area: metrics.area, minAreaRectArea: metrics.minAreaRectArea };
  const rejection = rejectNonTree(combined, chm);
  check("a cone is not flagged as a structure", rejection.isStructure === false);
  check("flatness is low — a cone's own foliage is not flat",
    rejection.discriminators.flatness < 0.5, `${rejection.discriminators.flatness}`);
  check("rectangularity sits near pi/4 for a round crown, well under the reject bar",
    rejection.discriminators.rectangularity < 0.85, `${rejection.discriminators.rectangularity}`);
  check("apex prominence is clearly positive — the apex stands over its own rim",
    rejection.discriminators.apexProminence > 0.3, `${rejection.discriminators.apexProminence}`);
  check("radial decay is strongly positive — height falls away from the apex",
    rejection.discriminators.radialDecay > 0.8, `${rejection.discriminators.radialDecay}`);
  check("return porosity and greenness are honestly absent, not zero",
    rejection.discriminators.returnPorosity.available === false
      && rejection.discriminators.greenness.available === false);

  const confidence = confidenceScore(rejection.discriminators, 0.87);
  check("confidence with no point cloud and no ortho is computed from 5 of 7 inputs",
    confidence.evidenceCount === 5 && confidence.evidenceOf === 7, `${confidence.evidenceCount}/${confidence.evidenceOf}`);
  check("a clean cone with a confident model score scores itself reasonably high",
    confidence.score > 0.5, `${confidence.score}`);
}

// ---------------------------------------------------------------------------
console.log("\nA cone on a slope, where the DTM's own tilt must cancel out completely");
{
  const W = 80, H = 80;
  const SLOPE = 0.08; // metres per metre, rising to the east
  // A plain, unslanted grid purely to get xOf/yOf for placing the cone's
  // apex at a cell centre; its own values are never read.
  const base = makeGrid(W, H, () => 0);
  const apexX = base.xOf(40);
  const apexY = base.yOf(40);
  const PEAK = 10;
  const BASE_R = 5;
  const cone = coneAt(apexX, apexY, PEAK, BASE_R);
  const slopedDtm = makeGrid(W, H, (col, row) => 100 + SLOPE * col);
  const dsm = makeGrid(W, H, (col, row) => 100 + SLOPE * col + cone(base.xOf(col), base.yOf(row)));

  const chm = chmFrom(dsm, slopedDtm, { cellSize: 0.25 });
  check("the slope cancels: the apex still reads the cone's own peak height",
    near(chm.get(40, 40), PEAK, 1e-2), `${chm.get(40, 40)}`);
  check("a cell outside the base radius still reads zero despite the tilted ground",
    chm.get(5, 5) === 0);

  const box = {
    minX: apexX - (BASE_R + 1), maxX: apexX + (BASE_R + 1),
    minY: apexY - (BASE_R + 1), maxY: apexY + (BASE_R + 1),
    boxId: 2, score: 0.8,
  };
  const segment = crownFromBox(box, chm, { padRadius: 2, thresholdFraction: 0.4, minHeight: 2, maxCrownRadius: 6 });
  check("a crown is still found on sloped ground", segment && segment.rejected === null);
  const metrics = crownMetrics(segment.polygon);
  check("crown area on the slope matches the flat-ground case within discretisation noise",
    near(metrics.area, Math.PI * 9, Math.PI * 9 * 0.25), `${metrics.area.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log("\nTwo overlapping cones, where the crowns must stay separate");
{
  const W = 100, H = 60;
  const base = makeGrid(W, H, () => 0);
  const apex1 = { col: 30, row: 30 };
  const apex2 = { col: 52, row: 30 }; // 22 cells = 5.5 m away at 0.25 m cells
  const x1 = base.xOf(apex1.col), y1 = base.yOf(apex1.row);
  const x2 = base.xOf(apex2.col), y2 = base.yOf(apex2.row);
  const H1 = 10, H2 = 7, R = 4; // base radius 4 m: the two 4 m-radius discs do overlap at 5.5 m apart
  const cone1 = coneAt(x1, y1, H1, R);
  const cone2 = coneAt(x2, y2, H2, R);
  const dtm = makeGrid(W, H, () => 100);
  const dsm = makeGrid(W, H, (col, row) => {
    const x = base.xOf(col), y = base.yOf(row);
    return 100 + Math.max(cone1(x, y), cone2(x, y));
  });
  const chm = chmFrom(dsm, dtm, { cellSize: 0.25 });

  // The radius fence (2.5 m, well under half the 5.5 m separation) is what
  // guarantees separation here even though the two discs geometrically touch.
  const options = { padRadius: 1.5, thresholdFraction: 0.4, minHeight: 2, maxCrownRadius: 2.5 };
  const box1 = { minX: x1 - 3, maxX: x1 + 1, minY: y1 - 3, maxY: y1 + 3, boxId: 10 };
  const box2 = { minX: x2 - 1, maxX: x2 + 3, minY: y2 - 3, maxY: y2 + 3, boxId: 11 };
  const seg1 = crownFromBox(box1, chm, options);
  const seg2 = crownFromBox(box2, chm, options);

  check("box 1 finds its own apex, not the taller neighbour's",
    seg1 && seg1.apex.col === apex1.col && seg1.apex.row === apex1.row, `${seg1?.apex.col},${seg1?.apex.row}`);
  check("box 2 finds its own apex, not the shorter neighbour's",
    seg2 && seg2.apex.col === apex2.col && seg2.apex.row === apex2.row, `${seg2?.apex.col},${seg2?.apex.row}`);
  check("apex heights are each cone's own peak, not merged or averaged",
    near(seg1.apexHeight, H1, 0.5) && near(seg2.apexHeight, H2, 0.5),
    `${seg1.apexHeight.toFixed(2)}, ${seg2.apexHeight.toFixed(2)}`);

  const cells1 = new Set(seg1.cells.map((c) => `${c.col},${c.row}`));
  const cells2 = new Set(seg2.cells.map((c) => `${c.col},${c.row}`));
  check("crown 1's cells never include crown 2's apex",
    !cells1.has(`${apex2.col},${apex2.row}`));
  check("crown 2's cells never include crown 1's apex",
    !cells2.has(`${apex1.col},${apex1.row}`));
  let overlap = 0;
  for (const key of cells1) if (cells2.has(key)) overlap += 1;
  check("the two crowns share no cells at all", overlap === 0, `${overlap} shared`);
}

// ---------------------------------------------------------------------------
console.log("\nA flat roof, which flatness and rectangularity together must catch");
{
  const W = 60, H = 40;
  const dtm = makeGrid(W, H, () => 100);
  const ROOF = 5;
  // A solid rectangular block, 20 x 14 cells (5 m x 3.5 m), elsewhere bare
  // ground at the same elevation as the DTM (CHM zero, not nodata).
  const inRoof = (col, row) => col >= 15 && col < 35 && row >= 10 && row < 24;
  const dsm = makeGrid(W, H, (col, row) => 100 + (inRoof(col, row) ? ROOF : 0));
  const chm = chmFrom(dsm, dtm, { cellSize: 0.25 });

  const box = { minX: dtm.xOf(15) - 1, maxX: dtm.xOf(34) + 1, minY: dtm.yOf(23) - 1, maxY: dtm.yOf(10) + 1, boxId: 20 };
  const segment = crownFromBox(box, chm, { padRadius: 1, thresholdFraction: 0.4, minHeight: 2, maxCrownRadius: 20 });
  check("a segment is found over the roof", segment && segment.rejected === null);

  const metrics = crownMetrics(segment.polygon);
  const expectedArea = 20 * 14 * 0.25 * 0.25;
  check(`roof area matches the block exactly, ${expectedArea} m2`,
    near(metrics.area, expectedArea, 1e-6), `${metrics.area}`);
  check("a solid axis-aligned block's rectangularity is (numerically) 1",
    near(metrics.area / metrics.minAreaRectArea, 1, 1e-6), `${metrics.area / metrics.minAreaRectArea}`);

  const combined = { ...segment, area: metrics.area, minAreaRectArea: metrics.minAreaRectArea };
  const rejection = rejectNonTree(combined, chm);
  check("flatness is exactly 1 — a flat roof has no relief at all",
    rejection.discriminators.flatness === 1, `${rejection.discriminators.flatness}`);
  check("rectangularity clears the reject bar", rejection.discriminators.rectangularity >= 0.85,
    `${rejection.discriminators.rectangularity}`);
  check("the roof is flagged and dropped as a structure, not scored as a low-confidence tree",
    rejection.isStructure === true && rejection.reason === "flat_and_rectangular");
}

// ---------------------------------------------------------------------------
console.log("\nDBH: insufficient angular spread must refuse, never guess");
{
  const cx = 10, cy = 20, r = 0.15;
  const arcPoints = [];
  for (let i = 0; i < 15; i += 1) {
    const deg = (i / 14) * 80; // 0 to 80 degrees: well under the 180 degree bar
    const rad = (deg * Math.PI) / 180;
    arcPoints.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
  }
  const result = estimateDbh(arcPoints);
  check("a one-sided arc is refused, not fit", result.dbh === DBH_NOT_RELIABLE, JSON.stringify(result));
  check("the refusal names the angular spread", /angular spread/.test(result.reason), result.reason);

  const tooFew = [[cx, cy], [cx + 0.1, cy], [cx, cy + 0.1]];
  const fewResult = estimateDbh(tooFew);
  check("fewer than 12 points is refused before any geometry runs",
    fewResult.dbh === DBH_NOT_RELIABLE && /fewer than/.test(fewResult.reason), fewResult.reason);
}

console.log("\nDBH: a full, clean ring of points must fit almost exactly");
{
  const cx = 10, cy = 20, r = 0.15; // 15 cm radius -> 30 cm DBH, a plausible stem
  const points = [];
  for (let i = 0; i < 24; i += 1) {
    const rad = (i / 24) * 2 * Math.PI;
    points.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
  }
  const result = estimateDbh(points);
  check("a full ring of points fits, rather than being refused",
    typeof result.dbh === "number", JSON.stringify(result));
  check("recovered DBH matches the true 30 cm to within a millimetre",
    near(result.dbh, 2 * r, 0.001), `${result.dbh}`);
  check("RMS residual on an exact ring is essentially zero",
    result.rmsM < 0.001, `${result.rmsM}`);
  check("girth is pi times the recovered DBH, to display precision",
    near(result.girth, Math.PI * result.dbh, 1e-3), `${result.girth}`);
}

console.log("\nDBH: the same ring, at real UTM coordinates rather than near the origin");
{
  // Every point above sat within about 10 cm of (0,0). Real stem-band points
  // never do -- they arrive as UTM eastings and northings, six or seven
  // digits before the decimal point, describing a circle a few centimetres
  // across. A circle fit that centres its arithmetic on the points' own mean
  // handles both scales identically; one that does not can lose the entire
  // signal to floating point cancellation while still returning cleanly
  // (never throwing, never NaN) with a wrong, misleadingly confident answer
  // -- or, as this fixture originally caught, a spurious "collinear" refusal
  // on sixteen points that plainly are not. Caught once already against
  // Kotba's real DTM during this engine's own build; kept here so it cannot
  // regress silently.
  const cx = 368048.335, cy = 2305371.949, r = 0.12;
  const points = [];
  for (let i = 0; i < 16; i += 1) {
    const rad = (i / 16) * 2 * Math.PI;
    points.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
  }
  const result = estimateDbh(points);
  check("a clean ring at real UTM magnitude still fits, not refused for false collinearity",
    typeof result.dbh === "number", JSON.stringify(result));
  check("recovered DBH matches the true 24 cm to within a millimetre",
    near(result.dbh, 2 * r, 0.001), `${result.dbh}`);
  check("the recovered centre lands back on the true UTM position, not the origin",
    near(result.centre[0], cx, 0.01) && near(result.centre[1], cy, 0.01),
    `${result.centre}`);
}

// ---------------------------------------------------------------------------
console.log("\nHeight classes, Malhar's ten default bands");
{
  check("1.5 m falls in the first band", heightClass(1.5) === DEFAULT_HEIGHT_CLASSES[0]);
  check("exactly 2 m falls in the SECOND band — half-open at the top",
    heightClass(2) === DEFAULT_HEIGHT_CLASSES[1]);
  check("16 m falls in the open-ended '>15 m' band",
    heightClass(16).label === ">15 m");
  check("a negative height matches no band", heightClass(-1) === null);
  check("NaN matches no band", heightClass(NaN) === null);

  const custom = [{ label: "short", min: 0, max: 5 }, { label: "tall", min: 5, max: 50 }];
  check("custom classDefs are used as given, not the hardcoded default",
    heightClass(3, custom).label === "short" && heightClass(30, custom).label === "tall");
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
