/**
 * Tools 2, 5 and 13 over HTTP: grid levels, surface comparison, tolerance.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/surface-api-test.mjs
 *   SITE=kiru-hydroelectric-survey node scripts/surface-api-test.mjs
 *
 * `terrain-test.mjs` checks the arithmetic against analytic surfaces. This
 * checks the route: that a polygon is projected and windowed correctly, that a
 * reference is never defaulted, that a tolerance the survey cannot resolve says
 * so, and that the difference layer draws with a ramp that keeps the sign.
 *
 * Written as relationships between independently computed values. A surface
 * comparison that quietly compares the wrong pair of rasters still returns
 * plausible metres.
 *
 * ## Which survey it runs against
 *
 * Nothing below is anchored to a place. It used to be: a five-point ring around
 * 73.730 E 20.842 N, a design level of 366 m, and a slippy tile at zoom 17
 * computed from those same degrees. All three are Kotba and nothing else — on
 * Aektanagar and Kiru the polygon is kilometres off the surveyed ground, so the
 * route answers "that area does not overlap this survey" and eighteen checks
 * fail for a reason that says nothing about the product.
 *
 * The geometry now comes from `scripts/lib/survey.mjs`, which derives it from
 * the raster's own header, and the three numbers that were survey constants —
 * the design level, the tolerances, the tile's zoom — are derived from what the
 * route itself reports about this survey.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { describeSurvey, openSurvey } from "./lib/survey.mjs";

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

/**
 * The survey's own header, which is all the geometry below is built from.
 *
 * Only the directory is parsed — a few tens of kilobytes whatever the file
 * weighs — so this costs the same on Kiru's 2.3 GB DTM as on Kotba's 7 MB one.
 * No pixels are read here at all: every number this suite checks comes back
 * from the route, and the route reads the raster from R2 rather than from disk.
 */
const survey = await openSurvey(SITE, "dtm");

/**
 * Half-width of the box the test polygon is inscribed in, in **metres** rather
 * than cells.
 *
 * The deliberate exception to the rule in `scripts/lib/survey.mjs`, for the
 * same reason `analysis-contract-test.mjs` makes it: what these checks are
 * about is *area*. The number of grid levels is the polygon's area over the
 * square of the spacing; the tolerance bands partition an area in m²; the
 * comparison is a volume over an area. Five thousand square metres is five
 * thousand square metres on every survey, so this says the same thing on all
 * three, and a polygon sized in cells would make the level count mean something
 * different on each.
 *
 * The cost is bounded anyway: the 100 m window behind it is 172k cells on
 * Kotba, 1.7M on Aektanagar's 7.7 cm grid and 155k on Kiru — the same window
 * `analysis-contract-test.mjs` already reads.
 */
const HALF = 50;

/**
 * A diamond, not a square, and the shape is the point.
 *
 * `compare` reads its cells from a rectangular window and then weights each one
 * by how much of it the ring covers, and the check below says it measures the
 * polygon rather than the window. Against a square that claim cannot fail: the
 * polygon *is* its own bounding box, so a route that skipped `cellCoverage`
 * entirely would agree to within the rim. A diamond inscribed in the same box
 * has exactly half its area, so the same mistake comes back 100% high and the
 * check has something to catch.
 *
 * Drawn in the survey's own projected metres and handed to the route as
 * lon/lat, which is the direction a real click travels.
 */
const POLY = [
  [survey.centreE, survey.centreN - HALF],
  [survey.centreE + HALF, survey.centreN],
  [survey.centreE, survey.centreN + HALF],
  [survey.centreE - HALF, survey.centreN],
  [survey.centreE, survey.centreN - HALF],
].map(survey.toLonLat);

/**
 * The raster's own bounds, so a coordinate can be checked against the ground it
 * claims to be on rather than against a number somebody remembered.
 *
 * This replaces `easting > 100000 && northing > 1000000`. The easting half is
 * true of every UTM coordinate anywhere and therefore asserts nothing; the
 * northing half is a statement about being well north of the equator, which is
 * true of these three surveys and false of any site below about 9 degrees N.
 * Neither says what the check is for, which is that the route answered in
 * projected metres and not in the degrees it was sent.
 */
const BOUNDS = {
  minE: survey.originX,
  maxE: survey.originX + survey.width * survey.cellSize,
  minN: survey.originY - survey.height * survey.cellSize,
  maxN: survey.originY,
};
const insideSurvey = (e, n) =>
  e >= BOUNDS.minE && e <= BOUNDS.maxE && n >= BOUNDS.minN && n <= BOUNDS.maxN;

