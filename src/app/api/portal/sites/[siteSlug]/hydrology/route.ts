import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import {
  HydrologyUnavailable,
  loadHydrology,
  type HydrologyLayer,
} from "@/lib/portal/hydrology-source";
import { lonLatToUtm, utmToLonLat } from "@/lib/geo/projection.mjs";
import {
  connectedFlood,
  downstreamOf,
  snapToChannel,
  watershedFrom,
} from "@/lib/geo/hydrology.mjs";
import { groupRingsIntoPolygons, polygonize } from "@/lib/geo/vectorise.mjs";

export const runtime = "nodejs";

/**
 * Hydrology, tools 24 to 28.
 *
 * Authorisation is identical to every other portal route and happens before any
 * file is opened: prove a session, then ask the tenant scoped store for the
 * site, and answer 404 for both "no such site" and "belongs to another client".
 *
 * ## What this route is, and is not
 *
 * It is a set of graph walks over grids that were computed offline by
 * `scripts/hydro-run.mjs`. It does not fill depressions or accumulate flow on
 * demand: those are whole-grid operations, they take seconds on these surveys
 * and minutes on a real forest, and their answer does not change between
 * requests. Tracing a watershed from a click, by contrast, is a walk over a
 * pointer grid and finishes in milliseconds.
 *
 * ## The four ways hydrology goes quietly wrong, and what is done about each
 *
 * 1. **Cell counts read as areas.** Flow accumulation is a count of cells. A
 *    client reads hectares. Every accumulation on this route is multiplied by
 *    cell area and reported as m² and ha, with the count kept beside it.
 * 2. **Pour points that miss the channel.** A click 2 m off a stream traces the
 *    catchment of a hillside rather than the valley, and the answer looks
 *    perfectly reasonable, just small. Points are snapped to the nearest channel
 *    and the route reports **that it snapped and how far**, so a client can see
 *    it happened.
 * 3. **Truncated catchments.** A survey is a rectangle cut out of a landscape.
 *    Water enters from outside it, so any contributing area computed from the
 *    survey alone is a lower bound. Every catchment says whether it touches the
 *    edge of the data, because a number that understates by an unknown amount
 *    must not be presented as a measurement.
 * 4. **Bathtub flooding.** Colouring every cell below a level is wrong and looks
 *    right: it floods hilltop hollows no water can reach. Flooding here is a
 *    connected fill from a seed the client chose, and the response says so.
 */

class BadRequest extends Error {}

type Pair = [number, number];

function readPoint(body: Record<string, unknown>, key: string): Pair {
  const raw = body[key];
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new BadRequest(`${key} must be a coordinate pair`);
  }
  const [a, b] = raw.map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new BadRequest(`${key} contains a non numeric coordinate`);
  }
  return [a, b];
}

