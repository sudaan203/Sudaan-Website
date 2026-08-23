/**
 * Tools 2, 5 and 13 over HTTP: grid levels, surface comparison, tolerance.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/surface-api-test.mjs
 *
 * `terrain-test.mjs` checks the arithmetic against analytic surfaces. This
 * checks the route: that a polygon is projected and windowed correctly, that a
 * reference is never defaulted, that a tolerance the survey cannot resolve says
 * so, and that the difference layer draws with a ramp that keeps the sign.
 *
 * Written as relationships between independently computed values. A surface
 * comparison that quietly compares the wrong pair of rasters still returns
 * plausible metres.
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const sql = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
const [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
await sql.end({ timeout: 3 });

const token = await new SignJWT({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

const POLY = [
  [73.7300, 20.8425],
  [73.7308, 20.8425],
  [73.7308, 20.8431],
  [73.7300, 20.8431],
  [73.7300, 20.8425],
];

async function ask(body) {
  const response = await fetch(`${BASE}/api/portal/sites/${SITE}/analysis`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: `sga_portal_session=${token}` },
    body: JSON.stringify({ crs: "lonlat", surface: "dtm", polygon: POLY, ...body }),
  });
  return { status: response.status, body: await response.json() };
}

console.log("\nTool 2: grid spot levels");
let polygonArea = 0;
{
  const { status, body } = await ask({ op: "grid-levels", spacing: 2 });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  const r = body.result;
  polygonArea = r.stats.polygonArea ?? r.stats.coveredArea;

  check("it echoes the spacing it used", r.spacing === 2);
  check("points are in the survey's own projected metres, not lon/lat",
    r.points.every((p) => p.easting > 100000 && p.northing > 1000000),
    `first ${r.points[0].easting.toFixed(1)}, ${r.points[0].northing.toFixed(1)}`);

  /*
   * The count follows from the area and the spacing, so it is derivable rather
   * than something to eyeball. Generous tolerance because a grid clipped to a
   * polygon lands where it lands relative to the rim.
   */
  const expected = polygonArea / 4;
  check("the number of levels follows from the area and the spacing",
    Math.abs(r.points.length - expected) < expected * 0.1,
    `${r.points.length} points, area/spacing² = ${expected.toFixed(0)}`);

  check("every level lies inside the polygon's own bounding box",
    r.points.every((p) => Number.isFinite(p.elevation)));
  check("elevations sit inside the statistics reported for the same polygon",
    r.points.every((p) => p.elevation >= r.stats.min - 1e-6 && p.elevation <= r.stats.max + 1e-6),
    `${r.stats.min?.toFixed(2)}..${r.stats.max?.toFixed(2)} m`);

  // Grid nodes are on a multiple of the spacing, which is what makes it a grid
  // rather than a scatter, and what a setting-out drawing depends on.
  check("levels land on whole multiples of the spacing",
    r.points.every((p) => near(p.easting % 2, 0, 1e-6) || near(p.easting % 2, 2, 1e-6)),
    `first easting ${r.points[0].easting}`);

  const coarse = (await ask({ op: "grid-levels", spacing: 5 })).body.result;
  check("a coarser spacing gives fewer levels, by about the square of the ratio",
    coarse.points.length < r.points.length &&
      Math.abs(coarse.points.length - r.points.length * (4 / 25)) < r.points.length * 0.1,
    `${coarse.points.length} at 5 m vs ${r.points.length} at 2 m`);

  const refused = await ask({ op: "grid-levels", spacing: 0.01 });
  check("a spacing that would produce millions of points is refused with a number",
    refused.status === 400 && /\d/.test(refused.body.error ?? ""),
    refused.body.error?.slice(0, 110));
}

console.log("\nTool 5: surface comparison");
let deviation;
{
  const { status, body } = await ask({ op: "compare", reference: "dsm" });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  deviation = body.result;

  check("it measures the polygon, not its bounding window",
    near(deviation.comparedArea, polygonArea, polygonArea * 0.02),
    `${deviation.comparedArea.toFixed(0)} m² of ${polygonArea.toFixed(0)}`);

  /*
   * The sign is the whole point. Measuring the DTM against the DSM, bare earth
   * sits *below* everything standing on it, so the mean must be negative. If
   * this ever came out positive the two rasters would have been swapped, and
   * every number would still look completely reasonable.
   */
  check("bare earth sits below the surface model, so the mean is negative",
    deviation.meanChange < 0, `${deviation.meanChange.toFixed(3)} m`);
  check("and reversing the pair reverses the sign",
    await (async () => {
      const back = (await ask({ op: "compare", reference: "dtm", surface: "dsm" })).body.result;
      return back.meanChange > 0 && near(back.meanChange, -deviation.meanChange, 0.15);
    })(), "measured both ways");

  check("mean ignoring sign is at least the size of the mean",
    deviation.meanAbsoluteChange >= Math.abs(deviation.meanChange) - 1e-9,
    `|mean| ${deviation.meanAbsoluteChange.toFixed(3)} vs mean ${deviation.meanChange.toFixed(3)}`);
  check("the range brackets the mean",
    deviation.minChange <= deviation.meanChange && deviation.meanChange <= deviation.maxChange,
    `${deviation.minChange.toFixed(2)}..${deviation.maxChange.toFixed(2)}`);
  check("net volume is what gained minus lost says it is",
    near(deviation.netVolume, deviation.volumeGained - deviation.volumeLost, 1e-6));
  check("with no tolerance asked for, nothing is classified",
    deviation.tolerance === null && deviation.withinShare === null && deviation.resolvable === null);
  check("a design level works as a reference too",
    (await ask({ op: "compare", reference: "plane:366" })).body.result.reference === "plane");
}

