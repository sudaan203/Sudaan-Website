/**
 * The shapefile route over HTTP: download, and upload.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/shapefile-api-test.mjs
 *
 * `shapefile-test.mjs` proves the binary formats are correct in isolation.
 * This proves the route: that a drawn point/line/polygon is projected into the
 * survey's own UTM zone before it is written, that an uploaded shapefile comes
 * back reprojected to longitude and latitude ready for the map, that a design
 * surface with no `.prj` is refused rather than guessed at, and that
 * authorisation runs before any of it.
 *
 * The strongest check here, and the one Malhar's tool exists for: download a
 * polygon, then upload the very zip that came back, and require the point that
 * lands on the map to be within millimetres of the point that was drawn. If a
 * client cannot trust that round trip, nothing else this route does matters.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { readShapefileGeometry, readDbf, writeShapefilePrj, parseShapefilePrj } from "../src/lib/geo/shapefile.mjs";
import { readZip, writeZip } from "../src/lib/geo/zip.mjs";
import { lonLatToUtm, utmToLonLat } from "../src/lib/geo/projection.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SITE = process.env.SITE ?? "kotba-survey";
const ZONE = 43;
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const sql = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
const [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
await sql.end({ timeout: 3 });

const token = await new SignJWT({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

const endpoint = `${BASE}/api/portal/sites/${SITE}/shapefile`;
const authed = (init) => fetch(endpoint, { ...init, headers: { ...init.headers, Cookie: `sga_portal_session=${token}` } });

console.log("\nAuthorisation, before anything is opened");
{
  const anonymous = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "download", geometryType: "point", features: [] }),
  });
  check("no session is refused", anonymous.status === 401, `status ${anonymous.status}`);

  const missing = await fetch(`${BASE}/api/portal/sites/no-such-site/shapefile`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: `sga_portal_session=${token}` },
    body: JSON.stringify({ op: "download", geometryType: "point", features: [] }),
  });
  check("an unknown site is a 404", missing.status === 404, `status ${missing.status}`);
}

console.log("\nDownload: a point");
{
  const feature = { geometry: { type: "Point", coordinates: [73.73081948186243, 20.842534656568944] } };
  const response = await authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "download", geometryType: "point", features: [feature] }),
  });
  check("the route answers", response.ok, `status ${response.status}`);
  check("as a zip", response.headers.get("content-type") === "application/zip",
    response.headers.get("content-type"));
  check("with a sensible file name", /filename="[a-z0-9_-]+\.zip"/i.test(
    response.headers.get("content-disposition") ?? ""), response.headers.get("content-disposition"));

  const zip = Buffer.from(await response.arrayBuffer());
  const entries = readZip(zip);
  check("all four files are present", ["shp", "shx", "dbf", "prj"].every((ext) =>
    entries.some((e) => e.name.toLowerCase().endsWith(`.${ext}`))),
    entries.map((e) => e.name).join(", "));

  const shp = entries.find((e) => e.name.endsWith(".shp")).data;
  const geo = readShapefileGeometry(shp);
  check("it is a point shapefile", geo.kind === "point");

  /*
   * The check that matters: the server projects lon/lat into the survey's own
   * UTM zone before writing, so the raw bytes in the .shp must be in metres
   * near 3.6e5/2.3e6, not degrees near 73/20. A route that forgot to project
   * would still produce a file that opens, with every point in the wrong place
   * by exactly the radius of the earth.
   */
  const [x, y] = geo.geometries[0].coordinates;
  check("the point was projected into UTM before writing, not left in degrees",
    x > 100000 && y > 1000000, `[${x}, ${y}]`);
  const [ex, ey] = lonLatToUtm(feature.geometry.coordinates[0], feature.geometry.coordinates[1], ZONE, true);
  check("and the projection is correct to sub-millimetre precision",
    near(x, ex, 1e-6) && near(y, ey, 1e-6), `off by ${Math.hypot(x - ex, y - ey).toExponential(2)} m`);

  const prj = entries.find((e) => e.name.endsWith(".prj")).data.toString("latin1");
  check("the .prj names the survey's own UTM zone", prj.includes("UTM_Zone_43N"), prj.slice(0, 60));
}

