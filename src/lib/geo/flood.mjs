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
      method: seeds ? "connected" : "threshold",
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
export function simulateFlood(grid, levels, seeds, interval, unproject) {
  return levels.map((level) => floodAt(grid, level, seeds, interval, unproject));
}
