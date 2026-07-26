/**
 * Turns the files a site actually has into the catalogue rows the portal needs.
 *
 * This replaces hand editing two files. Publishing Aektanagar meant adding asset
 * rows to both `src/lib/portal/seed.ts` and `scripts/portal-db-seed.mjs` by hand,
 * with hand assigned ids, hand written titles and hand typed descriptions. Every
 * incorrect figure in that site came from exactly that: a title claiming 0.5 m
 * contours, a description claiming 45 million points, an area of 35 ha. Nobody
 * mistyped anything; the numbers were simply never derived from the data.
 *
 * So the rule here is that a row is **discovered**, not declared. Walk the site's
 * folder, recognise what each file is, and describe it from the file itself. If a
 * fact cannot be read, the field is left empty rather than guessed.
 *
 * Ids are deterministic (uuid v5 over client/site/path) so publishing twice
 * updates the same rows instead of duplicating them, and no id table has to be
 * maintained anywhere.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";

/** A stable uuid v5 (SHA-1, name-based) in the portal's own namespace. */
const NAMESPACE = "9f2b7c4e-1d3a-4b6f-8e21-5c7a9d0b4e13";
export function stableUuid(...parts) {
  const nsBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(parts.join("/"), "utf8")
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Folder name to asset category. The folder is the operator's own filing. */
const CATEGORY_BY_DIR = {
  reports: "report",
  drawings: "drawing",
  imagery: "photo",
  photos: "photo",
  uav: "lidar",
  lidar: "lidar",
  dgps: "uav_dgps",
  "uav-dgps": "uav_dgps",
  control: "control_area",
  "control-area": "control_area",
};

const MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
};

