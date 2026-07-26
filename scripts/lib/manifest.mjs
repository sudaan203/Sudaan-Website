/**
 * One place that reads and writes a site's map manifest.
 *
 * It exists because the manifest was being edited by hand. make-terrain-tiles.mjs
 * printed a JSON block for a human to paste in, and that is how Aektanagar's
 * terrain layer got added: a node one liner typed at a prompt. Two failure modes
 * follow from that, and both happened.
 *
 * The manifest is written last by prepare-site.mjs, so a killed run leaves tiles
 * on disk with a stale manifest that still looks valid, and the portal serves the
 * old layers with no error anywhere. And a layer pasted in by hand can disagree
 * with the tiles it names, which nothing checks.
 *
 * So: upserting a layer is a function, layers are keyed, and `verify` walks what
 * the manifest claims against what is actually on disk.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function manifestPath(siteDir) {
  return join(siteDir, "manifest.json");
}

export function readManifest(siteDir) {
  const p = manifestPath(siteDir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/** A manifest for a site that has none yet. */
export function emptyManifest(site) {
  return { site, generatedAt: new Date().toISOString(), layers: [] };
}

/**
 * Add or replace a layer by key, preserving the order layers were first added.
 *
 * Replacing rather than appending matters: re-running a step should update its
 * layer, not add a second one with the same key, which would leave the portal
 * showing the first and the tiles belonging to the second.
 */
export function upsertLayer(manifest, layer) {
  if (!layer?.key) throw new Error("a layer needs a key");
  const i = manifest.layers.findIndex((l) => l.key === layer.key);
  if (i >= 0) manifest.layers[i] = layer;
  else manifest.layers.push(layer);
  manifest.generatedAt = new Date().toISOString();
  return manifest;
}

export function writeManifest(siteDir, manifest) {
  writeFileSync(manifestPath(siteDir), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Sort layers into the order the portal should draw and list them in. */
const ORDER = { tiles: 0, raster: 1, dem: 2, vector: 3 };
export function sortLayers(manifest) {
  manifest.layers.sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
  return manifest;
}

/**
 * Does the manifest describe what is actually there?
 *
 * Returns a list of problems rather than throwing, so a caller can report all of
 * them at once instead of one per run.
 */
export function verify(siteDir, manifest = readManifest(siteDir)) {
  const problems = [];
  if (!manifest) return ["no manifest.json"];
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    problems.push("the manifest declares no layers");
    return problems;
  }

  for (const layer of manifest.layers) {
    if (!layer.key) problems.push("a layer has no key");
    if (!layer.title) problems.push(`${layer.key}: no title`);

    if (layer.kind === "tiles" || layer.kind === "dem") {
      if (typeof layer.tiles !== "string") {
        problems.push(`${layer.key}: kind ${layer.kind} needs a tiles template`);
        continue;
      }
      const m = /^tiles\/([a-z0-9][a-z0-9-]*)\/\{z\}\/\{x\}\/\{y\}\.(webp|png)$/.exec(layer.tiles);
      if (!m) {
        problems.push(`${layer.key}: tiles template "${layer.tiles}" is not a shape the route will serve`);
        continue;
      }
      if (m[1] !== layer.key) {
        problems.push(`${layer.key}: tiles template points at "${m[1]}", not at its own key`);
      }
      const dir = join(siteDir, "tiles", layer.key);
      if (!existsSync(dir)) {
        problems.push(`${layer.key}: no tiles on disk at tiles/${layer.key}`);
        continue;
      }
      const zooms = readdirSync(dir).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b);
      if (zooms.length === 0) {
        problems.push(`${layer.key}: tiles/${layer.key} has no zoom directories`);
        continue;
      }
      if (layer.minZoom !== zooms[0] || layer.maxZoom !== zooms[zooms.length - 1]) {
        problems.push(
          `${layer.key}: manifest says z${layer.minZoom}-${layer.maxZoom}, disk has z${zooms[0]}-${zooms[zooms.length - 1]}`,
        );
      }
      // A DEM has to be gapless or MapLibre's hillshade dies on the border fill.
      if (layer.kind === "dem" && !layer.encoding) {
        problems.push(`${layer.key}: a dem layer needs an encoding`);
      }
    } else if (layer.kind === "raster" || layer.kind === "vector") {
      if (typeof layer.file !== "string") {
        problems.push(`${layer.key}: kind ${layer.kind} needs a file`);
      } else if (!existsSync(join(siteDir, layer.file))) {
        problems.push(`${layer.key}: ${layer.file} is named but missing`);
      }
    } else {
      problems.push(`${layer.key}: unknown kind "${layer.kind}"`);
    }
  }

  // The stale manifest trap: tiles newer than the manifest that names them.
  const p = manifestPath(siteDir);
  if (existsSync(p) && existsSync(join(siteDir, "tiles"))) {
    const manifestAt = statSync(p).mtimeMs;
    let newest = 0;
    for (const d of readdirSync(join(siteDir, "tiles"))) {
      const s = statSync(join(siteDir, "tiles", d));
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    }
    if (newest > manifestAt + 60000) {
      problems.push(
        "tiles/ is newer than manifest.json, so a tiling run probably did not finish. " +
          "This is what left Aektanagar serving 4,096 px overlays with a complete pyramid beside them.",
      );
    }
  }

  return problems;
}
