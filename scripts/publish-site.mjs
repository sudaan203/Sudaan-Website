#!/usr/bin/env node
/**
 * One command: a folder of survey deliverables in, a working dashboard out.
 *
 *   node scripts/publish-site.mjs <survey-folder> <site-slug> \
 *        --client demo-client --name "Reliance Jamnagar" --location "Jamnagar, Gujarat"
 *
 * Add --db to write the catalogue to Postgres as well. Without it the run stops
 * after producing files, which is the safe default: the same command can be run
 * repeatedly on a laptop with no database in reach.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 *
 * Publishing Aektanagar took six steps, three of which meant editing source code:
 *
 *   1. prepare-site.mjs                      produced tiles and a manifest
 *   2. make-terrain-tiles.mjs                produced DEM tiles, then a human
 *                                            pasted a layer into manifest.json
 *   3. make-site-previews.mjs                produced imagery previews
 *   4. make-site-deliverables.mjs            produced the PDFs
 *   5. hand edit seed.ts AND portal-db-seed.mjs to add the asset rows
 *   6. portal-db-seed.mjs --only <slug>      wrote them to the database
 *
 * Every wrong figure that reached the client came out of steps 2 and 5. The
 * contour title said 0.5 m when the shapefile said 1 m. The point cloud
 * description said 45,210,480 points when the header said 50,183,644. The area
 * said 35 ha when the footprint measured 25.3 ha. Three previews were another
 * site's files entirely. None of that was carelessness with a keyboard: it was a
 * pipeline that produced measurements and then asked a person to retype them.
 *
 * So this orchestrates every step, derives the catalogue from what was actually
 * produced, and runs the guards at the end. Nothing about a new site requires
 * touching code.
 * ---------------------------------------------------------------------------
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { readManifest, verify } from "./lib/manifest.mjs";
import { discoverAssets, siteFactsFromManifest, summaryFromFacts, stableUuid } from "./lib/catalogue.mjs";

/* --------------------------------------------------------------- options --- */

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const inputDir = positional[0] ? resolve(positional[0]) : null;
const slug = positional[1];

if (!inputDir || !slug) {
  console.error(`
Usage: node scripts/publish-site.mjs <survey-folder> <site-slug> [options]

  --client SLUG      client folder and database client (default demo-client)
  --name TEXT        site name shown to the client
  --location TEXT    location line
  --district TEXT
  --state TEXT
  --flown-on DATE    acquisition date, YYYY-MM-DD
  --quality N        WebP quality for imagery tiles (default 80)
  --max-pixels N     working limit for one raster (default 120000000)
  --db               also upsert the catalogue into Postgres
  --skip-tiles       reuse the tiles already in portal-data/map/<slug>
  --dry-run          say what would happen, write nothing

Example:
  node scripts/publish-site.mjs ~/surveys/reliance reliance-jamnagar \\
    --client reliance --name "Reliance Jamnagar" --location "Jamnagar, Gujarat" --db
`);
  process.exit(1);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  console.error(`site slug must be lowercase words and hyphens, got "${slug}"`);
  process.exit(1);
}
if (!existsSync(inputDir)) {
  console.error(`no such folder: ${inputDir}`);
  process.exit(1);
}

const clientSlug = flag("client", "demo-client");
const siteFolder = slug.replace(/-survey$/, "");
const siteName = flag("name", slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
const location = flag("location", null);
const district = flag("district", null);
const state = flag("state", null);
const flownOn = flag("flown-on", null);
const dryRun = has("dry-run");

const mapDir = resolve("portal-data", "map", slug);
const filesRoot = resolve("portal-data", "files");

/* ------------------------------------------------------------- discovery --- */

/**
 * Work out what is in the folder before running anything, so the plan can be
 * printed and a missing input is a message rather than a stack trace three steps
 * in.
 */
function survey(dir) {
  const found = { dems: [], orthos: [], shapefiles: [], grids: [], clouds: [], skipped: [] };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const ext = extname(e.name).toLowerCase();
      const stem = p.replace(/\.[^.]+$/, "");
      const georeferenced = [".tfw", ".pgw", ".jgw", ".wld"].some((x) => existsSync(stem + x)) &&
        existsSync(stem + ".prj");

      if (ext === ".tif" || ext === ".tiff") {
        (georeferenced ? found.dems : found.skipped).push(p);
      } else if ([".jpg", ".jpeg", ".png"].includes(ext)) {
        (georeferenced ? found.orthos : found.skipped).push(p);
      } else if (ext === ".shp") {
        found.shapefiles.push(p);
      } else if (ext === ".csv") {
        found.grids.push(p);
      } else if (ext === ".las" || ext === ".laz") {
        found.clouds.push(p);
      }
    }
  };
  walk(dir);
  return found;
}

