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
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
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

// Node's Hash.update() rejects a single call over roughly 2 GiB ("data is
// too long") - a real limitation, not this script's own guard, and it bit
// Kiru's 3.76 GB DSM the same way readFileSync's 2 GiB cap did above.
// Feeding it in chunks is well within what update() supports repeatedly.
const HASH_CHUNK = 512 * 1024 * 1024;
function hashOf(algorithm, data) {
  const hash = createHash(algorithm);
  if (typeof data === "string" || data.length <= HASH_CHUNK) {
    hash.update(data);
    return hash;
  }
  for (let offset = 0; offset < data.length; offset += HASH_CHUNK) {
    hash.update(data.subarray(offset, offset + HASH_CHUNK));
  }
  return hash;
}
const sha256 = (data) => hashOf("sha256", data).digest("hex");
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
function sign({ method, key, body, contentType, query }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? "");

  const canonicalUri =
    "/" + [BUCKET, ...key.split("/")].map((s) => encodeURIComponent(s)).join("/");
  // Sorted key=value pairs, joined with "&" - required even for a valueless
  // param like "uploads" (multipart initiate), which still needs its "=".
  const canonicalQuery = query
    ? Object.keys(query).sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`)
        .join("&")
    : "";

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
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
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
    url: `https://${HOST}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
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
  // Our own point cloud node format, written by prepare-point-cloud.mjs. It
  // would fall through to octet-stream anyway; naming it says the extension is
  // one of ours rather than something unrecognised that slipped in.
  pnt: "application/octet-stream",
  txt: "text/plain", csv: "text/csv", xml: "application/xml", dxf: "application/dxf",
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .DS_Store and friends
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walk(full)); continue; }
    if (entry.isFile()) { out.push(full); continue; }
    // Dirent.isFile()/.isDirectory() report the link itself, not its target,
    // so a symlink is neither - which is exactly what portal-data/terrain/
    // holds (dsm.tif/dtm.tif point at the real rasters elsewhere on disk;
    // see the resume-point memory). Without this, this walk silently found
    // zero files here and the upload never got them.
    if (entry.isSymbolicLink()) {
      const target = statSync(full); // follows the link
      if (target.isFile()) out.push(full);
      else if (target.isDirectory()) out.push(...walk(full));
    }
  }
  return out;
}

// readFileSync refuses anything over 2 GiB (Node's own guard, not a real
// memory limit) - which Kiru's terrain rasters are, at 3.76 GB and 2.3 GB.
// Nothing above MULTIPART_THRESHOLD reaches readFileSync any more, so that
// cap never bites: uploadMultipart below reads range by range instead.
async function readFileRange(path, start, length) {
  const out = Buffer.allocUnsafe(length);
  let offset = 0;
  for await (const chunk of createReadStream(path, { start, end: start + length - 1 })) {
    chunk.copy(out, offset);
    offset += chunk.length;
  }
  return offset === length ? out : out.subarray(0, offset);
}

// Below this, use multipart upload rather than one PUT of the whole file.
// A single ~3.76 GB buffered PUT for Kiru's DSM failed reproducibly with a
// TLS-level EPROTO a couple of minutes in - same failure with the sandbox on
// and off, so not a sandbox artifact, and not obviously this machine's
// network either since it happened at close to the same elapsed time twice.
// Multipart is what S3-compatible storage is actually built for at this
// size: each part is an ordinary 200 MB PUT, so one bad write costs one part
// and a retry, not the whole file, and nothing has to hold the full file in
// memory at once - only one part plus whatever's mid-flight.
const MULTIPART_THRESHOLD = 200 * 1024 * 1024;
const PART_SIZE = 200 * 1024 * 1024;

async function xmlText(response, label) {
  if (response.ok) return response.text();
  throw new Error(`${label}: ${response.status} ${(await response.text()).slice(0, 300)}`);
}

/**
 * Initiate, PUT each part, complete. No dedupe check here (`alreadyThere`'s
 * plain MD5 comparison doesn't apply - R2's ETag for a multipart object is
 * `<hash>-<partCount>`, not the whole-file MD5), so this always re-uploads.
 * Fine for a first publish; --force-equivalent by construction.
 */
async function uploadMultipart(key, path, size, contentType) {
  const initRequest = sign({ method: "POST", key, query: { uploads: "" }, contentType });
  const initXml = await xmlText(
    await fetch(initRequest.url, { method: "POST", headers: initRequest.headers }),
    `multipart initiate for ${key}`,
  );
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initXml)?.[1];
  if (!uploadId) throw new Error(`multipart initiate for ${key}: no UploadId in the response`);

  const parts = [];
  let partNumber = 1;
  for (let offset = 0; offset < size; offset += PART_SIZE) {
    const length = Math.min(PART_SIZE, size - offset);
    const chunk = await readFileRange(path, offset, length);
    const partRequest = sign({
      method: "PUT", key, body: chunk,
      query: { partNumber: String(partNumber), uploadId },
    });
    const partResponse = await fetch(partRequest.url, {
      method: "PUT", headers: partRequest.headers, body: chunk,
    });
    if (!partResponse.ok) {
      throw new Error(
        `multipart part ${partNumber} of ${key}: ${partResponse.status} ` +
          `${(await partResponse.text()).slice(0, 300)}`,
      );
    }
    const etag = partResponse.headers.get("etag");
    if (!etag) throw new Error(`multipart part ${partNumber} of ${key}: no ETag in the response`);
    parts.push({ partNumber, etag });
    console.log(
      `    part ${partNumber}/${Math.ceil(size / PART_SIZE)}  ${(offset / 1024 / 1024).toFixed(0)}-` +
        `${((offset + length) / 1024 / 1024).toFixed(0)} MB`,
    );
    partNumber += 1;
  }

  const completeBody =
    `<CompleteMultipartUpload>${parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join("")}</CompleteMultipartUpload>`;
  const completeRequest = sign({ method: "POST", key, body: completeBody, query: { uploadId } });
  await xmlText(
    await fetch(completeRequest.url, {
      method: "POST", headers: completeRequest.headers, body: completeBody,
    }),
    `multipart complete for ${key}`,
  );
}

/** Does the remote object already match, byte for byte? */
async function alreadyThere(key, body) {
  const request = sign({ method: "HEAD", key });
  const response = await fetch(request.url, { method: "HEAD", headers: request.headers });
  if (!response.ok) return false;
  const etag = (response.headers.get("etag") ?? "").replace(/"/g, "");
  // R2 returns the MD5 for a single part upload, which is what these are.
  return etag === hashOf("md5", body).digest("hex");
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
    const size = statSync(file).size;
    const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";

    if (args.dryRun) {
      console.log(`  would send  ${key}  ${(size / 1024).toFixed(0)} KB`);
      sent += 1;
      bytes += size;
      continue;
    }

    if (size > MULTIPART_THRESHOLD) {
      // Nothing here reads the whole file into memory - alreadyThere's plain
      // MD5 comparison doesn't apply to a multipart object's ETag anyway, so
      // this always sends. See the comment above uploadMultipart.
      try {
        await uploadMultipart(key, file, size, contentType);
      } catch (err) {
        failed += 1;
        console.error(`  FAILED ${key}: ${err.message}`);
        continue;
      }
      sent += 1;
      bytes += size;
      console.log(`  sent  ${key}  ${(size / 1024 / 1024).toFixed(0)} MB (multipart)`);
      continue;
    }

    const body = readFileSync(file);

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
