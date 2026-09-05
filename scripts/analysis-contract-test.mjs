/**
 * The measurement pipeline, from a click on the map to a number in the panel,
 * checked against real survey data without needing a server or a database.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/analysis-contract-test.mjs
 *
 * ## What this covers that the other suites do not
 *
 * `terrain-test.mjs` proves the arithmetic on synthetic surfaces where the
 * answer is known analytically. `analysis-core-test.mjs` proves the browser
 * client's sequencing. Neither touches the join between them: a click arrives as
 * **longitude and latitude**, and every number the client is sold on is computed
 * in **UTM metres**. That projection step is the one place where a mistake
 * produces a number that is wrong by a plausible-looking amount rather than an
 * error — square degrees, a transposed axis, the wrong zone — and it is exactly
 * where `docs/portal-map-architecture.md` 6b says the accuracy work lives.
 *
 * So this drives the same sequence the route drives, on the same file the route
 * opens, and anchors it to values computed independently in projected metres.
 *
 * It deliberately does **not** cover authorisation or the HTTP layer. That is
 * `analysis-api-test.mjs`, which needs the portal database.
 *
 * ## Which survey it runs against
 *
 *   SITE=aektanagar-survey node scripts/analysis-contract-test.mjs
 *
 * Nothing below is anchored to a place. It used to be: a latitude range that
 * said "Gujarat" and an elevation range of 300-450 m, both true of Kotba and of
 * nothing else. Aektanagar sits at 60 m and Kiru at 1,491 m in Jammu, so those
 * two checks failed on two thirds of the published surveys while asserting
 * nothing about the product. They are now derived from the raster.
 *
 * ## Why the grid is a window
 *
 * Ground truth here is a **windowed** read of the middle of the survey rather
 * than the whole file, and that is what lets this suite run on Kiru at all: its
 * DTM is 2.3 GB and `readGeoTiff` cannot open it — `readFileSync` throws
 * `ERR_FS_FILE_TOO_LARGE` past 2 GiB, before any of this project's code is
 * reached. A window is a real Grid carrying its own origin, so every function
 * in `terrain-analysis.mjs` treats it as a complete raster and every assertion
 * below means exactly what it meant before. On Kotba the window clamps to the
 * whole survey and nothing changes at all.
 */

import {
  REFERENCE,
  cutFill,
  polygonArea,
  polygonStats,
  profile,
  spotLevel,
} from "../src/lib/geo/terrain-analysis.mjs";
import { lonLatToUtm, utmToLonLat } from "../src/lib/geo/projection.mjs";
import { describeSurvey, openSurvey } from "./lib/survey.mjs";

const SITE = process.env.SITE ?? "kotba-survey";

/**
 * Half-width of the ground truth window, in metres rather than cells.
 *
 * The exception that proves the rule. Everywhere a *cost* or a *cell budget* is
 * under test, size in cells — see `boxOfCells` in `analysis-api-test.mjs`. Here
 * the quantities under test are metric by construction: a 100 m square is one
 * hectare, and the cut-and-fill identity below is "raising a plane one metre
 * over one hectare moves 10,000 m³". Those are the same statements on every
 * survey only if the polygon is the same size in metres.
 *
 * 200 m leaves room for the 100 m square, the 200 m profile, and the checks
 * that deliberately run 75 m off the edge of the grid.
 */
const WINDOW_HALF_M = 200;

let failures = 0;
let checks = 0;

function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function near(label, actual, expected, tolerance, unit = "") {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  check(label, ok, ok ? "" : `got ${actual}, want ${expected} ±${tolerance}${unit}`);
}

/**
 * The route's own coordinate contract, quoted rather than paraphrased: geometry
 * may arrive as lon/lat or as UTM, the caller must say which, and anything in
 * lon/lat is projected into the survey's zone once, here, before it reaches the
 * analysis. See `src/app/api/portal/sites/[siteSlug]/analysis/route.ts`.
 */
function toProjected(geometry, crs, zone, northern) {
  if (crs === "utm") return geometry;
  if (crs !== "lonlat") throw new Error(`crs must be "lonlat" or "utm", not "${crs}"`);
  return geometry.map(([lon, lat]) => lonLatToUtm(lon, lat, zone, northern));
}

const survey = await openSurvey(SITE, "dtm");
const { zone, northern, centreE, centreN } = survey;

/*
 * The ground truth grid. A window, not the file — see the header comment.
 *
 * Everything below reads `grid.width` and `grid.originX` rather than the
 * survey's, so "the edge of the grid" means the edge of this window. That is
 * the same assertion about the same code, made over less ground.
 */
