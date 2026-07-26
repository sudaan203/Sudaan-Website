#!/usr/bin/env node
/**
 * Is any client seeing another site's data?
 *
 *   node scripts/portal-assets-test.mjs
 *
 * This exists because of a real incident. Aektanagar's DSM, DTM and contour
 * previews were byte for byte identical to Kotba's: someone copied the folder to
 * get a page rendering and the images were never replaced. A client opened "their"
 * terrain and saw a survey 100 km away. Nothing failed, nothing warned, and the
 * page looked entirely convincing, because a colourised DEM of anywhere looks like
 * a colourised DEM.
 *
 * That is unfixable by eye and trivial to catch by hash, which is what this does.
 * It also checks that no deliverable is a stub, because the LiDAR entry was once a
 * 159 byte text file wearing a .las extension and claiming 45 million points.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "portal-data", "files");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok   ${name}${detail ? " — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

if (!existsSync(ROOT)) {
  console.error(`no ${ROOT}`);
  process.exit(1);
}

/** Every deliverable, keyed by "<client>/<site>". */
function collect() {
  const files = [];
  for (const client of readdirSync(ROOT, { withFileTypes: true })) {
    if (!client.isDirectory()) continue;
    const clientDir = path.join(ROOT, client.name);
    for (const site of readdirSync(clientDir, { withFileTypes: true })) {
      if (!site.isDirectory()) continue;
      const siteDir = path.join(clientDir, site.name);
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (!e.name.startsWith(".")) {
            files.push({
              site: `${client.name}/${site.name}`,
              rel: path.relative(siteDir, p),
              abs: p,
              size: statSync(p).size,
            });
          }
        }
      };
      walk(siteDir);
    }
  }
  return files;
}

const files = collect();
const sites = [...new Set(files.map((f) => f.site))];

console.log(`--- ${files.length} deliverables across ${sites.length} sites ---`);
console.log(`    ${sites.join(", ")}\n`);
check("more than one site is present, so sharing is detectable", sites.length > 1);

/* --------------------------------------------- the same bytes twice --- */

console.log("\n--- no site may serve another site's file ---");

const byHash = new Map();
for (const f of files) {
  const h = createHash("sha256").update(readFileSync(f.abs)).digest("hex");
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(f);
}

const shared = [...byHash.values()].filter(
  (group) => new Set(group.map((f) => f.site)).size > 1,
);

for (const group of shared) {
  console.log(
    `  FAIL ${group[0].rel} is identical across ${[...new Set(group.map((g) => g.site))].join(" and ")}`,
  );
  fail += 1;
}
if (shared.length === 0) {
  pass += 1;
  console.log("  ok   every deliverable is unique to its site");
}

// Duplicates inside one site are fine (a sheet reused across categories), but
// worth naming so they are a decision rather than an accident.
const withinSite = [...byHash.values()].filter(
  (g) => g.length > 1 && new Set(g.map((f) => f.site)).size === 1,
);
for (const g of withinSite) {
  console.log(`  note ${g[0].site}: ${g.map((f) => f.rel).join(" and ")} are the same bytes`);
}

/* ------------------------------------------------------------- stubs --- */

console.log("\n--- no deliverable may be a stub ---");

// A real PDF, image or point cloud is never this small. The old LiDAR "file" was
// 159 bytes of prose.
const MIN_BYTES = 1024;
const tiny = files.filter((f) => f.size < MIN_BYTES);
check(
  "no deliverable is suspiciously small",
  tiny.length === 0,
  tiny.length ? tiny.map((f) => `${f.site}/${f.rel} (${f.size} B)`).join(", ") : `smallest is ${Math.min(...files.map((f) => f.size))} B`,
);

// A file claiming a binary extension should actually be that format.
const MAGIC = {
  ".pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  ".webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  ".png": (b) => b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG",
  ".jpg": (b) => b[0] === 0xff && b[1] === 0xd8,
  ".jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  ".las": (b) => b.subarray(0, 4).toString("latin1") === "LASF",
  ".laz": (b) => b.subarray(0, 4).toString("latin1") === "LASF",
};