/** Which of the GeoTIFFs is a float DEM, and which is really imagery. */
async function classifyDems(paths) {
  const sharp = (await import("sharp")).default;
  const dems = [];
  const imagery = [];
  for (const p of paths) {
    try {
      const m = await sharp(p, { limitInputPixels: false }).metadata();
      (m.channels === 1 && m.depth === "float" ? dems : imagery).push(p);
    } catch {
      /* not readable as an image, leave it out */
    }
  }
  return { dems, imagery };
}

const found = survey(inputDir);
const { dems, imagery } = await classifyDems(found.dems);
const orthos = [...found.orthos, ...imagery];

/**
 * Which DEM is the terrain model and which is the surface model.
 *
 * Terrain is matched first and removed from the pool, because the naming is not
 * symmetric in practice. Kotba's surface model is called `Kotba_DEM`, so a plain
 * `/dsm/` test misses it entirely and the site publishes with no surface model at
 * all. Matching "dem" as a surface model only works if "dtm" has already been
 * taken out, otherwise a careless pattern claims both.
 */
const pick = (list, re) => list.find((p) => re.test(basename(p)));
const dtm = pick(dems, /dtm|terrain|bare.?earth/i) ?? null;
const remaining = dems.filter((p) => p !== dtm);
const dsm = pick(remaining, /dsm|dem|surface/i) ?? (dtm ? null : remaining[0] ?? null);
const ortho = pick(orthos, /ortho|mosaic|rgb/i) ?? orthos[0] ?? null;
const cloud = found.clouds.sort((a, b) => statSync(b).size - statSync(a).size)[0] ?? null;

console.log(`\n=== ${siteName} (${slug}) ===`);
console.log(`source     ${inputDir}`);
console.log(`client     ${clientSlug}`);
console.log(`\nfound in the folder:`);
console.log(`  elevation models  ${dems.length}${dsm ? `  DSM: ${basename(dsm)}` : ""}${dtm ? `  DTM: ${basename(dtm)}` : ""}`);
console.log(`  orthomosaics      ${orthos.length}${ortho ? `  ${basename(ortho)}` : ""}`);
console.log(`  shapefiles        ${found.shapefiles.length}`);
console.log(`  point grids       ${found.grids.length}`);
console.log(`  point clouds      ${found.clouds.length}${cloud ? `  ${basename(cloud)}` : ""}`);
if (found.skipped.length) {
  console.log(`  ! not georeferenced, will be skipped: ${found.skipped.map(basename).join(", ")}`);
}
if (dems.length === 0 && orthos.length === 0) {
  console.error(`\nnothing to publish: no georeferenced raster in ${inputDir}`);
  console.error(`Every raster needs a world file (.tfw/.jgw) and a .prj beside it.`);
  process.exit(1);
}
if (!dtm) {
  console.log(`  ! no terrain model found, so there will be no elevation readout or measurement`);
}

if (dryRun) {
  console.log(`\ndry run, nothing written\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ steps --- */

const node = process.execPath;
function step(label, args) {
  console.log(`\n--- ${label} ---`);
  const r = spawnSync(node, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${label} failed with exit code ${r.status}. Stopping here rather than publishing a half built site.`);
    process.exit(r.status ?? 1);
  }
}

if (!has("skip-tiles")) {
  step("tiles, contours and the manifest", [
    "scripts/prepare-site.mjs", inputDir, slug,
    "--quality", flag("quality", "80"),
    "--max-pixels", flag("max-pixels", "120000000"),
  ]);
}

if (dtm) {
  step("terrain, so elevation survives into the browser", [
    "scripts/make-terrain-tiles.mjs", dtm, slug, "--layer", "terrain",
  ]);
}

const previewArgs = ["scripts/make-site-previews.mjs", slug, "--client", clientSlug];
if (dsm) previewArgs.push("--dsm", dsm);
if (dtm) previewArgs.push("--dtm", dtm);
if (ortho) previewArgs.push("--ortho", ortho);
if (dsm || dtm || ortho) step("imagery previews", previewArgs);

const delivArgs = [
  "scripts/make-site-deliverables.mjs", slug,
  "--client", clientSlug, "--name", siteName,
];
if (location) delivArgs.push("--location", location);
if (cloud) delivArgs.push("--las", cloud);
step("PDF deliverables", delivArgs);

/* --------------------------------------------- copy through what is data --- */

// A point grid is a deliverable in its own right, not something to regenerate.
import { copyFileSync, mkdirSync } from "node:fs";
for (const grid of found.grids) {
  const dest = join(filesRoot, clientSlug, siteFolder, "drawings", basename(grid));
  mkdirSync(join(filesRoot, clientSlug, siteFolder, "drawings"), { recursive: true });
  copyFileSync(grid, dest);
  console.log(`\ncopied ${basename(grid)} into drawings/`);
}