/** Cells to search outward when snapping a click onto a channel. */
const SNAP_RADIUS_CELLS = 8;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { siteSlug } = await params;
  const site = await queryDb("hydrology site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "hydrology" });
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

  try {
    const hydro = await loadHydrology(siteSlug);
    const { manifest } = hydro;
    const epsg = hydro.epsg;
    const zone =
      epsg && epsg >= 32601 && epsg <= 32660
        ? { zone: epsg - 32600, northern: true }
        : epsg && epsg >= 32701 && epsg <= 32760
          ? { zone: epsg - 32700, northern: false }
          : null;
    if (!zone) {
      throw new HydrologyUnavailable(
        "incomplete",
        "This site's hydrology is not in a UTM zone, so areas computed on it would be meaningless.",
      );
    }

    /** A click, in whatever CRS the caller declared, as projected metres. */
    const project = ([a, b]: Pair): Pair => {
      if (crs === "utm") return [a, b];
      if (crs !== "lonlat") throw new BadRequest(`crs must be "lonlat" or "utm", not "${crs}"`);
      return lonLatToUtm(a, b, zone.zone, zone.northern) as Pair;
    };
    const unproject = ([x, y]: Pair): Pair =>
      utmToLonLat(x, y, zone.zone, zone.northern) as Pair;

    const common = {
      site: siteSlug,
      op,
      computedIn: `EPSG:${epsg}`,
      cellSize: hydro.cellSize,
      /**
       * Surfaced, not hidden. The hydrology grid is deliberately coarser than
       * the survey it came from, and a client comparing a 1 m stream network
       * against a 7.7 cm orthophoto deserves to know why it looks blockier than
       * the imagery underneath it.
       */
      resolutionNote:
        `Hydrology is computed at ${hydro.cellSize} m, coarser than the survey on purpose: ` +
        `routing flow across a photogrammetric surface at its native resolution turns every ` +
        `rut and bush into a sink and braids the stream network into noise.`,
      generatedAt: manifest.generatedAt,
      generator: manifest.generator,
    };

    let result: Record<string, unknown>;

    switch (op) {
      /**
       * What exists, with its provenance. The client needs this to build a layer
       * list and, more importantly, to answer "where did this come from" with a
       * record rather than a memory.
       */
      case "layers": {
        result = {
          analysis: manifest.analysis,
          layers: manifest.layers.map((l) => ({
            key: l.key,
            title: l.title,
            group: l.group,
            format: l.format,
            description: l.description,
            derivedFrom: l.derivedFrom,
            generator: l.generator,
            params: l.params,
            stats: l.stats ?? null,
          })),
        };
        break;
      }

      /** The vector products, straight through, for the map to draw. */
      case "streams":
      case "basins": {
        const data = await hydro.vector(op);
        if (!data) throw new HydrologyUnavailable("incomplete", `No ${op} were written for this site.`);
        result = { geojson: data };
        break;
      }

      /**
       * Tools 24 and 25 as a readout: click anywhere and learn what the terrain
       * is doing there.
       */
      case "inspect": {
        const [x, y] = project(readPoint(body, "at"));
        const accum = await hydro.grid("flow_accumulation");
        const cell = accum.cellAt(x, y);
        if (!cell) throw new BadRequest("That point is outside this survey.");

        const [filled, slope, order, sinks, direction] = await Promise.all([
          hydro.grid("filled"),
          hydro.grid("slope_degrees"),
          hydro.grid("stream_order"),
          hydro.grid("sinks"),
          hydro.grid("flow_direction"),
        ]);

        const at = (g: typeof accum) => {
          const v = g.get(cell.col, cell.row);
          return g.isNoData(v) ? null : v;
        };
        const cells = at(accum);
        const streamOrder = at(order);

        result = {
          easting: x,
          northing: y,
          elevation: at(filled),
          slopeDegrees: at(slope),
          slopePercent: at(slope) === null ? null : Math.tan((at(slope)! * Math.PI) / 180) * 100,
          // A count is not an area. Both are given, and the area is the one the
          // labels use.
          contributingCells: cells,
          contributingArea_m2: cells === null ? null : cells * accum.cellArea,
          contributingArea_ha: cells === null ? null : (cells * accum.cellArea) / 10000,
          strahlerOrder: streamOrder === null || streamOrder <= 0 ? null : streamOrder,
          onChannel: streamOrder !== null && streamOrder > 0,
          sinkDepth_m: at(sinks),
          drainsTo: (() => {
            // Which way the water goes from here, as a coordinate rather than a
            // D8 code, so the map can draw it.
            const i = cell.row * direction.width + cell.col;
            const next = downstreamOf(direction, i);
            if (next === -1 || next === i) return null;
            const nc = next % direction.width;
            const nr = Math.floor(next / direction.width);
            return { easting: direction.xOf(nc), northing: direction.yOf(nr) };
          })(),
        };
        break;
      }

      /**
       * Tool 26. Trace everything draining through one point.
       *
       * The upstream traversal is why hydrology grids are held whole: the answer
       * can reach any part of the survey, so there is no window that contains it
       * in advance.
       */
      case "watershed": {
        const [x, y] = project(readPoint(body, "at"));
        const [direction, accum] = await Promise.all([
          hydro.grid("flow_direction"),
          hydro.grid("flow_accumulation"),
        ]);
        const clicked = direction.cellAt(x, y);
        if (!clicked) throw new BadRequest("That point is outside this survey.");

        /*
         * Snapping is not a convenience. A pour point two metres off the channel
         * traces a hillside instead of a valley and returns a catchment that is
         * plausible, tidy and an order of magnitude too small. Whether it moved,
         * and how far, is part of the answer.
         */
        const snapped = body.snap === false
          ? clicked
          : snapToChannel(accum, clicked.col, clicked.row, SNAP_RADIUS_CELLS) ?? clicked;
        const moved_m =
          Math.hypot(snapped.col - clicked.col, snapped.row - clicked.row) * direction.cellSize;

        const mask = watershedFrom(direction, snapped.col, snapped.row);
        let cells = 0;
        let touchesEdge = false;
        for (let row = 0; row < mask.height; row += 1) {
          for (let col = 0; col < mask.width; col += 1) {
            if (mask.data[row * mask.width + col] !== 1) continue;
            cells += 1;
            // Against the edge of the file, or against a cell the survey never
            // saw. Either way water is arriving from somewhere unmeasured.
            if (col === 0 || row === 0 || col === mask.width - 1 || row === mask.height - 1) {
              touchesEdge = true;
            } else if (
              accum.isNoDataAt(col - 1, row) || accum.isNoDataAt(col + 1, row) ||
              accum.isNoDataAt(col, row - 1) || accum.isNoDataAt(col, row + 1)
            ) {
              touchesEdge = true;
            }
          }
        }

        const area = cells * direction.cellArea;
        const rings = polygonize(mask, direction);

        result = {
          pourPoint: {
            easting: direction.xOf(snapped.col),
            northing: direction.yOf(snapped.row),
            lonlat: unproject([direction.xOf(snapped.col), direction.yOf(snapped.row)]),
            snapped: moved_m > 0,
            snappedBy_m: moved_m,
          },
          cells,
          area_m2: area,
          area_ha: area / 10000,
          truncatedBySurveyEdge: touchesEdge,
          // Said in words as well as a flag: a bare boolean beside a number does
          // not stop the number being quoted on its own.
          note: touchesEdge
            ? "This catchment reaches the edge of the surveyed ground, so water enters it from " +
              "outside the data. The area above is a lower bound, not the true contributing area."
            : null,
          geojson: ringsToFeature(rings, unproject, {
            kind: "watershed",
            area_ha: area / 10000,
            truncated: touchesEdge,
          }),
        };
        break;
      }

      /**
       * Tool 27. Depressions deep enough to matter, from the fill step.
       */
      case "sinks": {
        const minDepth = Number(body.minDepth) > 0 ? Number(body.minDepth) : 0.25;
        const sinks = await hydro.grid("sinks");
        const mask = sinks.like(Uint8Array, 0, 255);
        let cells = 0;
        let volume = 0;
        let deepest = 0;
        for (let i = 0; i < sinks.length; i += 1) {
          const d = sinks.data[i];
          if (sinks.isNoData(d) || !(d >= minDepth)) continue;
          mask.data[i] = 1;
          cells += 1;
          volume += d * sinks.cellArea;
          if (d > deepest) deepest = d;
        }
        result = {
          minDepth_m: minDepth,
          cells,
          area_m2: cells * sinks.cellArea,
          area_ha: (cells * sinks.cellArea) / 10000,
          storage_m3: volume,
          deepest_m: deepest,
          geojson: ringsToFeature(polygonize(mask, sinks), unproject, {
            kind: "sinks",
            minDepth_m: minDepth,
          }),
        };
        break;
      }

      /**
       * Tool 28. Standing water to a stated level, from a seed.
       *
       * A connected fill, never a threshold over the whole raster. The two look
       * identical on a map and differ entirely in meaning: the threshold floods
       * every hollow at that elevation including ones on hilltops with no path
       * to them.
       */
      case "flood": {
        const level = Number(body.level);
        if (!Number.isFinite(level)) {
          throw new BadRequest("level is required, as an elevation in metres.");
        }
        const [x, y] = project(readPoint(body, "at"));
        const filled = await hydro.grid("filled");
        const seed = filled.cellAt(x, y);
        if (!seed) throw new BadRequest("That seed point is outside this survey.");

        const ground = filled.get(seed.col, seed.row);
        if (filled.isNoData(ground)) {
          throw new BadRequest("There is no survey data at that seed point.");
        }
        if (level <= ground) {
          throw new BadRequest(
            `A level of ${level.toFixed(2)} m is at or below the ground at that point ` +
              `(${ground.toFixed(2)} m), so nothing would be flooded. Choose a higher level.`,
          );
        }

        const flood = connectedFlood(filled, level, [seed]);
        const mask = filled.like(Uint8Array, 0, 255);
        /*
         * The deepest water, found by looking.
         *
         * This was `level - ground`, which is the depth at the *seed* and is
         * only the maximum if the seed happens to sit at the lowest point of the
         * lake. Seed a level 1.5 m above a hillside and the water runs down into
         * a valley 30 m below: the figure said 1.5 m while the panel labelled it
         * "Deepest". Plausible, wrong, and invisible.
         */
        let deepest = 0;
        for (let i = 0; i < flood.depth.length; i += 1) {
          const d = flood.depth.data[i];
          const wet = !flood.depth.isNoData(d) && d > 0;
          mask.data[i] = wet ? 1 : 0;
          if (wet && d > deepest) deepest = d;
        }

        result = {
          level_m: level,
          seedGround_m: ground,
          cells: flood.cells,
          area_m2: flood.area,
          area_ha: flood.area / 10000,
          storage_m3: flood.volume,
          maxDepth_m: deepest,
          depthAtSeed_m: level - ground,
          method:
            "Connected fill from the seed you chose. Hollows at this elevation with no path " +
            "from the seed stay dry, which a simple threshold would flood.",
          geojson: ringsToFeature(polygonize(mask, filled), unproject, {
            kind: "flood",
            level_m: level,
            storage_m3: flood.volume,
          }),
        };
        break;
      }

      default:
        throw new BadRequest(
          `Unknown op "${op}". One of: layers, streams, basins, inspect, watershed, sinks, flood.`,
        );
    }

    logPortalEvent("view_map", { userId: session.userId, site: siteSlug, file: `hydrology:${op}` });

    return NextResponse.json(
      { ...common, result },
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
    if (error instanceof HydrologyUnavailable) {
      // 409, matching the analysis route: the site exists and the client may see
      // it, there is simply nothing computed yet. A 404 would suggest it is gone.
      return NextResponse.json({ error: error.message, reason: error.reason }, { status: 409 });
    }
    logPortalEvent("denied", {
      userId: session.userId,
      site: siteSlug,
      file: `hydrology:${op}`,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Hydrology failed" }, { status: 500 });
  }
}

/**
 * Rings in projected metres to a GeoJSON feature in WGS84.
 *
 * RFC 7946 says GeoJSON is lon/lat on WGS84 and MapLibre expects exactly that,
 * so the geometry is unprojected on the way out. The projected figures stay in
 * the properties, because those are what a CAD workflow consumes and because
 * area must never be recomputed from the degrees.
 *
 * ## A MultiPolygon, and why this changed
 *
 * This used to hand `polygonize`'s flat ring list straight to a `Polygon` as
 * its `coordinates`, which declares ring 0 the outer boundary and **every
 * other ring a hole in it**. For a watershed that is right — a catchment is
 * one connected region — and it was written when watershed was the only
 * caller. It is wrong for `sinks`, which returns every depression on the
 * survey: all but the first became holes punched in the first, geometry no
 * reader can make sense of and none of them complains about. Found while
 * building the flood simulation, whose output is disconnected far more often
 * than not (207 separate ponds on Kotba at its lowest level).
 *
 * `groupRingsIntoPolygons` puts each patch back with its own holes. The type
 * is now always MultiPolygon, even for a single-patch watershed, so a client
 * never has to branch on how many pieces today's answer happens to have.
 */
function ringsToFeature(
  rings: number[][][],
  unproject: (p: [number, number]) => [number, number],
  properties: Record<string, unknown>,
) {
  const polygons = groupRingsIntoPolygons(rings);
  return {
    type: "FeatureCollection" as const,
    features: polygons.length
      ? [
          {
            type: "Feature" as const,
            properties,
            geometry: {
              type: "MultiPolygon" as const,
              coordinates: polygons.map((group: number[][][]) =>
                group.map((ring) =>
                  ring.map(([x, y]) => unproject([x, y] as [number, number])),
                ),
              ),
            },
          },
        ]
      : [],
  };
}
