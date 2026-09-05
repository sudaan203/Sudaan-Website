/**
 * Survey geometry for the test suites, derived from the raster rather than typed in.
 *
 * ## Why this exists
 *
 * Every suite here used to be anchored to Kotba: a lon/lat polygon around
 * 73.73 E 20.84 N, a plane at 366 m, a slippy tile at zoom 17, a line drawn
 * across the site. Pointed at another survey those are not merely wrong, they
 * are *off the map*, and the suite fails for a reason that says nothing about
 * the product. Two production bugs were found on surveys nothing exercised, and
 * both were invisible because only Kotba was ever tested.
 *
 * So the geometry a suite needs is computed from the survey's own header here,
 * once, and every suite asks for it the same way.
 *
 * ## Two rules this module exists to enforce
 *
 * **Size in cells, not metres.** A 600 m box is 6 million cells on Kotba's
 * 24 cm grid and 60 million on Aektanagar's 7.7 cm one. Anything working to a
 * cell budget — the flood tool does — therefore means something completely
 * different per survey when it is sized in metres. That is exactly how the
 * flood came to refuse a client's real view on Aektanagar. `boxOfCells` and
 * `ringOfCells` size from the survey's own cell, so a check says the same thing
 * whichever survey it is pointed at. Where a quantity is genuinely an
 * engineering one — a 25 m chainage interval, a 12 m carriageway half-width —
 * metres are right and are used deliberately.
 *
 * **Never read the whole raster to find out where the survey is.** `openRaster`
 * parses the directory only, a few tens of kilobytes however large the file, so
 * the header costs nothing even on Kiru's 2.3 GB DTM. `readGeoTiff` on that file
 * does not merely run out of memory, it throws `ERR_FS_FILE_TOO_LARGE` from the
 * filesystem before any of this code runs: `readFileSync` will not return more
 * than 2 GiB. A suite that needs pixels for ground truth takes a **window**
 * (`centreWindow`), which is a real Grid, indistinguishable from a whole-raster
 * one to everything in `terrain-analysis.mjs`, and works on all three surveys.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cached, fileSource } from "../../src/lib/geo/raster-source.mjs";
import { openRaster } from "../../src/lib/geo/raster-window.mjs";
import { lonLatToUtm, utmToLonLat } from "../../src/lib/geo/projection.mjs";

/**
 * The surveys the matrix runs over.
 *
 * Ordered smallest first so a run that is going to fail everywhere fails fast
 * and cheaply rather than after twenty minutes of Kiru.
 */
export const SURVEYS = [
  { slug: "kotba-survey", label: "kotba" },
  { slug: "aektanagar-survey", label: "aektanagar" },
  { slug: "kiru-hydroelectric-survey", label: "kiru" },
];

/** Where a survey's rasters live, honouring the same override the server uses. */
export function terrainDir(slug) {
  const base = process.env.PORTAL_TERRAIN_DIR ?? join(process.cwd(), "portal-data", "terrain");
  return join(base, slug);
}

export function rasterPath(slug, kind = "dtm") {
  return join(terrainDir(slug), `${kind}.tif`);
}

/** Is there a raster for this survey at all? The runner skips rather than fails. */
export function surveyPresent(slug, kind = "dtm") {
  return existsSync(rasterPath(slug, kind));
}

/**
 * Biggest raster `readGeoTiff` will open, in bytes.
 *
 * Not a policy this project chose: `fs.readFileSync` refuses anything over
 * 2 GiB with `ERR_FS_FILE_TOO_LARGE`, so the ceiling is the runtime's. Stated
 * here so a suite can decide *before* trying, and print a reason, rather than
 * discovering it as a stack trace.
 */
export const READ_WHOLE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Open a survey and derive everything a suite needs to place its geometry.
 *
 * The returned object is deliberately not a Grid. It carries the header, the
 * projections, and the helpers that turn a size in cells into coordinates, and
 * hands out pixels only through `centreWindow`.
 */
