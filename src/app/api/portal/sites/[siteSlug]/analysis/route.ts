import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import {
  loadTerrain,
  openTerrain,
  readTerrainWindow,
  surveyAccuracy,
  hasSpillSurface,
  TerrainUnavailable,
} from "@/lib/portal/terrain-source";
import { boundsOf, reduceOverPolygon, sampleFor } from "@/lib/geo/raster-window.mjs";
import { lonLatToUtm, utmToLonLat } from "@/lib/geo/projection.mjs";
import {
  spotLevel,
  profile,
  gridLevels,
  pointInPolygon,
  newCompare,
  accumulateCompare,
  finaliseCompare,
  newPolygonStats,
  accumulatePolygonStats,
  finalisePolygonStats,
  newCutFill,
  accumulateCutFill,
  finaliseCutFill,
  REFERENCE,
} from "@/lib/geo/terrain-analysis.mjs";
import {
  classifySlope,
  stockpileFrom,
  chainage,
  crossSections,
  corridorAnalysis,
  benchAnalysis,
} from "@/lib/geo/engineering.mjs";
import { slopeDegrees } from "@/lib/geo/hydrology.mjs";
import {
  simulateFlood,
  seedCellsInPolygon,
  newFloodExtent,
  accumulateFloodExtent,
  finaliseFloodExtent,
} from "@/lib/geo/flood.mjs";
import { buildMergeTree } from "@/lib/geo/merge-tree.mjs";

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
 * Cells one flood simulation may walk. Past this the request is **refused**,
 * never quietly coarsened.
 *
 * Measured end to end, eight levels, on the two surveys that bracket the
 * range — Aektanagar at 7.7 cm and Kiru at 25 cm:
 *
 *     budget   Aektanagar        Kiru
 *        4M    154 m, 1.0 s    509 m, 0.5 s
 *        8M    217 m, 2.2 s    719 m, 1.1 s
 *       12M    266 m, 3.3 s    881 m, 1.5 s
 *       16M    307 m, 4.3 s   1017 m, 1.9 s
 *
 * Twelve million is the point where the worst case is still about three
 * seconds. It started at four million, which was calibrated before the LZW
 * kernel and the merge tree, and on a 7.7 cm survey that came out as a 154 m
 * square — small enough that a client looking at a real reservoir was simply
 * told no. Nearly doubling the side length is the difference between a tool
 * that refuses and a tool that answers.
 *
 * The budget is in cells rather than metres because that is what the work is.
 * The same four million cells is a 154 m square on Aektanagar and a 509 m
 * square on Kiru, and both cost the same to simulate.
 *
 * This used to resample instead, averaging the grid down to fit. It was the
 * wrong trade and the client said so: the whole point of a 25 cm survey is
 * that it is a 25 cm survey, and a shoreline computed on 81 cm cells is a
 * different shoreline — one that cannot be checked against Global Mapper or
 * HEC-RAS reading the same file, which is what this tool is *for*. Worse, the
 * degradation was invisible in the picture. So the resampling is gone and the
 * answer to "too much ground" is a sentence telling the client to draw a
 * smaller study area, with the size they asked for and the size that fits both
 * named in it. A refusal a client can act on beats a number they cannot trust.
 */
const MAX_FLOOD_CELLS = 12_000_000;

/**
 * Ladder length from which building a merge tree is worth it.
 *
 * The tree turns each level into a lookup, but building it sorts every cell in
 * the window, and that sort is not free. Sixteen is where the two cross on the
 * measurements in the flood case below — under it the traversal wins outright,
 * over it the tree pulls away and keeps pulling away as the ladder grows.
 */
const TREE_PAYS_FROM_LEVELS = 16;

/**
 * The last merge tree built, kept for the next request against the same ground.
 *
 * A flood ladder is not one question, it is the same question at a dozen water
 * levels, and a client exploring a reservoir asks it again every time they move
 * the interval, the maximum or the slider. The tree does not depend on any of
 * those — only on the ground — so rebuilding it per request is paying the one
 * genuinely expensive part over and over for an answer that has not changed.
 *
 * One entry, not a map. Two clients on different surveys would evict each
 * other, which costs a rebuild and never a wrong answer; a map keyed by window
 * would hold hundreds of megabytes of somebody else's survey against the
 * chance they come back. The key is the ground itself — site, surface and the
 * exact window read — so a tree is only ever reused for the raster it was
 * built from.
 */
