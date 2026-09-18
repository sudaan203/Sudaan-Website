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

import { createReadStream, readFileSync, statSync } from "node:fs";
import { hashOf, r2Client, r2Credentials } from "./lib/r2.mjs";
import { CLASS_NAMES, localObjects, presentClasses } from "./lib/site-objects.mjs";

function parseArgs(argv) {
  const args = { concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--site") { args.site = value; i += 1; }
    else if (flag === "--from") { args.from = value; i += 1; }
    else if (flag === "--only") { args.only = value; i += 1; }
    else if (flag === "--concurrency") { args.concurrency = Number(value); i += 1; }
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--force") args.force = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.site) {
  console.log(`
  node scripts/upload-site.mjs --site <slug> [options]

    --site         site slug. Objects land under sites/<slug>/, the prefix the
                   Worker's grant check enforces.
    --only CLASS   just one of: map, terrain, hydrology, cloud
    --from DIR     upload this directory instead, at sites/<slug>/ with no
                   prefix. The escape hatch, not the normal path — see below.
    --dry-run      list what would be sent, touch nothing
    --force        re-send objects even when the remote copy already matches
    --concurrency  parallel uploads, default 4

  With neither --only nor --from, every data class a site has is pushed to the
  prefix the portal reads it from. That is the point: the prefixes are not
  uniform, and getting one wrong is silent. Ektanagar 2's point cloud is in the
  bucket twice right now — 741 objects correctly under cloud/ and 741 more
  flat at nodes/, from a --from that pointed one level too deep. The portal
  reads the first set and pays to store both.

  Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.
`);
  process.exit(args.help ? 0 : 1);
}

const creds = r2Credentials({ required: !args.dryRun });
const BUCKET = creds.bucket;
const ACCOUNT = creds.account;
const { sign, host: HOST } = r2Client(creds);

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

/**
 * Does the remote object already match, byte for byte?
 *
 * R2 returns the MD5 for a single part upload, which is what these are — but
 * for a compressible type it returns it as a **weak** validator, `W/"<md5>"`,
 * because the bytes it may serve after transfer encoding are not the bytes it
 * stored. The MD5 inside is still the MD5 of what was stored.
 *
 * Stripping only the quotes left `W/04e3c5...`, which never equalled a hex
 * digest, so every JSON and GeoJSON object re-uploaded on every run while the
 * TIFFs beside them skipped correctly. That is a quiet kind of wrong: it costs
 * bandwidth and class A operations rather than breaking anything, so nothing
 * ever pointed at it. Kotba's nine hydrology products sent three of themselves
 * every publish.
 */
async function alreadyThere(key, body) {
  const request = sign({ method: "HEAD", key });
  const response = await fetch(request.url, { method: "HEAD", headers: request.headers });
  if (!response.ok) return false;
  const etag = (response.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
  return etag === hashOf("md5", body).digest("hex");
}

/*
 * What goes where is `scripts/lib/site-objects.mjs`, shared with r2-prune.mjs.
 * A pruner working from a different idea of the key layout than the uploader
 * would delete live data, so neither script is allowed its own copy.
 */
if (args.only && !CLASS_NAMES.includes(args.only)) {
  throw new Error(`--only "${args.only}" is not one of: ${CLASS_NAMES.join(", ")}`);
}

const { present, absent } = args.from
  ? { present: [{ name: "from", prefix: "" }], absent: [] }
  : presentClasses(args.site, { only: args.only });
for (const c of absent) console.log(`  - ${c.name.padEnd(10)} nothing at ${c.dir(args.site)}`);

const files = localObjects(args.site, {
  only: args.only,
  from: args.from,
  onSkip: (what) => console.log(`  ! skipping ${what} — looks like a sync tool's duplicate`),
});
if (files.length === 0) {
  throw new Error(
    `nothing to upload for ${args.site}. Looked in:\n  ` +
      CLASS_NAMES.join("\n  "),
  );
}

console.log(`\nUploading ${files.length} files to sites/${args.site}/`);
for (const c of present) {
  console.log(`  ${c.name.padEnd(10)} -> sites/${args.site}/${c.prefix ? `${c.prefix}/` : ""}`);
}
console.log(`  bucket   ${BUCKET || "(dry run)"}`);
console.log(`  endpoint ${ACCOUNT ? HOST : "(dry run)"}\n`);

let sent = 0;
let skipped = 0;
let bytes = 0;
let failed = 0;

const queue = [...files];
async function worker() {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    const { path: file, key } = item;
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
