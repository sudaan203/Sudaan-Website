/**
 * Malhar's "Simulation Water Level Rise" tool: how far water spreads across
 * the terrain as its elevation rises, at the survey's own native resolution.
 *
 * `hydrology.mjs` already has both halves this needs — `connectedFlood` and
 * `thresholdFlood` — because tool 28 asked for a connected flood from a seed
 * years (in this project's terms, days) before this tool did. What this module
 * adds is everything a *simulation* needs on top of a single flood: running
 * many levels against the one grid, turning each into a vector polygon with
 * the attributes an exported shapefile needs, rasterising a drawn "starting
 * water body" polygon into seed cells, and saying honestly when a flood
 * reaches the edge of the surveyed ground.
 *
 * ## Native resolution, deliberately, not hydrology's 1 m grid
 *
 * Tool 28 runs against the hydrology bundle's grid, which is resampled to 1 m
 * on purpose — routing flow across a photogrammetric surface at native
 * resolution turns every rut and bush into a sink. That reasoning is about
 * *flow direction and accumulation*, and does not apply here: a level threshold
 * or a connected fill neither needs nor produces a flow direction, so there is
 * no resampling reason to give up the resolution the survey was actually flown
 * at. Malhar's own spec says as much — "use the actual DTM raster loaded in
 * the dashboard... resolution is preserved as much as practical" — and a tool
 * whose purpose is comparison against Global Mapper or HEC-RAS has to be
 * measured at the resolution those packages would read the same file at.
 *
 * ## A whole-grid operation, like slope (tool 14)
 *
 * A flood's extent is not known ahead of the read, so unlike a profile or a
 * polygon's statistics there is no bounding box to window the raster to. This
 * reads the DTM whole, once per simulation run, the same way tool 14 already
 * does, and inherits the same limit: it needs `PORTAL_TERRAIN_DIR` or a grid
 * under the `MAX_CELLS` cap in `terrain-source.ts`, and does not yet run over
 * the windowed R2 path production otherwise uses. See that file's own comment
 * on tool 14 for why, and `docs/tools.md` for the honest state of both.
 */

import { connectedFlood, thresholdFlood } from "./hydrology.mjs";
import { pointInPolygon } from "./terrain-analysis.mjs";
import { groupRingsIntoPolygons, polygonize } from "./vectorise.mjs";
import { floodMask } from "./merge-tree.mjs";

/**
 * Grid cells whose centre falls inside a ring, in the grid's own projected
 * coordinates.
 *
 * Restricted to the ring's own bounding box in cell space rather than walking
 * the whole grid, the same trick `polygonStats` uses for the identical reason:
 * a small drawn water body should cost what it covers, not what the survey
 * covers.
 */
export function seedCellsInPolygon(grid, ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const col0 = Math.max(0, Math.floor((minX - grid.originX) / grid.cellSize));
  const col1 = Math.min(grid.width - 1, Math.ceil((maxX - grid.originX) / grid.cellSize));
  const row0 = Math.max(0, Math.floor((grid.originY - maxY) / grid.cellSize));
  const row1 = Math.min(grid.height - 1, Math.ceil((grid.originY - minY) / grid.cellSize));

  const seeds = [];
  for (let row = row0; row <= row1; row += 1) {
    const y = grid.yOf(row);
    for (let col = col0; col <= col1; col += 1) {
      const x = grid.xOf(col);
      if (pointInPolygon(x, y, ring)) seeds.push({ col, row });
    }
  }
  return seeds;
}

/**
 * A single-feature FeatureCollection around every set cell in a mask, in
 * lon/lat.
 *
 * A **MultiPolygon**, always, even when the flood happens to be one pond. A
 * flood is disconnected far more often than not — 207 separate patches on
 * Kotba at its lowest simulated level — and `groupRingsIntoPolygons` is what
 * keeps each of those a patch rather than a hole in the first one. The type is
 * not varied by patch count because a client's downstream code should not have
 * to branch on how puddled today's water happens to be.
 */
function maskToFeature(mask, grid, unproject, properties) {
  const polygons = groupRingsIntoPolygons(polygonize(mask, grid));
  return {
    type: "FeatureCollection",
    features: polygons.length
      ? [
          {
            type: "Feature",
            properties,
            geometry: {
              type: "MultiPolygon",
              coordinates: polygons.map((rings) =>
                rings.map((ring) => ring.map(([x, y]) => unproject([x, y]))),
              ),
            },
          },
        ]
      : [],
  };
}