const liars = [];
for (const f of files) {
  const ext = path.extname(f.rel).toLowerCase();
  const test = MAGIC[ext];
  if (!test) continue;
  const head = readFileSync(f.abs).subarray(0, 16);
  if (!test(head)) liars.push(`${f.site}/${f.rel}`);
}
check(
  "every file matches the format its extension claims",
  liars.length === 0,
  liars.length ? liars.join(", ") : "checked pdf, webp, png, jpg, las",
);

/* ------------------------------------------------ no sample text anywhere --- */

console.log("\n--- no deliverable may carry the marketing sample text ---");

/**
 * The marketing site's sample PDFs describe a fictional site in Gezira State,
 * Sudan, in UTM zone 36N, and say "representative sample for demonstration
 * purposes only". Copies of them were served to two real clients as their contour
 * map, survey report, volume analysis and orthomosaic sheet.
 *
 * These strings appearing under portal-data/files means a sample has been copied
 * in again. They are safe to look for in /public/reports, where the samples
 * legitimately live.
 */
const SAMPLE_MARKERS = [
  "Gezira",
  "demonstration purposes",
  "Sample Deliverable",
  "representative sample",
];
const contaminated = [];
for (const f of files) {
  if (path.extname(f.rel).toLowerCase() !== ".pdf") continue;
  const text = readFileSync(f.abs).toString("latin1");
  const hits = SAMPLE_MARKERS.filter((m) => text.includes(m));
  if (hits.length) contaminated.push(`${f.site}/${f.rel} (${hits.join(", ")})`);
}
check(
  "no PDF contains the sample site's text",
  contaminated.length === 0,
  contaminated.length ? contaminated.join("; ") : `${files.filter((f) => f.rel.endsWith(".pdf")).length} PDFs checked`,
);

/**
 * A survey PDF should name the projection it was produced in. A sheet with no CRS
 * is either a placeholder or a sheet nobody can rely on.
 *
 * The exemption is earned, not configured: a document is excused only if it says
 * in its own text that it is not a survey deliverable. That keeps the isolation
 * fixture passing without giving anyone a path based allowlist to hide behind.
 */
const NOT_A_DELIVERABLE = "not a survey deliverable";
const noCrs = [];
let exempt = 0;
for (const f of files) {
  if (path.extname(f.rel).toLowerCase() !== ".pdf") continue;
  const text = readFileSync(f.abs).toString("latin1");
  if (text.includes(NOT_A_DELIVERABLE)) { exempt += 1; continue; }
  if (!/UTM/.test(text)) noCrs.push(`${f.site}/${f.rel}`);
}
check(
  "every survey PDF states its coordinate system",
  noCrs.length === 0,
  noCrs.length
    ? noCrs.join(", ")
    : `all name a UTM zone${exempt ? `, ${exempt} declared itself not a deliverable` : ""}`,
);

/* -------------------------------------------- previews look site specific --- */

console.log("\n--- previews should match their own survey's shape ---");

// A DEM preview generated from a site's own raster inherits that raster's aspect
// ratio. Two sites having pixel identical dimensions across every preview is not
// proof of a copy, but combined with the hash check above it is a useful smell.
const previewsBySite = new Map();
for (const f of files) {
  if (!/imagery\/(dsm|dtm)\.webp$/.test(f.rel.replace(/\\/g, "/"))) continue;
  const b = readFileSync(f.abs);
  // WebP VP8L/VP8X dimensions are awkward; use the RIFF size plus the byte length
  // as a cheap fingerprint instead of decoding.
  const key = `${b.length}`;
  if (!previewsBySite.has(f.site)) previewsBySite.set(f.site, []);
  previewsBySite.get(f.site).push(`${f.rel}:${key}`);
}
const fingerprints = [...previewsBySite.entries()].map(([site, list]) => ({ site, fp: list.sort().join("|") }));
const dupFp = fingerprints.filter((a, i) => fingerprints.findIndex((b) => b.fp === a.fp) !== i);
check(
  "no two sites have identically sized DEM previews",
  dupFp.length === 0,
  dupFp.length ? dupFp.map((d) => d.site).join(", ") : `${fingerprints.length} site(s) profiled`,
);

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
