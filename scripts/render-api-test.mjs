/**
 * The tile route, over HTTP, decoding what it actually returns.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/render-api-test.mjs
 *
 * Needs a server on :3000 and `.env.local`. Hydrology layers need
 * `hydro-run.mjs` to have been run for the site.
 *
 * `render-test.mjs` proves the colouring, lighting and tile maths in isolation.
 * This proves the route puts them together over real survey data: that a tile
 * covering the survey has pixels, that one beside it does not, that the two
 * agree where they meet, and that the response is a PNG rather than merely
 * claiming to be one.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
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

/** Decode a PNG far enough to read its pixels, verifying every CRC. */
function decodePng(buffer) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) if (buffer[i] !== sig[i]) throw new Error("not a PNG");
  let at = 8;
  let header = null;
  const idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const payload = buffer.subarray(at + 8, at + 8 + length);
    const declared = buffer.readUInt32BE(at + 8 + length);
    let c = 0xffffffff;
    const covered = buffer.subarray(at + 4, at + 8 + length);
    for (let i = 0; i < covered.length; i += 1) {
      c ^= covered[i];
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    if (((c ^ 0xffffffff) >>> 0) !== declared) throw new Error(`bad CRC on ${type}`);
    if (type === "IHDR") header = { width: payload.readUInt32BE(0), height: payload.readUInt32BE(4) };
    if (type === "IDAT") idat.push(payload);
    if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * 4;
  const pixels = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row += 1) {
    raw.copy(pixels, row * stride, row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
  }
  return { ...header, pixels };
}

const opaque = (p) => {
  let n = 0;
  for (let i = 3; i < p.length; i += 4) if (p[i] > 0) n += 1;
  return n;
};

async function tile(layer, z, x, y, query = "") {
  const url = `${BASE}/api/portal/sites/${SITE}/render/${layer}/${z}/${x}/${y}.png${query}`;
  const response = await fetch(url, { headers: { Cookie: `sga_portal_session=${token}` } });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get("Content-Type"), cache: response.headers.get("Cache-Control"), body };
}

// ---- where the survey is ---------------------------------------------------
/**
 * The survey's header, and — separately — a small window of its pixels.
 *
 * This was `readGeoTiff(DTM)`, which reads the *whole* raster to find out where
 * the middle is. On Kiru that does not merely run out of memory: `readFileSync`
 * throws `ERR_FS_FILE_TOO_LARGE` above 2 GiB, so the suite died on its first
 * line before a single check ran. `openSurvey` parses the directory only.
 */
const survey = await openSurvey(SITE, "dtm");
const lon = survey.centreLon;
const lat = survey.centreLat;

/**
 * An elevation stretch taken from this survey's own ground.
 *
 * The literal `?min=337&max=425` is Kotba's plateau. Handed to Aektanagar it is
 * 300 m below the terrain and to Kiru a kilometre above it, so every pixel
 * saturates at one end of the ramp — and the checks that follow are about
 * *colour variation*, so they fail on a picture that is uniformly the top colour
 * exactly as they would on a broken renderer. The two are indistinguishable
 * without knowing the ground, so the ground is what this reads.
 *
 * Taken from a 300 m window at the centre rather than the whole raster: it must
 * describe the tiles actually being rendered, and it has to be affordable on a
 * 2.3 GB file.
 */
const sample = await survey.centreWindowMetres(150);
let lo = Infinity;
let hi = -Infinity;
for (const v of sample.data) {
  if (!Number.isFinite(v) || v === sample.nodata) continue;
  if (v < lo) lo = v;
  if (v > hi) hi = v;
}
if (!Number.isFinite(lo) || hi <= lo) {
  throw new Error(`${SITE}: the centre window carries no elevations to stretch against`);
}
/** Rounded outwards, so the stretch always contains the ground it came from. */
const MIN = Math.floor(lo);
const MAX = Math.ceil(hi);
/** The full-range stretch, as the query string every check below shares. */
const RANGE = `?min=${MIN}&max=${MAX}`;
/**
 * A deliberately narrow stretch, for "a different stretch is a different
 * picture". A tenth of the range around the middle, so it is guaranteed to clip
 * on both sides whatever the survey's relief is.
 */
const NARROW = `?min=${(MIN + (MAX - MIN) * 0.45).toFixed(3)}&max=${(MIN + (MAX - MIN) * 0.55).toFixed(3)}`;
/** And a deliberately wide one, which must clip nothing. */
const WIDE = `?min=${MIN - (MAX - MIN)}&max=${MAX + (MAX - MIN)}`;

const Z = 18;
const n = 2 ** Z;
const X = Math.floor(((lon + 180) / 360) * n);
const Y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);

console.log(`\n${describeSurvey(survey)}`);
console.log(
  `  stretch ${MIN}..${MAX} m, from a 300 m window at the centre; z${Z} tile ${X}/${Y}`,
);