/**
 * One water level, in whichever mode `seeds` selects.
 *
 * The two modes return the same shape from `hydrology.mjs` by design, so this
 * function does not need to know which one ran to turn the answer into a
 * polygon and a set of statistics.
 */
function floodAt(grid, level, seeds, interval, unproject) {
  const flood = seeds ? connectedFlood(grid, level, seeds) : thresholdFlood(grid, level);

  const mask = grid.like(Uint8Array, 0, 255);
  let maxDepth = 0;
  let cells = 0;
  let volume = 0;
  // Reaches the edge of the file, or ground directly beside data the survey
  // never captured. Either way the true flood may continue past what is drawn,
  // the same honesty `watershedFrom`'s `truncatedBySurveyEdge` already applies
  // to a catchment that reaches past the surveyed rectangle.
  let touchesEdge = false;
  for (let i = 0; i < flood.depth.length; i += 1) {
    const d = flood.depth.data[i];
    /*
     * Strictly deeper than zero, not "at or below the level". `connectedFlood`
     * and `thresholdFlood` both count a cell exactly at the water's own
     * elevation as flooded, because that is the right answer to "is this cell
     * at or under the level" — but a water level sitting exactly on the ground
     * with nothing above it is not standing water, and Malhar's own worked
     * example agrees: the simulation's first step, at the seed's own ground
     * elevation, is meant to read 0 ha, not the seed cell's footprint. So the
     * statistics and the drawn polygon are both counted here, from depth,
     * rather than trusting the engine's own cell count — which would make the
     * two disagree the moment a whole flat basin sits exactly at the level.
     */
    const wet = !flood.depth.isNoData(d) && d > 0;
    mask.data[i] = wet ? 1 : 0;
    if (!wet) continue;
    cells += 1;
    volume += d * grid.cellArea;
    if (d > maxDepth) maxDepth = d;

    const col = i % grid.width;
    const row = (i - col) / grid.width;
    if (
      col === 0 || row === 0 || col === grid.width - 1 || row === grid.height - 1 ||
      grid.isNoDataAt(col - 1, row) || grid.isNoDataAt(col + 1, row) ||
      grid.isNoDataAt(col, row - 1) || grid.isNoDataAt(col, row + 1)
    ) {
      touchesEdge = true;
    }
  }

  return describeFlood(
    grid, level, cells, volume, maxDepth, touchesEdge, mask, interval, unproject, Boolean(seeds),
  );
}

/**
 * The result object, assembled in exactly one place.
 *
 * Both the traversal path and the merge-tree path end here. That is the point:
 * a caller must not be able to tell which one ran, and two copies of this
 * would be two places for the units, the rounding or the export attribute
 * names to drift apart.
 */
function describeFlood(
  grid, level, cells, volume, maxDepth, touchesEdge, mask, interval, unproject, connected,
) {
  const area_m2 = cells * grid.cellArea;
  const area_ha = area_m2 / 10_000;
  const area_km2 = area_m2 / 1_000_000;

  return {
    level_m: level,
    cells,
    area_m2,
    area_ha,
    area_km2,
    volume_m3: volume,
    maxDepth_m: maxDepth,
    truncated: touchesEdge,
    geojson: maskToFeature(mask, grid, unproject, {
      kind: "flood",
      method: connected ? "connected" : "threshold",
      // The exact attribute names Malhar's spec asks an exported polygon carry.
      Water_Level: Number(level.toFixed(2)),
      Interval: interval,
      Flood_Area_m2: Math.round(area_m2),
      Flood_Area_Ha: Number(area_ha.toFixed(2)),
      Flood_Area_km2: Number(area_km2.toFixed(4)),
      truncated: touchesEdge,
    }),
  };
}

/**
 * The whole simulation: one grid, many levels, in whichever mode `seeds`
 * selects for all of them.
 *
 * Levels are simulated independently — nothing here assumes they are sorted,
 * evenly spaced, or that a flood at one level has any relationship to the
 * next — because a client dragging the water-level slider asks for one level
 * at a time and an automatic run asks for a whole ladder, and both are this
 * same call with a different length array.
 */
/**
 * @param {object|null} [tree] A merge tree over this same grid, from `buildMergeTree`.
 */
