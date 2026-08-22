/**
 * The hydrology route, over HTTP, against precomputed layers for a real survey.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/hydrology-api-test.mjs
 *
 * Needs a server on :3000, `.env.local`, and hydrology generated for the site:
 *   node scripts/hydro-run.mjs --dtm portal-data/terrain/<slug>/dtm.tif \
 *     --out portal-data/hydrology/<slug>
 *
 * ## What is actually being checked
 *
 * The engine underneath is already validated: `hydro-test.mjs` runs 55
 * known-answer checks on synthetic surfaces, and `hydro-validate.mjs` agrees
 * with SAGA to 98% catchment IoU on the Kherwada fixture. So this suite is not
 * re-checking flow routing. It checks the things that live only in the route,
 * which are the four ways hydrology is quietly wrong in a product:
 *
 *   1. a cell count presented as an area
 *   2. a pour point that missed the channel, giving a tidy answer for the wrong
 *      catchment
 *   3. a catchment truncated by the survey edge, quoted as if it were complete
 *   4. a "flood" that is really a threshold, filling hollows water cannot reach
 *
 * Each of those produces a plausible number. None of them looks like an error.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SITE = process.env.SITE ?? "kotba-survey";
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const near = (label, a, b, tol, unit = "") =>
  check(label, Number.isFinite(a) && Math.abs(a - b) <= tol, `got ${a}, want ${b} ±${tol}${unit}`);

let owner;
try {
  const sql = postgres(val("DATABASE_URL"), {
    prepare: false, fetch_types: false, max: 2, connect_timeout: 8, onnotice() {},
  });
  [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
  await sql.end({ timeout: 3 });
} catch (error) {
  console.log(`\n  SKIPPED: the portal database is unreachable (${error.code ?? error.message}).\n`);
  process.exit(0);
}

const token = await new SignJWT({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

const endpoint = `${BASE}/api/portal/sites/${SITE}/hydrology`;

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
  try { payload = await response.json(); } catch { /* the body is the finding */ }
  return { status: response.status, payload };
}

// ---------------------------------------------------------------------------

console.log(`\nWhat has been computed for ${SITE}`);
let analysis;
{
  const { status, payload } = await post({ op: "layers" });
  check("the layer list is served", status === 200, `status ${status}`);
  if (status !== 200) {
    console.log("\n  Cannot continue without hydrology. Generate it with hydro-run.mjs.\n");
    process.exit(1);
  }
  analysis = payload.result.analysis;
  console.log(`  grid ${analysis.width} x ${analysis.height} at ${analysis.cellSize} m, ` +
    `${analysis.surveyArea_ha} ha, threshold ${analysis.streamThresholdCells} cells`);

  check("every layer states what produced it", payload.result.layers.every((l) => l.generator && l.derivedFrom));
  check("and the parameters it was produced with", payload.result.layers.every((l) => l.params?.cellSize));
  check("the response states the analysis cell size", payload.cellSize === analysis.cellSize);
  // The single most misreadable thing about this module: the hydrology grid is
  // coarser than the survey, deliberately, and nothing else on the page says so.
  check("and explains why hydrology is coarser than the survey", /coarser/i.test(payload.resolutionNote ?? ""));
  check("it is dated", Boolean(payload.generatedAt));
}

console.log("\nVectors the map draws");
for (const op of ["streams", "basins"]) {
  const { status, payload } = await post({ op });
  check(`${op} are served as GeoJSON`, status === 200 && payload.result.geojson?.type === "FeatureCollection",
    `status ${status}`);
  if (status === 200) {
    const f = payload.result.geojson.features;
    check(`  ${op} carry features`, f.length > 0, `${f.length}`);
    // RFC 7946: GeoJSON is WGS84 lon/lat. Serving projected metres here would
    // put the survey in the Atlantic as far as MapLibre is concerned.
    const [lon, lat] = flatten(f[0].geometry.coordinates);
    check(`  ${op} are in lon/lat, not raw eastings`,
      Math.abs(lon) <= 180 && Math.abs(lat) <= 90, `${lon}, ${lat}`);
  }
}

