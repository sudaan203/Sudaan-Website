/**
 * Known-answer tests for the Universal tools.
 *
 * The surfaces here are linear on purpose. Bilinear interpolation is exact on a
 * plane, and the midpoint rule is exact for a linear integrand, so a volume over
 * a cell aligned rectangle has a closed form answer this can be checked against
 * to floating point rather than to a tolerance. That matters more here than
 * anywhere else in the pipeline: `docs/portal-map-architecture.md` section 6b
 * says a wrong volume looks exactly like a right one, and a client operating the
 * tool themselves has no way to tell.
 *
 * Run:
 *   node scripts/terrain-test.mjs
 */

import { Grid } from "../src/lib/geo/raster.mjs";
import {
  spotLevel,
  profile,
  gridLevels,
  polygonArea,
  polygonPerimeter,
  polygonStats,
  cutFill,
  surfaceDifference,
  REFERENCE,
} from "../src/lib/geo/terrain-analysis.mjs";
import {
  pointsToCsv,
  pointsToTxt,
  pointsToDxf,
  pointsToLandXml,
  profileToCsv,
  writePrj,
} from "../src/lib/geo/export-formats.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** A 100 x 100 m grid at 1 m, origin at 0 E and 100 N, in UTM 43N. */
function makeGrid(fn, { width = 100, height = 100, cellSize = 1 } = {}) {
  const data = new Float32Array(width * height);
  const g = new Grid({
    width, height, cellSize,
    originX: 0, originY: height * cellSize,
    data, nodata: -99999, epsg: 32643,
  });
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      data[row * width + col] = fn(g.xOf(col), g.yOf(row));
    }
  }
  return g;
}

// A plane. Every analytic answer below comes from this being linear.
const PLANE = (x, y) => 10 + 0.1 * x + 0.02 * y;
const plane = makeGrid(PLANE);

// ---------------------------------------------------------------------------
console.log("\nSpot level, where bilinear interpolation is exact on a plane");
{
  for (const [x, y] of [[10, 50], [33.3, 71.9], [0.5, 99.5], [64.25, 12.75]]) {
    const got = spotLevel(plane, x, y);
    check(`(${x}, ${y}) reads ${PLANE(x, y).toFixed(4)}`, near(got, PLANE(x, y), 1e-4),
      `got ${got.toFixed(4)}`);
  }

  // Nearest neighbour, which is what the browser sampler does today, would land
  // on a cell centre and be wrong by up to half a cell of slope. On this plane
  // that is 5 cm, larger than the survey's own accuracy.
  const mid = spotLevel(plane, 20.5, 50.5);
  const off = spotLevel(plane, 20.9, 50.5);
  check("moving 0.4 m across the grid changes the answer, so it is interpolating",
    Math.abs(off - mid) > 0.03, `${(off - mid).toFixed(4)} m`);

  const holed = makeGrid(PLANE);
  holed.set(50, 50, holed.nodata);
  check("a point next to nodata returns null rather than inventing ground",
    spotLevel(holed, holed.xOf(50) + 0.4, holed.yOf(50) + 0.4) === null);
  check("a point outside the grid returns null", spotLevel(plane, -5, 50) === null);
}

// ---------------------------------------------------------------------------
console.log("\nPolygon geometry, in projected metres");
{
  const square = [[10, 20], [30, 20], [30, 40], [10, 40]];
  check("a 20 x 20 m square has an area of 400 m2", polygonArea(square) === 400);
  check("and a perimeter of 80 m", polygonPerimeter(square) === 80);

  const stats = polygonStats(plane, square);
  check("polygon stats report the area in hectares too",
    near(stats.areaHectares, 0.04, 1e-12), `${stats.areaHectares}`);
  // Mean of a plane over a rectangle is its value at the centroid.
  check("mean elevation over a plane is the value at the centroid",
    near(stats.mean, PLANE(20, 30), 1e-4), `got ${stats.mean.toFixed(4)}`);
  check("min and max are the two opposite corners",
    near(stats.min, PLANE(10.5, 20.5), 1e-3) && near(stats.max, PLANE(29.5, 39.5), 1e-3));
  check("a polygon fully inside the survey reports complete", stats.complete);

  // Half cell offset: the covered area must still come out at 400, which a
  // "is the cell centre inside" test cannot manage.
  const offset = [[10.5, 20.5], [30.5, 20.5], [30.5, 40.5], [10.5, 40.5]];
  const offsetStats = polygonStats(plane, offset);
  check("a polygon offset half a cell still measures 400 m2 of coverage",
    near(offsetStats.coveredArea, 400, 1), `${offsetStats.coveredArea.toFixed(2)} m2`);
}

