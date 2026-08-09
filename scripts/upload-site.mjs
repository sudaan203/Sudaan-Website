/**
 * Push a prepared site to the private R2 bucket the tile Worker serves.
 *
 *   node scripts/upload-site.mjs --site kotba-survey --from portal-data/map/kotba-survey
 *
 * Phase 3a, the half that puts bytes where the Worker can find them. Objects
 * land under `sites/<slug>/`, which is exactly the prefix `keyIsWithinSite`
 * enforces, so a grant for one site can never reach another's.
 *
 * Signed with SigV4 against R2's S3 compatible endpoint using `node:crypto`, so
 * there is no SDK to install and nothing new in package.json. That matters more
 * than it sounds on this machine: `node_modules` is already large enough that
 * iCloud evicts it, and every dependency added is a slower build.
 *
 * What this replaces. Publishing today means running a script and committing
 * about 1,700 binary files, which can never be self service and is why the
 * repository is acting as a CDN. After this, publishing is one command and the
 * repository stops growing.
 *
 * Environment, all from the Cloudflare dashboard under R2 -> Manage API tokens:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REGION = "auto"; // R2 has one region and expects this literal
const SERVICE = "s3";

function parseArgs(argv) {
  const args = { concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--site") { args.site = value; i += 1; }
    else if (flag === "--from") { args.from = value; i += 1; }
    else if (flag === "--concurrency") { args.concurrency = Number(value); i += 1; }
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--force") args.force = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.site || !args.from) {
  console.log(`
  node scripts/upload-site.mjs --site <slug> --from <directory> [options]

    --site         site slug. Objects land under sites/<slug>/, the prefix the
                   Worker's grant check enforces.
    --from         directory to upload, walked recursively
    --dry-run      list what would be sent, touch nothing
    --force        re-send objects even when the remote copy already matches
    --concurrency  parallel uploads, default 4

  Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.
`);
  process.exit(args.help ? 0 : 1);
}

// A slug that could escape its prefix would defeat the Worker's whole check, so
// it is validated here as well. Two places, because this one runs on a laptop
// with credentials and the other runs on the edge without them.
if (!/^[a-z0-9][a-z0-9-]*$/.test(args.site)) {
  throw new Error(
    `--site "${args.site}" is not a safe slug. Lower case letters, digits and hyphens only: ` +
      `anything else could place objects outside sites/<slug>/.`,
  );
}

const env = (name) => {
  const value = process.env[name];
  if (!value && !args.dryRun) {
    throw new Error(`${name} is not set. Cloudflare dashboard -> R2 -> Manage API tokens.`);
  }
  return value ?? "";
};
const ACCOUNT = env("R2_ACCOUNT_ID");
const ACCESS_KEY = env("R2_ACCESS_KEY_ID");
const SECRET_KEY = env("R2_SECRET_ACCESS_KEY");
const BUCKET = env("R2_BUCKET");
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/**
 * AWS Signature Version 4.
 *
 * Written out rather than pulled in because it is forty lines and the
 * alternative is the AWS SDK, which is tens of megabytes for one PUT. The two
 * places this usually goes wrong are both handled: every path segment is encoded
 * except the slashes, and the payload hash is the hash of the actual body rather
 * than UNSIGNED-PAYLOAD, so a truncated upload fails the signature instead of
 * silently storing a partial object.
 */
function sign({ method, key, body, contentType }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? "");

  const canonicalUri =
    "/" + [BUCKET, ...key.split("/")].map((s) => encodeURIComponent(s)).join("/");

  const headers = {
    host: HOST,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(contentType ? { "content-type": contentType } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${String(headers[h]).trim()}\n`)
    .join("");

  const canonicalRequest = [
    method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest),
  ].join("\n");

  let signingKey = hmac(`AWS4${SECRET_KEY}`, dateStamp);
  signingKey = hmac(signingKey, REGION);
  signingKey = hmac(signingKey, SERVICE);
  signingKey = hmac(signingKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");

  return {
    url: `https://${HOST}${canonicalUri}`,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

const CONTENT_TYPES = {
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", json: "application/json",
  geojson: "application/geo+json", pmtiles: "application/octet-stream",
  laz: "application/octet-stream", copc: "application/octet-stream",
  txt: "text/plain", csv: "text/csv", xml: "application/xml", dxf: "application/dxf",
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .DS_Store and friends
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Does the remote object already match, byte for byte? */
async function alreadyThere(key, body) {
  const request = sign({ method: "HEAD", key });
  const response = await fetch(request.url, { method: "HEAD", headers: request.headers });
  if (!response.ok) return false;
  const etag = (response.headers.get("etag") ?? "").replace(/"/g, "");
  // R2 returns the MD5 for a single part upload, which is what these are.
  return etag === createHash("md5").update(body).digest("hex");
}

const files = walk(args.from);
if (files.length === 0) throw new Error(`${args.from} contains no files`);

console.log(`\nUploading ${files.length} files to sites/${args.site}/`);
console.log(`  bucket   ${BUCKET || "(dry run)"}`);
console.log(`  endpoint ${ACCOUNT ? HOST : "(dry run)"}\n`);

let sent = 0;
let skipped = 0;
let bytes = 0;
let failed = 0;

const queue = [...files];
async function worker() {
  for (;;) {
    const file = queue.shift();
    if (!file) return;

    // POSIX separators, always: a key is not a path, and a backslash from a
    // Windows run would be a literal character in the object name.
    const suffix = relative(args.from, file).split(sep).join("/");
    const key = `sites/${args.site}/${suffix}`;
    const body = readFileSync(file);
    const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";

    if (args.dryRun) {
      console.log(`  would send  ${key}  ${(body.length / 1024).toFixed(0)} KB`);
      sent += 1;
      bytes += body.length;
      continue;
    }

    if (!args.force && (await alreadyThere(key, body))) {
      skipped += 1;
      continue;
    }

    const request = sign({ method: "PUT", key, body, contentType });
    const response = await fetch(request.url, {
      method: "PUT",
      headers: request.headers,
      body,
    });
    if (!response.ok) {
      failed += 1;
      console.error(`  FAILED ${key}: ${response.status} ${(await response.text()).slice(0, 200)}`);
      continue;
    }
    sent += 1;
    bytes += body.length;
    console.log(`  sent  ${key}  ${(body.length / 1024).toFixed(0)} KB`);
  }
}

await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));

console.log(
  `\n${args.dryRun ? "Dry run: " : ""}${sent} sent, ${skipped} already current, ` +
    `${failed} failed, ${(bytes / 1024 / 1024).toFixed(1)} MB`,
);
if (!args.dryRun && failed === 0) {
  console.log(`\nThe Worker will serve these to a grant for "${args.site}" and to nothing else.`);
}
process.exit(failed ? 1 : 0);