console.log("\nA tile over the survey");
{
  const { status, type, cache, body } = await tile("dtm", Z, X, Y);
  check("it is served", status === 200, `status ${status}`);
  check("as a PNG", type === "image/png", String(type));
  // Survey data belongs to one client, so a shared proxy must never hold it.
  check("cached privately", /private/.test(cache ?? ""), String(cache));
  check("and cached at all, since a tile cannot change", /max-age=\d\d+/.test(cache ?? ""), String(cache));

  const png = decodePng(body);
  check("256 x 256", png.width === 256 && png.height === 256, `${png.width}x${png.height}`);
  const painted = opaque(png.pixels);
  check("most of it is painted", painted > 256 * 256 * 0.5, `${painted} of ${256 * 256} pixels`);

  // Colour, not greyscale: the whole point of the ramp.
  let coloured = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (png.pixels[i + 3] === 0) continue;
    const [r, g, b] = [png.pixels[i], png.pixels[i + 1], png.pixels[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 12) coloured += 1;
  }
  check("it is coloured rather than grey", coloured > painted * 0.5, `${coloured} of ${painted}`);
}

console.log("\nA tile nowhere near the survey");
{
  const { status, body } = await tile("dtm", Z, X + 300, Y);
  check("is still a valid PNG, not a 404", status === 200, `status ${status}`);
  const png = decodePng(body);
  check("and is entirely transparent", opaque(png.pixels) === 0, `${opaque(png.pixels)} painted`);
}

console.log("\nThe stretch is the layer's, not the tile's");
{
  /*
   * The chessboard test. If each tile scaled its colours to its own contents,
   * neighbouring tiles would disagree wherever the terrain differs, and the tile
   * seams would become the most visible thing on the map. Two adjacent tiles
   * rendered with the same explicit range must agree along the edge they share.
   */
  /*
   * Measured as a contrast, not against a threshold somebody chose.
   *
   * The two columns being compared are adjacent but not identical ground: at
   * z18 they are about 0.55 m apart, and real terrain changes over 0.55 m, so
   * they can never match exactly and any fixed cut-off would be a guess.
   *
   * What distinguishes a correct render from a chessboard is the *size* of the
   * disagreement. With a shared stretch the seam is only the terrain changing;
   * with a per-tile stretch the same elevation is a different colour either side
   * of the boundary and the difference jumps. Measured on Kotba: 23 against 97,
   * a factor of four, which is what makes this worth asserting.
   */
  const edgeDifference = (a, b) => {
    let n = 0;
    let sum = 0;
    for (let row = 0; row < 256; row += 1) {
      const left = (row * 256 + 255) * 4;
      const right = (row * 256 + 0) * 4;
      if (a.pixels[left + 3] === 0 || b.pixels[right + 3] === 0) continue;
      n += 1;
      sum +=
        Math.abs(a.pixels[left] - b.pixels[right]) +
        Math.abs(a.pixels[left + 1] - b.pixels[right + 1]) +
        Math.abs(a.pixels[left + 2] - b.pixels[right + 2]);
    }
    return { rows: n, mean: n ? sum / n : 0 };
  };

  const range = RANGE;
  const shared = edgeDifference(
    decodePng((await tile("dtm", Z, X, Y, range)).body),
    decodePng((await tile("dtm", Z, X + 1, Y, range)).body),
  );
  const perTile = edgeDifference(
    decodePng((await tile("dtm", Z, X, Y)).body),
    decodePng((await tile("dtm", Z, X + 1, Y)).body),
  );

  check("adjacent tiles share an edge to compare", shared.rows > 10, `${shared.rows} rows`);
  check("a shared stretch leaves only the terrain in the seam",
    shared.mean < 40, `mean difference ${shared.mean.toFixed(1)} of 765`);
  check("and letting each tile pick its own range is visibly worse",
    perTile.mean > shared.mean * 2,
    `per tile ${perTile.mean.toFixed(1)} vs shared ${shared.mean.toFixed(1)}`);

  // An explicit range must actually change the picture, or the parameter is a lie.
  const narrow = decodePng((await tile("dtm", Z, X, Y, NARROW)).body);
  const wide = decodePng((await tile("dtm", Z, X, Y, WIDE)).body);
  check("a different stretch produces a different picture",
    Buffer.compare(narrow.pixels, wide.pixels) !== 0);
}

console.log("\nRelief");
{
  const shaded = decodePng((await tile("dtm", Z, X, Y, RANGE)).body);
  const flat = decodePng((await tile("dtm", Z, X, Y, `${RANGE}&relief=0`)).body);
  check("relief changes the image", Buffer.compare(shaded.pixels, flat.pixels) !== 0);

  // Shading must vary across the tile: a constant multiplier would pass the
  // check above while doing nothing that hillshading is for.
  let minLum = 255;
  let maxLum = 0;
  for (let i = 0; i < shaded.pixels.length; i += 4) {
    if (shaded.pixels[i + 3] === 0) continue;
    const lum = 0.2126 * shaded.pixels[i] + 0.7152 * shaded.pixels[i + 1] + 0.0722 * shaded.pixels[i + 2];
    minLum = Math.min(minLum, lum);
    maxLum = Math.max(maxLum, lum);
  }
  check("and it varies across the tile rather than dimming it uniformly",
    maxLum - minLum > 40, `luminance ${minLum.toFixed(0)}..${maxLum.toFixed(0)}`);
}