console.log("\nDownload: refusals");
{
  const empty = await authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "download", geometryType: "point", features: [] }),
  });
  check("no features is refused", empty.status === 400, `status ${empty.status}`);

  const badKind = await authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "download", geometryType: "circle", features: [{ geometry: { type: "Point", coordinates: [0, 0] } }] }),
  });
  check("an unknown geometry type is refused", badKind.status === 400, `status ${badKind.status}`);

  const mismatched = await authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      op: "download", geometryType: "point",
      features: [{ geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }],
    }),
  });
  check("a geometry that does not match the declared type is refused", mismatched.status === 400,
    `status ${mismatched.status}`);
}

console.log("\nDownload: a polygon, with real vertices");
let downloadedPolygonZip;
const drawnPolygon = [
  [73.7300, 20.8425],
  [73.7308, 20.8425],
  [73.7308, 20.8431],
  [73.7300, 20.8431],
  [73.7300, 20.8425],
];
{
  const response = await authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      op: "download", geometryType: "polygon", name: "boundary check",
      features: [{ geometry: { type: "Polygon", coordinates: [drawnPolygon] } }],
    }),
  });
  check("the route answers", response.ok, `status ${response.status}`);
  downloadedPolygonZip = Buffer.from(await response.arrayBuffer());
  const stem = (response.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1];
  check("the file name is sanitised from what was asked for", stem === "boundary_check.zip", stem);
}

console.log("\nUpload: the same zip that was just downloaded, round-tripped");
{
  const form = new FormData();
  form.append("file", new Blob([downloadedPolygonZip], { type: "application/zip" }), "boundary_check.zip");
  const response = await authed({ method: "POST", body: form });
  check("the route answers", response.ok, `status ${response.status}`);
  const body = await response.json();

  check("it is read back as a polygon", body.kind === "polygon", body.kind);
  check("with one feature", body.count === 1, `count ${body.count}`);
  check("and the survey's own UTM zone is recognised", body.crs.epsg === 32643, JSON.stringify(body.crs));

  const ring = body.featureCollection.features[0].geometry.coordinates[0];
  check("every original vertex reappears, to survey precision",
    drawnPolygon.every((original) =>
      ring.some(([lon, lat]) => near(lon, original[0], 1e-7) && near(lat, original[1], 1e-7)),
    ),
    JSON.stringify(ring[0]));

  /*
   * The round trip this tool exists to prove. Downloaded, then uploaded, the
   * first vertex must land within millimetres of where it started — not
   * "close on a map", actually within the survey's own accuracy. Compared in
   * UTM, where a millimetre means a millimetre, rather than in degrees where
   * it does not.
   */
  const [ux, uy] = lonLatToUtm(ring[0][0], ring[0][1], ZONE, true);
  const [dx, dy] = lonLatToUtm(drawnPolygon[0][0], drawnPolygon[0][1], ZONE, true);
  /*
   * A millimetre, not a micrometre. This vertex has been through the forward
   * UTM series twice and the inverse series once by this point — drawn ->
   * projected on download -> written -> read -> reprojected to lon/lat on
   * upload -> projected again here to compare — and `projection.mjs` states its
   * own accuracy as "millimetres", not more, because it is a truncated series
   * expansion rather than a closed form. A tighter tolerance than the function
   * itself promises is not a stricter test, it is a wrong one; the first version
   * of this check used 1e-6 m and failed on 0.047 mm of entirely expected
   * numerical noise.
   */
  check("downloaded then re-uploaded, a vertex is unchanged to survey precision",
    near(ux, dx, 1e-3) && near(uy, dy, 1e-3),
    `drift ${(Math.hypot(ux - dx, uy - dy) * 1000).toFixed(3)} mm`);
}

console.log("\nUpload: refusals");
{
  const noPrj = writeZip([{ name: "onlyshp.txt", data: Buffer.from("not a shapefile") }]);
  const form1 = new FormData();
  form1.append("file", new Blob([noPrj]), "bad.zip");
  const r1 = await authed({ method: "POST", body: form1 });
  check("a zip with no .shp is refused", r1.status === 400, `status ${r1.status}`);
  const body1 = await r1.json();
  check("  with a reason naming what is missing", /\.shp/i.test(body1.error ?? ""), body1.error);

  const notAZip = new FormData();
  notAZip.append("file", new Blob([Buffer.from("hello")]), "not-a-zip.zip");
  const r2 = await authed({ method: "POST", body: notAZip });
  check("a file that is not actually a zip is refused, not 500", r2.status === 400, `status ${r2.status}`);

  const noFile = new FormData();
  const r3 = await authed({ method: "POST", body: noFile });
  check("a multipart request with no file is refused", r3.status === 400, `status ${r3.status}`);
}

