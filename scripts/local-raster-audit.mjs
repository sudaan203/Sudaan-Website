/**
 * Which local survey rasters are safely duplicated in R2, and which are not.
 *
 *   node scripts/local-raster-audit.mjs
 *
 * Reports only. **This script never deletes anything** and takes no flag that
 * would make it. It prints the `rm` lines for the files it has proven are in the
 * bucket, and a human runs them or does not.
 *
 * ## Why this exists
 *
 * The portal reads terrain over HTTP from R2 (`PORTAL_TERRAIN_URL`), so once a
 * survey's rasters are in the bucket the local copies are no longer what the
 * product depends on. That is worth real disk: this machine ran to 11 GB free
 * with about 18 GB of survey data sitting in the repository directory.
 *
 * But "the portal does not need it" is not "nothing needs it", and the gap is
 * where a mistake would live:
 *
 *   **The test suites need the local files.** `scripts/lib/survey.mjs` resolves
 *   `portal-data/terrain/<slug>/<kind>.tif` on disk to compute ground truth —
 *   the whole point being that it is an *independent* answer, not one the route
 *   supplied. Delete the rasters and the suites stop being able to check the
 *   route at all. They do not fail loudly; `openSurvey` throws and the run dies
 *   before its first check.
 *
 * So the honest framing is a trade, and this script states both halves of it
 * rather than implying the space is free.
 *
 * ## What "in R2" means here
 *
 * A HEAD against the bucket, comparing **content length to the local file's
 * size**. A key that exists but is short — a half-finished multipart upload —
 * is reported as a mismatch, not a match, because that is exactly the case where
 * deleting the local copy loses the data for good.
 *
 * Credentials come from the environment, the same four the uploader uses:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REGION = "auto";
const SERVICE = "s3";

function env(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `${name} is not set. Export the four R2_* variables first, e.g.\n` +
        `  set -a; eval "$(grep -E '^R2_' .env.local)"; set +a`,
    );
    process.exit(1);
  }
  return value;
}

const ACCOUNT = env("R2_ACCOUNT_ID");
const KEY = env("R2_ACCESS_KEY_ID");
const SECRET = env("R2_SECRET_ACCESS_KEY");
const BUCKET = env("R2_BUCKET");
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

async function head(key) {
  const now = new Date();
  const amz = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amz.slice(0, 8);
  const empty = createHash("sha256").update("").digest("hex");
  const path = `/${BUCKET}/${key}`;
  const canonical = [
    "HEAD",
    path,
    "",
    `host:${HOST}\nx-amz-content-sha256:${empty}\nx-amz-date:${amz}\n`,
    "host;x-amz-content-sha256;x-amz-date",
    empty,
  ].join("\n");
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let signing = createHmac("sha256", `AWS4${SECRET}`).update(date).digest();
  for (const part of [REGION, SERVICE, "aws4_request"]) {
    signing = createHmac("sha256", signing).update(part).digest();
  }
  const signature = createHmac("sha256", signing).update(toSign).digest("hex");

  const response = await fetch(`https://${HOST}${path}`, {
    method: "HEAD",
    headers: {
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${KEY}/${scope}, ` +
        `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      "x-amz-content-sha256": empty,
      "x-amz-date": amz,
    },
  });
  return { status: response.status, length: Number(response.headers.get("content-length") ?? 0) };
}

const TERRAIN = join(process.cwd(), "portal-data", "terrain");
if (!existsSync(TERRAIN)) {
  console.error(`No ${TERRAIN}. Run this from the repository root.`);
  process.exit(1);
}

const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;

const rows = [];
let safe = 0;
let unsafe = 0;

for (const slug of readdirSync(TERRAIN).sort()) {
  const dir = join(TERRAIN, slug);
  if (!statSync(dir).isDirectory()) continue;
  for (const kind of ["dtm", "dsm"]) {
    const path = join(dir, `${kind}.tif`);
    if (!existsSync(path)) continue;
    // statSync, not lstatSync: these are symlinks into the delivery folders.
    const local = statSync(path).size;
    const { status, length } = await head(`sites/${slug}/${kind}.tif`);
    const matched = status === 200 && length === local;
    if (matched) safe += local;
    else unsafe += local;
    rows.push({
      survey: slug,
      layer: kind,
      local: gb(local),
      "in R2": status === 200 ? gb(length) : `HTTP ${status}`,
      verdict: matched ? "duplicated" : status === 200 ? "SIZE MISMATCH" : "LOCAL ONLY",
    });
  }
}

console.table(rows);
console.log(`\n  duplicated in R2 : ${gb(safe)}`);
console.log(`  local only       : ${gb(unsafe)}`);

console.log(
  `\nThe portal does not read any of the duplicated files — it reads R2. The test\n` +
    `suites do: scripts/lib/survey.mjs computes ground truth from these exact paths,\n` +
    `so removing them trades disk for the ability to verify the route independently.\n` +
    `Re-download or re-point the symlinks and the suites work again.`,
);

const removable = rows.filter((r) => r.verdict === "duplicated");
if (removable.length) {
  console.log(`\nProven present in R2, so recoverable if removed:\n`);
  for (const r of removable) {
    // The symlink target is the real file; that is what occupies the space.
    const path = join(TERRAIN, r.survey, `${r.layer}.tif`);
    console.log(`  # ${r.survey} ${r.layer} (${r.local})`);
    console.log(`  rm "$(readlink -f ${JSON.stringify(path)})"`);
  }
}

const risky = rows.filter((r) => r.verdict !== "duplicated");
if (risky.length) {
  console.log(`\nNOT safe to remove — no verified copy in the bucket:\n`);
  for (const r of risky) console.log(`  ${r.survey} ${r.layer}: ${r.verdict}`);
}