const grid = await survey.centreWindowMetres(WINDOW_HALF_M);
const width = grid.width ?? grid.ncols;
const height = grid.height ?? grid.nrows;

/**
 * A design level roughly at this survey's own ground, for the checks that need
 * *a* plane and do not care which.
 *
 * This was the literal 360, which is Kotba's plateau. On Aektanagar it sits
 * 300 m in the air and on Kiru 1,100 m underground. The assertions it feeds are
 * about area rather than volume, so they survived — but a constant that is
 * silently 1.1 km wrong on a published survey is the exact shape of the bug
 * this exercise is hunting, and it costs nothing to derive.
 */
const gridStats = grid.stats();
const datum = Math.round(gridStats.mean);

console.log(`\n${describeSurvey(survey)}`);
console.log(`  ground truth window ${width} x ${height} cells (${2 * WINDOW_HALF_M} m square, clamped to the survey)`);
console.log(`  design level for the reference checks: ${datum} m`);

console.log("\nThe projection round trip, which everything else rests on");
{
  // Every coordinate the browser sends has been through this both ways. If it
  // does not close, no number downstream means anything.
  const [lon, lat] = utmToLonLat(centreE, centreN, zone, northern);
  const [backE, backN] = lonLatToUtm(lon, lat, zone, northern);
  near("easting survives a round trip", backE, centreE, 0.001, " m");
  near("northing survives a round trip", backN, centreN, 0.001, " m");

  /*
   * What a transposed axis or the wrong zone actually looks like, stated
   * without naming a place.
   *
   * This read "the survey lands in Gujarat" against a hardcoded latitude band,
   * which was true of Kotba and of no other published survey: Aektanagar is
   * just north of the band and Kiru is 12 degrees away in Jammu. It failed on
   * both while asserting nothing about the projection.
   *
   * A UTM zone is a 6 degree band of longitude with a known centre, and the
   * raster declares which one it is in its own header. So the survey must land
   * inside the band its EPSG code claims, and within half a degree of latitude
   * of where the northing says it is. Swap the axes, or read zone 43 as zone 44,
   * and the point leaves the band. That catches the real failure on every
   * survey rather than on one.
   */
  const centralMeridian = 6 * zone - 183;
  check(
    "the survey lands inside the UTM band its own header declares",
    Math.abs(lon - centralMeridian) < 3.1,
    `${lon.toFixed(4)} E, zone ${zone} runs ${(centralMeridian - 3).toFixed(0)}..${(centralMeridian + 3).toFixed(0)}`,
  );
  check(
    "and on the hemisphere the northing says it is on",
    northern === (lat > 0),
    `${lat.toFixed(4)} N, header says ${northern ? "northern" : "southern"}`,
  );
}

console.log("\nTool 1, spot level: a click in degrees, an answer in metres");
{
  const truth = spotLevel(grid, centreE, centreN);
  const [lon, lat] = utmToLonLat(centreE, centreN, zone, northern);
  // Exactly what `AnalysisClient.spot` sends: a one element array, crs lonlat.
  const [[x, y]] = toProjected([[lon, lat]], "lonlat", zone, northern);
  // A micrometre. The round trip through degrees is not bit exact, and the
  // survey it is describing is accurate to 4 cm, so anything at this scale is
  // arithmetic noise rather than a projection error. Tightening this to 1e-9
  // would only ever fail for reasons nobody should act on.
  near("a lon/lat click reads the same cell as the UTM coordinate", spotLevel(grid, x, y), truth, 1e-5, " m");

  /*
   * "A real elevation", without quoting one survey's range.
   *
   * This was `truth > 300 && truth < 450`, which is Kotba's plateau and nowhere
   * else: Aektanagar reads about 60 m and Kiru about 1,491 m, so the check
   * failed on both without saying anything true about either.
   *
   * The failure actually worth catching is a nodata sentinel being read as
   * ground — -32767 here, or -9999, or -3.4e38 — which is what turns a hole in
   * the survey into a crater in a volume. Bounding by what an elevation on this
   * planet can be catches every sentinel in one rule and is true of every
   * survey; `scripts/lib/geo.mjs` draws the same line for the same reason. The
   * second half is the sharper one: a spot level has to lie inside the range of
   * the ground it was read from.
   */
  check(
    "the level is an elevation rather than a nodata sentinel read as ground",
    truth > -500 && truth < 9000,
    `${truth.toFixed(3)} m`,
  );
  const around = polygonStats(grid, [
    [centreE - 5, centreN - 5],
    [centreE + 5, centreN - 5],
    [centreE + 5, centreN + 5],
    [centreE - 5, centreN + 5],
    [centreE - 5, centreN - 5],
  ]);
  check(
    "and sits inside the range of the ground immediately around it",
    truth >= around.min - 1e-6 && truth <= around.max + 1e-6,
    `${truth.toFixed(3)} m in ${around.min.toFixed(3)}..${around.max.toFixed(3)}`,
  );

  // Bilinear, not nearest neighbour. Half a cell off centre must move the answer
  // continuously; a nearest-neighbour read would return an identical value
  // across the whole cell, which is the bug this replaced.
  const half = grid.cellSize / 2;
  const a = spotLevel(grid, centreE, centreN);
  const b = spotLevel(grid, centreE + half, centreN);
  const c = spotLevel(grid, centreE + grid.cellSize, centreN);
  check(
    "sampling is interpolated, not stepped",
    a !== b && b !== c,
    `${a.toFixed(4)} / ${b.toFixed(4)} / ${c.toFixed(4)}`,
  );
  check(
    "a half cell step lands between its neighbours",
    (b >= Math.min(a, c) && b <= Math.max(a, c)),
    `${b.toFixed(4)} between ${a.toFixed(4)} and ${c.toFixed(4)}`,
  );
}