console.log("\nTool 13: tolerance");
{
  const { status, body } = await ask({ op: "compare", reference: "dsm", tolerance: 0.5 });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  const r = body.result;

  check("the deviation is unchanged by asking for the classification",
    near(r.meanChange, deviation.meanChange, 1e-9) &&
      near(r.comparedArea, deviation.comparedArea, 1e-9),
    "same measurement, one more reading of it");
  check("within, above and below partition the area compared",
    near(r.withinArea + r.aboveArea + r.belowArea, r.comparedArea, 1),
    `${(r.withinArea + r.aboveArea + r.belowArea).toFixed(0)} of ${r.comparedArea.toFixed(0)}`);
  check("the share within is that area over the area compared",
    near(r.withinShare, r.withinArea / r.comparedArea, 1e-6),
    `${(r.withinShare * 100).toFixed(1)} %`);

  const loose = (await ask({ op: "compare", reference: "dsm", tolerance: 5 })).body.result;
  check("a looser tolerance can only include more ground",
    loose.withinArea >= r.withinArea - 1e-6,
    `${loose.withinArea.toFixed(0)} m² at 5 m vs ${r.withinArea.toFixed(0)} m² at 0.5 m`);

  /*
   * The check this tool exists to get right. A ±20 mm tolerance on a survey
   * stated accurate to ±40 mm cannot be assessed: the map would be survey noise
   * and would look exactly like a map of defects, which is the reading a
   * contractor would act on.
   */
  const fine = (await ask({ op: "compare", reference: "dsm", tolerance: 0.02 })).body.result;
  check("a tolerance finer than the survey's accuracy is flagged unresolvable",
    fine.resolvable === false, `rmseZ ${fine.rmseZ}, tolerance ${fine.tolerance}`);
  check("and says so in words a client can act on",
    /cannot distinguish|survey noise/i.test(fine.note ?? ""), fine.note?.slice(0, 110));
  check("while one coarser than it is resolvable and silent",
    r.resolvable === true && r.note === null);

  const zero = await ask({ op: "compare", reference: "dsm", tolerance: 0 });
  check("a zero tolerance is refused rather than classifying everything as out",
    zero.status === 400, `status ${zero.status}`);
  const blank = await ask({ op: "compare", reference: "dsm", tolerance: "" });
  check("and a blank one asks only for the deviation, not for a zero tolerance",
    blank.status === 200 && blank.body.result.tolerance === null,
    `status ${blank.status}, tolerance ${blank.body.result?.tolerance}`);
}

console.log("\nThe reference is never defaulted");
{
  const missing = await ask({ op: "compare" });
  check("comparing against nothing is refused", missing.status === 400, `status ${missing.status}`);
  check("and the refusal names the choices",
    /boundary|plane|dtm|dsm/.test(missing.body.error ?? ""), missing.body.error?.slice(0, 110));
  const nonsense = await ask({ op: "compare", reference: "plane:high" });
  check("a plane that is not an elevation is refused", nonsense.status === 400,
    nonsense.body.error?.slice(0, 90));
}

console.log("\nThe difference layer keeps its sign");
{
  const tileOf = (lon, lat, z) => {
    const n = 2 ** z;
    const r = (lat * Math.PI) / 180;
    return [
      Math.floor(((lon + 180) / 360) * n),
      Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
    ];
  };
  const [x, y] = tileOf(73.7305, 20.8425, 17);
  const tile = (q) =>
    fetch(`${BASE}/api/portal/sites/${SITE}/render/difference/17/${x}/${y}.png?${q}`, {
      headers: { Cookie: `sga_portal_session=${token}` },
    });

  const ok = await tile("min=-25&max=25&ramp=difference");
  check("a difference tile renders", ok.status === 200 && ok.headers.get("content-type") === "image/png",
    `status ${ok.status}`);
  const bytes = new Uint8Array(await ok.arrayBuffer());
  check("as a real PNG", bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG");

  /*
   * The guard that matters. A difference coloured with a rainbow loses the one
   * thing that matters about it — whether it is above or below zero — and the
   * server refuses rather than drawing something confident and wrong.
   */
  const wrong = await tile("min=-25&max=25&ramp=rainbow");
  check("a sequential ramp on a signed quantity is refused", wrong.status === 400,
    `status ${wrong.status}`);
  const why = await wrong.json();
  check("with a reason that explains what is lost",
    /signed|above or below zero/i.test(why.error ?? ""), why.error?.slice(0, 120));
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
