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
 *
 * ## What it covers, as of 18 Sep 2026
 *
 * Hydrology and the point cloud were built after this script and never folded
 * in, so publishing a site had drifted back to five commands: this one, then
 * hydro-run.mjs, then prepare-point-cloud.mjs, then upload-site.mjs, then a
 * Vercel environment edit for the client's login. The first three are now here.
 *
 *   tiles, contours, manifest   prepare-site.mjs
 *   terrain                     make-terrain-tiles.mjs
 *   previews                    make-site-previews.mjs
 *   PDF deliverables            make-site-deliverables.mjs
 *   hydrology                   hydro-run.mjs            (skip: --skip-hydrology)
 *   point cloud                 prepare-point-cloud.mjs  (skip: --skip-cloud)
 *   catalogue                   portal-db-publish.mjs    (with --db)
 *
 * The last two are the slow ones and run last, so a mistake in --client is
 * caught in minutes rather than after an hour of tiling and streaming.
 *
 * With `--publish` it also pushes every data class to R2 and writes the
 * database, which is the whole of getting a survey in front of a client:
 *
 *   node scripts/publish-site.mjs "D:\surveys\reliance" reliance-jamnagar \
 *     --client reliance --name "Reliance Jamnagar" --flown-on 2026-10-02 --publish
 *
 * Run it on the machine that already holds the processed survey. Nothing about
 * that machine is special beyond Node 22, this repository, and R2 credentials in
 * the environment — and the survey never has to be copied anywhere first.
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
  --publish          the whole thing: build, upload to R2, write the database,
                     and print the client's link. Implies --db.
  --skip-tiles       reuse the tiles already in portal-data/map/<slug>
  --skip-hydrology   do not derive flow, streams and catchments from the DTM
  --skip-cloud       do not build the point cloud quadtree from the LAS
  --hydro-cell N     hydrology analysis cell size in metres (default 1)
  --hydro-threshold N  channel initiation threshold in cells (default 500)
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

/*
 * `--publish` is the whole job, so it implies the database: a site whose bytes
 * are in R2 but whose rows are not in Postgres is invisible to the client, which
 * is the same as not having published it.
 */
const publish = has("publish");
const writeDb = publish || has("db");

/*
 * Everything this run will need, checked before it does any work.
 *
 * Tiling a survey takes minutes and a point cloud takes an hour, and both of
 * them happen before the first byte is uploaded or the first row is written.
 * Discovering there that R2_SECRET_ACCESS_KEY was never exported means doing it
 * all again. There is nothing clever here — it is just the difference between
 * finding out in one second and finding out in ninety minutes.
 */
{
  const missing = [];
  if (publish) {
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
      if (!process.env[name]) missing.push(name);
    }
  }
  if (writeDb && !process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    missing.push("DATABASE_URL (or POSTGRES_URL)");
  }
  if (missing.length > 0 && !dryRun) {
    console.error(`\nmissing from the environment: ${missing.join(", ")}`);
    console.error(
      publish
        ? `\nR2 credentials: Cloudflare dashboard -> R2 -> Manage API tokens.\n` +
          `Put them in .env.local and export them, or drop --publish to build the\nsite on disk and upload it separately.`
        : `\nDrop --db to build the site without writing the catalogue to Postgres.`,
    );
    process.exit(1);
  }
}

const mapDir = resolve("portal-data", "map", slug);
const hydrologyDir = resolve("portal-data", "hydrology", slug);
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
  console.log(`  ! not georeferenced, will be skipped: ${found.skipped.map((f) => basename(f)).join(", ")}`);
}
if (dems.length === 0 && orthos.length === 0) {
  console.error(`\nnothing to publish: no georeferenced raster in ${inputDir}`);
  console.error(`Every raster needs a world file (.tfw/.jgw) and a .prj beside it.`);
  process.exit(1);
}
if (!dtm) {
  console.log(`  ! no terrain model found, so there will be no elevation readout or measurement`);
}

/* ------------------------------------------------------------------ steps --- */

const node = process.execPath;

/**
 * A command line a person can paste back into a shell.
 *
 * Execution goes through spawnSync with an argument array, so quoting never
 * affects what runs. It affects only what gets printed — and what gets printed
 * is a rerun line for a step that failed, which is useless if the survey folder
 * is called "Ektanagar 2 Final" and the line silently breaks at the space.
 */