console.log("\nArea, where degrees would be catastrophic and plausible");
{
  const HALF = 50; // a 100 m square: exactly one hectare, by construction
  const ringUtm = [
    [centreE - HALF, centreN - HALF],
    [centreE + HALF, centreN - HALF],
    [centreE + HALF, centreN + HALF],
    [centreE - HALF, centreN + HALF],
    [centreE - HALF, centreN - HALF],
  ];
  const ringLonLat = ringUtm.map(([e, n]) => utmToLonLat(e, n, zone, northern));
  const projected = toProjected(ringLonLat, "lonlat", zone, northern);

  near("a 100 m square drawn in degrees comes back as one hectare", polygonArea(projected), 10000, 5, " m²");

  // The failure this guards against, stated as a number: the same ring measured
  // in raw degrees is about 8e-7 square degrees, which is not 10,000 of
  // anything. A UI that printed it would look like it was working.
  const inDegrees = polygonArea(ringLonLat);
  check(
    "the same ring measured in degrees is nothing like an area",
    inDegrees < 1e-4,
    `${inDegrees.toExponential(2)} square degrees`,
  );

  const stats = polygonStats(grid, projected);
  check("the hectare is fully inside the survey", stats.complete === true);
  check(
    "mean sits between min and max",
    stats.min < stats.mean && stats.mean < stats.max,
    `${stats.min.toFixed(2)} / ${stats.mean.toFixed(2)} / ${stats.max.toFixed(2)}`,
  );
  /*
   * The tolerance is derived from the sampler, because a flat 5 m² was a
   * cell-count assertion dressed up as an area.
   *
   * `cellCoverage` decides a boundary cell's share by testing a 4x4 lattice
   * inside it, so every cell the rim passes through carries a quantisation
   * error of up to a sixteenth of a cell. The rim crosses `perimeter / cellSize`
   * cells, so the total is proportional to `perimeter * cellSize` — which means
   * the honest tolerance is different on every survey and 5 m² was only ever
   * Kotba's. It is 20 cells there and 846 on Aektanagar's 7.7 cm grid, and on
   * Kiru the real discretisation gap is 10.5 m² and the check simply failed.
   *
   * A quarter of the boundary band leaves room for the quantisation to
   * accumulate one way without ever approaching the failure this is here to
   * catch: the same hectare measured in Web Mercator is about 1,500 m² out,
   * sixty times this bound on the coarsest survey.
   */
  const rimBand = (stats.perimeter * grid.cellSize) / 4;
  near("covered area matches the polygon area", stats.coveredArea, stats.area, rimBand, " m²");
}

