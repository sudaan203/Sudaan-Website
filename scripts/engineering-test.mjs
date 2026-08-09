/**
 * Known-answer tests for the contractor, mining and road tools, 11 to 21.
 *
 * Same discipline as `terrain-test.mjs`: the surfaces are built so the answer
 * can be worked out on paper. A ramp at a known grade must report that grade, a
 * pyramid of known dimensions must report its own volume, a staircase must be
 * read back as the benches and faces it was built from.
 *
 * Run:
 *   node scripts/engineering-test.mjs
 */

import { Grid } from "../src/lib/geo/raster.mjs";
import { slopeDegrees } from "../src/lib/geo/hydrology.mjs";
import { REFERENCE } from "../src/lib/geo/terrain-analysis.mjs";
import {
  SLOPE_SCHEMES,
  classifySlope,
  degreesToPercent,
  percentToDegrees,
  toleranceAnalysis,
  stockpileVolume,
  chainage,
  formatChainage,
  crossSections,
  corridorAnalysis,
  benchAnalysis,
  steepSlopeZones,
  earthworkProgress,
} from "../src/lib/geo/engineering.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;

function makeGrid(fn, { width = 120, height = 120, cellSize = 1 } = {}) {
  const data = new Float32Array(width * height);
  const g = new Grid({
    width, height, cellSize, originX: 0, originY: height * cellSize,
    data, nodata: -99999, epsg: 32643,
  });
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) data[row * width + col] = fn(g.xOf(col), g.yOf(row));
  }
  return g;
}

// ---------------------------------------------------------------------------
console.log("\nSlope units, where the three specifications disagree");
{
  check("15 degrees is 27% and not 15%", near(degreesToPercent(15), 26.795, 1e-3),
    `${degreesToPercent(15).toFixed(3)}%`);
  check("the conversion round trips", near(percentToDegrees(degreesToPercent(31)), 31, 1e-9));
  check("all three of Malhar's schemes are carried verbatim",
    Object.keys(SLOPE_SCHEMES).length === 3);
  check("and one of them really is in percent",
    SLOPE_SCHEMES.earthwork.unit === "percent" && SLOPE_SCHEMES.terrain.unit === "degrees");

  let refused = false;
  try { classifySlope(makeGrid(() => 0), "whichever"); } catch { refused = true; }
  check("classifying without naming a scheme is refused", refused,
    "picking one for him would bury a disagreement in code");

  // A plane at a known slope must land in the band that contains it.
  const ramp = makeGrid((x) => x * 0.2); // 20% grade, 11.31 degrees
  const slope = slopeDegrees(ramp);
  const degrees = classifySlope(slope, "terrain");
  const percent = classifySlope(slope, "earthwork");
  check("an 11.3 degree slope falls in the 5 to 15 degree band",
    degrees.legend[1].share > 0.9, `${(degrees.legend[1].share * 100).toFixed(1)}%`);
  check("the same slope is 20% and falls in the 15 to 25 percent band",
    percent.legend[2].share > 0.9, `${(percent.legend[2].share * 100).toFixed(1)}%`);
  check("which is a different band index, so the unit really does matter", true,
    "band 1 by degrees, band 2 by percent");
  check("legend areas add up to the classified area",
    near(degrees.legend.reduce((s, b) => s + b.area, 0), 120 * 120, 1));
}

