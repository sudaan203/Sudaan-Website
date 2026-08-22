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