console.log("\nUpload: a shapefile with no .prj is refused rather than placed guessing");
{
  // Built directly from the engine, bypassing this route's own download path,
  // so the check is independent of whether download happens to always attach one.
  const { writeShapefileGeometry, writeDbf } = await import("../src/lib/geo/shapefile.mjs");
  const { shp, shx } = writeShapefileGeometry("point", [{ type: "Point", coordinates: [361500, 2420900] }]);
  const dbf = writeDbf([{ id: 1 }]);
  const zip = writeZip([
    { name: "noprj.shp", data: shp },
    { name: "noprj.shx", data: shx },
    { name: "noprj.dbf", data: dbf },
  ]);
  const form = new FormData();
  form.append("file", new Blob([zip]), "noprj.zip");
  const response = await authed({ method: "POST", body: form });
  check("refused", response.status === 400, `status ${response.status}`);
  const body = await response.json();
  check("naming the actual problem: no stated projection", /projection|prj/i.test(body.error ?? ""),
    body.error);
}

console.log("\nUpload: a shapefile in a different UTM zone still places correctly");
{
  // Zone 44, a different projection from the survey's own 43 — the tool exists
  // to compare against something else, and refusing anything not in the
  // survey's own zone would defeat that.
  const { writeShapefileGeometry, writeDbf } = await import("../src/lib/geo/shapefile.mjs");
  const zone44Point = [255000, 2305000]; // an arbitrary point, zone 44N
  const { shp, shx } = writeShapefileGeometry("point", [{ type: "Point", coordinates: zone44Point }]);
  const dbf = writeDbf([{ id: 1, source: "other software" }]);
  const prj = Buffer.from(writeShapefilePrj(32644), "latin1");
  const zip = writeZip([
    { name: "zone44.shp", data: shp }, { name: "zone44.shx", data: shx },
    { name: "zone44.dbf", data: dbf }, { name: "zone44.prj", data: prj },
  ]);
  const form = new FormData();
  form.append("file", new Blob([zip]), "zone44.zip");
  const response = await authed({ method: "POST", body: form });
  check("a different zone is accepted, not refused for disagreeing with the survey",
    response.ok, `status ${response.status}`);
  const body = await response.json();
  check("the detected zone is the file's own, not the survey's", body.crs.epsg === 32644,
    JSON.stringify(body.crs));

  const [lon, lat] = body.featureCollection.features[0].geometry.coordinates;
  const [ex, ey] = utmToLonLat(zone44Point[0], zone44Point[1], 44, true);
  check("reprojected correctly using its own zone", near(lon, ex, 1e-9) && near(lat, ey, 1e-9));
}

// ---------------------------------------------------------------------------
console.log("\nThe projection comes from the survey, not only from its manifest");
{
  /*
   * `siteUtmZone` used to read the zone from the map manifest alone and refuse
   * the export when it was absent. Kiru's manifest carries no `utmZone` on any
   * layer, so every shapefile export from that survey answered "This site has
   * no recorded UTM zone to export in" — while every other tool on the same
   * site worked, because they all read the zone from the raster.
   *
   * The tool built so a client could check our coordinates against his own
   * software was the one tool that could not run on the survey he was checking,
   * and nothing caught it because the suite only ever ran against Kotba, whose
   * manifest happens to carry the zone.
   *
   * Checked here for whichever survey SITE names, so the next survey published
   * without a complete manifest fails this rather than a client.
   */
  // The point need not be inside the survey: the bug was in looking up the
  // site's zone, not in projecting the geometry into it.
  const response = await authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      op: "download",
      geometryType: "point",
      features: [{ geometry: { type: "Point", coordinates: [73.73, 20.84] }, properties: {} }],
    }),
  });
  check(`${SITE} can export at all`, response.ok, `status ${response.status}`);

  if (response.ok) {
    const entries = readZip(Buffer.from(await response.arrayBuffer()));
    const prj = entries.find((e) => e.name.endsWith(".prj"));
    check("the zip carries a .prj", Boolean(prj));
    if (prj) {
      const crs = parseShapefilePrj(prj.data.toString("latin1"));
      check("and it names a real UTM zone rather than defaulting",
        Number.isFinite(crs.epsg) &&
          ((crs.epsg >= 32601 && crs.epsg <= 32660) || (crs.epsg >= 32701 && crs.epsg <= 32760)),
        `EPSG:${crs.epsg} — ${crs.description}`);
    }
  }
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
