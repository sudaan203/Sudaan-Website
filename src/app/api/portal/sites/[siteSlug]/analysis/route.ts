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
import { lonLatToUtm, utmToLonLat } from "@/lib/geo/projection.mjs";
import {
  spotLevel,
  profile,
  polygonStats,
  gridLevels,
  cutFill,
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

export const runtime = "nodejs";

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
  const kind = body.surface === "dsm" ? "dsm" : "dtm";

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
        const spec = String(body.reference ?? "");
        let reference;
        if (spec === "boundary") reference = REFERENCE.boundaryPlane(grid, ring);
        else if (spec.startsWith("plane:")) reference = REFERENCE.plane(Number(spec.slice(6)));
        else if (spec === "dsm" || spec === "dtm") {
          // The other surface, windowed to the same ground. Two rasters of the
          // same site need not share an origin or a cell size, and they do not
          // have to: `REFERENCE.surface` samples by world coordinate.
          const other = await openTerrain(siteSlug, spec);
          const [minX, minY, maxX, maxY] = boundsOf(ring);
          const otherGrid = await readTerrainWindow(other, [minX, minY, maxX, maxY]);
          if (!otherGrid) {
            throw new BadRequest(
              `That area does not overlap this site's ${spec.toUpperCase()}, so there is ` +
                "nothing to measure against.",
            );
          }
          reference = REFERENCE.surface(otherGrid);
        } else {
          // Deliberately not defaulted. Cut and fill against a flat plane, the
          // polygon's own rim and a second surface are three different questions
          // with three different answers, and the client has to choose.
          throw new BadRequest(
            'reference is required: "boundary", "plane:<elevation>", "dtm" or "dsm". ' +
              "A volume against an unstated reference is not a measurement.",
          );
        }
        result =
          op === "stockpile"
            ? stockpileVolume(grid, ring, reference, { rmseZ })
            : cutFill(grid, ring, reference, { rmseZ });
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

      default:
        throw new BadRequest(
          `Unknown op "${op}". One of: spot, profile, grid-levels, polygon-stats, volume, ` +
            `stockpile, slope, chainage, cross-sections, corridor, bench.`,
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