// ---------------------------------------------------------------------------
console.log("\nCut and fill, against a reference stated every time");
{
  const square = [[10, 20], [30, 20], [30, 40], [10, 40]];

  // Analytic: the plane rises 0.1 per metre east and 0.02 per metre north, so
  // over x in [10,30] and y in [20,40] against a plane at the south west corner
  // value, the integral has a closed form. Cell centres put the midpoint rule on
  // it exactly.
  const base = PLANE(10, 20);
  const result = cutFill(plane, square, REFERENCE.plane(base), { rmseZ: 0.04 });
  const expected = (0.1 * (20 * 20) / 2) * 20 + (0.02 * (20 * 20) / 2) * 20;
  check(`cut over the square is ${expected} m3`, near(result.cut, expected, 0.5),
    `got ${result.cut.toFixed(3)}`);
  check("nothing is below the reference, so fill is zero", result.fill === 0);
  check("net is cut minus fill", near(result.net, result.cut, 1e-9));
  check("the reference used is echoed back in the result", result.reference === "plane");
  check("the CRS the volume was computed in is stated", result.computedIn === "EPSG:32643");

  // 4 cm of systematic error over 400 m2 is 16 m3, which is 2% of this volume
  // and would be invisible without being reported.
  check("uncertainty is rmseZ times area, in cubic metres",
    near(result.uncertainty, 0.04 * 400, 1e-9), `${result.uncertainty} m3`);

  // Reference through the middle: cut and fill must balance exactly.
  const mid = cutFill(plane, square, REFERENCE.plane(PLANE(20, 30)));
  check("a reference at the centroid gives equal cut and fill",
    near(mid.cut, mid.fill, 0.5), `cut ${mid.cut.toFixed(2)}, fill ${mid.fill.toFixed(2)}`);
  check("so the net volume is zero", near(mid.net, 0, 0.5), `${mid.net.toFixed(4)}`);

  // A second surface, offset by a constant, is the cleanest possible check.
  const lower = makeGrid((x, y) => PLANE(x, y) - 2);
  const versus = cutFill(plane, square, REFERENCE.surface(lower));
  check("against a surface exactly 2 m below, cut is 2 x 400 = 800 m3",
    near(versus.cut, 800, 0.5), `got ${versus.cut.toFixed(3)}`);
  check("and the mean depth is exactly 2 m", near(versus.meanDepth, 2, 1e-3));

  // The boundary plane fit should recover the plane it was sampled from.
  const boundary = cutFill(plane, square, REFERENCE.boundaryPlane(plane, square));
  check("a best fit plane through the rim of a planar site finds no volume",
    near(boundary.cut, 0, 0.5) && near(boundary.fill, 0, 0.5),
    `cut ${boundary.cut.toFixed(3)}, fill ${boundary.fill.toFixed(3)}`);

  let refused = false;
  try { cutFill(plane, square, null); } catch { refused = true; }
  check("a volume with no stated reference is refused, not defaulted", refused);

  // A polygon hanging off the survey must say so rather than quietly returning
  // the volume of the part it could see.
  const holed = makeGrid(PLANE);
  for (let row = 60; row < 80; row += 1) for (let col = 10; col < 30; col += 1) {
    holed.set(col, row, holed.nodata);
  }
  const partial = cutFill(holed, [[10, 20], [30, 20], [30, 40], [10, 40]], REFERENCE.plane(base));
  check("a polygon over a gap in the survey reports incomplete",
    !partial.complete && partial.nodataArea > 0, `${partial.nodataArea} m2 missing`);
}

// ---------------------------------------------------------------------------
console.log("\nCross section");
{
  const line = [[10, 50], [90, 50]];
  const p = profile(plane, line);
  check("the profile is as long as the line", near(p.length, 80, 1e-9));
  check("every sample sits on the plane",
    p.points.every((q) => near(q.elevation, PLANE(q.easting, q.northing), 1e-4)));
  check("chainage starts at zero and ends at the length",
    p.points[0].chainage === 0 && near(p.points[p.points.length - 1].chainage, 80, 1e-9));
  // Rising 0.1 m per metre east is a 10% grade.
  check("grade over a plane rising 0.1 per metre is 10%",
    near(p.gradePercent, 10, 1e-3), `${p.gradePercent.toFixed(4)}%`);
  check("total gain is the full rise, 8 m", near(p.gain, 8, 1e-3), `${p.gain.toFixed(4)}`);
  check("nothing is lost going uphill", near(p.loss, 0, 1e-6));
  check("no samples are missing data", p.samplesWithoutData === 0);

  // An L shaped alignment: chainage has to accumulate across the corner.
  const bent = profile(plane, [[10, 10], [10, 50], [50, 50]]);
  check("chainage accumulates across a bend", near(bent.length, 80, 1e-9),
    `${bent.length}`);
}

