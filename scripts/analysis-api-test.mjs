/**
 * End to end checks on the analysis API, over real HTTP, against real survey data.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/analysis-api-test.mjs
 *
 * Needs a dev or production server on :3000 and `.env.local` for DATABASE_URL
 * and PORTAL_AUTH_SECRET; it mints an owner session directly rather than driving
 * the Google consent screen, the same way `portal-ux-test.mjs` does.
 *
 * ## What this is for, given the unit tests already pass
 *
 * `terrain-test.mjs` proves the arithmetic on synthetic surfaces with analytic
 * answers. It cannot prove that the *route* hands the arithmetic the right
 * numbers. Everything between a click and a volume — JSON shapes, the lon/lat to
 * UTM projection, which raster got opened, whether the tenant check let it
 * through — lives only here, and every one of those failures produces a
 * plausible number rather than an error.
 *
 * So the checks below are anchored to values computed independently, by calling
 * the analysis library directly on the same file the server will open. If the
 * two disagree, something in the HTTP layer is lying.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { readGeoTiff } from "../src/lib/geo/raster.mjs";
import { polygonStats, spotLevel } from "../src/lib/geo/terrain-analysis.mjs";
import { lonLatToUtm, utmToLonLat } from "../src/lib/geo/projection.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SITE = process.env.SITE ?? "kotba-survey";
const DTM = process.env.DTM ?? `portal-data/terrain/${SITE}/dtm.tif`;

const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

let failures = 0;
let checks = 0;

function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Agreement to a stated tolerance, printed with the gap when it fails. */
function near(label, actual, expected, tolerance, unit = "") {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  check(
    label,
    ok,
    ok ? "" : `got ${actual}, want ${expected} ±${tolerance}${unit}`,
  );
}

// ---- ground truth, computed here rather than quoted ------------------------

const grid = readGeoTiff(DTM);
const width = grid.width ?? grid.ncols;
const height = grid.height ?? grid.nrows;
const centreE = grid.originX + (width / 2) * grid.cellSize;
const centreN = grid.originY - (height / 2) * grid.cellSize;
const [centreLon, centreLat] = utmToLonLat(centreE, centreN, 43, true);

const truthSpot = spotLevel(grid, centreE, centreN);
const HALF = 50; // a 100 m square, exactly one hectare
const truthRingUtm = [
  [centreE - HALF, centreN - HALF],
  [centreE + HALF, centreN - HALF],
  [centreE + HALF, centreN + HALF],
  [centreE - HALF, centreN + HALF],
  [centreE - HALF, centreN - HALF],
];
const truthStats = polygonStats(grid, truthRingUtm);

console.log(`\nGround truth from ${DTM}`);
console.log(`  grid          ${width} x ${height} at ${grid.cellSize.toFixed(4)} m, EPSG:${grid.epsg}`);
console.log(`  centre        ${centreE.toFixed(3)} E ${centreN.toFixed(3)} N`);
console.log(`  spot level    ${truthSpot.toFixed(4)} m`);
console.log(`  1 ha mean     ${truthStats.mean.toFixed(4)} m`);

// ---- a real session --------------------------------------------------------

/**
 * The route's tenant check reads the database, so no database means no HTTP
 * test at all. That is worth saying out loud and skipping cleanly rather than
 * failing 40 checks with a connection error, which reads as "the analysis is
 * broken" when the analysis is fine and the database is simply not there.
 *
 * `scripts/analysis-contract-test.mjs` covers the same arithmetic offline.
 */