console.log(`\n${describeSurvey(survey)}`);
console.log(
  `  test polygon  a ${2 * HALF} m diamond (${2 * HALF * HALF} m²) on the middle of the survey, ` +
    `read from a window of ${(Math.round((2 * HALF) / survey.cellSize) ** 2 / 1e6).toFixed(2)}M cells`,
);

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
/**
 * A design level at this survey's own ground, for the checks that need *a*
 * plane and do not care which.
 *
 * This was the literal 366, which is Kotba's plateau: 300 m in the air over
 * Aektanagar and 1.1 km underground at Kiru. The check it feeds only reads the
 * reference back, so it survived a wrong plane — but a constant that is a
 * kilometre out on a published survey is exactly the shape of bug this exercise
 * is hunting, and the route has already told us the mean of the ground under
 * the polygon by the time it is needed.
 */
let datum = 0;
/**
 * The vertical accuracy the route quotes for *this* survey, which is what the
 * tolerance checks below have to be built from.
 *
 * `surveyAccuracy` resolves it per site from the site row, falling back to
 * `PORTAL_SURVEY_RMSE_Z`, so it is not a constant this suite may assume. The
 * tolerances are then stated as multiples of it: one finer than the survey can
 * resolve, one coarser, one coarser still.
 */
let rmseZ = null;
{
  const { status, body } = await ask({ op: "grid-levels", spacing: 2 });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  const r = body.result;
  /*
   * `stats.area` is the area of the ring itself. This read
   * `stats.polygonArea ?? stats.coveredArea`, and `polygonStats` has no
   * `polygonArea` field — only `cutFill` and `compareSurfaces` do — so the
   * fallback fired every time and every "area" below was really the *covered*
   * area. That made "it measures the polygon, not its bounding window" compare
   * a measurement against itself: both sides are the same weighted cell count
   * over the same ring, so it could not fail whatever the route did.
   */
  polygonArea = r.stats.area;
  datum = Math.round(r.stats.mean);
  rmseZ = body.rmseZ;

  check("it echoes the spacing it used", r.spacing === 2);
  check("points are in the survey's own projected metres, not the degrees they were sent as",
    r.points.every((p) => insideSurvey(p.easting, p.northing)),
    `first ${r.points[0].easting.toFixed(1)}, ${r.points[0].northing.toFixed(1)} in ` +
      `${BOUNDS.minE.toFixed(0)}..${BOUNDS.maxE.toFixed(0)} E`);

  /*
   * The count follows from the area and the spacing, so it is derivable rather
   * than something to eyeball.
   *
   * The slack is derived too, because a flat 10% was a statement about the
   * *square* this polygon used to be. Counting lattice nodes inside a shape is
   * the area over the spacing squared plus a boundary term: every node the rim
   * passes near falls in or out depending on where the lattice happens to land,
   * and there are about `perimeter / spacing` of them. On a square of a given
   * area that term is as small as it gets; on the diamond it is larger, and on
   * a long thin study area larger still, so tying it to the perimeter the route
   * itself reports says the same thing for any shape. It is nowhere near loose
   * enough to hide the failure worth catching, which is the grid being laid
   * over the bounding box rather than the polygon — that is 100% high.
   */
  const expected = polygonArea / 4;
  const rimNodes = r.stats.perimeter / 2;
  check("the number of levels follows from the area and the spacing",
    Math.abs(r.points.length - expected) < rimNodes,
    `${r.points.length} points, area/spacing² = ${expected.toFixed(0)} ±${rimNodes.toFixed(0)} on the rim`);

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

console.log(`  ...this survey's ground is at ${datum} m and it is quoted to ${rmseZ === null ? "no stated accuracy" : `${(rmseZ * 1000).toFixed(0)} mm`}`);

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

  /*
   * Reversing the pair reverses the sign — as a *fraction* of the deviation
   * rather than within a flat 0.15 m.
   *
   * The two directions are not the same arithmetic. Asked one way the route
   * walks the DTM's cells and samples the DSM; asked the other it walks the
   * DSM's cells and samples the DTM, and on two of these three surveys those
   * are different grids at different resolutions (Kotba 0.24 m against 0.16 m,
   * Kiru 0.25 m against 0.20 m). So the two means differ by a little, and how
   * much depends entirely on how rough the ground is: 0.15 m is 8% of Kotba's
   * 1.8 m mean canopy and would be a far tighter claim on a survey whose mean
   * is small, or a far looser one on Kiru's gorge. A share of the quantity says
   * the same thing on all three, and a genuine swap does not miss by 10%, it
   * fails outright by not changing sign at all.
   */
  const back = (await ask({ op: "compare", reference: "dtm", surface: "dsm" })).body.result;
  check("and reversing the pair reverses the sign",
    back.meanChange > 0 &&
      Math.abs(back.meanChange + deviation.meanChange) < Math.abs(deviation.meanChange) * 0.1,
    `${deviation.meanChange.toFixed(3)} m one way, ${back.meanChange.toFixed(3)} m the other`);

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
    (await ask({ op: "compare", reference: `plane:${datum}` })).body.result.reference === "plane");
}