console.log("\nInspect: a cell count is not an area");
let sample;
{
  /*
   * Pick the survey's outlet, not just any point on a stream.
   *
   * The first vertex of a stream segment is its headwater, and a watershed
   * traced there is one cell: technically correct, and useless as a test,
   * because every downstream assertion then passes trivially against zero. So
   * the candidates are the ends of the highest order segments, and the one with
   * the largest contributing area wins. That point is where the survey actually
   * drains, which is the interesting case and the one a client clicks.
   */
  const { payload: streams } = await post({ op: "streams" });
  const features = streams.result.geojson.features;
  const highest = Math.max(...features.map((f) => f.properties.strahler_order ?? 0));
  const candidates = [];
  for (const f of features) {
    if ((f.properties.strahler_order ?? 0) < highest) continue;
    const coords = f.geometry.coordinates;
    const line = Array.isArray(coords[0][0]) ? coords[0] : coords;
    candidates.push(line[0], line[line.length - 1]);
    if (candidates.length >= 40) break;
  }

  let best = null;
  for (const point of candidates) {
    const { status, payload } = await post({ op: "inspect", at: point, crs: "lonlat" });
    if (status !== 200) continue;
    const area = payload.result.contributingArea_m2 ?? 0;
    if (!best || area > best.area) best = { point, area };
  }
  check("an outlet was found to test against", Boolean(best) && best.area > 0,
    best ? `${best.area.toFixed(0)} m² draining through it` : "none");
  sample = best.point;

  const [lon, lat] = sample;
  const { status, payload } = await post({ op: "inspect", at: [lon, lat], crs: "lonlat" });
  check("a point on a stream can be inspected", status === 200, `status ${status}`);
  if (status === 200) {
    const r = payload.result;
    check("it reports an elevation", Number.isFinite(r.elevation), `${r.elevation}`);
    check("and a slope in both units", Number.isFinite(r.slopeDegrees) && Number.isFinite(r.slopePercent));
    // The check this section exists for.
    check("contributing area is given, not only a cell count",
      Number.isFinite(r.contributingArea_m2) && Number.isFinite(r.contributingArea_ha));
    near("and the area is the count times cell area",
      r.contributingArea_m2, r.contributingCells * analysis.cellSize ** 2, 1e-6, " m²");
    near("with hectares consistent with square metres",
      r.contributingArea_ha, r.contributingArea_m2 / 10000, 1e-9, " ha");
    check("a point on a channel says so", r.onChannel === true, `order ${r.strahlerOrder}`);
    check("and carries a Strahler order", Number.isInteger(r.strahlerOrder) && r.strahlerOrder >= 1,
      `${r.strahlerOrder}`);
    check("it says which way the water leaves", r.drainsTo === null || Number.isFinite(r.drainsTo.easting));
  }
}

console.log("\nWatershed: the pour point must reach the channel, and say if it moved");
{
  const { status, payload } = await post({ op: "watershed", at: sample, crs: "lonlat" });
  check("a watershed is traced", status === 200, `status ${status}`);
  if (status === 200) {
    const r = payload.result;
    // Against the outlet this is a real catchment, not a single headwater cell.
    check("it reports a substantial area", r.cells > 100, `${r.area_ha.toFixed(3)} ha, ${r.cells} cells`);
    near("area is cells times cell area", r.area_m2, r.cells * analysis.cellSize ** 2, 1e-6, " m²");
    check("the catchment cannot exceed the survey",
      r.area_ha <= analysis.surveyArea_ha * 1.001,
      `${r.area_ha.toFixed(2)} of ${analysis.surveyArea_ha} ha`);
    check("the pour point is reported back", Number.isFinite(r.pourPoint.easting));
    check("and whether it was snapped to a channel", typeof r.pourPoint.snapped === "boolean",
      `snapped ${r.pourPoint.snapped} by ${r.pourPoint.snappedBy_m?.toFixed(2)} m`);
    check("truncation by the survey edge is reported", typeof r.truncatedBySurveyEdge === "boolean");
    // A flag beside a number does not stop the number being quoted alone.
    check("and when truncated, said in words too",
      !r.truncatedBySurveyEdge || /lower bound/i.test(r.note ?? ""), r.note ?? "");
    check("the catchment comes back as a polygon", r.geojson.features.length > 0);

    /*
     * The invariant that ties the two halves of this module together, and the
     * one that caught a real bug.
     *
     * Flow accumulation at a cell IS the number of cells draining through it,
     * counted during the batch run. A watershed traced from that cell is the set
     * of those cells, counted by walking the pointer grid. They are computed by
     * different code at different times and must agree exactly.
     *
     * When they did not, the cause was the route feeding ESRI direction codes to
     * a traversal expecting internal indices: no error, a valid polygon, and a
     * catchment of one cell where the accumulation said 7,246. Nothing else in
     * the suite noticed, because every downstream assertion passes happily
     * against zero.
     */
    const { payload: atPour } = await post({
      op: "inspect",
      at: r.pourPoint.lonlat,
      crs: "lonlat",
    });
    const accumulated = atPour.result.contributingCells;
    check(
      "the catchment holds exactly as many cells as the accumulation counted",
      r.cells === accumulated,
      `traced ${r.cells}, accumulated ${accumulated}`,
    );
  }
}