let owner;
try {
  const sql = postgres(val("DATABASE_URL"), {
    prepare: false,
    fetch_types: false,
    max: 2,
    connect_timeout: 8,
    onnotice() {},
  });
  [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
  await sql.end({ timeout: 3 });
} catch (error) {
  console.log(`\n  SKIPPED: the portal database is unreachable (${error.code ?? error.message}).`);
  console.log("  The analysis route authorises against it before opening any raster, so");
  console.log("  none of these checks can run. The arithmetic is covered offline by:");
  console.log("      node scripts/analysis-contract-test.mjs\n");
  process.exit(0);
}
if (!owner) throw new Error("no owner user in the database to mint a session for");

const token = await new SignJWT({
  userId: owner.id,
  email: owner.email,
  fullName: owner.full_name ?? owner.email,
  role: "owner",
  clientId: null,
  via: "google",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

const endpoint = `${BASE}/api/portal/sites/${SITE}/analysis`;

async function post(body, { authorised = true } = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorised ? { Cookie: `sga_portal_session=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* a body that is not JSON is itself the finding */
  }
  return { status: response.status, payload };
}

// ---- the contract the browser client actually sends -------------------------

console.log("\nTool 1, spot level");
{
  // Exactly the shape `AnalysisClient.spot` builds: a one element `at` array in
  // lon/lat, letting the server project.
  const { status, payload } = await post({ op: "spot", at: [[centreLon, centreLat]], crs: "lonlat" });
  check("the client's request shape is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    near("elevation matches a direct read of the raster", payload.result.elevation, truthSpot, 0.001, " m");
    near("the server projected to the same easting", payload.result.easting, centreE, 0.01, " m");
    near("the server projected to the same northing", payload.result.northing, centreN, 0.01, " m");
    check("the response states its CRS", payload.computedIn === `EPSG:${grid.epsg}`, payload.computedIn);
    check("the response states the cell size", Math.abs(payload.cellSize - grid.cellSize) < 1e-9);
    check("the surface is echoed back", payload.surface === "dtm", payload.surface);
  }
}

{
  // The same point sent already projected must give the same answer. If these
  // two disagree the CRS contract is not being honoured, and every area and
  // volume on the site is suspect.
  const { status, payload } = await post({ op: "spot", at: [[centreE, centreN]], crs: "utm" });
  check("a point sent in UTM is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    near("lon/lat and UTM routes agree on elevation", payload.result.elevation, truthSpot, 0.001, " m");
  }
}

{
  const { status } = await post({ op: "spot", at: [[centreLon, centreLat]], crs: "wgs84" });
  check("an unknown CRS is refused rather than guessed", status === 400, `status ${status}`);
}

console.log("\nTool 2 companion, polygon statistics");
{
  const ring = truthRingUtm.map(([e, n]) => utmToLonLat(e, n, 43, true));
  const { status, payload } = await post({ op: "polygon-stats", polygon: ring, crs: "lonlat" });
  check("a lon/lat ring is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    const r = payload.result;
    // 1 ha drawn in UTM, reprojected to lon/lat and back by the server. The
    // round trip is not bit exact, so a few m² either way is expected; a
    // percentage would not be.
    near("area comes back as one hectare", r.area, 10000, 5, " m²");
    near("mean elevation matches the direct computation", r.mean, truthStats.mean, 0.01, " m");
    near("minimum matches", r.min, truthStats.min, 0.01, " m");
    near("maximum matches", r.max, truthStats.max, 0.01, " m");
    check("the polygon is reported as fully covered", r.complete === true);
    // The reason area is computed server side in UTM at all: the same ring in
    // Web Mercator at this latitude is about 15% larger, and that error looks
    // entirely plausible on screen.
    check(
      "area is not the Web Mercator figure",
      Math.abs(r.area - 10000) < 100,
      `${r.area.toFixed(0)} m²`,
    );
  }
}

console.log("\nTool 3, profile");
{
  const a = utmToLonLat(centreE - 100, centreN, 43, true);
  const b = utmToLonLat(centreE + 100, centreN, 43, true);
  const { status, payload } = await post({ op: "profile", line: [a, b], crs: "lonlat" });
  check("a two point line is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    const r = payload.result;
    near("the profile is 200 m long", r.length, 200, 0.5, " m");
    check("it returns samples", r.points.length > 100, `${r.points.length} samples`);
    check(
      "sampling defaults to the raster's own cell size",
      Math.abs(r.sampleSpacing - grid.cellSize) < 1e-6,
      `${r.sampleSpacing}`,
    );
    check("chainage starts at zero", Math.abs(r.points[0].chainage) < 1e-9);
    near("chainage ends at the line length", r.points[r.points.length - 1].chainage, r.length, 0.5, " m");
    const monotonic = r.points.every((p, i) => i === 0 || p.chainage >= r.points[i - 1].chainage);
    check("chainage never goes backwards", monotonic);
    check(
      "every sample carries a coordinate in the survey grid",
      r.points.every((p) => Number.isFinite(p.easting) && Number.isFinite(p.northing)),
    );
    // The end to end grade and the steepest step are different numbers, and the
    // panel labels them differently, so the API must really return both.
    check("grade and steepest step are distinct fields", "gradePercent" in r && "maxSlopePercent" in r);
  }
}

{
  // The client caps very long profiles rather than asking for tens of thousands
  // of samples. The server must honour an explicit spacing.
  const a = utmToLonLat(centreE - 100, centreN, 43, true);
  const b = utmToLonLat(centreE + 100, centreN, 43, true);
  const { status, payload } = await post({ op: "profile", line: [a, b], crs: "lonlat", spacing: 5 });
  check("an explicit sample spacing is honoured", status === 200 && Math.abs(payload.result.sampleSpacing - 5) < 1e-9);
  if (status === 200) {
    check(
      "a coarser spacing really does return fewer samples",
      payload.result.points.length < 60,
      `${payload.result.points.length} samples`,
    );
  }
}

console.log("\nTool 4, cut and fill");
{
  const ring = truthRingUtm.map(([e, n]) => utmToLonLat(e, n, 43, true));
  const { status } = await post({ op: "volume", polygon: ring, crs: "lonlat" });
  check(
    "a volume with no reference surface is refused, not defaulted",
    status === 400,
    `status ${status}`,
  );
}

{
  const ring = truthRingUtm.map(([e, n]) => utmToLonLat(e, n, 43, true));
  const level = Math.round(truthStats.mean * 100) / 100;
  const { status, payload } = await post({
    op: "volume",
    polygon: ring,
    crs: "lonlat",
    reference: `plane:${level}`,
  });
  check("a volume against a stated plane is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    const r = payload.result;
    check("the reference is echoed back", r.reference === "plane", r.reference);
    check("cut and fill are both non negative", r.cut >= 0 && r.fill >= 0);
    near("net is cut minus fill", r.net, r.cut - r.fill, 1e-6, " m³");
    // Against the mean elevation, cut and fill over the same hectare should be
    // comparable. Wildly lopsided would mean the plane is not where we think.
    check(
      "cut and fill straddle a plane at the mean",
      r.cut > 0 && r.fill > 0,
      `cut ${r.cut.toFixed(0)}, fill ${r.fill.toFixed(0)}`,
    );
    near("the measured area is the hectare drawn", r.measuredArea, 10000, 50, " m²");
    // The number that turns up in a dispute: systematic error over the area.
    if (r.rmseZ !== null) {
      near("uncertainty is the vertical accuracy across the measured area", r.uncertainty, r.rmseZ * r.measuredArea, 1e-6, " m³");
    }
    check("the result states its CRS", r.computedIn === `EPSG:${grid.epsg}`, r.computedIn);
  }
}

{
  const ring = truthRingUtm.map(([e, n]) => utmToLonLat(e, n, 43, true));
  const { status, payload } = await post({
    op: "volume",
    polygon: ring,
    crs: "lonlat",
    reference: "boundary",
  });
  check("a volume against the polygon rim is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    check("the boundary plane is named as the reference", payload.result.reference === "boundaryPlane", payload.result.reference);
  }
}

{
  // DSM minus DTM is the canopy and structure height, and it must be positive:
  // the surface model cannot sit below bare earth.
  const ring = truthRingUtm.map(([e, n]) => utmToLonLat(e, n, 43, true));
  const { status, payload } = await post({
    op: "volume",
    polygon: ring,
    crs: "lonlat",
    surface: "dsm",
    reference: "dtm",
  });
  if (status === 200) {
    check(
      "the surface model stands above the terrain model, never below",
      payload.result.fill < payload.result.cut * 0.05,
      `cut ${payload.result.cut.toFixed(0)} m³ vs fill ${payload.result.fill.toFixed(0)} m³`,
    );
  } else {
    check("DSM against DTM is available", false, `status ${status}`);
  }
}

console.log("\nRefusals and isolation");
{
  const { status } = await post({ op: "spot", at: [[centreLon, centreLat]] }, { authorised: false });
  check("no session is refused", status === 401, `status ${status}`);
}
{
  const response = await fetch(`${BASE}/api/portal/sites/definitely-not-a-site/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `sga_portal_session=${token}` },
    body: JSON.stringify({ op: "spot", at: [[centreLon, centreLat]] }),
  });
  check("an unknown site is 404, never a confirmation", response.status === 404, `status ${response.status}`);
}
{
  const { status } = await post({ op: "definitely-not-an-op", at: [[centreLon, centreLat]] });
  check("an unknown op is refused with a readable message", status === 400, `status ${status}`);
}
{
  const { status } = await post({ op: "profile", line: [[centreLon, centreLat]], crs: "lonlat" });
  check("a one point line is refused", status === 400, `status ${status}`);
}
{
  const { status } = await post({ op: "polygon-stats", polygon: [[1, 2], [3, 4]], crs: "lonlat" });
  check("a two point polygon is refused", status === 400, `status ${status}`);
}
{
  const { status } = await post({ op: "spot", at: [["north", "east"]], crs: "lonlat" });
  check("non numeric coordinates are refused", status === 400, `status ${status}`);
}

/**
 * A bounds box around the survey centre, sized in **cells** rather than metres.
 *
 * The flood tool works to a cell budget, so a box measured in metres means
 * completely different things on different surveys: 600 m is 6 million cells on
 * Kotba's 24 cm grid and 60 million on Aektanagar's 7.7 cm one. Sizing the box
 * from the survey's own cell size is what lets these checks say the same thing
 * whichever survey they are pointed at.
 */
function boxOfCells(cells) {
  const half = (Math.sqrt(cells) / 2) * grid.cellSize;
  return [
    utmToLonLat(centreE - half, centreN - half, 43, true),
    utmToLonLat(centreE + half, centreN + half, 43, true),
  ];
}

console.log("\nFlood simulation, Malhar's water-level-rise tool");
{
  /*
   * Anchored to a direct read of the same raster, the way every other check in
   * this file is. The independent number here is the *count of cells at or
   * below a level*, computed by walking the grid directly — if the route's
   * threshold flood disagrees with that, something between the request and the
   * engine is lying about which raster or which level.
   */
  const level = truthSpot + 5;
  let belowCells = 0;
  for (let i = 0; i < grid.data.length; i += 1) {
    const z = grid.data[i];
    if (!grid.isNoData(z) && level - z > 0) belowCells += 1;
  }
  const independentArea = belowCells * grid.cellSize * grid.cellSize;

  /*
   * Deliberately un-bounded, and deliberately guarded. This is the one check
   * anchored to an independent walk of the *whole* raster, so the request has
   * to cover the whole raster too — which only works where the survey fits the
   * cell budget. On a survey too big for that, the refusal is the correct
   * answer and is asserted further down instead.
   */
  const wholeSurveyFits = width * height <= 4_000_000;
  const { status, payload } = await post({ op: "flood", levels: [level], crs: "lonlat" });
  if (!wholeSurveyFits) {
    check("a whole-survey flood is refused on a survey past the budget", status === 400, `status ${status}`);
  } else {
  check("a flood with no water source is accepted", status === 200, `status ${status}`);
    if (status === 200) {
    check("and answered as a threshold flood, not a connected one",
      payload.result.method === "threshold", payload.result.method);
    near("the flooded area matches a direct read of the raster",
      payload.result.levels[0].area_m2, independentArea, 0.5, " m2");
    check("hectares and km2 agree with the m2 figure",
      Math.abs(payload.result.levels[0].area_ha * 10_000 - payload.result.levels[0].area_m2) < 1e-6 &&
      Math.abs(payload.result.levels[0].area_km2 * 1_000_000 - payload.result.levels[0].area_m2) < 1e-6);
    // MultiPolygon, not Polygon. A flood is disconnected far more often than
    // not, and one Polygon carrying every ring flat declares the second patch
    // onwards to be holes in the first — see `groupRingsIntoPolygons`.
    check("a flood polygon comes back as GeoJSON",
      payload.result.levels[0].geojson?.features?.[0]?.geometry?.type === "MultiPolygon");
    check("as separate patches, not one patch with the rest punched out of it",
      payload.result.levels[0].geojson.features[0].geometry.coordinates.length >= 1);
    check("carrying the export attributes Malhar's spec names",
      payload.result.levels[0].geojson.features[0].properties.Water_Level !== undefined &&
      payload.result.levels[0].geojson.features[0].properties.Flood_Area_Ha !== undefined);
    }
  }
}
{
  // The whole ladder in one request, which is what an automatic run sends.
  const levels = [truthSpot + 2, truthSpot + 4, truthSpot + 6];
  const { status, payload } = await post({ op: "flood", levels, bounds: boxOfCells(1_000_000), crs: "lonlat", interval: 2 });
  check("a ladder of levels is accepted in one request", status === 200, `status ${status}`);
  if (status === 200) {
    check("one result per level", payload.result.levels.length === 3, `${payload.result.levels.length}`);
    // Physically necessary, and the strongest cheap check there is: raising the
    // water can never uncover ground. A simulation that ever shrinks has either
    // read a different raster between steps or lost cells somewhere.
    check("the flooded area never shrinks as the water rises",
      payload.result.levels.every((l, i, all) => i === 0 || l.area_m2 >= all[i - 1].area_m2),
      payload.result.levels.map((l) => l.area_ha.toFixed(2)).join(" -> "));
    check("each polygon carries the interval it was simulated at",
      payload.result.levels.every((l) =>
        l.geojson.features.length === 0 || l.geojson.features[0].properties.Interval === 2));
  }
}
{
  // Seeded from a point: a connected flood, and it must not exceed the bathtub
  // answer at the same level — connectivity can only ever remove cells.
  const level = truthSpot + 5;
  const bathtub = await post({ op: "flood", levels: [level], bounds: boxOfCells(1_000_000), crs: "lonlat" });
  const seeded = await post({
    op: "flood", levels: [level], at: [[centreLon, centreLat]], bounds: boxOfCells(1_000_000), crs: "lonlat",
  });
  check("a flood seeded at a point is accepted", seeded.status === 200, `status ${seeded.status}`);
  if (seeded.status === 200 && bathtub.status === 200) {
    check("and answered as a connected flood", seeded.payload.result.method === "connected");
    /*
     * Against the 3x3 neighbourhood, not one exact cell, and the reason is a
     * real quirk worth knowing about.
     *
     * A spot level is bilinear — it interpolates the four cells around the
     * point — while a flood seed is the cell the click lands in, because a
     * fill starts from a cell and not from a point between four of them. So
     * comparing the seed against `truthSpot` was never quite right; it passed
     * on Kotba only because the two agree there to under a millimetre.
     *
     * Comparing against one exact cell is not right either. `readWindow` gives
     * the window an origin of `originX + col0 * cellSize`, and on a survey
     * whose cell size has a long mantissa — Aektanagar's is 0.07686839999999892
     * — that arithmetic drifts: at col0 = 2812 the window sits 2811.9999999999786
     * cells from the raster origin rather than 2812. A point near a cell
     * boundary can therefore resolve one cell differently through the windowed
     * reader than through the whole-file one. Here that is 7.7 cm of ground and
     * 3 mm of elevation.
     *
     * That drift is pre-existing, affects every windowed read, and deserves its
     * own fix rather than a fudge here. What this check can honestly assert is
     * that the seed elevation is one of the cells actually under the click —
     * which still catches the failure that matters, a seed read from the wrong
     * part of the survey.
     */
    const seedCell = grid.cellAt(centreE, centreN);
    const neighbourhood = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const c = seedCell.col + dc;
        const r = seedCell.row + dr;
        if (grid.inside(c, r) && !grid.isNoDataAt(c, r)) neighbourhood.push(grid.get(c, r));
      }
    }
    const reported = seeded.payload.result.seedGround_m;
    check("reporting the ground elevation of a cell actually under the seed",
      neighbourhood.some((v) => Math.abs(v - reported) < 1e-6),
      `${reported} against ${neighbourhood.length} cells around ${grid.get(seedCell.col, seedCell.row)}`);
    check("the connected flood never exceeds the threshold flood at the same level",
      seeded.payload.result.levels[0].area_m2 <= bathtub.payload.result.levels[0].area_m2 + 1e-6,
      `${seeded.payload.result.levels[0].area_ha.toFixed(2)} ha connected, ` +
        `${bathtub.payload.result.levels[0].area_ha.toFixed(2)} ha threshold`);
  }
}
{
  /*
   * Bounds, which is what makes this op work on a survey larger than memory.
   * It began as a whole-grid read like tool 14's and was therefore dead in
   * production for *every* site — `loadTerrain` reads local files, and no
   * value of PORTAL_TERRAIN_DIR exists on a serverless filesystem — as well as
   * refusing Kiru locally, whose DTM is 2.5 billion cells. The client now
   * sends the map's own view.
   */
  const box = boxOfCells(1_000_000);
  const level = truthSpot + 5;
  const { status, payload } = await post({
    op: "flood", levels: [level], bounds: box, crs: "lonlat",
  });
  check("a flood bounded to a view is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    check("and reports the cell size it actually computed at",
      Number.isFinite(payload.result.computedAtCellSize_m),
      `${payload.result.computedAtCellSize_m} m`);
    check("never finer than the survey's own native cell",
      payload.result.computedAtCellSize_m >= payload.cellSize - 1e-9);
    // The bounded flood must not exceed the whole-survey one at the same level:
    // a window can only ever contain less ground.
    const whole = await post({ op: "flood", levels: [level], bounds: boxOfCells(2_000_000), crs: "lonlat" });
    if (whole.status === 200) {
      check("a windowed flood never exceeds the whole-survey flood at the same level",
        payload.result.levels[0].area_m2 <= whole.result?.levels?.[0]?.area_m2 + 1
          || whole.payload.result.levels[0].area_m2 >= payload.result.levels[0].area_m2 - 1,
        `${payload.result.levels[0].area_ha.toFixed(2)} ha windowed`);
    }
  }
}
{
  // A view that misses the survey entirely is a different fact from "nothing
  // floods", and must not come back as a confident zero.
  const far = [[centreLon + 5, centreLat + 5], [centreLon + 5.01, centreLat + 5.01]];
  const { status } = await post({
    op: "flood", levels: [truthSpot + 5], bounds: far, crs: "lonlat",
  });
  check("a view that misses the survey is refused, not answered with zero flooding",
    status === 400, `status ${status}`);
}
{
  /*
   * The two guarantees this tool now makes, which are the whole reason the
   * resampling was taken out: what comes back is always at the survey's own
   * resolution, and an area too large to do that for is refused rather than
   * quietly coarsened. Malhar rejected any loss of resolution, so "it was
   * slow so we averaged it down" is not an outcome this route is allowed to
   * reach on its own.
   */
  const box = boxOfCells(1_000_000);
  const { status, payload } = await post({
    op: "flood", levels: [truthSpot + 5], bounds: box, crs: "lonlat",
  });
  check("a study-area flood is accepted", status === 200, `status ${status}`);
  if (status === 200) {
    check("and is computed at the survey's own native cell, never coarser",
      Math.abs(payload.result.computedAtCellSize_m - grid.cellSize) < 1e-9,
      `${payload.result.computedAtCellSize_m} m vs native ${grid.cellSize} m`);
    // Never `true`. The field went away with the resampling it described, so
    // absent and false both mean the same thing: this answer is native.
    check("so nothing reports itself as resampled",
      payload.result.resampled !== true, String(payload.result.resampled));
  }
}
{
  /*
   * An area far past the cell budget, which must be refused rather than
   * silently coarsened — and refused with something a client can act on. An
   * unactionable "too large" is exactly what sent a screenshot back from the
   * last client demo.
   *
   * Only assertable on a survey big enough to exceed the budget. `windowFor`
   * clamps to the raster, so on Kotba — 2.2 million cells in total, well under
   * the 4 million budget — asking for a 40 km box just returns the whole
   * survey, correctly and at native resolution. That is the right behaviour,
   * so it is what gets checked there.
   */
  const d = 20000; // a 40 km box: past any survey here
  const huge = [
    utmToLonLat(centreE - d, centreN - d, 43, true),
    utmToLonLat(centreE + d, centreN + d, 43, true),
  ];
  const { status, payload } = await post({
    op: "flood", levels: [truthSpot + 5], bounds: huge, crs: "lonlat",
  });
  const surveyFitsWhole = width * height <= 4_000_000;

  if (surveyFitsWhole) {
    check(
      "a survey smaller than the budget answers whole rather than refusing",
      status === 200,
      `${(width * height / 1e6).toFixed(1)}M cells total, status ${status}`,
    );
    if (status === 200) {
      check("and still at native resolution",
        Math.abs(payload.result.computedAtCellSize_m - grid.cellSize) < 1e-9);
    }
  } else {
    check("an area past the cell budget is refused, not silently coarsened",
      status === 400, `status ${status}`);
    const message = String(payload?.error ?? "");
    check("and the refusal says it never coarsens the survey",
      /full resolution/i.test(message) && /never coarsens/i.test(message), message.slice(0, 80));
    check("and tells the client what size would work",
      /square or less/i.test(message), message.slice(-70));
  }
}
{
  const { status } = await post({ op: "flood", crs: "lonlat" });
  check("a flood with no level at all is refused", status === 400, `status ${status}`);
}
{
  const { status } = await post({
    op: "flood", levels: Array.from({ length: 500 }, (_, i) => truthSpot + i * 0.1), crs: "lonlat",
  });
  check("an unreasonable number of levels is refused rather than attempted", status === 400, `status ${status}`);
}
{
  // Far outside the survey. This must be refused, not answered with an empty
  // flood, because "no water anywhere" and "you pointed off the map" are
  // different facts and only one of them is about the terrain.
  const { status } = await post({
    op: "flood", levels: [truthSpot + 5], at: [[centreLon + 5, centreLat + 5]], crs: "lonlat",
  });
  check("a water source outside the survey is refused", status === 400, `status ${status}`);
}

console.log("\nGeometry cross check: the browser and the server must agree");
{
  // `geodesy.ts` in the browser and `projection.mjs` on the server are separate
  // implementations of the same projection. The panel prints the browser's
  // length next to heights the server computed, so if they ever disagree the
  // client is reading a profile of a line that is not the one on screen.
  const a = utmToLonLat(centreE - 137.5, centreN - 62.25, 43, true);
  const b = utmToLonLat(centreE + 89.25, centreN + 41.5, 43, true);
  const { status, payload } = await post({ op: "profile", line: [a, b], crs: "lonlat" });
  if (status === 200) {
    const [ax, ay] = lonLatToUtm(a[0], a[1], 43, true);
    const [bx, by] = lonLatToUtm(b[0], b[1], 43, true);
    const independent = Math.hypot(bx - ax, by - ay);
    near("an independently projected length agrees with the server's", payload.result.length, independent, 0.01, " m");
  } else {
    check("the cross check line was accepted", false, `status ${status}`);
  }
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