let floodTreeCache: { key: string; tree: ReturnType<typeof buildMergeTree> } | null = null;

/**
 * The refusal, written for the client who has to do something about it.
 *
 * Three variants because there are three different situations behind the same
 * cell count, and each one has a different next action: an area that was drawn
 * too big should be redrawn smaller; a view being used *because* nothing was
 * drawn should be replaced by a drawn area rather than zoomed in and guessed
 * at; and a whole survey means the tool was asked to flood everything, which on
 * Kiru is 21 km of gorge nobody was asking about.
 */
function floodTooLarge(
  from: "area" | "view" | "survey",
  cols: number,
  rows: number,
  cellSize: number,
): BadRequest {
  const million = (n: number) => `${(n / 1_000_000).toFixed(1)} million`;
  const metres = (n: number) => `${Math.round(n).toLocaleString("en-GB")} m`;
  /*
   * The square that does fit, in this survey's own metres, because "12 million
   * cells" is not a size anyone can draw and "about 800 m across" is.
   *
   * Deliberately under the true maximum. A window is padded by a margin so
   * edge interpolation has neighbours, it rounds outward to whole cells, and a
   * box drawn on a lon/lat map is not exactly square once projected — so an
   * area drawn at the arithmetic limit lands just over it. Suggesting the exact
   * maximum meant telling a client a size and then refusing it when they drew
   * it, which is worse than refusing plainly. Four fifths of the budget leaves
   * room for all three effects.
   */
  const fits = metres(Math.sqrt(MAX_FLOOD_CELLS * 0.8) * cellSize);
  const size =
    `${metres(cols * cellSize)} by ${metres(rows * cellSize)} — ` +
    `${million(cols * rows)} cells at this survey's ${cellSize.toFixed(3)} m resolution`;
  const subject =
    from === "area" ? "The study area you drew is" : from === "view" ? "The view is" : "This survey is";
  const action =
    from === "area"
      ? `Draw a smaller study area — about ${fits} square or less — and run it again.`
      : `Draw a flood study area on the map — about ${fits} square or less — and run it again.`;
  return new BadRequest(
    `${subject} ${size}. This tool simulates at the survey's full resolution and never ` +
      `coarsens it, so it works over at most ${million(MAX_FLOOD_CELLS)} cells at a time. ${action}`,
  );
}

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

/**
 * The read/decode/compute split for one request, as a `Server-Timing` value.
 *
 * `io` is fetching bytes — a disk read locally, a range request to the tile
 * Worker in production. `decode` is LZW. `compute` is everything after the
 * pixels are in memory, derived rather than measured directly so the three
 * always sum to the whole and no time goes missing between them.
 */