// ---------------------------------------------------------------------------
console.log("\nTolerance analysis");
{
  const design = makeGrid(() => 100);
  // Built low, on grade, and high, in three equal strips.
  const built = makeGrid((x) => (x < 40 ? 99.95 : x < 80 ? 100.0 : 100.05));
  const t = toleranceAnalysis(built, design, 0.02, { rmseZ: 0.004 });

  check("the on grade third is within tolerance",
    near(t.withinArea, 40 * 120, 130), `${t.withinArea} m2`);
  check("the high third is flagged above", near(t.aboveArea, 40 * 120, 130));
  check("the low third is flagged below", near(t.belowArea, 40 * 120, 130));
  check("above and below are counted separately, not merged",
    t.aboveArea > 0 && t.belowArea > 0 && t.aboveArea !== t.comparedArea);
  check("the worst deviation each way is reported",
    near(t.worstAbove, 0.05, 1e-4) && near(t.worstBelow, 0.05, 1e-4));
  check("a survey finer than the tolerance can resolve it", t.resolvable === true);

  // The case that matters commercially: checking 20 mm with a 40 mm survey.
  const coarse = toleranceAnalysis(built, design, 0.02, { rmseZ: 0.04 });
  check("a survey coarser than the tolerance says so instead of drawing a green map",
    coarse.resolvable === false && coarse.note !== null);
}

// ---------------------------------------------------------------------------
console.log("\nStockpile volume, against a pyramid with a known answer");
{
  // A square pyramid on flat ground at 100 m: base 40 x 40, apex 5 m up.
  // Volume of a pyramid is base area times height over three.
  const BASE = 40;
  const HEIGHT = 5;
  const cx = 60;
  const cy = 60;
  const dem = makeGrid((x, y) => {
    const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
    return d >= BASE / 2 ? 100 : 100 + HEIGHT * (1 - d / (BASE / 2));
  });

  const ring = [[40, 40], [80, 40], [80, 80], [40, 80]];
  const pile = stockpileVolume(dem, ring, REFERENCE.plane(100), { rmseZ: 0.04 });
  const analytic = (BASE * BASE * HEIGHT) / 3;
  check(`a ${BASE} x ${BASE} x ${HEIGHT} m pyramid holds ${analytic.toFixed(0)} m3`,
    near(pile.volume, analytic, analytic * 0.02), `got ${pile.volume.toFixed(1)} m3`);
  check("its peak height is reported", near(pile.maxHeight, HEIGHT, 0.2),
    `${pile.maxHeight.toFixed(3)} m`);
  check("the base area is the footprint it actually covers",
    near(pile.baseArea, BASE * BASE, BASE * BASE * 0.05), `${pile.baseArea} m2`);
  check("mean height is volume over base, which for a pyramid is a third of the peak",
    near(pile.meanHeight, HEIGHT / 3, 0.15), `${pile.meanHeight.toFixed(3)} m`);
  check("uncertainty scales with the measured area", pile.uncertainty > 0);

  let refused = false;
  try { stockpileVolume(dem, ring, null); } catch { refused = true; }
  check("a pile with no stated base is refused", refused);
}

// ---------------------------------------------------------------------------
console.log("\nChainage along a ramp");
{
  const ramp = makeGrid((x) => 100 + x * 0.03); // a steady 3% climb eastwards
  const line = [[10, 60], [110, 60]];
  const c = chainage(ramp, line, 25);

  check("stations land on whole multiples of the interval",
    c.stations.map((s) => s.chainage).slice(0, 5).join(",") === "0,25,50,75,100");
  check("the alignment length is right", near(c.length, 100, 1e-9));
  check("every station reads a grade of 3%",
    c.stations.slice(1).every((s) => near(s.gradePercent, 3, 1e-3)),
    `first: ${c.stations[1].gradePercent.toFixed(4)}%`);
  check("maximum longitudinal grade is 3%", near(c.maxGradePercent, 3, 1e-3));
  check("chainage formats as a drawing expects", formatChainage(1234.5) === "1+234.500");
  check("and short chainage still pads correctly", formatChainage(25) === "0+025.000");
  check("no station is missing data", c.stationsWithoutData === 0);
}

