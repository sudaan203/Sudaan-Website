/**
 * Georeferenced map layers for a site. Node runtime only.
 *
 * Layers live in portal-data/map/<site-slug>/, produced by
 * scripts/prepare-map-data.mjs from the raw survey. That folder is outside
 * public/ on purpose: this is a client's processed data, so every byte is served
 * through an authorised route that checks the caller can see the site first.
 *
 * Layers are described by a manifest on disk rather than a database table. The
 * catalogue is written by the pipeline, not by people, so a table would add a
 * migration and a sync problem without adding a decision anyone makes. When
 * uploads arrive and an owner starts choosing what is published, that is the
 * moment to move this into Postgres beside `assets`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const MAP_ROOT = path.join(process.cwd(), "portal-data", "map");

/** Two corners are enough for a bounding box; four allow a rotated footprint. */
export type LonLat = [number, number];

export type MapLayer = {
  key: string;
  kind: "raster" | "vector";
  title: string;
  file: string;
  /** Raster only: top left, top right, bottom right, bottom left. */
  coordinates?: [LonLat, LonLat, LonLat, LonLat];
  featureCount?: number;
  elevation?: { min: number; max: number };
};

export type MapManifest = {
  site: string;
  generatedAt: string;
  layers: MapLayer[];
};

/**
 * A slug is part of a filesystem path here, so it is validated rather than
 * trusted. Site slugs are lowercase words and hyphens; anything else is refused
 * before it can climb out of the map root.
 */
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9._-]*$/i;

function siteDir(siteSlug: string): string {
  if (!SAFE_SLUG.test(siteSlug)) throw new Error(`unsafe site slug: ${siteSlug}`);
  const dir = path.resolve(MAP_ROOT, siteSlug);
  const root = path.resolve(MAP_ROOT);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(`refusing a site slug outside the map root: ${siteSlug}`);
  }
  return dir;
}

/** The manifest for a site, or null when the site has no map data yet. */
export async function readMapManifest(siteSlug: string): Promise<MapManifest | null> {
  let dir: string;
  try {
    dir = siteDir(siteSlug);
  } catch {
    return null;
  }

  try {
    const raw = await readFile(path.join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as MapManifest;
    if (!Array.isArray(parsed.layers)) return null;
    // Only expose layers whose file name is safe to put back in a URL.
    parsed.layers = parsed.layers.filter((layer) => SAFE_FILE.test(layer.file));
    return parsed;
  } catch {
    return null;
  }
}

export type MapFile = { body: Buffer; contentType: string };

/**
 * Reads one layer file, but only if the manifest lists it. Going through the
 * manifest means a caller cannot name an arbitrary file inside the folder even
 * if it passes the character checks.
 */
export async function readMapFile(siteSlug: string, file: string): Promise<MapFile | null> {
  if (!SAFE_FILE.test(file)) return null;

  const manifest = await readMapManifest(siteSlug);
  if (!manifest) return null;
  if (!manifest.layers.some((layer) => layer.file === file)) return null;

  const dir = siteDir(siteSlug);
  const full = path.resolve(dir, file);
  if (!full.startsWith(dir + path.sep)) return null;

  const contentType = file.endsWith(".geojson")
    ? "application/geo+json"
    : file.endsWith(".webp")
      ? "image/webp"
      : file.endsWith(".png")
        ? "image/png"
        : null;
  if (!contentType) return null;

  try {
    return { body: await readFile(full), contentType };
  } catch {
    return null;
  }
}
