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
import { cached, fileSource, httpSource } from "@/lib/geo/raster-source.mjs";
import { openRaster } from "@/lib/geo/raster-window.mjs";
import { createTileGrant, TILE_GRANT_COOKIE } from "@/lib/portal/tile-grant";

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

/**
 * Where a site's rasters live, which is not always a disk.
 *
 * `PORTAL_TERRAIN_URL` points at a base that serves the same
 * `<slug>/<kind>.tif` layout over HTTP with Range support: in practice the tile
 * Worker in front of the private R2 bucket, which already forwards Range headers
 * and authorises with the short lived grant cookie. Unset, everything behaves
 * exactly as before and reads the local directory.
 *
 * This is the setting that makes measurement possible in production at all. The
 * rasters are gitignored and total 316 MB, a serverless bundle caps out around
 * 250 MB, and the filesystem is read only, so there is no value of
 * `PORTAL_TERRAIN_DIR` that can work there. Reading byte ranges is not an
 * optimisation, it is the only route.
 */
function terrainLocation(siteSlug: string, kind: TerrainKind) {
  const base = process.env.PORTAL_TERRAIN_URL;
  if (base) {
    return { remote: true as const, ref: `${base.replace(/\/+$/, "")}/${siteSlug}/${kind}.tif` };
  }
  return { remote: false as const, ref: join(terrainDir(siteSlug), `${kind}.tif`) };
}

type OpenRaster = Awaited<ReturnType<typeof openRaster>>;
const openCache = new Map<string, Promise<OpenRaster>>();

/**
 * Open a raster for windowed reading, without decoding any of it.
 *
 * Returns after parsing the directory only, which is a few tens of kilobytes
 * however large the file is, so the metadata a caller needs to project its
 * geometry (the UTM zone, the cell size) costs almost nothing. The pixels come
 * later and only for the window asked for.
 *
 * Cached per path because a client measuring a site makes many requests against
 * the same raster and re-reading the directory each time would be the dominant
 * cost of a spot level.
 */
export async function openTerrain(siteSlug: string, kind: TerrainKind = "dtm") {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteSlug)) {
    throw new TerrainUnavailable("missing", `"${siteSlug}" is not a valid site slug`);
  }

  const { remote, ref } = terrainLocation(siteSlug, kind);
  const hit = openCache.get(ref);
  if (hit) return hit;

  const opening = (async () => {
    if (!remote && !existsSync(ref)) {
      throw new TerrainUnavailable(
        "missing",
        `No ${kind.toUpperCase()} published for this site. Place the source GeoTIFF at ` +
          `portal-data/terrain/${siteSlug}/${kind}.tif, in UTM, and restart.`,
      );
    }

    let raster: OpenRaster;
    try {
      raster = await openRaster(
        cached(
          remote
            ? httpSource(ref, {
                /**
                 * The portal authorises itself to the tile Worker exactly the
                 * way a browser does, with a short lived, site scoped grant.
                 *
                 * Reusing that path rather than giving the server R2 keys keeps
                 * one set of rules in one file: the Worker still cannot be
                 * talked into serving another site, and a compromised portal
                 * process leaks the same thirty minutes of one survey a
                 * compromised browser would. Minted per request because the
                 * grant outlives neither the cache nor a long lived process.
                 */
                headers: async () => ({
                  Cookie: `${TILE_GRANT_COOKIE}=${await createTileGrant(siteSlug)}`,
                }),
              })
            : await fileSource(ref),
        ),
      );
    } catch (error) {
      // A remote 404 is the same fact as a missing file: this survey has no
      // such raster. Anything else is a real failure and must not be dressed up
      // as "not published", which would send an operator looking in the wrong
      // place.
      const message = error instanceof Error ? error.message : String(error);
      if (remote && /not found|not authorised/i.test(message)) {
        throw new TerrainUnavailable(
          "missing",
          `No ${kind.toUpperCase()} published for this site at ${ref}.`,
        );
      }
      throw error;
    }

    if (!raster.utmZone) {
      throw new TerrainUnavailable(
        "not-projected",
        `The ${kind.toUpperCase()} for this site is EPSG ${raster.epsg ?? "unknown"}, which is ` +
          `not a UTM zone. Area and volume computed on it would be meaningless. Re-export in UTM.`,
      );
    }
    return raster;
  })();

  // Only a successful open is worth remembering. Caching the rejection would
  // make a raster that was published a minute ago stay missing for the life of
  // the process.
  openCache.set(ref, opening);
  opening.catch(() => openCache.delete(ref));
  return opening;
}

/**
 * Read the part of a survey that a piece of geometry actually touches.
 *
 * The window is the geometry's bounding box, padded, and the guard is on the
 * *window* rather than the file: a hectare is the same number of cells whether
 * it sits in Kotba or in Dang Forest, and refusing it because the survey around
 * it is large would be refusing the thing this reader exists to make possible.
 */
export async function readTerrainWindow(
  raster: OpenRaster,
  bounds: [number, number, number, number],
) {
  const window = raster.windowFor(bounds);
  if (!window) return null;

  if (window.cols * window.rows > MAX_CELLS) {
    throw new TerrainUnavailable(
      "too-large",
      `That area covers ${window.cols} x ${window.rows} cells at this survey's ` +
        `${raster.cellSize.toFixed(3)} m resolution, which is past what can be measured in one ` +
        `request. Draw a smaller area.`,
    );
  }
  return raster.readWindow(window);
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