function serverTiming(
  raster: { readStats?: { requests: number; bytes: number; ioMs: number; decodeMs: number } },
  startedAt: number,
): string {
  const total = performance.now() - startedAt;
  const s = raster.readStats;
  if (!s) return `total;dur=${total.toFixed(1)}`;
  const compute = Math.max(0, total - s.ioMs - s.decodeMs);
  return [
    `io;desc="bytes";dur=${s.ioMs.toFixed(1)}`,
    `decode;desc="lzw";dur=${s.decodeMs.toFixed(1)}`,
    `compute;dur=${compute.toFixed(1)}`,
    `reads;desc="range requests";dur=${s.requests}`,
    `fetched;desc="KB";dur=${(s.bytes / 1024).toFixed(0)}`,
    `total;dur=${total.toFixed(1)}`,
  ].join(", ");
}

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
    const startedAt = performance.now();
    const raster = await openTerrain(siteSlug, kind);
    /*
     * Counters cleared per request, so `Server-Timing` below describes this
     * measurement and not everything the cached raster has ever served.
     */
    raster.resetStats?.();
    const utm = raster.utmZone!;
    /**
     * What may be said about this survey's accuracy, resolved from the site row
     * the tenant check already loaded rather than from a global default.
     *
     * `rmseZ` is still what the arithmetic takes, and it is still nullable, so
     * the engineering functions are unchanged: they already return a null
     * uncertainty when there is no figure. What is new is that the response
     * carries the *provenance* beside it, because a client asking "where does
     * ±4 cm come from" deserves an answer from the API rather than from an email
     * thread — and because a typical figure and a measured one look identical
     * once they are a number on a screen.
     */
    const accuracy = surveyAccuracy(site);
    const rmseZ = accuracy.rmseZ;
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
      accuracy,
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
     * Run a sampling tool against only the ground its samples land on.
     *
     * This is what unblocked the cross section on a large survey, and it did
     * not do it by measuring less. A profile takes at most a couple of thousand
     * samples along a line and needs nothing in between them, but the only
     * reader available took a bounding box — so a section drawn corner to
     * corner asked for the box around the diagonal, which on a full site is the
     * whole survey, and the honest answer to that was a refusal. The tool never
     * needed the ground it was being refused.
     *
     * `sampleFor` asks the tool which cells it wants — by running it once
     * against a façade that records the question and answers nothing — and then
     * reads only those, in a handful of small windows. Measured on Kotba with a
     * line drawn corner to corner: 4% of the survey for a profile, 12% for a
     * corridor, and byte-identical results either way. On a survey where the
     * bounding box was hundreds of millions of cells, the saving is the
     * difference between a refusal and an answer.
     *
     * Every tool routed through here decides *where* to sample from geometry
     * alone, never from an elevation it has already read, which is the property
     * that makes the probe pass sound. `sampleFor` says so at more length.
     */
    const sampled = <T,>(run: (grid: any) => T) =>
      sampleFor(raster, run as (grid: any) => unknown, { signal: request.signal }) as Promise<{
        result: T;
        grid: { tiles: number; cellsRead: number; misses: number };
      }>;

    /**
     * Measure a polygon of any size, by walking it in tiles and carrying the
     * accumulator between them.
     *
     * The area cap on cut and fill, stockpile volume, polygon statistics and
     * surface comparison is gone, and not because the limit was raised. Every
     * number those four report is a sum, a weight or a maximum, and those
     * compose across a partition — so the polygon is read one band at a time
     * and only the running totals cross a band boundary. Nothing is coarsened,
     * nothing is sampled, and the arithmetic is the same arithmetic in a
     * different order. `reduceOverPolygon` carries the proof and the two rules
     * that keep it exact.
     *
     * The reference is built *before* the walk, because all three kinds can be:
     * a plane is a constant, a boundary plane is a least-squares fit through
     * samples along the rim — sparse, so `sampled` serves it — and a second
     * surface is read band by band inside the walk, against the same world
     * coordinates.
     */
    const overPolygon = async (
      ring: Geometry,
      accumulate: (grid: any) => void | Promise<void>,
    ) => reduceOverPolygon(raster, ring, accumulate, { signal: request.signal });

    /**
     * The reference a measurement is taken against, read once for every op
     * that needs one.
       *
     * Extracted when tools 5 and 13 arrived and needed exactly this contract.
     * Two copies of it would be two places for "boundary" to stop meaning the
     * same thing, and the whole point of stating a reference is that it means
     * one thing.
     */
    const readReference = async (ring: Geometry) => {
      const spec = String(body.reference ?? "");

      if (spec === "boundary") {
        /*
         * Samples along the rim only, so this is a *sparse* read even when the
         * polygon it bounds is the whole site. A least-squares plane through
         * those samples is then a constant for every band of the walk, which is
         * what keeps a boundary-referenced volume as unlimited as a plane one.
         */
        const { result } = await sampled((g) => REFERENCE.boundaryPlane(g, ring));
        return { at: () => result, perBand: false as const };
      }

      if (spec.startsWith("plane:")) {
        const at = Number(spec.slice(6));
        if (!Number.isFinite(at)) {
          throw new BadRequest(`"${spec}" does not name an elevation in metres.`);
        }
        const reference = REFERENCE.plane(at);
        return { at: () => reference, perBand: false as const };
      }

      if (spec === "dsm" || spec === "dtm") {
        /*
         * The other surface, read band by band alongside the one being
         * measured, rather than windowed whole to the polygon.
         *
         * This is the only reference that costs ground, and reading it whole
         * would have reimposed exactly the limit the tiled walk removes: a
         * DSM-against-DTM volume over a full site would allocate the second
         * survey entirely, and refuse. `REFERENCE.surface` samples by world
         * coordinate, so it does not care that it is being handed one band at
         * a time — or that the two rasters disagree about origin and cell size,
         * which on Kotba they do, 0.157 m against 0.241 m.
         */
        const other = await openTerrain(siteSlug, spec);
        let overlapped = false;
        return {
          perBand: true as const,
          at: async (band: { originX: number; originY: number; width: number; height: number; cellSize: number }) => {
            const minX = band.originX;
            const maxX = band.originX + band.width * band.cellSize;
            const maxY = band.originY;
            const minY = band.originY - band.height * band.cellSize;
            const otherGrid = await readTerrainWindow(other, [minX, minY, maxX, maxY]);
            if (!otherGrid) return null;
            overlapped = true;
            return REFERENCE.surface(otherGrid);
          },
          /*
           * Checked after the walk rather than before it. A band that misses
           * the other survey is ordinary — two surveys of one site rarely share
           * an outline — and only a polygon that missed it *everywhere* is the
           * error the old whole-window read was catching.
           */
          get overlapped() { return overlapped; },
          kind: spec.toUpperCase(),
        };
      }

      // Deliberately not defaulted. Measured against a flat plane, against the
      // polygon's own rim and against a second surface are three different
      // questions with three different answers, and the client has to choose.
      throw new BadRequest(
        'reference is required: "boundary", "plane:<elevation>", "dtm" or "dsm". ' +
        "A measurement against an unstated reference is not a measurement.",
      );
    };

    /**
     * Walk a polygon in bands, accumulating, with the reference resolved per
     * band where it has to be. The shape every unlimited polygon op shares.
     */
    const measurePolygon = async (
      ring: Geometry,
      accumulate: (grid: any, reference: any) => void,
    ) => {
      const ref = await readReference(ring);
      let missingEverywhere = false;
      await overPolygon(ring, async (grid) => {
        const reference = ref.perBand ? await ref.at(grid) : ref.at();
        // No overlap with the reference surface in this band. The cells are
        // still counted — as reference-missing, which is what they are — so a
        // partly covered comparison reports the gap instead of hiding it.
        if (!reference) { missingEverywhere = true; return; }
        accumulate(grid, reference);
      });
      if (ref.perBand && !ref.overlapped) {
        throw new BadRequest(
          `That area does not overlap this site's ${ref.kind}, so there is ` +
            "nothing to measure against.",
        );
      }
      void missingEverywhere;
      return ref;
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
        result = (await sampled((g) => profile(g, line, { spacing }))).result;
        break;
      }

      /**
       * Tool 2. Two different reads, because it asks two different questions.
       *
       * The levels themselves are a lattice of spot heights — sparse, capped at
       * 250,000 points by `gridLevels` itself — so they are sampled. The
       * statistics beside them describe the whole polygon, so they are reduced
       * over it. Reading one window big enough for both was what tied the
       * lattice's cost to the polygon's bounding box rather than to the number
       * of points actually asked for.
       */
      case "grid-levels": {
        const ring = project(readGeometry(body, "polygon", 3));
        const spacing = Number(body.spacing) > 0 ? Number(body.spacing) : 1;
        const levels = (await sampled((g) => gridLevels(g, ring, spacing))).result;
        const acc = newPolygonStats();
        await overPolygon(ring, (grid) => accumulatePolygonStats(acc, grid, ring));
        result = { ...levels, stats: finalisePolygonStats(acc, ring) };
        break;
      }

      // Drawing tools: area, perimeter, min, max, mean
      case "polygon-stats": {
        const ring = project(readGeometry(body, "polygon", 3));
        const acc = newPolygonStats();
        const cost = await overPolygon(ring, (grid) => accumulatePolygonStats(acc, grid, ring));
        result = { ...finalisePolygonStats(acc, ring), readIn: cost.tiles };
        break;
      }

      /**
       * Tool 4, and tool 15 when the reference is the pile's own rim.
       *
       * No area limit. The polygon is walked in bands and the accumulator
       * carries the totals between them, so a cut and fill over a whole site is
       * a longer read rather than a refusal — at the survey's own resolution,
       * with the same arithmetic. See `overPolygon` above and
       * `reduceOverPolygon` for why that is exact rather than approximate.
       */
      case "volume":
      case "stockpile": {
        const ring = project(readGeometry(body, "polygon", 3));
        const acc = newCutFill();
        let used: unknown = null;
        await measurePolygon(ring, (grid, reference) => {
          used = reference;
          accumulateCutFill(acc, grid, ring, reference);
        });
        const volume = finaliseCutFill(acc, ring, { rmseZ, reference: used as { kind: string } });
        result = op === "stockpile" ? stockpileFrom(volume, ring) : volume;
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
        const acc = newCompare({ tolerance });
        let used: unknown = null;
        await measurePolygon(ring, (grid, reference) => {
          used = reference;
          accumulateCompare(acc, grid, ring, reference);
        });
        result = finaliseCompare(acc, ring, { rmseZ, reference: used as { kind: string } });
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
        const answer = (await sampled((g) => chainage(g, line, interval, { rmseZ }))).result;
        result = { ...answer, stations: answer.stations.map(withLonLat) };
        break;
      }

      // Tools 20 and 21. Both sample out to `halfWidth` either side of the
      // centre line, so the window has to reach that far or the shoulders come
      // back as nodata and the section looks like it ran off the survey.
      case "cross-sections": {
        const line = project(readGeometry(body, "line", 2));
        const halfWidth = Number(body.halfWidth) > 0 ? Number(body.halfWidth) : 15;
        const answer = (
          await sampled((g) =>
            crossSections(g, line, {
              interval: Number(body.interval) > 0 ? Number(body.interval) : 10,
              halfWidth,
            }),
          )
        ).result;
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
        const answer = (
          await sampled((g) =>
            corridorAnalysis(g, line, {
              interval: Number(body.interval) > 0 ? Number(body.interval) : 10,
              halfWidth,
              maxGradePercent: Number(body.maxGradePercent) > 0 ? Number(body.maxGradePercent) : 10,
              maxCrossfallPercent:
                Number(body.maxCrossfallPercent) > 0 ? Number(body.maxCrossfallPercent) : 6,
            }),
          )
        ).result;
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
        result = (
          await sampled((g) =>
            benchAnalysis(g, line, {
              benchSlopePercent:
                Number(body.benchSlopePercent) > 0 ? Number(body.benchSlopePercent) : 10,
              minBenchWidth: Number(body.minBenchWidth) > 0 ? Number(body.minBenchWidth) : 2,
            }),
          )
        ).result;
        break;
      }

      /**
       * Malhar's water-level-rise simulation tool.
       *
       * Bounded by a **study area** the client draws, and computed over it at
       * the survey's own native resolution, always. A flood's own extent is not
       * known before the read — that is what makes this different from a
       * profile or a polygon's statistics — but the ground worth asking about
       * is, because a reservoir at a dam site is a 500 m question and the
       * survey around it is a 21 km gorge. See `flood.mjs` for why this reads
       * the DTM at native resolution rather than reusing tool 28's hydrology
       * grid, which is deliberately resampled to 1 m, and `MAX_FLOOD_CELLS`
       * above for why too much ground is refused rather than coarsened.
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
         * The study area: the ground this simulation is allowed to touch.
         *
         * This op began as `loadTerrain`, a whole-grid read like tool 14's, on
         * the reasoning that a flood's extent is not known before the read so
         * there is nothing to window to. That is true of the *flood* and false
         * of the *study area*, and the difference stopped being academic the
         * moment Kiru arrived: its DTM is 83,979 x 30,046 cells at 25 cm — 2.5
         * billion cells, 10 GB as Float32 — so the whole-grid read refused it
         * outright and the tool reported "measurements are not available for
         * this survey", which is not what was wrong.
         *
         * Three sources, in order of how well they say what the client meant:
         *
         *   `area`    a rectangle or polygon drawn on the map for this purpose.
         *             The client said "flood here", so this is what is flooded.
         *   `bounds`  the map's own view, as [[west, south], [east, north]],
         *             used when nothing was drawn. A reasonable guess at intent
         *             and nothing more, which is why the panel says so.
         *   neither   the whole survey, which only a small one survives.
         *
         * All three are windowed the same way and guarded by the same cell cap,
         * so the only thing that changes between them is the wording of the
         * refusal when it does not fit.
         *
         * Projected as a ring of corners, never as two opposite ones: a UTM
         * rectangle is not a lon/lat rectangle. Grid convergence turns it by up
         * to half a degree here, so a box built from two corners misses ground
         * the other two cover — the same trap the point cloud's node bounds hit
         * in #48.
         */
        const drawn = body.area !== undefined;
        const ring: Geometry | null = drawn
          ? project(readGeometry(body, "area", 3))
          : body.bounds !== undefined
            ? (() => {
                const [[west, south], [east, north]] = readGeometry(body, "bounds", 2);
                return project([
                  [west, south],
                  [east, south],
                  [east, north],
                  [west, north],
                ]);
              })()
            : null;
        const from = drawn ? "area" : ring ? "view" : "survey";

        /**
         * Size the read before making it, not after.
         *
         * `windowFor` is arithmetic on the directory this route already parsed,
         * so an oversized request is refused in microseconds instead of after
         * the two seconds it would take to pull 40 million cells off disk and
         * then decide they were too many. That ordering is the difference
         * between a refusal that feels like an answer and one that feels like a
         * timeout.
         */
        const box = ring
          ? (boundsOf(ring) as [number, number, number, number])
          : (raster.bounds as [number, number, number, number]);
        const window = raster.windowFor(box);
        if (!window) {
          throw new BadRequest(
            drawn
              ? "That study area does not overlap this survey. Draw it over the surveyed ground."
              : "That view does not overlap this survey.",
          );
        }
        /**
         * Too much ground to *simulate* — which is not the same as too much
         * ground to answer.
         *
         * A connected flood from a seed the client placed is a traversal, and
         * its extent is not known before the read, so it stays bounded by the
         * study area drawn around it. That is the shape of the question rather
         * than a limitation: placing a seed is saying where to look.
         *
         * Everything else is a per-cell predicate. "Below this level" is
         * `dem <= L`, and "reached by water rising from outside" is
         * `spill <= L` against a surface where the connectivity was resolved
         * once, at publish time. Both are reductions, both compose over a
         * partition, and neither needs the whole grid resident — so the ground
         * is walked in bands and the answer is exact at the survey's own
         * resolution, however much of it was asked about.
         *
         * This is what the refusal Malhar screenshotted turns into. It was
         * never a measurement that could not be made; it was a traversal being
         * run for a question that did not need one.
         */
        const seeded = body.at !== undefined || body.polygon !== undefined;
        if (window.cols * window.rows > MAX_FLOOD_CELLS) {
          if (seeded) throw floodTooLarge(from, window.cols, window.rows, raster.cellSize);

          /*
           * `rising` asks the connected question — water arriving from outside
           * the survey — and needs the spill surface to answer it. Without one
           * the honest answer is the threshold, said plainly, rather than a
           * connected flood quietly downgraded to a bathtub fill.
           */
          const available = hasSpillSurface(siteSlug);
          if (body.rising === true && !available) {
            throw new BadRequest(
              "This survey has no spill surface yet, so water cannot be traced from outside " +
                "it. Ask us to build one, or run the plain level instead — every cell at or " +
                "below the level, whether water could reach it or not.",
            );
          }
          const spillRaster = body.rising === true ? await openTerrain(siteSlug, "spill") : null;

          const acc = newFloodExtent(levels);
          const area = ring ?? [
            [box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]],
          ];
          await reduceOverPolygon(
            raster,
            area,
            async (band, cells) => {
              /*
               * The spill surface is written from this DTM and shares its
               * geometry exactly, so it is read by the *same cell window*
               * rather than by world bounds. Matching on coordinates would
               * introduce a rounding between two rasters that are by
               * construction the same grid, and a one-cell shift between the
               * arrival level and the ground it is subtracted from is a depth
               * error nothing downstream could detect.
               */
              const spill = spillRaster ? await spillRaster.readWindow(cells) : null;
              accumulateFloodExtent(acc, band, { spill, ring });
            },
            { signal: request.signal },
          );

          result = {
            ...finaliseFloodExtent(acc, {
              method: spillRaster ? "rising" : "threshold",
            }),
            /*
             * The same shape the bounded path returns, deliberately. The panel
             * reports where a simulation was run and over how much ground, and
             * that sentence is as true of a site-wide answer as of a drawn one;
             * giving this path its own field names would have meant two code
             * paths in the panel saying the same thing differently.
             */
            studyArea: {
              source: from,
              width_m: window.cols * raster.cellSize,
              height_m: window.rows * raster.cellSize,
              cells: window.cols * window.rows,
            },
            /*
             * No polygons. A site-wide flood at 7 cm is hundreds of millions of
             * cells and its boundary is not a shape a browser can hold, let
             * alone draw — Kotba alone vectorises into 207 separate patches
             * over a fraction of that ground. The extent is drawn by the tiler,
             * which renders it a tile at a time from the same rasters this
             * counted, so the picture and the figures cannot disagree.
             */
            geojson: null,
            layer: spillRaster ? "flood_rising" : "flood_level",
            /*
             * Whether the *other* mode could have been asked for. The panel
             * offers the choice only where it can be honoured, rather than
             * showing a control that answers with a refusal.
             */
            risingAvailable: available,
            resolution_m: raster.cellSize,
            note:
              `Computed over ${from === "survey" ? "the whole survey" : "the area shown"} at ` +
              `${raster.cellSize.toFixed(3)} m, the survey's own resolution. ` +
              (spillRaster
                ? "Water is connected to ground outside the survey; a hollow with no path to it stays dry."
                : "Every cell at or below the level counts, whether water could reach it or not."),
          };
          break;
        }
        const dtm = await raster.readWindow(window);
        if (!dtm) throw new BadRequest("That study area does not overlap this survey.");

        /**
         * Ground outside the drawn shape is not surveyed ground, for this run.
         *
         * The window is a rectangle because a raster read is a rectangle, but a
         * study area need not be: a client drawing a reservoir along a valley
         * draws a polygon, and reporting the water in the corners of its
         * bounding box as part of "the area you asked about" would be a wrong
         * number in the one field this tool exists to produce. Blanking those
         * cells to nodata makes the flood stop at the drawn line exactly, and
         * costs one point-in-polygon test per cell — about 40 ms over a full
         * four-million-cell budget, against the 2 s the simulation itself takes.
         *
         * It also makes `truncated` mean the right thing: water reaching the
         * edge of the study area now borders nodata, so the same check that
         * flags a flood running off the survey flags one running out of the
         * area the client chose to look at. Both are lower bounds, and the panel
         * says so.
         */
        if (ring) {
          for (let row = 0; row < dtm.height; row += 1) {
            const y = dtm.yOf(row);
            for (let col = 0; col < dtm.width; col += 1) {
              if (!pointInPolygon(dtm.xOf(col), y, ring)) {
                dtm.data[row * dtm.width + col] = dtm.nodata;
              }
            }
          }
        }

        let seeds: { col: number; row: number }[] | null = null;
        if (body.polygon !== undefined) {
          const start = project(readGeometry(body, "polygon", 3));
          seeds = seedCellsInPolygon(dtm, start).filter(
            (cell) => !dtm.isNoDataAt(cell.col, cell.row),
          );
          if (seeds.length === 0) {
            throw new BadRequest(
              ring
                ? "That starting water body has no surveyed ground under it inside the study area."
                : "That starting area has no surveyed ground under it.",
            );
          }
        } else if (body.at !== undefined) {
          const [[x, y]] = project(readGeometry(body, "at", 1));
          const cell = dtm.cellAt(x, y);
          // Tested against the ring rather than against the grid, because a
          // point in the corner of a polygon's bounding box is inside the
          // window and outside the study area, and the two failures need
          // different words: one is "you drew the area somewhere else", the
          // other is "there is a hole in the survey there".
          const outside = !cell || (ring !== null && !pointInPolygon(x, y, ring));
          if (outside) {
            throw new BadRequest(
              drawn
                ? "The water source is outside the study area you drew. Place it inside the area, or draw the area around it."
                : ring
                  ? "The water source is outside the area on screen. Pan it back into view, or place a new one."
                  : "That starting point is outside this survey.",
            );
          }
          if (dtm.isNoDataAt(cell.col, cell.row)) {
            throw new BadRequest("There is no survey data at that starting point.");
          }
          seeds = [cell];
        }

        /**
         * Use the merge tree only where it actually wins, which is not
         * everywhere.
         *
         * Measured on Aektanagar, whose 7.7 cm cells make it the worst case
         * here — traversal against build-plus-query, per level count:
         *
         *      cells  levels   traversal   build + query
         *         4M       2      176 ms          693 ms
         *         4M       8      693 ms         1019 ms
         *         4M      16     2302 ms         1543 ms
         *        10M       8     1812 ms         2333 ms
         *        10M      16     5185 ms         3697 ms
         *
         * The build is a sort over every cell and it dominates: below about
         * sixteen levels it costs more than the traversals it replaces. An
         * earlier version used the tree from two levels upward and made the
         * common case — a client checking a handful of levels — up to four
         * times slower.
         *
         * A tree already built for this exact ground is a different matter.
         * The query is far cheaper than a traversal at every level count, so
         * once the build is paid for it is always worth using, which is what
         * makes a session of adjusting the interval and scrubbing the slider
         * fast even though the first run is not.
         */
        const floodTree = (() => {
          if (!seeds || seeds.length !== 1) return null;
          const key = `${siteSlug}:dtm:${window.col0},${window.row0},${window.cols},${window.rows}`;
          if (floodTreeCache?.key === key) return floodTreeCache.tree;
          if (levels.length < TREE_PAYS_FROM_LEVELS) return null;
          const tree = buildMergeTree(dtm);
          floodTreeCache = { key, tree };
          return tree;
        })();

        result = {
          method: seeds ? "connected" : "threshold",
          seedGround_m: seeds ? dtm.get(seeds[0].col, seeds[0].row) : null,
          /*
           * The resolution the flood was computed at, which is now always the
           * survey's own and is reported anyway. It used to be able to differ —
           * the route coarsened large windows — and a client who had read that
           * number once should be able to read it again and see for themselves
           * that it stopped moving, rather than take our word that the
           * downsampling is gone.
           */
          computedAtCellSize_m: dtm.cellSize,
          /*
           * What was actually simulated, so the panel can say it rather than
           * imply it. A flooded-area figure means nothing without the ground it
           * was measured over, and "the area on screen" was only ever true by
           * accident once a client had panned.
           */
          studyArea: {
            source: from,
            width_m: window.cols * dtm.cellSize,
            height_m: window.rows * dtm.cellSize,
            cells: window.cols * window.rows,
          },
          levels: simulateFlood(dtm, levels, seeds, interval, unproject, floodTree),
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
          /**
           * Where this request's time went, in the header the platform already
           * has for it.
           *
           * Every read timing this project has is from a laptop with a warm
           * page cache — 28 ms of I/O against 51 ms of LZW on Kotba. In
           * production the bytes come from R2 over the network into a
           * serverless function, and whether that flips the ratio is the whole
           * question behind moving compute next to the data. Guessing at it
           * from local numbers would be guessing at the one number that
           * decides it, so every response now carries its own.
           *
           * Durations only — no sizes of anything a client cannot already see,
           * and it is behind the same session check as the measurement itself.
           * `Server-Timing` because browsers already chart it and `curl -D -`
           * already prints it; a bespoke debug endpoint would be one more
           * thing to secure and to remember exists.
           */
          "Server-Timing": serverTiming(raster, startedAt),
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