export function simulateFlood(grid, levels, seeds, interval, unproject, tree = undefined) {
  /*
   * With a merge tree, a flood stops being a traversal.
   *
   * `connectedFlood` walks the grid once per level, so a twelve step ladder
   * walks it twelve times. The tree already encodes which cells join which
   * component at which elevation, so every level in the ladder is a lookup
   * plus a contiguous read of the cells it covers — the same answer, from an
   * index instead of a search. Verified cell for cell against `connectedFlood`
   * in `scripts/merge-tree-test.mjs`; this is a speed change, never an
   * accuracy one, and nothing here samples the terrain any more coarsely.
   *
   * Only for a single source cell. A drawn source polygon seeds thousands of
   * cells at once and would need the union of every component they touch,
   * which is more machinery than the common case justifies — that path keeps
   * the traversal, and is no slower than it was.
   */
  if (tree && seeds && seeds.length === 1) {
    const cell = seeds[0].row * grid.width + seeds[0].col;
    const sourceZ = grid.data[cell];
    if (!grid.isNoData(sourceZ)) {
      return levels.map((level) =>
        floodAtFromTree(grid, tree, cell, sourceZ, level, interval, unproject));
    }
  }
  return levels.map((level) => floodAt(grid, level, seeds, interval, unproject));
}

/**
 * One level, answered from the tree.
 *
 * Deliberately assembles the same result object as `floodAt`, field for field,
 * because the route and the client cannot be allowed to tell which path ran.
 * The statistics walk the flooded cells rather than the grid, so the cost is
 * the water and not the survey.
 */
function floodAtFromTree(grid, tree, cell, sourceZ, level, interval, unproject) {
  const { mask, indices } = floodMask(tree, grid, cell, level, sourceZ);

  let maxDepth = 0;
  let volume = 0;
  let cells = 0;
  let touchesEdge = false;
  for (let n = 0; n < indices.length; n += 1) {
    const i = indices[n];
    const d = level - grid.data[i];
    /*
     * The tree answers "at or below this level", which is the right reading of
     * a level set and is what its own tests assert against `connectedFlood`.
     * This tool asks something slightly stricter — water has to have depth —
     * and the difference is exactly the cells standing at the water line. They
     * are dropped here rather than in the tree, because this is where that
     * rule is stated and where Malhar's worked example lives: the first step of
     * a simulation, at the source's own ground elevation, must read 0 ha.
     */
    if (!(d > 0)) {
      mask.data[i] = 0;
      continue;
    }
    cells += 1;
    if (d > maxDepth) maxDepth = d;
    volume += d * grid.cellArea;

    const col = i % grid.width;
    const row = (i - col) / grid.width;
    if (
      col === 0 || row === 0 || col === grid.width - 1 || row === grid.height - 1 ||
      grid.isNoDataAt(col - 1, row) || grid.isNoDataAt(col + 1, row) ||
      grid.isNoDataAt(col, row - 1) || grid.isNoDataAt(col, row + 1)
    ) {
      touchesEdge = true;
    }
  }

  return describeFlood(
    grid, level, cells, volume, maxDepth, touchesEdge, mask, interval, unproject, true,
  );
}

/**
 * Flood extent and storage over ground too large to simulate, at full
 * resolution, without simulating.
 *
 * ## Two questions, two mechanisms, one shape
 *
 * **"Everything at or below this level."** A plain elevation threshold is a
 * per-cell predicate — `dem[c] <= L` — with no connectivity in it at all. So it
 * is a reduction, it composes over any partition, and it needs no precomputed
 * anything: a whole-survey answer is the band-by-band sum of the band answers.
 * This is the question Malhar's "From elevation" run was asking when it was
 * refused, and it never needed the traversal it was being refused for.
 *
 * **"Everything water reaches as it rises from outside."** Connectivity is
 * global, so this genuinely cannot be answered from a window — water may enter
 * the window from ground outside it. It is answered instead from the *spill
 * surface*, where `spill[c]` is the level water standing outside first reaches
 * `c` at, so the predicate is `spill[c] <= L` and connectivity was resolved once
 * when that raster was built. Same reduction, different predicate.
 *
 * Depth is `L - dem[c]` in both cases, and volume is depth against cell area,
 * so the storage figure is the same arithmetic either way.
 *
 * What is deliberately **not** here is a connected flood from a seed the client
 * placed. That one is a traversal whose extent is not known before the read,
 * and it stays bounded by the study area drawn around it — which is not a
 * limitation so much as the shape of the question: placing a seed is saying
 * where to look.
 *
 * @param {number[]} levels water levels, ascending
 */
