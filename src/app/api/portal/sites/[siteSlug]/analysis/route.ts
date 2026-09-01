import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import {
  loadTerrain,
  openTerrain,
  readTerrainWindow,
  surveyRmseZ,
  TerrainUnavailable,
} from "@/lib/portal/terrain-source";
import { boundsOf } from "@/lib/geo/raster-window.mjs";
import { resample } from "@/lib/geo/raster.mjs";
import { lonLatToUtm, utmToLonLat } from "@/lib/geo/projection.mjs";
import {
  spotLevel,
  profile,
  polygonStats,
  gridLevels,
  cutFill,
  compareSurfaces,
  REFERENCE,
} from "@/lib/geo/terrain-analysis.mjs";
import {
  classifySlope,
  stockpileVolume,
  chainage,
  crossSections,
  corridorAnalysis,
  benchAnalysis,
} from "@/lib/geo/engineering.mjs";
import { slopeDegrees } from "@/lib/geo/hydrology.mjs";
import { simulateFlood, seedCellsInPolygon } from "@/lib/geo/flood.mjs";

export const runtime = "nodejs";

/**
 * Most water levels one flood simulation request may ask for.
 *
 * The client builds its own ladder from a starting elevation, an interval and
 * a maximum, client side, and sends the whole thing in one request rather than
 * one request per animation frame. That is far cheaper than it sounds — the
 * DTM is read and cached once regardless — but nothing stops a crafted request
 * asking for ten thousand one-millimetre steps, each one a whole-grid flood
 * fill. 200 comfortably covers a 2 m interval across a 400 m relief, which is
 * a bigger rise than any survey here has.
 */
const MAX_FLOOD_LEVELS = 200;

/**
 * Cells a flood simulation will actually walk, after which the grid is
 * resampled coarser rather than the request refused.
 *
 * Measured on Kiru, whose DTM is 25 cm: a 1.6 km view is 39.7 million cells,
 * and at that size **each level costs about 1.1 seconds** — a ten-step ladder
 * is twelve seconds of compute on top of a two-second read, which is past what
 * a serverless function should be asked for and well past what feels
 * interactive. At four million the same ladder is under a second in total.
 *
 * Resampling rather than refusing is the right trade here and it is the trade
 * `hydro-run` already makes for the same reason: a flood *extent* at 1 m is the
 * same map as a flood extent at 25 cm, because the thing being drawn is a
 * shoreline on a hillside, not a feature the size of a cell. Malhar's §10 asks
 * for exactly this — "DTM resolution is preserved as much as practical" beside
 * "large DTM datasets are processed efficiently". The response reports the cell
 * size it actually used, so the number is never quietly finer than the work.
 */
const MAX_FLOOD_CELLS = 4_000_000;

/**
 * The measurement API the client dashboard operates.
 *
 * Authorisation is identical to every other portal route and happens before any
 * file is opened: prove a session, then ask the tenant scoped store for the
 * site. `getSite` returns null both for "no such site" and "belongs to another
 * client", and this answers 404 for both, so a slug is never confirmed.
 *
 * ## Coordinates, which is where this would go quietly wrong
 *
 * A polygon drawn on a MapLibre map arrives as longitude and latitude. Computing
 * its area on those numbers gives square degrees, which is meaningless and
 * varies with latitude, and the result would look entirely plausible. So the
 * contract is explicit: geometry may arrive as `lonlat` or as `utm`, the caller
 * must say which, and anything in `lonlat` is projected into the survey's own
 * UTM zone here, once, before it reaches the analysis.
 *
 * Everything downstream works in projected metres and every response repeats the
 * CRS it was computed in.
 */

type Geometry = number[][];

function toProjected(geometry: Geometry, crs: string, zone: number, northern: boolean): Geometry {
  if (crs === "utm") return geometry;
  if (crs !== "lonlat") {
    throw new BadRequest(`crs must be "lonlat" or "utm", not "${crs}"`);
  }
  return geometry.map(([lon, lat]) => lonLatToUtm(lon, lat, zone, northern));
}