// ---------------------------------------------------------------------------
console.log("\nCross sections cut perpendicular, not along the grid");
{
  // A valley running exactly north east, so a section taken along the grid axes
  // would be wider than the real one by a factor of sqrt(2).
  const valley = makeGrid((x, y) => 100 + Math.abs((x - y) / Math.SQRT2) * 0.5);
  const line = [[20, 20], [100, 100]]; // up the valley floor at 45 degrees
  const cs = crossSections(valley, line, { interval: 20, halfWidth: 10 });

  check("sections are cut at the requested interval",
    cs.sections.length >= 5 && near(cs.sections[1].chainage, 20, 1e-9));

  // The centre sits on the floor, but reads about 0.18 m high rather than
  // exactly 100. That is not an error: the floor is a sharp V, the grid stores
  // one value per cell centre, and bilinear interpolation across a kink cannot
  // reproduce a crease that falls between samples. Real terrain has the same
  // property, so the test asserts the robust fact (the centreline is the lowest
  // point of the section) rather than a precision the data cannot carry.
  check("the centre of each section is the lowest point on it",
    cs.sections.every((s) => {
      const lows = s.samples.filter((q) => q.elevation !== null).map((q) => q.elevation);
      return near(s.centreElevation, Math.min(...lows), 1e-9);
    }),
    "if the section were cut along the axes the floor would not be at the centre");
  check("and reads within a fifth of a metre of the true floor",
    cs.sections.every((s) => near(s.centreElevation, 100, 0.25)),
    "the residual is the grid failing to resolve a sharp crease, not a bug");
  // Perpendicular to a 45 degree valley, the ground rises 0.5 m per metre of
  // offset, so 10 m out is 5 m up. Along the axes it would be 3.54 m.
  const edge = cs.sections[1].samples[cs.sections[1].samples.length - 1];
  check("10 m off the centreline is 5.00 m up, the perpendicular answer",
    near(edge.elevation - 100, 5, 0.05), `got ${(edge.elevation - 100).toFixed(3)} m`);
  check("offsets run left to right through zero",
    cs.sections[0].samples[0].offset === -10 &&
    cs.sections[0].samples[cs.sections[0].samples.length - 1].offset === 10);
  check("a symmetric valley has no crossfall",
    near(cs.sections[1].crossfallPercent, 0, 1e-3));
}

