import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import { loadTerrain, surveyRmseZ, TerrainUnavailable } from "@/lib/portal/terrain-source";
import { lonLatToUtm } from "@/lib/geo/projection.mjs";
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
    const dem = loadTerrain(siteSlug, kind);
    const utm = dem.utmZone!;
    const rmseZ = surveyRmseZ();
    const project = (g: Geometry) => toProjected(g, crs, utm.zone, utm.northern);
    const common = {
      site: siteSlug,
      surface: kind,
      computedIn: `EPSG:${dem.epsg}`,
      cellSize: dem.cellSize,
      rmseZ,
    };

    let result: Record<string, unknown>;

    switch (op) {
      // Tool 1
      case "spot": {
        const [[x, y]] = project(readGeometry(body, "at", 1));
        const elevation = spotLevel(dem, x, y);
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
        const spacing = Number(body.spacing) > 0 ? Number(body.spacing) : dem.cellSize;
        result = profile(dem, line, { spacing });
        break;
      }

      // Tool 2
      case "grid-levels": {
        const ring = project(readGeometry(body, "polygon", 3));
        const spacing = Number(body.spacing) > 0 ? Number(body.spacing) : 1;
        result = { ...gridLevels(dem, ring, spacing), stats: polygonStats(dem, ring) };
        break;
      }

      // Drawing tools: area, perimeter, min, max, mean
      case "polygon-stats": {
        result = polygonStats(dem, project(readGeometry(body, "polygon", 3)));
        break;
      }

      // Tool 4, and tool 15 when the reference is the pile's own rim
      case "volume":
      case "stockpile": {
        const ring = project(readGeometry(body, "polygon", 3));
        const spec = String(body.reference ?? "");
        let reference;
        if (spec === "boundary") reference = REFERENCE.boundaryPlane(dem, ring);
        else if (spec.startsWith("plane:")) reference = REFERENCE.plane(Number(spec.slice(6)));
        else if (spec === "dsm" || spec === "dtm") {
          reference = REFERENCE.surface(loadTerrain(siteSlug, spec));
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
            ? stockpileVolume(dem, ring, reference, { rmseZ })
            : cutFill(dem, ring, reference, { rmseZ });
        break;
      }

      // Tool 14
      case "slope": {
        const scheme = String(body.scheme ?? "");
        const classified = classifySlope(slopeDegrees(dem), scheme);
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
        result = chainage(dem, line, interval, { rmseZ });
        break;
      }

      // Tools 20 and 21
      case "cross-sections": {
        const line = project(readGeometry(body, "line", 2));
        result = crossSections(dem, line, {
          interval: Number(body.interval) > 0 ? Number(body.interval) : 10,
          halfWidth: Number(body.halfWidth) > 0 ? Number(body.halfWidth) : 15,
        });
        break;
      }
      case "corridor": {
        const line = project(readGeometry(body, "line", 2));
        result = corridorAnalysis(dem, line, {
          interval: Number(body.interval) > 0 ? Number(body.interval) : 10,
          halfWidth: Number(body.halfWidth) > 0 ? Number(body.halfWidth) : 15,
          maxGradePercent: Number(body.maxGradePercent) > 0 ? Number(body.maxGradePercent) : 10,
        });
        break;
      }

      default:
        throw new BadRequest(
          `Unknown op "${op}". One of: spot, profile, grid-levels, polygon-stats, volume, ` +
            `stockpile, slope, chainage, cross-sections, corridor.`,
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