console.log("\nHydrology layers render too");
/*
 * These come from `hydro-run.mjs`, which is a separate publishing step, so a
 * survey can legitimately have a DTM and no hydrology. That is a gap in the
 * data rather than a defect in the route, and a suite that reports it as a
 * failure teaches everyone to ignore its output. Reported as a skip, and named,
 * so the gap stays visible without being an error.
 */
for (const layer of ["slope_degrees", "flow_accumulation", "filled"]) {
  const { status, body } = await tile(layer, Z, X, Y);
  if (status === 404) {
    console.log(`  SKIPPED: ${layer} is not published for ${SITE}; run hydro-run.mjs to cover it.`);
    continue;
  }
  if (status !== 200) {
    check(`${layer} renders`, false, `status ${status}`);
    continue;
  }
  const png = decodePng(body);
  check(`${layer} renders with pixels`, opaque(png.pixels) > 0, `${opaque(png.pixels)} painted`);
}

console.log("\nFlow accumulation is drawn logarithmically, or it is a blank map");
{
  /*
   * A drainage network's accumulation is 1 for nearly every cell and thousands
   * for a thin thread of channel. Stretched linearly the whole survey collapses
   * into the bottom colour, which is a faithful rendering of the numbers and
   * tells a client nothing. The check is that the two are genuinely different
   * pictures and that the logarithmic one actually uses the ramp.
   */
  const spread = (png) => {
    const seen = new Set();
    for (let i = 0; i < png.pixels.length; i += 4) {
      if (png.pixels[i + 3] === 0) continue;
      // Quantised, so this counts distinguishable tones rather than noise.
      seen.add(`${png.pixels[i] >> 4},${png.pixels[i + 1] >> 4},${png.pixels[i + 2] >> 4}`);
    }
    return seen.size;
  };

  /*
   * The range is the survey's own cell count, which is the *theoretical*
   * maximum accumulation: the most cells that can drain through one cell is all
   * of them. It is an upper bound on every survey by construction, so it needs
   * no calibration and no knowledge of the drainage.
   *
   * This was `?min=1&max=7246` — the greatest accumulation on *Kotba*. It is a
   * count of upstream cells, so it scales with the survey's size and drainage
   * and means nothing anywhere else.
   *
   * Dropping the range entirely does not work either, and it is worth writing
   * down why: the route then falls back to the *tile's* own min and max, which
   * is a narrow range, and over a narrow range a linear ramp does not collapse.
   * Measured on Kotba that way, log spread 34 tones against linear's 24 — the
   * right direction but nothing like the separation this check is asserting,
   * because the thing being tested had been removed from the test. A wide range
   * is the precondition for "linear collapses", so it has to be stated.
   */
  const range = `?min=1&max=${survey.cells}`;
  const got = await tile("flow_accumulation", Z, X, Y, range);
  if (got.status !== 200) {
    console.log(`  SKIPPED: no flow accumulation published for ${SITE} (status ${got.status}).`);
  } else {
    const log = decodePng(got.body);
    const linear = decodePng((await tile("flow_accumulation", Z, X, Y, `${range}&scale=linear`)).body);

    check("the two scales produce different pictures", Buffer.compare(log.pixels, linear.pixels) !== 0);
    check("and the logarithmic one uses far more of the ramp",
      spread(log) > spread(linear) * 2,
      `${spread(log)} tones against ${spread(linear)}`);
  }
}

console.log("\nRefusals and isolation");
{
  const r = await fetch(`${BASE}/api/portal/sites/${SITE}/render/dtm/${Z}/${X}/${Y}.png`);
  check("no session is refused", r.status === 401, `status ${r.status}`);
}
{
  const r = await fetch(`${BASE}/api/portal/sites/definitely-not-a-site/render/dtm/${Z}/${X}/${Y}.png`, {
    headers: { Cookie: `sga_portal_session=${token}` },
  });
  check("an unknown site is 404, never a confirmation", r.status === 404, `status ${r.status}`);
}
{
  const { status } = await tile("definitely-not-a-layer", Z, X, Y);
  check("an unknown layer is refused", status === 400, `status ${status}`);
}
{
  const { status, body } = await tile("dtm", 2, 1, 1);
  check("a zoom below the useful range is empty, not an error", status === 200, `status ${status}`);
  check("and really is empty", opaque(decodePng(body).pixels) === 0);
}
{
  const { status } = await tile("dtm", Z, "abc", Y);
  check("a non numeric tile coordinate is refused", status === 400, `status ${status}`);
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
