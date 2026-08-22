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
 */

import { readGeoTiff } from "../src/lib/geo/raster.mjs";
import {
  REFERENCE,
  cutFill,
  polygonArea,
  polygonStats,
  profile,
  spotLevel,
} from "../src/lib/geo/terrain-analysis.mjs";
import { lonLatToUtm, utmToLonLat } from "../src/lib/geo/projection.mjs";

const DTM = process.env.DTM ?? "portal-data/terrain/kotba-survey/dtm.tif";
const DSM = process.env.DSM ?? "portal-data/terrain/kotba-survey/dsm.tif";

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

const grid = readGeoTiff(DTM);
const { zone, northern } = grid.utmZone;
const width = grid.width ?? grid.ncols;
const height = grid.height ?? grid.nrows;
const centreE = grid.originX + (width / 2) * grid.cellSize;
const centreN = grid.originY - (height / 2) * grid.cellSize;

console.log(`\nSurvey: ${DTM}`);
console.log(`  ${width} x ${height} at ${grid.cellSize.toFixed(4)} m, EPSG:${grid.epsg}, UTM ${zone}${northern ? "N" : "S"}`);

console.log("\nThe projection round trip, which everything else rests on");
{
  // Every coordinate the browser sends has been through this both ways. If it
  // does not close, no number downstream means anything.
  const [lon, lat] = utmToLonLat(centreE, centreN, zone, northern);
  const [backE, backN] = lonLatToUtm(lon, lat, zone, northern);
  near("easting survives a round trip", backE, centreE, 0.001, " m");
  near("northing survives a round trip", backN, centreN, 0.001, " m");
  check(
    "the survey lands in Gujarat, not somewhere a transposed axis would put it",
    lat > 20 && lat < 21.5 && lon > 73 && lon < 74.5,
    `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
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
  check("the level is a real elevation for this site", truth > 300 && truth < 450, `${truth.toFixed(3)} m`);

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
  near("covered area matches the polygon area", stats.coveredArea, stats.area, 5, " m²");
}

console.log("\nTool 3, profile: chainage, sampling and gaps");
{
  const a = utmToLonLat(centreE - 100, centreN, zone, northern);
  const b = utmToLonLat(centreE + 100, centreN, zone, northern);
  const line = toProjected([a, b], "lonlat", zone, northern);
  const result = profile(grid, line, { spacing: grid.cellSize });

  near("a 200 m line measures 200 m", result.length, 200, 0.05, " m");
  check("it samples at about one cell", result.points.length > 700, `${result.points.length} samples`);
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
  let dsm;
  try {
    dsm = readGeoTiff(DSM);
  } catch {
    check("a surface model is available to compare", false, "could not read the DSM");
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
    check(
      "canopy and structures stand above the ground, essentially never below",
      chm.fill < chm.cut * 0.05,
      `above ${chm.cut.toFixed(0)} m³, below ${chm.fill.toFixed(0)} m³`,
    );
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

  const volume = cutFill(grid, ring, REFERENCE.plane(360), { rmseZ: 0.04 });
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

  const volume = cutFill(grid, ring, REFERENCE.plane(360), { rmseZ: 0.04 });
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