class BadRequest extends Error {}

function readGeometry(body: Record<string, unknown>, key: string, minimum: number): Geometry {
  const raw = body[key];
  if (!Array.isArray(raw) || raw.length < minimum) {
    throw new BadRequest(`${key} must be an array of at least ${minimum} coordinate pairs`);
  }
  return raw.map((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) throw new BadRequest(`${key} has a malformed pair`);
    const [a, b] = pair.map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new BadRequest(`${key} contains a non numeric coordinate`);
    }
    return [a, b];
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { siteSlug } = await params;
  const site = await queryDb("analysis site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "analysis" });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const op = String(body.op ?? "");
  const crs = String(body.crs ?? "lonlat");
  /*
   * Flood simulation always reads the terrain model. Water spreads over bare
   * earth, not canopy or rooftops, so a client asking this op for the surface
   * model would get a physically meaningless answer. Rather than refuse and
   * make a client resend, `surface` is simply not read for this one op — the
   * panel that drives it never offers the toggle in the first place.
   */
  const kind = op === "flood" ? "dtm" : body.surface === "dsm" ? "dsm" : "dtm";

  try {
    /**
     * Open the directory first, read pixels later.
     *
     * This ordering is what makes windowed reads possible at all, and it is a
     * genuine chicken and egg: projecting the client's lon/lat geometry needs
     * the survey's UTM zone, and knowing which part of the raster to read needs
     * the projected geometry. Parsing the TIFF directory costs tens of
     * kilobytes whatever the file weighs, so the zone is cheap to learn and the
     * pixels are then fetched once, for the bounding box that was actually
     * drawn.
     */
    const raster = await openTerrain(siteSlug, kind);
    const utm = raster.utmZone!;
    const rmseZ = surveyRmseZ();
    const project = (g: Geometry) => toProjected(g, crs, utm.zone, utm.northern);

    /**
     * Projected metres back to lon/lat, for anything the map has to draw.
     *
     * The alignment tools answer in the survey's own CRS, which is right — a
     * chainage is a distance in metres and a station is a point in metres. But a
     * client cannot see a station until it is on the map, and reprojecting
     * fifty of them in the browser would mean shipping a UTM implementation to
     * every page for the sake of four tools. One `lonlat` beside each easting
     * and northing costs a few hundred bytes and keeps the projection in one
     * place.
     */
    const unproject = ([x, y]: [number, number]): [number, number] =>
      utmToLonLat(x, y, utm.zone, utm.northern) as [number, number];
    const withLonLat = <T extends { easting?: number; northing?: number }>(row: T) =>
      typeof row.easting === "number" && typeof row.northing === "number"
        ? { ...row, lonlat: unproject([row.easting, row.northing]) }
        : row;
    const common = {
      site: siteSlug,
      surface: kind,
      computedIn: `EPSG:${raster.epsg}`,
      cellSize: raster.cellSize,
      rmseZ,
    };

    /**
     * The window a piece of geometry needs, in projected metres.
     *
     * `pad` is not cosmetic. A cross section samples perpendicular offsets out
     * to `halfWidth`, and a corridor the same, so a window sized to the centre
     * line alone would run out of raster exactly where those samples land and
     * quietly return nodata for the shoulders.
     */
    const windowed = async (geometry: Geometry, pad = 0) => {
      const [minX, minY, maxX, maxY] = boundsOf(geometry);
      const grid = await readTerrainWindow(raster, [minX - pad, minY - pad, maxX + pad, maxY + pad]);
      if (!grid) {
        // The geometry misses the survey entirely. Not an error: the honest
        // answer is that there is nothing there, and the analysis functions
        // already say so cell by cell.
        throw new BadRequest(
          "That area does not overlap this survey. Draw it over the surveyed ground.",
        );
      }
      return grid;
    };

    /**
     * The reference a measurement is taken against, read once for every op
     * that needs one.
       *
     * Extracted when tools 5 and 13 arrived and needed exactly this contract.
     * Two copies of it would be two places for "boundary" to stop meaning the
     * same thing, and the whole point of stating a reference is that it means
     * one thing.
     */
    const readReference = async (
      grid: NonNullable<Awaited<ReturnType<typeof windowed>>>,
      ring: Geometry,
    ) => {
      const spec = String(body.reference ?? "");
      if (spec === "boundary") return REFERENCE.boundaryPlane(grid, ring);
      if (spec.startsWith("plane:")) {
        const at = Number(spec.slice(6));
        if (!Number.isFinite(at)) {
        throw new BadRequest(`"${spec}" does not name an elevation in metres.`);
        }
        return REFERENCE.plane(at);
      }
      if (spec === "dsm" || spec === "dtm") {
        // The other surface, windowed to the same ground. Two rasters of the
        // same site need not share an origin or a cell size, and they do not
        // have to: `REFERENCE.surface` samples by world coordinate. Kotba's
        // are 0.157 m and 0.241 m, so this is the ordinary case here.
        const other = await openTerrain(siteSlug, spec);
        const [minX, minY, maxX, maxY] = boundsOf(ring);
        const otherGrid = await readTerrainWindow(other, [minX, minY, maxX, maxY]);
        if (!otherGrid) {
        throw new BadRequest(
          `That area does not overlap this site's ${spec.toUpperCase()}, so there is ` +
            "nothing to measure against.",
        );
        }
        return REFERENCE.surface(otherGrid);
      }
      // Deliberately not defaulted. Measured against a flat plane, against the
      // polygon's own rim and against a second surface are three different
      // questions with three different answers, and the client has to choose.
      throw new BadRequest(
        'reference is required: "boundary", "plane:<elevation>", "dtm" or "dsm". ' +
        "A measurement against an unstated reference is not a measurement.",
      );
    };

    let result: Record<string, unknown>;

    switch (op) {
      // Tool 1
      case "spot": {
        const [[x, y]] = project(readGeometry(body, "at", 1));
        // A point still needs its neighbours: the read is bilinear, and
        // `windowFor` pads by enough cells to supply them.
        const grid = await windowed([[x, y]]);
        const elevation = spotLevel(grid, x, y);
        result = {
          easting: x, northing: y, elevation,
          method: "bilinear from the source raster",
          note: elevation === null ? "No survey data at this point." : null,
        };
        break;
      }

      // Tool 3
      case "profile": {
        const line = project(readGeometry(body, "line", 2));
        const spacing = Number(body.spacing) > 0 ? Number(body.spacing) : raster.cellSize;
        result = profile(await windowed(line), line, { spacing });
        break;
      }

      // Tool 2
      case "grid-levels": {
        const ring = project(readGeometry(body, "polygon", 3));
        const spacing = Number(body.spacing) > 0 ? Number(body.spacing) : 1;
        const grid = await windowed(ring);
        result = { ...gridLevels(grid, ring, spacing), stats: polygonStats(grid, ring) };
        break;
      }

      // Drawing tools: area, perimeter, min, max, mean
      case "polygon-stats": {
        const ring = project(readGeometry(body, "polygon", 3));
        result = polygonStats(await windowed(ring), ring);
        break;
      }

      // Tool 4, and tool 15 when the reference is the pile's own rim
      case "volume":
      case "stockpile": {
        const ring = project(readGeometry(body, "polygon", 3));
        const grid = await windowed(ring);
        const reference = await readReference(grid, ring);
        result =
          op === "stockpile"
            ? stockpileVolume(grid, ring, reference, { rmseZ })
            : cutFill(grid, ring, reference, { rmseZ });
        break;
      }

      /**
       * Tools 5 and 13: surface comparison, and tolerance analysis.
       *
       * One op, because they are one act — how far does this surface sit from
       * that one, over this area — and a tolerance is a classification of the
       * same numbers rather than a second measurement. Sending `tolerance` asks
       * for the classification; omitting it asks only for the deviation.
       */
      case "compare": {
        const ring = project(readGeometry(body, "polygon", 3));
        const grid = await windowed(ring);
        const reference = await readReference(grid, ring);
        /*
         * Absent is not zero. `Number(undefined)` is NaN and would be caught,
         * but `Number("")` is 0 and finite, and a zero tolerance classifies
         * every cell as out of tolerance while looking like a deliberate answer.
         * That trap has cost this codebase three features already.
         */
        const raw = body.tolerance;
        const tolerance =
          raw === undefined || raw === null || String(raw).trim() === "" ? null : Number(raw);
        if (tolerance !== null && !(tolerance > 0)) {
          throw new BadRequest("tolerance must be a positive number of metres");
        }
        result = compareSurfaces(grid, ring, reference, { tolerance, rmseZ });
        break;
      }

      /**
       * Tool 14. The one operation here that genuinely needs the whole raster:
       * a slope legend reports the area falling in each band across the entire
       * survey, so there is no window that answers it.
       *
       * It therefore still reads the file whole, and on a deployment without
       * local rasters, or on a survey past the cell cap, it fails the way it
       * always did. Making this windowed means computing it per band from the
       * overviews, which is a different piece of work; until then the honest
       * position is that this one op has not moved.
       */
      case "slope": {
        const scheme = String(body.scheme ?? "");
        const classified = classifySlope(slopeDegrees(loadTerrain(siteSlug, kind)), scheme);
        // The raster itself is not returned: it is megabytes of Int16 and the
        // map renders slope from the tiler. The legend and the areas are what a
        // client reads off a slope map.
        result = { unit: classified.unit, source: classified.source, legend: classified.legend };
        break;
      }

      // Tool 19
      case "chainage": {
        const line = project(readGeometry(body, "line", 2));
        const interval = Number(body.interval) > 0 ? Number(body.interval) : 25;
        const answer = chainage(await windowed(line), line, interval, { rmseZ });
        result = { ...answer, stations: answer.stations.map(withLonLat) };
        break;
      }

      // Tools 20 and 21. Both sample out to `halfWidth` either side of the
      // centre line, so the window has to reach that far or the shoulders come
      // back as nodata and the section looks like it ran off the survey.
      case "cross-sections": {
        const line = project(readGeometry(body, "line", 2));
        const halfWidth = Number(body.halfWidth) > 0 ? Number(body.halfWidth) : 15;
        const answer = crossSections(await windowed(line, halfWidth), line, {
          interval: Number(body.interval) > 0 ? Number(body.interval) : 10,
          halfWidth,
        });
        result = {
          ...answer,
          sections: answer.sections.map((section: Record<string, unknown>) => {
            const samples = section.samples as { easting: number; northing: number }[];
            return {
              ...section,
              centreLonLat: unproject([
                section.centreEasting as number,
                section.centreNorthing as number,
              ]),
              /*
               * The two ends of the cut, so the map can draw the tick the
               * section was actually taken along. Derived from the first and
               * last samples rather than from the half width and a bearing,
               * because those samples *are* where it was measured.
               */
              endsLonLat: samples.length
                ? [
                    unproject([samples[0].easting, samples[0].northing]),
                    unproject([
                      samples[samples.length - 1].easting,
                      samples[samples.length - 1].northing,
                    ]),
                  ]
                : null,
            };
          }),
        };
        break;
      }
      case "corridor": {
        const line = project(readGeometry(body, "line", 2));
        const halfWidth = Number(body.halfWidth) > 0 ? Number(body.halfWidth) : 15;
        const answer = corridorAnalysis(await windowed(line, halfWidth), line, {
          interval: Number(body.interval) > 0 ? Number(body.interval) : 10,
          halfWidth,
          maxGradePercent: Number(body.maxGradePercent) > 0 ? Number(body.maxGradePercent) : 10,
          maxCrossfallPercent:
            Number(body.maxCrossfallPercent) > 0 ? Number(body.maxCrossfallPercent) : 6,
        });
        result = {
          ...answer,
          stations: answer.stations.map(withLonLat),
          unsafeStations: answer.unsafeStations.map(withLonLat),
        };
        break;
      }

      /**
       * Tool 16, bench analysis.
       *
       * A section *across* a mine face, not along a road: the line is read as a
       * profile and split into alternating flats and risers. Which means it will
       * happily find "benches" on a natural hillside, so the result says what it
       * measured rather than what it means. That wording is in the panel too.
       *
       * The window needs no margin — this samples the line itself, like a
       * profile, and unlike the corridor ops it never reaches sideways.
       */
      case "bench": {
        const line = project(readGeometry(body, "line", 2));
        result = benchAnalysis(await windowed(line), line, {
          benchSlopePercent:
            Number(body.benchSlopePercent) > 0 ? Number(body.benchSlopePercent) : 10,
          minBenchWidth: Number(body.minBenchWidth) > 0 ? Number(body.minBenchWidth) : 2,
        });
        break;
      }

      /**
       * Malhar's water-level-rise simulation tool.
       *
       * A whole-grid operation, like slope (tool 14): a flood's extent is not
       * known ahead of the read, so unlike every other op here there is no
       * bounding box to window the raster to. See `flood.mjs` for why this
       * reads the DTM at its own native resolution rather than reusing tool
       * 28's hydrology grid, which is deliberately resampled to 1 m.
       *
       * `at` or `polygon` names a water source; the flood grows outward from
       * it and a hilltop hollow at the same elevation stays dry. Neither given
       * asks the plain question instead — every cell at or below the level —
       * which is the only sensible answer when there is no source for
       * anything to be connected to.
       *
       * `levels` carries the whole ladder an automatic run or an export-all
       * needs in one request, so the DTM is read once regardless of how many
       * steps the client is animating through; a single `level` is accepted
       * as a convenience for the slider dragging to one elevation.
       */
      case "flood": {
        const rawLevels = Array.isArray(body.levels)
          ? body.levels.map(Number)
          : Number.isFinite(Number(body.level))
            ? [Number(body.level)]
            : null;
        if (!rawLevels || rawLevels.length === 0 || rawLevels.some((l) => !Number.isFinite(l))) {
          throw new BadRequest(
            "levels must be a non-empty array of elevations in metres (or a single level).",
          );
        }
        if (rawLevels.length > MAX_FLOOD_LEVELS) {
          throw new BadRequest(`At most ${MAX_FLOOD_LEVELS} levels can be simulated in one request.`);
        }
        // Deduplicated and sorted so a client that sends its ladder out of
        // order, or with a repeated boundary value, gets exactly one result
        // per distinct elevation rather than paying for what it happened to
        // send twice.
        const levels = [...new Set(rawLevels)].sort((a, b) => a - b);
        const interval = Number(body.interval) > 0 ? Number(body.interval) : null;

        /**
         * The ground to flood, as a window rather than the whole survey.
         *
         * This began as `loadTerrain`, a whole-grid read like tool 14's, on the
         * reasoning that a flood's extent is not known before the read so there
         * is nothing to window to. That is true of the *flood* and false of the
         * *study area*, and the difference stopped being academic the moment
         * Kiru arrived: its DTM is 83,979 x 30,046 cells at 25 cm — 2.5 billion
         * cells, 10 GB as Float32 — so the whole-grid read refused it outright
         * and the tool reported "measurements are not available for this
         * survey", which is not what was wrong.
         *
         * A flood over 21 km of gorge is not a thing anyone asks for anyway.
         * The client sends the bounds they are looking at, the flood is computed
         * over exactly that, and water reaching the edge of it is already
         * reported as `truncated` by the same check that flags water reaching
         * the edge of the survey — because for this read they are the same edge.
         *
         * Without bounds it falls back to the whole raster, which still works
         * for every survey small enough to hold and refuses the ones that are
         * not, with `readTerrainWindow`'s own message naming the cell count and
         * telling the client to draw something smaller.
         */
        const view =
          body.bounds === undefined
            ? null
            : (() => {
                const raw = readGeometry(body, "bounds", 2);
                const [[west, south], [east, north]] = raw;
                // Projected as four corners, not two: a UTM rectangle is not a
                // lon/lat rectangle. Grid convergence turns it by up to half a
                // degree here, so a box built from two opposite corners misses
                // ground the other two cover — the same trap the point cloud's
                // node bounds hit in #48.
                return project([
                  [west, south],
                  [east, south],
                  [east, north],
                  [west, north],
                ]);
              })();

        const read = view
          ? await windowed(view)
          : await readTerrainWindow(raster, raster.bounds as [number, number, number, number]);
        if (!read) {
          throw new BadRequest("That view does not overlap this survey.");
        }

        /*
         * Coarsen if the view is large, rather than refusing it or spending a
         * second a level. `resample` averages, so a coarser cell is the mean of
         * the ground under it — which is the honest reduction for a water
         * surface, and it refuses to upsample, so a small view keeps its native
         * resolution untouched.
         */
        const cells = read.width * read.height;
        const dtm =
          cells > MAX_FLOOD_CELLS
            ? resample(read, read.cellSize * Math.sqrt(cells / MAX_FLOOD_CELLS))
            : read;

        let seeds: { col: number; row: number }[] | null = null;
        if (body.polygon !== undefined) {
          const ring = project(readGeometry(body, "polygon", 3));
          seeds = seedCellsInPolygon(dtm, ring);
          if (seeds.length === 0) {
            throw new BadRequest("That starting area has no surveyed ground under it.");
          }
        } else if (body.at !== undefined) {
          const [[x, y]] = project(readGeometry(body, "at", 1));
          const cell = dtm.cellAt(x, y);
          if (!cell) {
            // Distinguished, because they need different actions from the
            // client: a source outside the *survey* is a misplaced click, and
            // one outside the *view* means panning it off screen after placing
            // it, which is easy to do and would otherwise read as our bug.
            throw new BadRequest(
              view
                ? "The water source is outside the area on screen. Pan it back into view, or place a new one."
                : "That starting point is outside this survey.",
            );
          }
          if (dtm.isNoDataAt(cell.col, cell.row)) {
            throw new BadRequest("There is no survey data at that starting point.");
          }
          seeds = [cell];
        }

        result = {
          method: seeds ? "connected" : "threshold",
          seedGround_m: seeds ? dtm.get(seeds[0].col, seeds[0].row) : null,
          /*
           * The resolution the flood was actually computed at, which is not
           * always the survey's own. `common.cellSize` reports the raster's
           * native cell, and a client reading that beside an area computed on a
           * coarsened grid would credit the figure with precision it does not
           * have. Stated here, per request, next to the numbers it governs.
           */
          computedAtCellSize_m: dtm.cellSize,
          resampled: dtm.cellSize > read.cellSize + 1e-9,
          levels: simulateFlood(dtm, levels, seeds, interval, unproject),
        };
        break;
      }

      default:
        throw new BadRequest(
          `Unknown op "${op}". One of: spot, profile, grid-levels, polygon-stats, volume, ` +
            `stockpile, compare, slope, chainage, cross-sections, corridor, bench, flood.`,
        );
    }

    logPortalEvent("view_map", { userId: session.userId, site: siteSlug, file: `analysis:${op}` });

    return NextResponse.json(
      { op, ...common, result },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof BadRequest) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TerrainUnavailable) {
      // 409 rather than 404: the site exists and the client may see it, there is
      // simply nothing to measure yet. A 404 here would suggest the site is gone.
      return NextResponse.json(
        { error: error.message, reason: error.reason },
        { status: 409 },
      );
    }
    // A guardrail tripping, such as a grid level request over a huge polygon,
    // arrives here with a message written for the client to read.
    if (error instanceof Error && /refus|limit|spacing|scheme|reference/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logPortalEvent("denied", {
      userId: session.userId,
      site: siteSlug,
      file: `analysis:${op}`,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
  }
}