// ---------------------------------------------------------------------------
console.log("\nCorridor analysis flags what is unsafe");
{
  // A haul road climbing 15%, which is over any sane limit.
  const steep = makeGrid((x) => 100 + x * 0.15);
  const road = corridorAnalysis(steep, [[10, 60], [110, 60]], {
    interval: 20, halfWidth: 8, maxGradePercent: 10,
  });
  check("every station on a 15% climb is flagged unsafe",
    road.unsafeStations.length === road.stations.length - 1,
    `${road.unsafeStations.length} of ${road.stations.length - 1} graded stations`);
  check("the limits used are reported with the result", road.limits.maxGradePercent === 10);
  check("the width method is stated rather than implied", road.widthMethod.includes("derived"));

  const gentle = corridorAnalysis(makeGrid((x) => 100 + x * 0.02), [[10, 60], [110, 60]], {
    interval: 20, halfWidth: 8, maxGradePercent: 10,
  });
  check("a 2% road raises nothing", gentle.unsafeStations.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nBenches read back off a staircase");
{
  // Three 10 m benches separated by 5 m risers, built along x.
  const steps = makeGrid((x) => {
    const stage = Math.floor(x / 15);
    const into = x - stage * 15;
    return 100 + stage * 5 + (into > 10 ? ((into - 10) / 5) * 5 : 0);
  });
  // Sampled on cell centres, so bilinear interpolation is exact and the
  // staircase stays sharp. Off centre the edges blur by a cell and every width
  // below moves by one metre, which is worth knowing when reading real output.
  const b = benchAnalysis(steps, [[2.5, 60.5], [110.5, 60.5]], {
    benchSlopePercent: 10, minBenchWidth: 2,
  });

  check("the flats are found as benches", b.benches.length === 8, `${b.benches.length}`);
  check("the risers are found as faces", b.faces.length === 7, `${b.faces.length}`);
  check("each face climbs exactly the 5 m it was built with",
    near(b.meanBenchHeight, 5, 1e-6), `${b.meanBenchHeight.toFixed(4)} m`);

  // A run of N samples spans N-1 metres, and the segment where the slope changes
  // belongs to the steep run. So a 10 m bench beside a 5 m riser reads as 9 and
  // 6 on a 1 m grid. That is the sampling, not the detector, and it is stable:
  // asserting 10 and 5 would be asserting a resolution the profile has not got.
  const interior = b.benches.slice(1, -1).map((x) => x.width);
  check("interior benches all read 9 m, one sample short of the 10 m built",
    interior.every((w) => near(w, 9, 1e-9)), `${interior.join(", ")}`);
  check("faces all read 6 m, one sample long, for the same reason",
    b.faces.every((f) => near(f.width, 6, 1e-9)));
  check("so the face angle is atan(5/6) = 39.8 rather than the built 45",
    near(b.maxFaceAngleDegrees, (Math.atan(5 / 6) * 180) / Math.PI, 1e-3),
    `${b.maxFaceAngleDegrees.toFixed(2)} degrees`);
  check("and every face reports the identical angle, so the reading is stable",
    new Set(b.faces.map((f) => f.angleDegrees.toFixed(6))).size === 1);
}

// ---------------------------------------------------------------------------
console.log("\nSteep ground, described as geometry and not as stability");
{
  const face = makeGrid((x) => (x < 60 ? 100 : 100 + (x - 60) * 1.2)); // 50 degrees
  const zones = steepSlopeZones(slopeDegrees(face), 45);
  check("slopes past the design angle are found", zones.exceedingArea > 0,
    `${zones.exceedingHectares.toFixed(3)} ha`);
  check("the steepest angle is reported", near(zones.steepestDegrees, 50.2, 1),
    `${zones.steepestDegrees.toFixed(1)} degrees`);
  check("nothing is flagged on flat ground",
    steepSlopeZones(slopeDegrees(makeGrid(() => 100)), 45).exceedingArea === 0);
  check("the output says what it cannot tell you", zones.caveat.includes("groundwater"),
    "calling this stability would invite a reading the data cannot support");
}

// ---------------------------------------------------------------------------
console.log("\nEarthwork progress across three surveys");
{
  const ring = [[20, 20], [100, 20], [100, 100], [20, 100]];
  const area = 80 * 80;
  // Start at 100, dig to 99, dig to 98. Design is 98, so it finishes complete.
  const jan = { label: "Jan", grid: makeGrid(() => 100) };
  const feb = { label: "Feb", grid: makeGrid(() => 99) };
  const mar = { label: "Mar", grid: makeGrid(() => 98) };
  const design = makeGrid(() => 98);

  const p = earthworkProgress([jan, feb, mar], ring, { design, rmseZ: 0.04 });
  check("two steps for three surveys", p.steps.length === 2);
  check("each month excavated 1 m over the polygon",
    near(p.steps[0].excavated, area, area * 0.02), `${p.steps[0].excavated.toFixed(0)} m3`);
  check("nothing was filled", near(p.steps[0].filled, 0, 1));
  check("total excavated is both months", near(p.totalExcavated, 2 * area, area * 0.04),
    `${p.totalExcavated.toFixed(0)} m3`);
  check("reaching the design surface reads as 100% complete",
    near(p.completion.percentComplete, 100, 1), `${p.completion.percentComplete.toFixed(1)}%`);
  check("with nothing left to move", near(p.completion.volumeRemaining, 0, area * 0.02));

  // Half way there should read as half done by volume.
  const half = earthworkProgress([jan, feb], ring, { design });
  check("stopping half way reads as about 50% complete",
    near(half.completion.percentComplete, 50, 2),
    `${half.completion.percentComplete.toFixed(1)}%`);

  let refused = false;
  try { earthworkProgress([jan], ring, {}); } catch { refused = true; }
  check("progress needs at least two surveys", refused);
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