// ---------------------------------------------------------------------------
console.log("\nGrid levels");
{
  const square = [[10, 20], [30, 20], [30, 40], [10, 40]];
  const g5 = gridLevels(plane, square, 5);
  check("a 5 m grid snaps to whole multiples of 5 in the projected CRS",
    g5.points.every((p) => p.easting % 5 === 0 && p.northing % 5 === 0));
  check("every generated point carries an elevation",
    g5.points.every((p) => Number.isFinite(p.elevation)));
  check("the points really lie on the plane",
    g5.points.every((p) => near(p.elevation, PLANE(p.easting, p.northing), 1e-4)));

  const g1 = gridLevels(plane, square, 1);
  check("a finer spacing yields more points", g1.points.length > g5.points.length,
    `${g1.points.length} at 1 m vs ${g5.points.length} at 5 m`);

  let refused = false;
  try { gridLevels(plane, square, 0.01, { maxPoints: 1000 }); } catch { refused = true; }
  check("an unreasonable point count is refused with a number, not attempted", refused);
}

// ---------------------------------------------------------------------------
console.log("\nSurface comparison");
{
  const lower = makeGrid((x, y) => PLANE(x, y) - 0.5);
  const diff = surfaceDifference(plane, lower);
  check("a uniform 0.5 m rise over 10,000 m2 is 5,000 m3 gained",
    near(diff.volumeGained, 5000, 1e-3), `${diff.volumeGained.toFixed(2)}`);
  check("nothing was lost", near(diff.volumeLost, 0, 1e-6));
  check("mean change is 0.5 m", near(diff.meanChange, 0.5, 1e-4));

  let refused = false;
  try {
    surfaceDifference(plane, makeGrid(PLANE, { width: 50, height: 50 }));
  } catch { refused = true; }
  check("comparing mismatched grids is refused rather than silently resampled", refused);
}

// ---------------------------------------------------------------------------
console.log("\nExports, where the coordinate order and the CRS are the traps");
{
  const points = [
    { name: "P1", easting: 345308.186, northing: 2355499.104, elevation: 12.345 },
    { name: "P2", easting: 345310.5, northing: 2355501.25, elevation: 13.5 },
  ];

  const csv = pointsToCsv(points, { epsg: 32643 });
  check("CSV states its CRS in the header", csv.includes("# CRS: EPSG:32643"));
  check("CSV warns these are not longitude and latitude",
    csv.includes("not longitude and latitude"));
  check("CSV rows are easting, northing, elevation",
    csv.includes("P1,345308.186,2355499.104,12.345"));

  let refused = false;
  try { pointsToCsv(points, {}); } catch { refused = true; }
  check("an export with no CRS is refused", refused);

  const txt = pointsToTxt(points);
  check("TXT is bare id E N Z with no header, as importers expect",
    txt.split("\n")[0] === "P1 345308.186 2355499.104 12.345");

  const dxf = pointsToDxf(points, { labels: false });
  check("DXF carries a POINT entity per level", (dxf.match(/\nPOINT\n/g) ?? []).length === 2);
  check("DXF puts them on a named layer", dxf.includes("SPOT_LEVELS"));
  check("DXF holds the projected easting as X", dxf.includes("345308.1860"));

  // The one that would be silently, catastrophically wrong.
  const xml = pointsToLandXml(points, { epsg: 32643 });
  check("LandXML writes northing BEFORE easting, per the schema",
    xml.includes("2355499.1040 345308.1860 12.3450"),
    "easting first would transpose the whole survey");
  check("LandXML records the EPSG code", xml.includes('epsgCode="32643"'));

  const prj = writePrj(32643);
  check("the .prj sidecar names UTM zone 43N", prj.includes("UTM_Zone_43N"));
  // Zone 43 spans 72 to 78 E, so its central meridian is 75, which is exactly
  // what the fixture's own .prj files say.
  check("and gets the central meridian right at 75", prj.includes('"Central_Meridian",75.0'));

  let prjRefused = false;
  try { writePrj(4326); } catch { prjRefused = true; }
  check("a non UTM code is refused rather than given a guessed datum", prjRefused);

  const sectionCsv = profileToCsv(profile(plane, [[10, 50], [20, 50]]), { epsg: 32643 });
  check("a profile exports chainage first", sectionCsv.includes("chainage,easting,northing"));
  check("and states its CRS too", sectionCsv.includes("EPSG:32643"));
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