{
  /*
   * Deliberately off channel, but only just: about 5 m, which is a plausible
   * miss with a mouse and still well inside the survey. An earlier version of
   * this offset by 28 m, landed outside the data, got a 400, and the comparison
   * below never ran while the suite still reported green.
   */
  const off = [sample[0] + 0.00005, sample[1] + 0.00005];
  const { status, payload } = await post({ op: "watershed", at: off, crs: "lonlat" });
  check("an off channel click still returns a catchment", status === 200 && payload.result.area_ha > 0,
    `status ${status}`);
  if (status === 200) {
    console.log(`  ...snapped ${payload.result.pourPoint.snappedBy_m.toFixed(2)} m, ` +
      `${payload.result.area_ha.toFixed(3)} ha`);
  }

  // With snapping disabled the same click should generally drain far less
  // ground. This is the failure mode being guarded: quiet, tidy, and small.
  const { status: s2, payload: p2 } = await post({ op: "watershed", at: off, crs: "lonlat", snap: false });
  if (status === 200 && s2 === 200) {
    check("snapping is what makes the difference between a valley and a hillside",
      p2.result.area_ha <= payload.result.area_ha,
      `unsnapped ${p2.result.area_ha.toFixed(3)} ha vs snapped ${payload.result.area_ha.toFixed(3)} ha`);
    check("and turning it off is reported as not snapped", p2.result.pourPoint.snapped === false);
  }
}

console.log("\nSinks: depressions, with storage");
{
  const { status, payload } = await post({ op: "sinks", minDepth: 0.25 });
  check("sinks are served", status === 200, `status ${status}`);
  if (status === 200) {
    const r = payload.result;
    check("with the threshold echoed back", r.minDepth_m === 0.25);
    check("an area", r.area_m2 >= 0);
    check("and a storage volume", r.storage_m3 >= 0, `${r.storage_m3.toFixed(1)} m³`);
    check("the deepest is at least the threshold, or there are none",
      r.cells === 0 || r.deepest_m >= 0.25, `${r.deepest_m?.toFixed(3)} m`);

    // A higher threshold cannot select more ground than a lower one.
    const { payload: deeper } = await post({ op: "sinks", minDepth: 1.0 });
    check("a deeper threshold selects no more than a shallower one",
      deeper.result.area_m2 <= r.area_m2,
      `${deeper.result.area_m2.toFixed(0)} vs ${r.area_m2.toFixed(0)} m²`);
  }
}