console.log("\nTool 3, profile: chainage, sampling and gaps");
{
  const a = utmToLonLat(centreE - 100, centreN, zone, northern);
  const b = utmToLonLat(centreE + 100, centreN, zone, northern);
  const line = toProjected([a, b], "lonlat", zone, northern);
  const result = profile(grid, line, { spacing: grid.cellSize });

  near("a 200 m line measures 200 m", result.length, 200, 0.05, " m");
  /*
   * Derived, because "more than 700 samples" is a statement about Kotba's cell
   * size wearing the clothes of a statement about sampling. A 200 m line at one
   * sample per cell is 829 samples on Kotba, 2,602 on Aektanagar and 786 on
   * Kiru; a fixed floor either passes vacuously or fails for no reason.
   */
  const expectedSamples = 200 / grid.cellSize;
  check(
    "it samples at about one cell",
    Math.abs(result.points.length - expectedSamples) < expectedSamples * 0.02,
    `${result.points.length} samples, one per ${grid.cellSize.toFixed(4)} m cell is ~${expectedSamples.toFixed(0)}`,
  );
  check("chainage starts at zero", Math.abs(result.points[0].chainage) < 1e-9);
  near("chainage ends at the length", result.points.at(-1).chainage, result.length, 1e-6, " m");
  check(
    "chainage is monotonic",
    result.points.every((p, i) => i === 0 || p.chainage >= result.points[i - 1].chainage),
  );
  check(
    "end to end grade and steepest step are genuinely different numbers",
    Math.abs(result.gradePercent) <= result.maxSlopePercent + 1e-9,
    `grade ${result.gradePercent.toFixed(2)}%, steepest ${result.maxSlopePercent.toFixed(2)}%`,
  );
  // Climb and descent are walked separately so a hole in the survey does not
  // read as a cliff down and a cliff back up.
  check("climb and descent are both non negative", result.gain >= 0 && result.loss >= 0);
  near(
    "climb minus descent is the net change between the ends",
    result.gain - result.loss,
    result.points.at(-1).elevation - result.points[0].elevation,
    0.01,
    " m",
  );

  const coarse = profile(grid, line, { spacing: 5 });
  check("a coarser spacing really returns fewer samples", coarse.points.length < 50, `${coarse.points.length}`);
  near("and still measures the same line", coarse.length, result.length, 1e-9, " m");
}

console.log("\nTool 4, cut and fill: the one most likely to be quietly wrong");
{
  const HALF = 50;
  const ring = [
    [centreE - HALF, centreN - HALF],
    [centreE + HALF, centreN - HALF],
    [centreE + HALF, centreN + HALF],
    [centreE - HALF, centreN + HALF],
    [centreE - HALF, centreN - HALF],
  ];
  const stats = polygonStats(grid, ring);
  const rmseZ = 0.04;

  // Against a plane at the mean, cut and fill must both exist and roughly
  // balance. A wildly lopsided answer means the plane is not where we think.
  const atMean = cutFill(grid, ring, REFERENCE.plane(stats.mean), { rmseZ });
  check("cut is positive", atMean.cut > 0, `${atMean.cut.toFixed(0)} m³`);
  check("fill is positive", atMean.fill > 0, `${atMean.fill.toFixed(0)} m³`);
  near("net is cut minus fill", atMean.net, atMean.cut - atMean.fill, 1e-6, " m³");
  check(
    "against the mean, cut and fill are the same order of magnitude",
    Math.max(atMean.cut, atMean.fill) / Math.min(atMean.cut, atMean.fill) < 4,
    `cut ${atMean.cut.toFixed(0)} vs fill ${atMean.fill.toFixed(0)}`,
  );

  // The sign convention, pinned down. Raise the reference by a metre over a
  // hectare and exactly 10,000 m³ must move from cut to fill. This is the check
  // that catches an inverted sign, which is otherwise invisible: the magnitudes
  // stay believable and only the word changes.
  const up = cutFill(grid, ring, REFERENCE.plane(stats.mean + 1), { rmseZ });
  near(
    "raising the reference 1 m over 1 ha moves the net by 10,000 m³",
    atMean.net - up.net,
    10000,
    60,
    " m³",
  );
  check("raising the reference increases fill", up.fill > atMean.fill);
  check("raising the reference decreases cut", up.cut < atMean.cut);

  // A plane below everything is all cut, and the volume is then the mean height
  // above it times the area: a closed form to check against.
  const floor = REFERENCE.plane(stats.min - 10);
  const allCut = cutFill(grid, ring, floor, { rmseZ });
  near("a plane below the ground is entirely cut", allCut.fill, 0, 1e-6, " m³");
  near(
    "and its volume is mean height above the plane times area",
    allCut.cut,
    (stats.mean - (stats.min - 10)) * stats.coveredArea,
    stats.coveredArea * 0.01,
    " m³",
  );

  // The number that turns up in a dispute.
  near("uncertainty is rmse times measured area", allCut.uncertainty, rmseZ * allCut.measuredArea, 1e-9, " m³");
  near("which over a hectare at 4 cm is 400 m³", allCut.uncertainty, 400, 5, " m³");

  check("the result names its reference", atMean.reference === "plane", atMean.reference);
  check("the result states its CRS", allCut.computedIn === `EPSG:${grid.epsg}`, allCut.computedIn);

  const rim = cutFill(grid, ring, REFERENCE.boundaryPlane(grid, ring), { rmseZ });
  check("a boundary reference names itself distinctly", rim.reference === "boundaryPlane", rim.reference);
  check(
    "levelling to the rim gives a different answer than levelling to the mean",
    Math.abs(rim.net - atMean.net) > 1,
    `rim net ${rim.net.toFixed(0)} vs mean net ${atMean.net.toFixed(0)}`,
  );
}

