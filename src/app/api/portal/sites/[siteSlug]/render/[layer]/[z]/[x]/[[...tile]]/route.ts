import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { openTerrain, TerrainUnavailable } from "@/lib/portal/terrain-source";
import {
  HydrologyUnavailable,
  loadHydrology,
  type HydrologyLayer,
} from "@/lib/portal/hydrology-source";
import { lonLatToUtm } from "@/lib/geo/projection.mjs";
import { encodePng, transparentPng } from "@/lib/geo/png.mjs";
import { rampFor } from "@/lib/geo/colour.mjs";
import { hillshade, renderGrid } from "@/lib/geo/render.mjs";
import { overlaps, sampleIntoTile, tileBoundsProjected } from "@/lib/geo/tiles.mjs";
import { clampedParam, numberParam } from "@/lib/portal/numbers";

export const runtime = "nodejs";

/**
 * The dynamic tiler: a survey raster, coloured and shaded, one tile at a time.
 *
 *   /api/portal/sites/<slug>/render/<layer>/<z>/<x>/<y>.png
 *
 * ## Why this is a route and not a container
 *
 * `docs/dashboard-tools-plan.md` scoped the tiler as TiTiler inside a Docker
 * image with GDAL, and listed "two new services for one operator" as a standing
 * risk. That scoping was right when `readGeoTiff` could only read a whole file.
 *
 * It is not right any more. A tile is a window, and `raster-window.mjs` reads an
 * arbitrary window out of a GeoTIFF over byte ranges. So the tiler is this file:
 * work out which part of the survey a tile covers, read exactly that, resample,
 * colour, shade, encode. No new service, no GDAL, and it runs in the same place
 * as everything else.
 *
 * ## What it fixes
 *
 * A3 named three reasons the DSM did not show trees. All three are addressed
 * here rather than at ingest, which is the point of rendering on demand:
 *
 * - the ramp is stretched across the layer's **true** minimum and maximum,
 *   taken from the raster, not a percentile guess baked in weeks ago
 * - the hillshade is **composited into** the colour rather than floated over it
 *   as a separate half-transparent layer
 * - it reads the **source** raster, so nothing is lost to a pre-baked pyramid
 *
 * ## Caching
 *
 * `private`, because a tile is survey data and belongs to one client, and
 * `immutable` for a day, because the answer for a given tile and set of
 * parameters cannot change unless the survey is republished. Between those two,
 * a client panning around pays for each tile once and a shared proxy never holds
 * one client's terrain for another. Same reasoning as the tile Worker's own
 * headers.
 */

const TILE_SIZE = 256;
/** Past this the request is asking for more ground than a tile can honestly show. */
const MAX_ZOOM = 24;
const MIN_ZOOM = 8;

/** Layers this route will draw, and how each one should look. */
const LAYERS = {
  dtm: { source: "terrain", kind: "dtm", ramp: "rainbow", relief: true, label: "Terrain model", unit: "m" },
  dsm: { source: "terrain", kind: "dsm", ramp: "rainbow", relief: true, label: "Surface model", unit: "m" },
  filled: { source: "hydrology", kind: "filled", ramp: "rainbow", relief: true, label: "Filled terrain", unit: "m" },
  slope_degrees: { source: "hydrology", kind: "slope_degrees", ramp: "viridis", relief: false, label: "Slope", unit: "°" },
  flow_accumulation: { source: "hydrology", kind: "flow_accumulation", ramp: "water", relief: false, label: "Flow accumulation", unit: "cells", log: true },
  sinks: { source: "hydrology", kind: "sinks", ramp: "water", relief: false, label: "Depression depth", unit: "m" },
  stream_order: { source: "hydrology", kind: "stream_order", ramp: "water", relief: false, label: "Stream order", unit: "" },
  /**
   * Tool 5, the colour-coded deviation map: the surface model minus the terrain
   * model, which on these surveys is the height of everything standing on the
   * ground — canopy, stockpiles, structures.
   *
   * A diverging ramp, and `rampFor` refuses a rainbow for a signed quantity: a
   * difference coloured with a rainbow loses the sign, which is the only thing
   * that matters about it. Relief is off, because shading a difference would
   * light a quantity that has no surface.
   */
  difference: { source: "difference", kind: "dsm", ramp: "difference", relief: false, label: "Surface minus terrain", unit: "m", signed: true },
} as const;