/* ------------------------------------------------------------- catalogue --- */

console.log(`\n--- catalogue ---`);

const manifest = readManifest(mapDir);
const problems = verify(mapDir, manifest);
if (problems.length) {
  console.error(`the map bundle is not consistent:`);
  for (const p of problems) console.error(`  ! ${p}`);
  process.exit(1);
}
console.log(`manifest: ${manifest.layers.length} layers, all matching what is on disk`);

const clientId = stableUuid("client", clientSlug);
const siteId = stableUuid("site", clientSlug, slug);
const surveyId = stableUuid("survey", clientSlug, slug, flownOn ?? "baseline");

const assets = discoverAssets({
  filesRoot, clientSlug, siteFolder, siteId, surveyId, manifest,
});
const facts = siteFactsFromManifest(manifest);

// Extra figures for the summary, read from the files rather than asserted.
const extras = {};
const contourLayer = manifest.layers.find((l) => l.kind === "vector");
if (contourLayer?.file && existsSync(join(mapDir, contourLayer.file))) {
  const gj = JSON.parse(readFileSync(join(mapDir, contourLayer.file), "utf8"));
  const levels = [...new Set(gj.features.map((f) => f.properties?.elevation).filter(Number.isFinite))].sort((a, b) => a - b);
  if (levels.length > 1) extras.contourInterval = Number((levels[1] - levels[0]).toFixed(3));
}
if (found.grids.length) {
  const text = readFileSync(found.grids[0], "utf8").trim().split(/\r?\n/);
  extras.gridPoints = text.length - 1;
  const xs = [...new Set(text.slice(1, 400).map((l) => Number(l.split(",")[0])))].sort((a, b) => a - b);
  if (xs.length > 2) extras.gridSpacing = Number((xs[1] - xs[0]).toFixed(2));
}
if (cloud) {
  const h = Buffer.alloc(400);
  const fd = (await import("node:fs")).openSync(cloud, "r");
  (await import("node:fs")).readSync(fd, h, 0, 400, 0);
  (await import("node:fs")).closeSync(fd);
  if (h.toString("ascii", 0, 4) === "LASF") {
    let n = h.readUInt32LE(107);
    if (h[24] === 1 && h[25] >= 4) {
      const wide = h.readBigUInt64LE(247);
      if (wide > 0n) n = Number(wide);
    }
    extras.lidarPoints = n;
  }
}

const site = {
  id: siteId,
  client_id: clientId,
  slug,
  name: siteName,
  location: location ?? null,
  district,
  state,
  area_label: facts.areaHa ? `${facts.areaHa.toFixed(1)} ha` : null,
  industry: flag("industry", "Infrastructure"),
  status: "delivered",
  summary: summaryFromFacts(facts, extras),
  is_published: true,
};

console.log(`site:     ${site.name}`);
console.log(`  area      ${site.area_label ?? "not measurable"}   (from the manifest footprint)`);
console.log(`  summary   ${site.summary ?? "none"}`);
console.log(`assets:   ${assets.length} discovered`);
for (const a of assets) {
  console.log(`  ${a.category.padEnd(9)} ${a.title.padEnd(38)} ${(a.size_bytes / 1024).toFixed(0)} KB`);
}

const cataloguePath = join(filesRoot, clientSlug, siteFolder, "catalogue.json");
const catalogue = {
  generatedAt: new Date().toISOString(),
  client: { id: clientId, slug: clientSlug },
  site,
  survey: {
    id: surveyId,
    site_id: siteId,
    label: flag("survey-label", "Baseline flight"),
    flown_on: flownOn,
  },
  assets,
};
(await import("node:fs")).writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2));
console.log(`\nwrote ${cataloguePath}`);

/* ------------------------------------------------------------------- db --- */

if (has("db")) {
  step("database", ["scripts/portal-db-publish.mjs", cataloguePath]);
} else {
  console.log(`\nNot written to the database. Re-run with --db, or:`);
  console.log(`  node scripts/portal-db-publish.mjs ${cataloguePath}`);
}

/* ---------------------------------------------------------------- guards --- */

console.log(`\n--- guards ---`);
for (const t of ["scripts/portal-assets-test.mjs", "scripts/portal-map-test.mjs"]) {
  const r = spawnSync(node, [t], { encoding: "utf8" });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  console.log(`  ${basename(t).padEnd(26)} ${last}`);
  if (r.status !== 0) {
    console.error(`\n${t} failed. The site is on disk but something is wrong with it.`);
    console.error((r.stdout ?? "").split("\n").filter((l) => /FAIL/.test(l)).join("\n"));
    process.exit(1);
  }
}

console.log(`
done. ${slug} is published.

  map bundle   portal-data/map/${slug}/
  deliverables portal-data/files/${clientSlug}/${siteFolder}/
  catalogue    ${cataloguePath}
`);