console.log("\nDSM against DTM: the surface model cannot sit below bare earth");
{
  /*
   * The DSM is opened and windowed separately, and it is not the same grid
   * shape as the DTM on two of the three surveys: Kotba's DSM is 15.7 cm
   * against a 24 cm DTM, Kiru's is 19.8 cm against 25 cm. `REFERENCE.surface`
   * samples the reference rather than assuming a shared index, which is the
   * only reason a comparison between them means anything — and is worth
   * knowing before someone "optimises" it into an array subtraction.
   */
  let dsm;
  try {
    const dsmSurvey = await openSurvey(SITE, "dsm");
    dsm = await dsmSurvey.centreWindowMetres(WINDOW_HALF_M);
    await dsmSurvey.close();
  } catch (error) {
    check("a surface model is available to compare", false, error.message.slice(0, 100));
  }
  if (dsm) {
    const HALF = 50;
    const ring = [
      [centreE - HALF, centreN - HALF],
      [centreE + HALF, centreN - HALF],
      [centreE + HALF, centreN + HALF],
      [centreE - HALF, centreN + HALF],
      [centreE - HALF, centreN - HALF],
    ];
    const chm = cutFill(dsm, ring, REFERENCE.surface(grid), { rmseZ: 0.04 });

    const meanCanopy = chm.net / chm.measuredArea;
    console.log(
      `  ...canopy above ${chm.cut.toFixed(0)} m³, below ${chm.fill.toFixed(0)} m³ ` +
        `(${((chm.fill / chm.cut) * 100).toFixed(1)}%), mean height ${meanCanopy.toFixed(2)} m`,
    );

    /*
     * What this section can honestly assert, and why it is no longer a 5% tail.
     *
     * The check used to be `fill < cut * 0.05`: essentially no ground anywhere
     * under the hectare may have the DSM below the DTM. That is true on Kotba
     * (2.1%) and all but exactly true on Aektanagar (0.005%), and it is false on
     * Kiru, where 10.3% of the volume has the surface model *below* bare earth,
     * by up to 10 m.
     *
     * Kiru is not wrong and neither is the code. The centre of that survey is a
     * dam site in a gorge whose walls run past 200% gradient, the two models are
     * at different resolutions (25.4 cm DTM against a 19.8 cm DSM), and a DTM is
     * an interpolated ground classification: across a cliff lip the
     * interpolation carries "ground" out over the drop while the first return
     * has already fallen away below it. A quarter metre of horizontal
     * disagreement on a 67 degree face is two thirds of a metre vertically, and
     * a cliff lip supplies far more than a quarter metre. A third of the lattice
     * points over that hectare are affected.
     *
     * A slope threshold to excuse it would just be Kotba's number again wearing
     * a different hat — Kotba's own median gradient is 46%, close enough to any
     * such cutoff to be luck. So the assertions here are the ones that are true
     * of every survey and still catch the failure this section exists for, which
     * is the two rasters being swapped:
     *
     *   - the mean canopy height over the hectare is positive and real;
     *   - measuring the pair the other way round inverts it;
     *   - ground below the surface model stays a minority of the volume.
     *
     * A swap makes the first two fail outright and drives the third to about
     * 100%. Steep terrain moves the third from 2% to 10% and leaves the first
     * two untouched, which is the distinction that matters.
     */
    check(
      "canopy and structures stand above the ground on average",
      meanCanopy > 0.1,
      `mean canopy height ${meanCanopy.toFixed(3)} m`,
    );
    const swapped = cutFill(grid, ring, REFERENCE.surface(dsm), { rmseZ: 0.04 });
    check(
      "and measuring the pair the other way round inverts the answer",
      Math.abs(swapped.net + chm.net) < Math.abs(chm.net) * 0.02,
      `${chm.net.toFixed(0)} m³ one way, ${swapped.net.toFixed(0)} m³ the other`,
    );
    check(
      "ground standing above the surface model stays a minority of the volume",
      chm.fill < chm.cut * 0.5,
      `below ${chm.fill.toFixed(0)} m³ against above ${chm.cut.toFixed(0)} m³`,
    );

    /*
     * This one holds on any terrain and is the blunder check: a DSM read with
     * the wrong scale, or against the wrong DTM, gives a canopy hundreds of
     * metres tall rather than tens.
     */
    check(
      "and the tallest thing standing is a plausible height, not a blunder",
      chm.maxCutDepth > 0.5 && chm.maxCutDepth < 80,
      `${chm.maxCutDepth.toFixed(2)} m`,
    );
  }
}