type LayerKey = keyof typeof LAYERS;

function png(body: Buffer, status = 200) {
  return new NextResponse(new Uint8Array(body), {
    status,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * An empty tile, not a 404.
 *
 * Most requested tiles miss a survey entirely: a site is a few hundred metres
 * across and the world is not. MapLibre treats a missing tile and an empty one
 * differently at the edges of a source, and a transparent PNG composites
 * correctly in every case with no special handling in the style.
 */
const EMPTY = transparentPng(TILE_SIZE);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string; layer: string; z: string; x: string; tile?: string[] }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { siteSlug, layer, z, x, tile } = await params;
  const site = await queryDb("render site lookup", () => getSite(session, siteSlug));
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const spec = LAYERS[layer as LayerKey];
  /*
   * Whether this layer's values carry a sign, which decides more than a colour.
   *
   * `rampFor` refuses a sequential ramp for a signed quantity *and* a diverging
   * one for an unsigned quantity, in both directions. Omitting this made the
   * difference layer answer 500 the first time it was asked for, which is the
   * guard working exactly as intended.
   */
  const signed = Boolean((LAYERS[layer as LayerKey] as { signed?: boolean } | undefined)?.signed);
  if (!spec) {
    return NextResponse.json(
      { error: `Unknown layer "${layer}". One of: ${Object.keys(LAYERS).join(", ")}.` },
      { status: 400 },
    );
  }

  const zoom = Number(z);
  const tx = Number(x);
  const ty = Number((tile?.[0] ?? "").replace(/\.(png|webp)$/i, ""));
  if (!Number.isInteger(zoom) || !Number.isInteger(tx) || !Number.isInteger(ty)) {
    return NextResponse.json({ error: "z, x and y must be integers" }, { status: 400 });
  }
  if (zoom < MIN_ZOOM || zoom > MAX_ZOOM) {
    // Not an error: a style with a wide zoom range will ask, and an empty tile
    // is a truthful answer for ground this route will not draw.
    return png(EMPTY);
  }
  const span = 2 ** zoom;
  if (tx < 0 || ty < 0 || tx >= span || ty >= span) return png(EMPTY);

  try {
    // ---- find the grid ----------------------------------------------------
    let grid;
    let epsg: number | null;
    /*
     * Set when the layer builds its tile directly rather than handing back a
     * grid in the survey's own geometry. The difference layer does, because the
     * tile is the only common grid its two inputs have; sampling it into a tile
     * a second time would be resampling a resample. Kept separate from `grid`
     * rather than assigned over it, because a tile-space grid has no world
     * origin and nothing downstream should be able to ask it for one.
     */
    let tileGrid: ReturnType<typeof sampleIntoTile> | null = null;

    /**
     * The difference layer is computed here rather than stored.
     *
     * Both models are sampled into *this tile*, so the tile itself is the common
     * grid and no resampling is invented: every pixel compares the two surfaces
     * at the same point on the ground. That matters here more than usual —
     * Kotba's DSM is 0.157 m and its DTM is 0.241 m with different origins, so
     * there is no shared cell to subtract, and `surfaceDifference` correctly
     * refuses such a pair.
     *
     * Sampled at the tile's own resolution rather than the raster's, which is a
     * point sample rather than an average and so will alias on a canopy edge at
     * low zoom. That is the right trade for a display layer: the polygon
     * statistics in the analysis route read every cell, and they are what a
     * client quotes.
     */
    if (spec.source === "difference") {
      const dsm = await openTerrain(siteSlug, "dsm");
      const dtm = await openTerrain(siteSlug, "dtm");
      epsg = dsm.epsg;
      const zone = dsm.utmZone!;
      const project = (lon: number, lat: number) =>
        lonLatToUtm(lon, lat, zone.zone, zone.northern) as [number, number];
      const bbox = tileBoundsProjected(zoom, tx, ty, project);
      if (!overlaps(bbox, dsm.bounds) || !overlaps(bbox, dtm.bounds)) return png(EMPTY);

      const upper = dsm.windowFor(bbox);
      const lower = dtm.windowFor(bbox);
      if (!upper || !lower) return png(EMPTY);
      if (upper.cols * upper.rows > 40_000_000 || lower.cols * lower.rows > 40_000_000) {
        return png(EMPTY);
      }
      const upperGrid = await dsm.readWindow(upper);
      const lowerGrid = await dtm.readWindow(lower);
      if (!upperGrid || !lowerGrid) return png(EMPTY);

      const a = sampleIntoTile(upperGrid, zoom, tx, ty, project, TILE_SIZE);
      const b = sampleIntoTile(lowerGrid, zoom, tx, ty, project, TILE_SIZE);
      for (let i = 0; i < a.data.length; i += 1) {
        // Either surface missing means the difference is unknown, not zero.
        // Zero would draw as "no change", which is a claim, not an absence.
        if (a.isNoData(a.data[i]) || b.isNoData(b.data[i])) a.data[i] = a.nodata;
        else a.data[i] = a.data[i] - b.data[i];
      }
      tileGrid = a;
    } else if (spec.source === "terrain") {
      const raster = await openTerrain(siteSlug, spec.kind as "dtm" | "dsm");
      epsg = raster.epsg;
      const zone = raster.utmZone!;
      const project = (lon: number, lat: number) =>
        lonLatToUtm(lon, lat, zone.zone, zone.northern) as [number, number];

      const bbox = tileBoundsProjected(zoom, tx, ty, project);
      if (!overlaps(bbox, raster.bounds)) return png(EMPTY);

      const window = raster.windowFor(bbox);
      if (!window) return png(EMPTY);
      // A tile is bounded ground, so this cannot run away; the guard is against
      // a request for a low zoom over a very fine survey.
      if (window.cols * window.rows > 40_000_000) return png(EMPTY);
      grid = await raster.readWindow(window);
    } else {
      const hydro = await loadHydrology(siteSlug);
      grid = await hydro.grid(spec.kind as HydrologyLayer);
      epsg = hydro.epsg;
    }
    if (!grid && !tileGrid) return png(EMPTY);

    const code = epsg ?? 0;
    const zone =
      code >= 32601 && code <= 32660
        ? { zone: code - 32600, northern: true }
        : code >= 32701 && code <= 32760
          ? { zone: code - 32700, northern: false }
          : null;
    if (!zone) return png(EMPTY);
    const project = (lon: number, lat: number) =>
      lonLatToUtm(lon, lat, zone.zone, zone.northern) as [number, number];

    if (
      grid &&
      !overlaps(tileBoundsProjected(zoom, tx, ty, project), [
        grid.originX,
        grid.originY - grid.height * grid.cellSize,
        grid.originX + grid.width * grid.cellSize,
        grid.originY,
      ])
    ) {
      return png(EMPTY);
    }

    // ---- resample into the tile -------------------------------------------
    const sampled = tileGrid ?? sampleIntoTile(grid!, zoom, tx, ty, project, TILE_SIZE);

    let any = false;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < sampled.data.length; i += 1) {
      const v = sampled.data[i];
      if (sampled.isNoData(v)) continue;
      any = true;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!any) return png(EMPTY);

    /**
     * Stretch across the whole layer, not across this tile.
     *
     * Per-tile min and max is the single most tempting mistake here and it makes
     * a chessboard: each tile gets its own scale, so the same elevation is a
     * different colour either side of a tile boundary and the seams become the
     * most visible feature on the map. The range comes from the caller, or from
     * the layer's recorded statistics, and only falls back to this tile when
     * there is nothing else, which is the least wrong option rather than a good
     * one.
     */
    /*
     * Every one of these goes through `numberParam`, which returns null for a
     * parameter that was not supplied. `Number(searchParams.get(k))` is 0 for an
     * absent key, and `Number.isFinite(0)` is true, so the obvious spelling
     * silently substitutes zero for "not asked for". That is how every tile came
     * back fully transparent: the alpha channel was multiplied by an opacity
     * nobody had set.
     */
    const url = new URL(request.url);
    const askedMin = numberParam(url.searchParams, "min");
    const askedMax = numberParam(url.searchParams, "max");
    let lo = askedMin ?? min;
    let hi = askedMax ?? max;
    if (!(hi > lo)) {
      lo = min;
      hi = max > min ? max : min + 1;
    }
    /*
     * A diverging ramp has to be centred on zero, or its midpoint colour lands
     * somewhere that means nothing. Left to the data's own range, a difference
     * running -2 to +25 m would paint +11.5 m as "no change", which is the one
     * reading this layer exists to give correctly.
     */
    if (signed) {
      const reach = Math.max(Math.abs(lo), Math.abs(hi));
      lo = -reach;
      hi = reach;
    }

    const rampName = url.searchParams.get("ramp") ?? spec.ramp;
    let stops;
    try {
      stops = rampFor(rampName, { signed });
    } catch (error) {
      // A client asking for the wrong kind of ramp is a bad request, not a
      // server fault, and the message says exactly why in terms worth reading.
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "unusable ramp" },
        { status: 400 },
      );
    }

    /**
     * Flow accumulation is not a linear quantity and must not be drawn as one.
     *
     * On Kotba it runs from 1 to 7,246 cells, and the distribution is what a
     * drainage network always is: almost every cell drains almost nothing, and a
     * thin thread of channel cells carries everything. Stretched linearly, more
     * than 99% of the map sits in the bottom colour and the channels are a
     * handful of bright pixels. The picture is technically a faithful
     * representation of the numbers and tells a client nothing at all.
     *
     * A logarithmic stretch is the standard treatment for exactly this, and the
     * legend says which was used so nobody reads the colours as proportional.
     * `?scale=linear` opts out.
     */
    const askedScale = url.searchParams.get("scale");
    const logarithmic =
      askedScale === "log" || (Boolean((spec as { log?: boolean }).log) && askedScale !== "linear");

    /*
     * Relief is computed first, and it has to be.
     *
     * The log transform below rewrites the sampled values in place, and a
     * hillshade of log-elevations is not a hillshade of anything: the gradients
     * would be of the logarithm, so slope would be compressed at height and
     * exaggerated near zero. No layer combines the two today, because everything
     * with a log stretch has `relief: false`, but that is a coincidence of the
     * current table rather than a property anybody enforced, and reordering
     * these two blocks later would be an easy and silent mistake.
     */
    const wantsRelief = url.searchParams.get("relief") !== "0" && spec.relief;
    const relief = wantsRelief
      ? hillshade(sampled, {
          azimuth: 315,
          altitude: 45,
          zFactor: 1,
          exaggeration: clampedParam(url.searchParams, "exaggeration", {
            min: 0.1,
            max: 8,
            fallback: 1.6,
          }),
        })
      : null;

    if (logarithmic) {
      // log1p keeps zero at zero, which matters: an accumulation of 0 and of 1
      // are meaningfully different and neither should become -Infinity.
      for (let i = 0; i < sampled.data.length; i += 1) {
        const v = sampled.data[i];
        if (!sampled.isNoData(v)) sampled.data[i] = Math.log1p(Math.max(0, v));
      }
      lo = Math.log1p(Math.max(0, lo));
      hi = Math.log1p(Math.max(0, hi));
      if (!(hi > lo)) hi = lo + 1;
    }

    const rgba = renderGrid(sampled, {
      stops,
      min: lo,
      max: hi,
      relief,
      opacity: clampedParam(url.searchParams, "opacity", { min: 0, max: 1, fallback: 1 }),
    });

    return png(encodePng(TILE_SIZE, TILE_SIZE, rgba));
  } catch (error) {
    // A survey with no such raster is not an error worth a 500, and it is not
    // worth a JSON body either: this endpoint is consumed by an <img>, and a
    // style asking for a layer a site does not have should see empty ground.
    if (error instanceof TerrainUnavailable || error instanceof HydrologyUnavailable) {
      return png(EMPTY);
    }
    return NextResponse.json({ error: "The tile could not be rendered" }, { status: 500 });
  }
}