/** A readable title from a filename, without inventing anything about content. */
function titleFor(file) {
  const stem = basename(file, extname(file));
  const known = {
    "topographic-survey-report": "Topographic Survey Report",
    "topographic-survey": "Topographic Survey Report",
    "contour-map": "Contour Map",
    "point-cloud-summary": "LiDAR Point Cloud, survey summary",
    "volume-analysis": "Volume Analysis Report",
    "orthomosaic-sheet": "Orthomosaic Sheet",
    ortho: "Orthomosaic preview",
    dsm: "DSM preview",
    dtm: "DTM preview",
    contours: "Contours over orthomosaic",
    grid: "Survey Elevation Grid",
  };
  const key = stem.toLowerCase();
  if (known[key]) return known[key];
  return stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Facts about a file, read from the file. Only things that are true by
 * construction go in here; nothing about survey methodology or accuracy, because
 * those are not knowable from the bytes.
 */
function describe(abs, ext, manifest) {
  if (ext === ".csv" || ext === ".tsv") {
    const text = readFileSync(abs, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return null;
    const sep = ext === ".tsv" ? "\t" : ",";
    const header = lines[0].split(sep).map((h) => h.trim().toUpperCase());
    const zi = header.findIndex((h) => /ELEV|^Z$/.test(h));
    const rows = lines.length - 1;
    if (zi < 0) return `${rows.toLocaleString("en-IN")} rows, columns ${header.join(", ")}.`;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 1; i < lines.length; i += 1) {
      const v = Number(lines[i].split(sep)[zi]);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Number.isFinite(min) ? `, ${min.toFixed(2)} to ${max.toFixed(2)} m` : "";
    return `${rows.toLocaleString("en-IN")} surveyed points${range}.`;
  }

  // A contour sheet can borrow the manifest's own count and range, which the
  // pipeline measured rather than assumed.
  if (/contour/i.test(basename(abs)) && manifest) {
    const v = manifest.layers?.find((l) => l.kind === "vector");
    if (v?.featureCount && v.elevation) {
      return `${v.featureCount} contour lines from ${v.elevation.min} to ${v.elevation.max} m.`;
    }
  }
  if (/^dsm/i.test(basename(abs)) && manifest) {
    const l = manifest.layers?.find((x) => /dsm|surface/i.test(x.key) && x.elevation);
    if (l) return `Surface model, ${l.elevation.min} to ${l.elevation.max} m, colourised with relief shading.`;
  }
  if (/^dtm/i.test(basename(abs)) && manifest) {
    const l = manifest.layers?.find((x) => /dtm|terrain/i.test(x.key) && x.elevation);
    if (l) return `Bare earth terrain model, ${l.elevation.min} to ${l.elevation.max} m.`;
  }
  if (/^ortho/i.test(basename(abs)) && manifest) {
    const l = manifest.layers?.find((x) => /ortho|mosaic/i.test(x.key));
    if (l?.downsampledFrom) {
      return `True colour orthomosaic. Preview reduced from ${l.downsampledFrom[0]}x${l.downsampledFrom[1]} px.`;
    }
    return "True colour orthomosaic.";
  }
  return null;
}

/**
 * Every publishable asset under a site's file folder.
 *
 * @param filesRoot portal-data/files
 * @param clientSlug e.g. demo-client
 * @param siteFolder e.g. aektanagar
 */
export function discoverAssets({ filesRoot, clientSlug, siteFolder, siteId, surveyId, manifest }) {
  const root = join(filesRoot, clientSlug, siteFolder);
  if (!existsSync(root)) return [];

  const out = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const category = CATEGORY_BY_DIR[dir.name.toLowerCase()] ?? "misc";
    const dirPath = join(root, dir.name);

    const files = readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();

    let order = 0;
    for (const name of files) {
      const ext = extname(name).toLowerCase();
      const mimeType = MIME_BY_EXT[ext];
      // Unknown types are skipped rather than published: the asset route refuses
      // anything not on its allowlist anyway, and a row pointing at a file the
      // route will 415 is a "cannot be previewed" message with no way out.
      if (!mimeType) continue;

      const abs = join(dirPath, name);
      order += 1;
      const storageKey = `${clientSlug}/${siteFolder}/${dir.name}/${name}`;
      out.push({
        id: stableUuid(clientSlug, siteFolder, dir.name, name),
        site_id: siteId,
        survey_id: surveyId,
        category,
        title: titleFor(name),
        file_name: name,
        storage_key: storageKey,
        mime_type: mimeType,
        description: describe(abs, ext, manifest),
        size_bytes: statSync(abs).size,
        is_published: true,
        sort_order: order,
      });
    }
  }
  return out;
}

/** Site level figures taken from the manifest, so the card cannot drift. */
export function siteFactsFromManifest(manifest) {
  if (!manifest?.layers?.length) return {};
  const dsm = manifest.layers.find((l) => /dsm|surface/i.test(l.key) && l.elevation);
  const dtm = manifest.layers.find((l) => /dtm|terrain/i.test(l.key) && l.elevation);
  const vector = manifest.layers.find((l) => l.kind === "vector");
  const tiled = manifest.layers.filter((l) => l.kind === "tiles" || l.kind === "dem");

  // Area from the widest declared footprint, in hectares, via a local metric
  // approximation. Good to a fraction of a percent over a survey this size.
  let areaHa = null;
  const withBounds = manifest.layers.filter((l) => Array.isArray(l.bounds));
  if (withBounds.length) {
    const west = Math.min(...withBounds.map((l) => l.bounds[0]));
    const south = Math.min(...withBounds.map((l) => l.bounds[1]));
    const east = Math.max(...withBounds.map((l) => l.bounds[2]));
    const north = Math.max(...withBounds.map((l) => l.bounds[3]));
    const midLat = (south + north) / 2;
    const w = (east - west) * 111320 * Math.cos((midLat * Math.PI) / 180);
    const h = (north - south) * 110540;
    areaHa = (w * h) / 10000;
  }

  return {
    areaHa,
    dsmRange: dsm?.elevation ?? null,
    dtmRange: dtm?.elevation ?? null,
    contourCount: vector?.featureCount ?? null,
    contourRange: vector?.elevation ?? null,
    layerCount: manifest.layers.length,
    tiledLayers: tiled.length,
  };
}

/** A site summary written from measurements, with no methodology claims. */
export function summaryFromFacts(facts, extras = {}) {
  const bits = [];
  if (facts.dsmRange && facts.dtmRange) {
    bits.push(
      `surface and terrain models spanning ${facts.dtmRange.min} to ${facts.dsmRange.max} m`,
    );
  } else if (facts.dtmRange) {
    bits.push(`a terrain model spanning ${facts.dtmRange.min} to ${facts.dtmRange.max} m`);
  }
  if (facts.contourCount) {
    const step = extras.contourInterval ? `${extras.contourInterval} m ` : "";
    bits.push(`${facts.contourCount} ${step}contour lines`);
  }
  if (extras.gridPoints) bits.push(`a ${extras.gridSpacing ?? ""} m elevation grid`.replace("  ", " "));
  if (extras.lidarPoints) {
    bits.push(`a ${(extras.lidarPoints / 1e6).toFixed(1)} million point LiDAR cloud`);
  }
  if (bits.length === 0) return null;
  const list =
    bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}`;
  return `Processed survey deliverables for this site: ${list}.`;
}

export { relative };