console.log("\nPolygons that leave the survey are reported, not silently trimmed");
{
  // Half on, half off: the arithmetic is happy to measure less ground than was
  // drawn and hand back a plausible number. It must say so.
  const edgeE = grid.originX + width * grid.cellSize;
  const ring = [
    [edgeE - 25, centreN - 25],
    [edgeE + 75, centreN - 25],
    [edgeE + 75, centreN + 25],
    [edgeE - 25, centreN + 25],
    [edgeE - 25, centreN - 25],
  ];
  const stats = polygonStats(grid, ring);
  check("a polygon straddling the edge measures less ground than was drawn", stats.coveredArea < stats.area * 0.999);

  /**
   * The trap, pinned down so nobody has to rediscover it in front of a client.
   *
   * `nodataArea` counts only cells the statistics actually walked, and that
   * window is clamped to the raster. Everything the polygon covers *beyond the
   * edge of the survey* is in neither `coveredArea` nor `nodataArea`, so the two
   * do not add up to the polygon and `nodataArea` understates the real gap.
   *
   * The UI therefore reports `area - coveredArea`, which is immune to this
   * because both terms describe the same polygon. See `MeasurePanel`.
   */
  check(
    "covered and nodata do NOT account for the whole polygon once it leaves the raster",
    stats.coveredArea + stats.nodataArea < stats.area * 0.9,
    `${stats.coveredArea.toFixed(0)} + ${stats.nodataArea.toFixed(0)} vs ${stats.area.toFixed(0)} m² drawn`,
  );
  check(
    "so the shortfall the UI shows is the honest one",
    stats.area - stats.coveredArea > stats.nodataArea,
    `${(stats.area - stats.coveredArea).toFixed(0)} m² vs nodata's ${stats.nodataArea.toFixed(0)} m²`,
  );

  const volume = cutFill(grid, ring, REFERENCE.plane(datum), { rmseZ: 0.04 });
  check(
    "a volume over the same polygon measures less than was drawn",
    volume.measuredArea < volume.polygonArea,
    `${volume.measuredArea.toFixed(0)} of ${volume.polygonArea.toFixed(0)} m²`,
  );
}

console.log("\nOff the survey entirely: no answer, rather than a confident zero");
{
  const farE = grid.originX + width * grid.cellSize + 1000;
  check("a spot level off the raster is null", spotLevel(grid, farE, centreN) === null);

  const ring = [
    [farE, centreN - 25],
    [farE + 50, centreN - 25],
    [farE + 50, centreN + 25],
    [farE, centreN + 25],
    [farE, centreN - 25],
  ];
  const stats = polygonStats(grid, ring);
  check("statistics off the raster report no elevation at all", stats.min === null && stats.mean === null);
  check("rather than reporting zero", stats.mean !== 0);

  // The sharpest form of the trap above: nothing was measured, nothing was
  // walked, so `complete` is vacuously true. Anything keying a "this result is
  // trustworthy" badge off that flag alone would light it up here, over a
  // polygon with no survey underneath it at all.
  check(
    "`complete` is vacuously true off the survey, which is why the UI ignores it",
    stats.complete === true && stats.coveredArea === 0,
    `complete ${stats.complete}, covered ${stats.coveredArea} m²`,
  );

  const volume = cutFill(grid, ring, REFERENCE.plane(datum), { rmseZ: 0.04 });
  check(
    "a volume off the survey measures nothing, and says so by area",
    volume.measuredArea === 0 && volume.polygonArea > 0,
    `${volume.measuredArea} of ${volume.polygonArea.toFixed(0)} m²`,
  );
  check("and reports no volume rather than a zero quantity", volume.cut === 0 && volume.fill === 0);
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
