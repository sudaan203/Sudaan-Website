/**
 * Which local files become which R2 keys, for one site.
 *
 * This is the single answer to a question two scripts ask. `upload-site.mjs`
 * asks it to know what to send. `r2-prune.mjs` asks it to know what may be
 * deleted — and a pruner working from a *different* idea of the key layout than
 * the uploader would delete live data. So there is one table, and neither script
 * is allowed its own.
 *
 * ## The prefixes are not uniform, and that is not tidiable
 *
 * The three `PORTAL_*_URL` bases all point at the same `sites` root, and each
 * source module appends its own segment:
 *
 *   terrain-source.ts    `<slug>/dtm.tif`
 *   hydrology-source.ts  `<slug>/hydrology/<file>`
 *   cloud-source.ts      `<slug>/cloud/cloud.json`
 *
 * Map and terrain therefore share the site root, which is why a prune cannot
 * reason about them separately — see `r2-prune.mjs`, which requires every class
 * to be present locally before it deletes anything.
 *
 * Checked against the live bucket on 18 Sep 2026 rather than inferred.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SURVEYS } from "./survey.mjs";

/**
 * Where a survey's *raw delivery* sits on this machine.
 *
 * Not `portal-data/` — that holds what the pipeline produced. This is what the
 * surveyor handed over: the orthomosaic, the LAS, the CSVs. The folder is named
 * for humans (`surveys/ektanagar-1`) and the slug is named for R2
 * (`aektanagar-survey`), and the two are deliberately different strings, so the
 * mapping comes from `survey.mjs` rather than from string surgery on the slug.
 */
function sourceDir(slug) {
  const known = SURVEYS.find((s) => s.slug === slug);
  return join("surveys", known ? known.label : slug.replace(/-survey$/, ""));
}

/**
 * @type {{ name: string, dir: (slug: string) => string, prefix: string,
 *          archive?: boolean }[]}
 *
 * `archive` marks a class that exists so the local copy can be *deleted*. The
 * others are working data the pipeline reads; this one is the delivery itself,
 * parked where it can be fetched back if a survey ever has to be reprocessed at
 * different settings. That inverts the usual assumption — for every other class,
 * missing locally is a state to worry about; for this one it is the goal — which
 * is why `r2-prune` has to know the difference.
 */
export const CLASSES = [
  { name: "map", dir: (slug) => join("portal-data", "map", slug), prefix: "" },
  { name: "terrain", dir: (slug) => join("portal-data", "terrain", slug), prefix: "" },
  { name: "hydrology", dir: (slug) => join("portal-data", "hydrology", slug), prefix: "hydrology" },
  { name: "cloud", dir: (slug) => join("portal-data", "cloud", slug), prefix: "cloud" },
  { name: "source", dir: sourceDir, prefix: "source", archive: true },
];

export const CLASS_NAMES = CLASSES.map((c) => c.name);

/**
 * A copy a sync tool made, which must never reach the bucket.
 *
 * iCloud and Finder resolve a conflict by leaving "nodes 2" beside "nodes", and
 * `portal-data/cloud/ektanagar-2-survey` holds exactly that today. Uploading it
 * would put a second complete quadtree under a name nothing reads.
 *
 * The space is required. A bare trailing number is not a sync artefact — a tile
 * pyramid's first segment is a zoom level, and a rule without the space would
 * quietly refuse to upload `13/`.
 */
export const DUPLICATE = / \d+$/;

/**
 * A slug that could escape its prefix would defeat the Worker's grant check, so
 * it is validated wherever one is turned into a key.
 */
export function assertSafeSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(
      `"${slug}" is not a safe site slug. Lower case letters, digits and hyphens only: ` +
        `anything else could address objects outside sites/<slug>/.`,
    );
  }
  return slug;
}

/** Every file under a directory, following symlinks. */
export function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .DS_Store and friends
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walk(full)); continue; }
    if (entry.isFile()) { out.push(full); continue; }
    // Dirent.isFile()/.isDirectory() report the link itself, not its target, so
    // a symlink is neither — which is exactly what portal-data/terrain/ holds
    // (dsm.tif/dtm.tif point at the real rasters elsewhere on disk). Without
    // this, the walk silently found zero files there.
    if (entry.isSymbolicLink()) {
      const target = statSync(full); // follows the link
      if (target.isFile()) out.push(full);
      else if (target.isDirectory()) out.push(...walk(full));
    }
  }
  return out;
}

/**
 * The data classes a site actually has on this machine.
 *
 * @param {string} slug
 * @param {{ only?: string }} [options]
 */
export function presentClasses(slug, { only } = {}) {
  assertSafeSlug(slug);
  if (only && !CLASS_NAMES.includes(only)) {
    throw new Error(`"${only}" is not one of: ${CLASS_NAMES.join(", ")}`);
  }
  const wanted = CLASSES.filter((c) => (only ? c.name === only : true));
  return {
    present: wanted.filter((c) => existsSync(c.dir(slug))),
    absent: wanted.filter((c) => !existsSync(c.dir(slug))),
  };
}

/**
 * Local files paired with the key each one belongs at.
 *
 * @param {string} slug
 * @param {{ only?: string, from?: string, onSkip?: (what: string) => void }} [options]
 *   `from` overrides the class table entirely and uploads one directory at the
 *   site root — the escape hatch, and the way Ektanagar 2's cloud came to be in
 *   the bucket twice.
 * @returns {{ path: string, key: string }[]}
 */
export function localObjects(slug, { only, from, onSkip } = {}) {
  assertSafeSlug(slug);
  const sources = from
    ? [{ name: "from", dir: from, prefix: "" }]
    : presentClasses(slug, { only }).present.map((c) => ({ ...c, dir: c.dir(slug) }));

  const objects = [];
  for (const source of sources) {
    for (const file of walk(source.dir)) {
      const suffix = relative(source.dir, file).split(sep).join("/");
      const first = suffix.split("/")[0].replace(/\.[^.]+$/, "");
      if (DUPLICATE.test(first)) {
        onSkip?.(`${source.name}/${suffix}`);
        continue;
      }
      objects.push({
        path: file,
        key: `sites/${slug}/${source.prefix ? `${source.prefix}/` : ""}${suffix}`,
      });
    }
  }
  return objects;
}
