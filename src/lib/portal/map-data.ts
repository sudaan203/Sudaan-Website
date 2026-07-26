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
  /**
   * "tiles" is what scripts/prepare-site.mjs produces and what everything new
   * should use: a pyramid the browser samples a screenful at a time, so cost is
   * flat in the size of the deliverable. "raster" is the older single image
   * overlay, kept because it is simple and fine for something small.
   */
  /**
   * "dem" is Terrain-RGB: the elevation is packed into the channels rather than
   * turned into a colour, so the browser gets metres back. That one difference is
   * what makes hillshade, an elevation readout, profiles and volumes possible,
   * and it is what the reference dashboard cannot do, because its DEM styling was
   * baked at ingest (see docs/reference/dashboard/03-orthomaps-dtm.jpg, where the
   * nodata gaps are painted black and cannot be fixed without re-ingesting).
   */
  kind: "tiles" | "raster" | "vector" | "dem";
  title: string;
  /** raster and vector layers: a file in the site's folder. */
  file?: string;
  /** tiles: a template relative to the site's folder, with {z}/{x}/{y}. */
  tiles?: string;
  minZoom?: number;
  maxZoom?: number;
  /** tiles: [west, south, east, north], so nothing is requested off the survey. */
  bounds?: [number, number, number, number];
  /** raster and tiles: top left, top right, bottom right, bottom left. */
  coordinates?: [LonLat, LonLat, LonLat, LonLat];
  featureCount?: number;
  elevation?: { min: number; max: number };
  /**
   * Source width and height, present only when the raster was too large to tile
   * on the machine that prepared it and was resized first. Recorded so the
   * difference between "this is everything that was flown" and "this is a
   * reduced copy" is visible rather than inferred from how blurry it looks.
   */
  downsampledFrom?: [number, number];
  /** dem only: how elevation is packed into the channels. */
  encoding?: "mapbox" | "terrarium";
  /**
   * The survey's UTM zone. Measurement has to happen in a projected CRS: a
   * polygon drawn on the map arrives as lon/lat, and computing its area on those
   * numbers gives square degrees, which at this latitude is wrong by about 16%.
   */
  utmZone?: number;
  utmNorthern?: boolean;
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
/**
 * Exactly `tiles/<layer-key>/{z}/{x}/{y}.<webp|png>`, nothing more inventive.
 *
 * PNG is allowed only because Terrain-RGB has to be lossless: one channel unit
 * is 0.1 m of elevation, so WebP's rounding would put noise into the hillshade
 * and into every measurement taken off it. Imagery stays WebP.
 */
const SAFE_TILE_TEMPLATE = /^tiles\/[a-z0-9][a-z0-9-]*\/\{z\}\/\{x\}\/\{y\}\.(webp|png)$/;

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
    // Only expose layers we can build a safe URL for.
    //
    // Both "tiles" and "dem" are pyramids and carry a template; "raster" and
    // "vector" name a single file. Getting this wrong is silent: a layer that
    // fails the check is simply absent from the map, with no error anywhere,
    // which is exactly how the terrain layer went missing when `dem` was added
    // and this filter was not updated with it.
    const isPyramid = (layer: MapLayer) => layer.kind === "tiles" || layer.kind === "dem";
    parsed.layers = parsed.layers.filter((layer) =>
      isPyramid(layer)
        ? typeof layer.tiles === "string" && SAFE_TILE_TEMPLATE.test(layer.tiles)
        : typeof layer.file === "string" && SAFE_FILE.test(layer.file),
    );
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
/**
 * A tile request, and only a tile request.
 *
 * Tiles cannot be listed in the manifest one by one, so instead of "is this
 * file named", the rule is "does this look exactly like a tile belonging to a
 * layer this site declares". Layer key must match a `kind: "tiles"` layer, and
 * z, x and y must be plain integers. Nothing else gets through, which keeps the
 * catch-all route from becoming a way to read the folder.
 */
function tilePathIsDeclared(manifest: MapManifest, segments: string[]): boolean {
  if (segments.length !== 5) return false;
  const [dir, layerKey, z, x, yFile] = segments;
  if (dir !== "tiles") return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(layerKey)) return false;
  if (!/^\d{1,2}$/.test(z) || !/^\d{1,9}$/.test(x)) return false;
  if (!/^\d{1,9}\.(webp|png)$/.test(yFile)) return false;
  return manifest.layers.some(
    (layer) => (layer.kind === "tiles" || layer.kind === "dem") && layer.key === layerKey,
  );
}

/**
 * Is this a legitimate request for a tile that simply was not generated?
 *
 * The survey footprint is a rotated quadrilateral, MapLibre asks for every tile
 * in the rectangle around it, and the corners have no data so no file was
 * written. Those requests are correct behaviour, not an attack and not a bug, so
 * the route answers 204 and the browser console stays clean. Anything that is
 * not a declared tile path still gets a flat 404.
 */
export async function isDeclaredTilePath(siteSlug: string, requested: string): Promise<boolean> {
  const segments = requested.split("/").filter(Boolean);
  const manifest = await readMapManifest(siteSlug);
  if (!manifest) return false;
  return tilePathIsDeclared(manifest, segments);
}

export async function readMapFile(siteSlug: string, requested: string): Promise<MapFile | null> {
  const segments = requested.split("/").filter(Boolean);
  // Reject the separators and traversal tokens before they reach the filesystem.
  if (segments.some((s) => s === "." || s === ".." || s.includes("\\") || s.includes("\0"))) {
    return null;
  }

  const manifest = await readMapManifest(siteSlug);
  if (!manifest) return null;

  const isTile = tilePathIsDeclared(manifest, segments);
  if (!isTile) {
    if (segments.length !== 1) return null;
    if (!SAFE_FILE.test(segments[0])) return null;
    if (!manifest.layers.some((layer) => layer.file === segments[0])) return null;
  }

  const file = segments.join("/");
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