export function newFloodExtent(levels) {
  return {
    levels: levels.slice(),
    // One accumulator per level, filled in the same pass over each band. A
    // ladder is the common case — a client animating a rise asks for a dozen
    // levels at once — and reading the ground once for all of them is the
    // whole reason the request carries the ladder rather than one level.
    cells: levels.map(() => 0),
    volume: levels.map(() => 0),
    deepest: levels.map(() => 0),
    surveyed: 0,
    cellArea: null,
  };
}

/**
 * @param acc from `newFloodExtent`
 * @param dtm a band of the terrain model
 * @param {{ spill?: any, ring?: number[][] | null }} [options] `spill` switches the
 *        predicate from "below the level" to "reached by water rising from
 *        outside"; `ring` restricts the count to a drawn shape, since a band is
 *        a rectangle and a study area need not be.
 */
export function accumulateFloodExtent(acc, dtm, { spill = null, ring = null } = {}) {
  if (acc.cellArea === null) acc.cellArea = dtm.cellArea;
  if (spill && (spill.width !== dtm.width || spill.height !== dtm.height)) {
    // Read by the same cell window from a raster written off this one, so a
    // disagreement here is a publishing fault — a spill surface built from a
    // different DTM than the site now serves — and every depth below it would
    // be a subtraction between two unrelated surfaces.
    throw new Error(
      `flood: spill band is ${spill.width}x${spill.height} against the terrain's ` +
        `${dtm.width}x${dtm.height}. The spill surface was built from a different raster.`,
    );
  }

  const { levels } = acc;
  for (let row = 0; row < dtm.height; row += 1) {
    for (let col = 0; col < dtm.width; col += 1) {
      const i = row * dtm.width + col;
      const z = dtm.data[i];
      if (dtm.isNoData(z)) continue;
      if (ring && !pointInPolygon(dtm.xOf(col), dtm.yOf(row), ring)) continue;
      acc.surveyed += 1;

      // The level at which this cell is wet. Its own ground for a threshold,
      // the level water arrives at for a rising flood.
      let arrives = z;
      if (spill) {
        const s = spill.data[i];
        if (spill.isNoData(s)) continue;
        arrives = s;
      }

      /*
       * Levels are ascending, so once a cell is dry at one level it is dry at
       * every level below it. Walking down from the top and stopping at the
       * first dry level turns the inner loop into a binary-search-shaped scan
       * rather than a full pass per level.
       */
      for (let k = levels.length - 1; k >= 0; k -= 1) {
        if (arrives > levels[k]) break;
        const depth = levels[k] - z;
        if (depth <= 0) continue;
        acc.cells[k] += 1;
        acc.volume[k] += depth;
        if (depth > acc.deepest[k]) acc.deepest[k] = depth;
      }
    }
  }
  return acc;
}

export function finaliseFloodExtent(acc, { method }) {
  const cellArea = acc.cellArea ?? 0;
  return {
    method,
    cellArea,
    surveyedCells: acc.surveyed,
    surveyedArea_m2: acc.surveyed * cellArea,
    /*
     * Field for field what the simulated path returns, so the panel reads one
     * shape. The two differ in exactly one place and it is stated rather than
     * implied: `geojson` is null, because a flood across a whole survey has a
     * boundary no browser can hold, and the extent is drawn by the tiler
     * instead.
     */
    levels: acc.levels.map((level, k) => ({
      level_m: level,
      cells: acc.cells[k],
      area_m2: acc.cells[k] * cellArea,
      area_ha: (acc.cells[k] * cellArea) / 10000,
      area_km2: (acc.cells[k] * cellArea) / 1e6,
      volume_m3: acc.volume[k] * cellArea,
      maxDepth_m: acc.deepest[k],
      /*
       * Always true, and honestly so. Water at the boundary of a survey may
       * continue past it, and a site-wide run is by definition up against that
       * boundary everywhere — so every area here is a lower bound, exactly as
       * the simulated path's is when the flood reaches the drawn edge.
       */
      truncated: true,
      geojson: null,
      /** Share of the surveyed ground under water at this level. */
      coverage: acc.surveyed > 0 ? acc.cells[k] / acc.surveyed : null,
    })),
  };
}