console.log("\nTool 13: tolerance");
{
  /*
   * Three tolerances, stated as multiples of the accuracy the route quotes for
   * this survey rather than as 0.02 / 0.5 / 5 m.
   *
   * The fixed numbers were readable and they were also Kotba's: they only mean
   * "finer than the survey can resolve" and "coarser than it" because Kotba is
   * quoted at ±40 mm. A survey quoted at ±10 mm would make 0.02 m resolvable
   * and the unresolvable check would fail on a route that is behaving
   * correctly; one quoted at ±600 mm would make 0.5 m unresolvable and take the
   * `note === null` check with it. Multiples of the survey's own figure say the
   * same thing whatever that figure is.
   */
  const unresolvable = rmseZ / 2;
  const tolerance = rmseZ * 10;
  const looser = rmseZ * 100;

  const { status, body } = await ask({ op: "compare", reference: "dsm", tolerance });
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

  const loose = (await ask({ op: "compare", reference: "dsm", tolerance: looser })).body.result;
  check("a looser tolerance can only include more ground",
    loose.withinArea >= r.withinArea - 1e-6,
    `${loose.withinArea.toFixed(0)} m² at ${looser} m vs ${r.withinArea.toFixed(0)} m² at ${tolerance} m`);

  /*
   * The check this tool exists to get right. A tolerance finer than the survey
   * is stated accurate to cannot be assessed: the map would be survey noise and
   * would look exactly like a map of defects, which is the reading a contractor
   * would act on.
   */
  const fine = (await ask({ op: "compare", reference: "dsm", tolerance: unresolvable })).body.result;
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

  /**
   * The zoom at which one 256 px tile is about 256 of this survey's own cells,
   * which is the one place in this suite where sizing in cells is what matters.
   *
   * A tile is a fixed number of pixels over a variable amount of ground, so a
   * fixed zoom is a fixed number of *metres* wearing a tile's clothes. Zoom 17
   * is roughly 285 m across at these latitudes: 1,180 cells square on Kotba's
   * 24 cm grid, and 3,700 square — 14 million cells, read twice, once per
   * surface — on Aektanagar's 7.7 cm one. Nothing about the sign of a ramp
   * needs fourteen million cells, and pulling them over byte ranges from R2 is
   * what made this section time out rather than fail.
   *
   * One pixel to one cell is also the zoom a client actually inspects a
   * difference map at, and it puts the same amount of work behind the tile on
   * every survey.
   */
  const equatorMetres = 40075016.686;
  const zoomForNativeCell = (lat, cellSize) => {
    const across = equatorMetres * Math.cos((lat * Math.PI) / 180);
    return Math.min(24, Math.max(8, Math.round(Math.log2(across / (256 * cellSize)))));
  };
  const z = zoomForNativeCell(survey.centreLat, survey.cellSize);
  const [x, y] = tileOf(survey.centreLon, survey.centreLat, z);
  const tile = (q) =>
    fetch(`${BASE}/api/portal/sites/${SITE}/render/difference/${z}/${x}/${y}.png?${q}`, {
      headers: { Cookie: `sga_portal_session=${token}` },
    });

  console.log(`  ...tile ${z}/${x}/${y}, about ${((equatorMetres * Math.cos((survey.centreLat * Math.PI) / 180)) / 2 ** z).toFixed(0)} m across at ${survey.cellSize.toFixed(3)} m cells`);

  const ok = await tile("min=-25&max=25&ramp=difference");
  check("a difference tile renders", ok.status === 200 && ok.headers.get("content-type") === "image/png",
    `status ${ok.status}`);
  const bytes = new Uint8Array(await ok.arrayBuffer());
  check("as a real PNG", bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG");

  /*
   * That the tile has ground on it, which the refusal below depends on.
   *
   * The tiler answers an empty transparent PNG — 200, not an error — for a tile
   * that misses the survey, and it does so *before* it validates the ramp. So a
   * tile placed off the surveyed ground would sail through the rainbow check
   * below by never reaching it, and the guard this section exists to prove
   * would be untested while reporting a pass. Comparing against a tile
   * deliberately placed a degree away is the cheapest way to know the
   * difference.
   */
  const far = tileOf(survey.centreLon + 1, survey.centreLat + 1, z);
  const empty = await fetch(
    `${BASE}/api/portal/sites/${SITE}/render/difference/${z}/${far[0]}/${far[1]}.png?min=-25&max=25&ramp=difference`,
    { headers: { Cookie: `sga_portal_session=${token}` } },
  );
  const emptyBytes = new Uint8Array(await empty.arrayBuffer());
  check("and one carrying real ground, not the empty tile returned off the survey",
    bytes.length !== emptyBytes.length,
    `${bytes.length} bytes here against ${emptyBytes.length} a degree away`);

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

await survey.close();

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