console.log("\nFlood: a connected fill, never a bathtub");
{
  const { payload: inspected } = await post({ op: "inspect", at: sample, crs: "lonlat" });
  const ground = inspected.result.elevation;

  const { status, payload } = await post({
    op: "flood", at: sample, crs: "lonlat", level: ground + 1.5,
  });
  check("a flood is computed from a seed", status === 200, `status ${status}`);
  if (status === 200) {
    const r = payload.result;
    check("it reports an inundated area", r.area_m2 > 0, `${r.area_m2.toFixed(0)} m²`);
    check("and a storage volume", r.storage_m3 > 0, `${r.storage_m3.toFixed(1)} m³`);
    near("hectares agree with square metres", r.area_ha, r.area_m2 / 10000, 1e-9, " ha");
    check("the seed's ground level is reported", Number.isFinite(r.seedGround_m));
    // The distinction that matters, stated in the response rather than assumed.
    check("the method says it is a connected fill", /connected fill/i.test(r.method ?? ""));
    check("and warns that unreachable hollows stay dry", /stay dry|threshold/i.test(r.method ?? ""));
    check("a flood cannot cover more than the survey",
      r.area_ha <= analysis.surveyArea_ha * 1.001, `${r.area_ha.toFixed(2)} ha`);

    /*
     * The deepest water is a property of the lake, not of where you seeded it.
     *
     * This was reported as `level - groundAtSeed`, which is only the maximum
     * when the seed happens to be the lowest point flooded. Seeding 1.5 m above
     * a hillside floods the valley 30 m below and the figure still said 1.5 m,
     * under a label reading "Deepest".
     */
    check("the deepest water is at least the depth at the seed",
      r.maxDepth_m >= r.depthAtSeed_m - 1e-9,
      `deepest ${r.maxDepth_m.toFixed(2)} m vs at the seed ${r.depthAtSeed_m.toFixed(2)} m`);
    check("and no deeper than the level above the lowest ground it could reach",
      r.maxDepth_m <= r.level_m, `${r.maxDepth_m.toFixed(2)} m`);
    // Mean depth cannot exceed the deepest point. A max taken from the wrong
    // cell would routinely fail this on real terrain.
    check("mean depth does not exceed the deepest",
      r.storage_m3 / r.area_m2 <= r.maxDepth_m + 1e-9,
      `mean ${(r.storage_m3 / r.area_m2).toFixed(2)} m vs deepest ${r.maxDepth_m.toFixed(2)} m`);

    // Monotonic: raising the water cannot shrink the lake.
    const { payload: higher } = await post({
      op: "flood", at: sample, crs: "lonlat", level: ground + 3,
    });
    check("raising the level cannot shrink the flood",
      higher.result.area_m2 >= r.area_m2,
      `${higher.result.area_m2.toFixed(0)} vs ${r.area_m2.toFixed(0)} m²`);
    check("and cannot reduce the storage",
      higher.result.storage_m3 >= r.storage_m3,
      `${higher.result.storage_m3.toFixed(0)} vs ${r.storage_m3.toFixed(0)} m³`);
  }

  // Below the ground at the seed there is nothing to flood, and saying "0 m³"
  // would imply a computation happened. It is a bad request.
  const { status: low } = await post({ op: "flood", at: sample, crs: "lonlat", level: ground - 5 });
  check("a level below the seed's ground is refused, not answered with zero", low === 400, `status ${low}`);
}

console.log("\nRefusals and isolation");
{
  const { status } = await post({ op: "layers" }, { authorised: false });
  check("no session is refused", status === 401, `status ${status}`);
}
{
  const r = await fetch(`${BASE}/api/portal/sites/definitely-not-a-site/hydrology`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `sga_portal_session=${token}` },
    body: JSON.stringify({ op: "layers" }),
  });
  check("an unknown site is 404, never a confirmation", r.status === 404, `status ${r.status}`);
}
{
  const { status } = await post({ op: "definitely-not-an-op" });
  check("an unknown op is refused with a readable message", status === 400, `status ${status}`);
}
{
  const { status } = await post({ op: "inspect", at: [0, 0], crs: "lonlat" });
  check("a point far outside the survey is refused", status === 400, `status ${status}`);
}
{
  const { status } = await post({ op: "inspect", at: sample, crs: "wgs84" });
  check("an unknown CRS is refused rather than guessed", status === 400, `status ${status}`);
}
{
  const { status } = await post({ op: "flood", at: sample, crs: "lonlat" });
  check("a flood with no level is refused", status === 400, `status ${status}`);
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);

/** First coordinate pair out of an arbitrarily nested GeoJSON coordinate array. */
function flatten(coords) {
  let c = coords;
  while (Array.isArray(c[0])) c = c[0];
  return c;
}