const shellArg = (a) => (/[^\w@%+=:,./-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
const commandLine = (args) => `node ${args.map(shellArg).join(" ")}`;

/** Run one thing, and stop the whole publish if it fails. */
function step(label, args) {
  console.log(`\n--- ${label} ---`);
  const r = spawnSync(node, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${label} failed with exit code ${r.status}. Stopping here rather than publishing a half built site.`);
    process.exit(r.status ?? 1);
  }
}

/**
 * What this run will do, as data, before any of it happens.
 *
 * Collected rather than executed inline for two reasons. `--dry-run` can then
 * show the actual plan — the whole point of a dry run is to answer "what is
 * about to happen to my survey", which a message saying "nothing written" does
 * not. And the ordering decision, cheap steps first and the two slow ones last,
 * becomes visible in one place instead of being implied by the order of the
 * statements that happen to run them.
 *
 * `optional: true` means a failure degrades the site rather than stopping it.
 * That is right for hydrology and the point cloud and wrong for everything else:
 * without tiles there is no site, and publishing half of one wastes the client's
 * first look. Hydrology and the cloud are additional layers over a site that is
 * already complete, they are the two slowest things here by an order of
 * magnitude, and they are the two most likely to meet something they dislike in
 * a survey nobody has processed before. Losing an hour of tiling because a LAS
 * has an unexpected point format would be the wrong trade.
 */
const plan = [];

if (!has("skip-tiles")) {
  plan.push({
    label: "tiles, contours and the manifest",
    args: [
      "scripts/prepare-site.mjs", inputDir, slug,
      "--quality", flag("quality", "80"),
      "--max-pixels", flag("max-pixels", "120000000"),
    ],
  });
}

if (dtm) {
  plan.push({
    label: "terrain, so elevation survives into the browser",
    args: ["scripts/make-terrain-tiles.mjs", dtm, slug, "--layer", "terrain"],
  });
}

if (dsm || dtm || ortho) {
  const args = ["scripts/make-site-previews.mjs", slug, "--client", clientSlug];
  if (dsm) args.push("--dsm", dsm);
  if (dtm) args.push("--dtm", dtm);
  if (ortho) args.push("--ortho", ortho);
  plan.push({ label: "imagery previews", args });
}

{
  const args = [
    "scripts/make-site-deliverables.mjs", slug,
    "--client", clientSlug, "--name", siteName,
  ];
  if (location) args.push("--location", location);
  if (cloud) args.push("--las", cloud);
  plan.push({ label: "PDF deliverables", args });
}

/*
 * The two slow, optional layers.
 *
 * Both were built after this orchestrator and never folded into it, so every
 * site since has needed them run by hand — which is most of the reason
 * publishing a survey had drifted back to five commands.
 */
if (dtm && !has("skip-hydrology")) {
  plan.push({
    label: "hydrology: flow, streams and catchments",
    args: [
      "scripts/hydro-run.mjs",
      "--dtm", dtm,
      "--out", hydrologyDir,
      "--cell", flag("hydro-cell", "1"),
      "--threshold", flag("hydro-threshold", "500"),
    ],
    optional: true,
    missing: "but tools 24 to 28 will have nothing to read",
  });
} else if (!dtm && !has("skip-hydrology")) {
  console.log(`  ! no terrain model, so no hydrology. Water runs over bare earth, not over a surface model.`);
}

if (cloud && !has("skip-cloud")) {
  plan.push({
    label: "point cloud: streaming quadtree",
    args: ["scripts/prepare-point-cloud.mjs", "--site", slug, "--las", cloud],
    optional: true,
    missing: "but the cloud browser will have nothing to stream",
  });
}

if (dryRun) {
  console.log(`\nwould run, in order:\n`);
  for (const [i, p] of plan.entries()) {
    console.log(`  ${i + 1}. ${p.label}${p.optional ? "   (optional)" : ""}`);
    console.log(`     ${commandLine(p.args)}`);
  }
  console.log(`\n  then: catalogue${writeDb ? ", database" : ""}${publish ? ", upload to R2" : ""}, guards`);
  console.log(`\ndry run, nothing written\n`);
  process.exit(0);
}

/**
 * Named at the end as well as where it happened: a failure a thousand lines up
 * the scroll of an hour-long run is a failure nobody sees.
 */
const degraded = [];

for (const p of plan) {
  if (!p.optional) {
    step(p.label, p.args);
    continue;
  }
  console.log(`\n--- ${p.label} ---`);
  const r = spawnSync(node, p.args, { stdio: "inherit" });
  if (r.status === 0) continue;
  console.error(`\n  ! ${p.label} failed with exit code ${r.status}.`);
  console.error(`    The site will still publish, ${p.missing}.`);
  degraded.push({ ...p, rerun: commandLine(p.args) });
}

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

if (writeDb) {
  step("database", ["scripts/portal-db-publish.mjs", cataloguePath]);
} else {
  console.log(`\nNot written to the database. Re-run with --db, or:`);
  console.log(`  node scripts/portal-db-publish.mjs ${cataloguePath}`);
}

/* ---------------------------------------------------------------- guards --- */

/* ------------------------------------------------------------ to the edge --- */

/*
 * The upload goes after the database rather than before it.
 *
 * Neither order is free of a window where the two disagree, so the question is
 * which failure is better. Rows without bytes is a site the client can open and
 * find broken. Bytes without rows is a site that is simply not there yet, which
 * is what they already believe. The second is the one to be caught in.
 */
if (publish) {
  step("upload to R2", ["scripts/upload-site.mjs", "--site", slug]);
}

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
  catalogue    ${cataloguePath}${existsSync(hydrologyDir) ? `
  hydrology    portal-data/hydrology/${slug}/` : ""}${existsSync(resolve("portal-data", "cloud", slug)) ? `
  point cloud  portal-data/cloud/${slug}/` : ""}
`);

if (publish) {
  const base = (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  console.log(`  the client opens\n    ${base}/portal/${slug}\n`);
  console.log(`  They need a login before that link works. If they have none yet, invite`);
  console.log(`  them from the owner console rather than from here — it is the same`);
  console.log(`  decision as granting access to the data, and it belongs in one place.\n`);
} else {
  console.log(`  Not uploaded. The bytes are on this machine only.`);
  console.log(`  Re-run with --publish, or: node scripts/upload-site.mjs --site ${slug}\n`);
}

/*
 * Named at the end as well as where they happened.
 *
 * A failure a thousand lines up the scroll of an hour-long run is a failure
 * nobody sees. The rerun line is given in full so fixing one does not mean
 * reconstructing its arguments.
 */
if (degraded.length > 0) {
  console.log(`  ${degraded.length} layer${degraded.length === 1 ? "" : "s"} did not build:\n`);
  for (const d of degraded) {
    console.log(`  - ${d.label}`);
    console.log(`    ${d.missing}`);
    console.log(`    re-run: ${d.rerun}\n`);
  }
}
