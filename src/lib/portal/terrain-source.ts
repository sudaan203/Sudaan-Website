/**
 * Finding, and caching, the elevation model a site's measurements are read from.
 *
 * Every number the analysis API returns comes from here, so this is where the
 * accuracy rules from `docs/portal-map-architecture.md` section 6b are actually
 * enforced rather than described:
 *
 * - The **source raster**, not a tile. Terrain-RGB quantises to 0.1 m, which is
 *   two and a half times coarser than the survey's own accuracy, and the tile
 *   pyramid is in Web Mercator, which means a reprojection on top.
 * - **Native resolution**, so nothing is resampled before it is measured.
 * - **A projected CRS**, refused if it is not UTM, because area and volume in
 *   degrees are meaningless.
 *
 * Files live outside `public/` and are never served directly: this module reads
 * them server side and only computed numbers cross the wire.
 *
 * ## The known limit, stated plainly
 *
 * `readGeoTiff` reads the whole file. That is fine for the surveys on disk today
 * (Kotba's DTM is 7 MB, Aektanagar's is comparable) and it is why a cached grid
 * per site is cheap. It does **not** scale to Dang Forest: 450 km² as a float32
 * COG is tens of gigabytes and no serverless function will hold it.
 *
 * The fix is windowed reads over HTTP range requests against a COG, so the cost
 * of a measurement scales with the polygon rather than the survey. That is the
 * same capability the tiler needs and it belongs in the same phase. Until then
 * this module refuses a raster it would choke on rather than exhausting the
 * function's memory and returning a 500 with no explanation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readGeoTiff } from "@/lib/geo/raster.mjs";

/**
 * Biggest raster to load whole, in cells.
 *
 * 80 million float32 cells is about 320 MB as a Float32Array, which fits in a
 * generous serverless function and is far more than any survey published so far.
 * Past this the answer is a windowed COG read, not a bigger machine.
 */
const MAX_CELLS = 80_000_000;

/** Where a site's source rasters live. Outside public/, never served directly. */
function terrainDir(siteSlug: string) {
  const base = process.env.PORTAL_TERRAIN_DIR ?? join(process.cwd(), "portal-data", "terrain");
  return join(base, siteSlug);
}

export type TerrainKind = "dtm" | "dsm";

/**
 * Grids are cached per process because a client measuring a site will make many
 * requests against the same raster, and decoding a 7 MB LZW GeoTIFF on every
 * spot level would dominate the response time.
 *
 * Keyed by path, not by slug, so a republished site under a new filename is not
 * served from a stale entry.
 */
type Cached = { grid: ReturnType<typeof readGeoTiff>; loadedAt: number };
const cache = new Map<string, Cached>();

export class TerrainUnavailable extends Error {
  readonly reason: "missing" | "too-large" | "not-projected";
  constructor(reason: "missing" | "too-large" | "not-projected", message: string) {
    super(message);
    this.reason = reason;
    this.name = "TerrainUnavailable";
  }
}

/**
 * The site's terrain model, ready to measure against.
 *
 * Throws `TerrainUnavailable` rather than returning null, because each reason
 * needs a different answer to the client and silently degrading to "no data" is
 * how a missing raster becomes a confident zero.
 */
export function loadTerrain(siteSlug: string, kind: TerrainKind = "dtm") {
  // The slug reaches the filesystem, so it is validated here even though the
  // route has already resolved it through the tenant scoped store. Defence in
  // depth: this function is exported and the next caller may be less careful.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteSlug)) {
    throw new TerrainUnavailable("missing", `"${siteSlug}" is not a valid site slug`);
  }

  const path = join(terrainDir(siteSlug), `${kind}.tif`);
  const hit = cache.get(path);
  if (hit) return hit.grid;

  if (!existsSync(path)) {
    throw new TerrainUnavailable(
      "missing",
      `No ${kind.toUpperCase()} published for this site. Place the source GeoTIFF at ` +
        `portal-data/terrain/${siteSlug}/${kind}.tif, in UTM, and restart.`,
    );
  }

  const grid = readGeoTiff(path);

  if (!grid.utmZone) {
    throw new TerrainUnavailable(
      "not-projected",
      `The ${kind.toUpperCase()} for this site is EPSG ${grid.epsg ?? "unknown"}, which is not ` +
        `a UTM zone. Area and volume computed on it would be meaningless. Re-export in UTM.`,
    );
  }
  if (grid.width * grid.height > MAX_CELLS) {
    throw new TerrainUnavailable(
      "too-large",
      `The ${kind.toUpperCase()} for this site is ${grid.width} x ${grid.height} cells, past ` +
        `what can be read whole. This needs the windowed COG reader.`,
    );
  }

  cache.set(path, { grid, loadedAt: Date.now() });
  return grid;
}

/** Which terrain models a site actually has, for the map to offer. */
export function availableTerrain(siteSlug: string): TerrainKind[] {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteSlug)) return [];
  return (["dtm", "dsm"] as TerrainKind[]).filter((kind) =>
    existsSync(join(terrainDir(siteSlug), `${kind}.tif`)),
  );
}

/**
 * The survey's stated vertical accuracy, used for the uncertainty band on every
 * volume.
 *
 * A per survey column is the right home for this and it is on the phase 0 list;
 * until that lands it comes from configuration rather than being hardcoded in
 * the analysis, so the number that appears beside a volume is at least in one
 * place. Sudaan advertises plus or minus 3 to 4 cm.
 */
export function surveyRmseZ(): number {
  const configured = Number(process.env.PORTAL_SURVEY_RMSE_Z);
  return Number.isFinite(configured) && configured > 0 ? configured : 0.04;
}