export async function openSurvey(slug, kind = "dtm") {
  const path = rasterPath(slug, kind);
  if (!existsSync(path)) {
    throw new Error(`no ${kind.toUpperCase()} for ${slug} at ${path}`);
  }

  const source = cached(await fileSource(path));
  const raster = await openRaster(source);

  const zone = raster.utmZone;
  if (!zone) {
    throw new Error(
      `${slug} is EPSG ${raster.epsg}, which is not a UTM zone. Every metre-based ` +
        `check in these suites would be meaningless on it.`,
    );
  }

  const { width, height, cellSize, originX, originY } = raster;

  /*
   * The centre of the middle *cell*, not the middle of the grid.
   *
   * Half a cell of difference, and it matters. `originX + (width / 2) * cellSize`
   * lands on a cell boundary whenever the width is even, and a point on a
   * boundary is the one place where two readers can disagree about which cell it
   * is in: `windowFor` gives a window the origin `originX + col0 * cellSize`,
   * and on a survey whose cell size has a long mantissa — Aektanagar's is
   * 0.07686839999999892 — that lands at 2811.9999999999786 cells from the raster
   * origin rather than 2812, so `floor()` picks the cell before. Sampling at a
   * cell centre is the farthest a point can be from that seam, and costs
   * nothing.
   */
  const centreE = originX + (Math.floor(width / 2) + 0.5) * cellSize;
  const centreN = originY - (Math.floor(height / 2) + 0.5) * cellSize;
  const [centreLon, centreLat] = utmToLonLat(centreE, centreN, zone.zone, zone.northern);

  const toLonLat = ([e, n]) => utmToLonLat(e, n, zone.zone, zone.northern);
  const toUtm = ([lon, lat]) => lonLatToUtm(lon, lat, zone.zone, zone.northern);

  /** Half-width in metres of a square holding `cells` cells of this survey. */
  const halfOf = (cells) => (Math.sqrt(cells) / 2) * cellSize;

  return {
    slug,
    kind,
    path,
    raster,
    width,
    height,
    cellSize,
    originX,
    originY,
    epsg: raster.epsg,
    tiled: raster.tiled,
    zone: zone.zone,
    northern: zone.northern,
    cells: width * height,
    centreE,
    centreN,
    centreLon,
    centreLat,
    toLonLat,
    toUtm,

    /**
     * On-disk size, followed through the symlink the terrain directory uses.
     *
     * `statSync` rather than `lstatSync`: `portal-data/terrain/<slug>/dtm.tif`
     * is a symlink into the delivery folder on every developer machine here, and
     * the size of a symlink is the length of its target string.
     */
    bytes: statSync(path).size,

    /**
     * Can `readGeoTiff` open this file at all?
     *
     * The ceiling that fires first is the *byte* one, and it fires inside `fs`
     * rather than anywhere in this project: `readFileSync` throws
     * `ERR_FS_FILE_TOO_LARGE` over 2 GiB regardless of `--max-old-space-size`.
     * A suite that only checked the cell count would still be surprised by it.
     */
    get readableWhole() {
      return this.bytes <= READ_WHOLE_LIMIT_BYTES;
    },

    /** A lon/lat bounding box, as two corners, holding `cells` cells. */
    boxOfCells(cells) {
      const half = halfOf(cells);
      return [
        toLonLat([centreE - half, centreN - half]),
        toLonLat([centreE + half, centreN + half]),
      ];
    },

    /** A closed square ring in projected metres, holding `cells` cells. */
    ringOfCells(cells) {
      return this.ringOfMetres(halfOf(cells));
    },

    /**
     * A closed square ring in projected metres, given a half-width in metres.
     *
     * Metres are correct where the *area itself* is the quantity under test — a
     * hectare is a hectare on every survey, and the cut-and-fill checks are
     * anchored to "10,000 m³ per metre of plane over one hectare". Use
     * `ringOfCells` wherever the cost or the cell budget is what is being
     * exercised.
     */
    ringOfMetres(half) {
      return [
        [centreE - half, centreN - half],
        [centreE + half, centreN - half],
        [centreE + half, centreN + half],
        [centreE - half, centreN + half],
        [centreE - half, centreN - half],
      ];
    },

    /** The same ring, in lon/lat, which is what the routes are sent. */
    ringLonLat(half) {
      return this.ringOfMetres(half).map(toLonLat);
    },

    /**
     * A line of `length` metres across the middle of the survey, as lon/lat.
     *
     * Bent deliberately: a straight line cannot catch a cross-section cut along
     * the grid axes instead of across the alignment, because on a straight line
     * the two coincide. The bend is a fixed fraction of the length so the line
     * has the same shape on every survey.
     */
    lineOfMetres(length, vertices = 3) {
      const points = [];
      for (let i = 0; i < vertices; i += 1) {
        const t = i / (vertices - 1) - 0.5; // -0.5 .. +0.5 along the line
        const along = t * length * 0.72; // leaves room for the bend
        const across = Math.sin(t * Math.PI) * length * 0.18;
        points.push(toLonLat([centreE + along, centreN + across]));
      }
      return points;
    },

    /**
     * A Grid of the middle of the survey, read through the windowed reader.
     *
     * This is what makes ground truth possible on a survey too large to read
     * whole. The Grid it returns carries its *own* origin — the window's top
     * left corner — so every function in `terrain-analysis.mjs` treats it as a
     * complete raster, and a check about "the edge of the grid" is a check
     * about the edge of this window. That is the same assertion, on a smaller
     * survey, which is why the contract suite can run on Kiru at all.
     */
    async centreWindow(cells) {
      return this.centreWindowMetres(halfOf(cells));
    },

    /**
     * The same, given a half-width in metres.
     *
     * For the suites whose subject is metric by construction — a hectare, a
     * 200 m profile — where a fixed cell count would cover wildly different
     * ground on a 7.7 cm survey than on a 25 cm one.
     */
    async centreWindowMetres(half) {
      const window = raster.windowFor([
        centreE - half,
        centreN - half,
        centreE + half,
        centreN + half,
      ]);
      if (!window) throw new Error(`${slug}: the centre window missed the raster`);
      return raster.readWindow(window);
    },

    async close() {
      await raster.close();
    },
  };
}

/**
 * One line describing a survey, printed by every suite before its checks.
 *
 * Uniform on purpose: when a suite fails on one survey and passes on another,
 * the first question is always "how do these two differ", and the answer should
 * be in the output already.
 */
export function describeSurvey(s) {
  return (
    `${s.slug}: ${s.width} x ${s.height} at ${s.cellSize.toFixed(4)} m ` +
    `(${(s.cells / 1e6).toFixed(1)}M cells), EPSG:${s.epsg}, UTM ${s.zone}${s.northern ? "N" : "S"}, ` +
    `${s.tiled ? "tiled" : "stripped"}`
  );
}
