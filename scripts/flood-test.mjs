/**
 * Known-answer tests for `flood.mjs`, Malhar's water-level-rise simulation
 * engine.
 *
 * `hydro-test.mjs` already proves `connectedFlood` and `thresholdFlood`
 * themselves against a two-basin fixture where a bathtub answer and the right
 * answer differ. This file proves the layer built on top of them: running a
 * whole ladder of levels in one call, turning each into a real polygon with
 * the attributes an exported shapefile needs, rasterising a drawn starting
 * area into seed cells, and flagging a flood that reaches the edge of the
 * survey honestly rather than presenting a lower bound as an exact answer.
 *
 * Run:
 *   node scripts/flood-test.mjs
 */

import { Grid } from "../src/lib/geo/raster.mjs";
import { simulateFlood, seedCellsInPolygon } from "../src/lib/geo/flood.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const identity = ([x, y]) => [x, y];

function makeGrid(width, height, fn, { cellSize = 1, nodata = -99999 } = {}) {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) data[row * width + col] = fn(col, row);
  }
  return new Grid({
    width, height, cellSize, originX: 0, originY: height * cellSize, data, nodata,
  });
}

// ---------------------------------------------------------------------------
console.log("\nThe two-basin fixture, this time run as a simulation ladder");
{
  // Same shape as hydro-test's: a basin reachable from a river and an
  // identical-depth hollow on high ground, separated by a rim.
  const W = 40, H = 12;
  const dem = makeGrid(W, H, (col, row) => {
    if (col >= 4 && col <= 9 && row >= 4 && row <= 7) return 10; // basin by the river
    if (col >= 26 && col <= 31 && row >= 4 && row <= 7) return 10; // hollow on the hill
    if (col >= 20) return 60; // the high ground, and the rim
    return 14; // the floodplain
  });

  const levels = [8, 10, 12];
  const seeds = [{ col: 6, row: 6 }];

  const connected = simulateFlood(dem, levels, seeds, 2, identity);
  check("three levels in, three results out", connected.length === 3);
  check("below the basin floor, nothing floods", connected[0].cells === 0 && connected[0].area_m2 === 0);
  check("at the basin's own floor, still nothing to flood", connected[1].cells === 0);
  check(
    "above the floor, only the connected basin floods, 24 m2",
    connected[2].cells === 24 && near(connected[2].area_m2, 24, 1e-9),
  );
  check(
    "the isolated hollow on the hill never appears, at any level in the ladder",
    connected.every((r) => r.cells <= 24),
  );

  const threshold = simulateFlood(dem, [12], null, null, identity);
  check(
    "the same level, without a seed, floods both basins — the bathtub answer",
    threshold[0].cells === 48,
    `${threshold[0].cells} cells`,
  );
  check(
    "so the connected and threshold answers genuinely differ at the one level that matters",
    connected[2].cells * 2 === threshold[0].cells,
  );

  const feature = connected[2].geojson.features[0];
  check("a flooded level produces one polygon feature", connected[2].geojson.features.length === 1);
  check("an unflooded level produces none, not an empty polygon", connected[0].geojson.features.length === 0);
  check("the polygon carries the water level Malhar's export attributes need",
    feature.properties.Water_Level === 12 && feature.properties.Interval === 2);
  // Checked on the result's own unrounded fields, not the geojson's display
  // properties: those are rounded to 2 and 4 decimal places for a client to
  // read, and at this fixture's 24 m2 scale that rounds hectares to 0.00,
  // which would fail a unit cross-check that has nothing to do with the area
  // itself.
  check("and the flooded area in all three units, consistent with each other",
    near(connected[2].area_ha * 10_000, connected[2].area_m2, 1e-9) &&
    near(connected[2].area_km2 * 1_000_000, connected[2].area_m2, 1e-9));
  check("method is recorded on the feature, connected here", feature.properties.method === "connected");
  check("and threshold there", threshold[0].geojson.features[0].properties.method === "threshold");
}

// ---------------------------------------------------------------------------
console.log("\nA flood that reaches the edge of the survey says so");
{
  // A basin that sits right against the western edge of the grid: at a level
  // that submerges it, the flood has nowhere further west to be measured.
  const W = 16, H = 16;
  const dem = makeGrid(W, H, (col) => (col < 4 ? 10 : 30));
  const seeds = [{ col: 1, row: 8 }];

  const [dry, wet] = simulateFlood(dem, [5, 15], seeds, null, identity);
  check("below the basin, dry and not flagged", dry.cells === 0 && dry.truncated === false);
  check("flooded, and the flood reaches column 0 — flagged, not silently understated",
    wet.cells > 0 && wet.truncated === true);

  // The same basin, moved away from every edge in both directions, must not be
  // flagged: bounding only the column and leaving the row unrestricted would
  // let the basin reach row 0 and row H-1 and flag for the wrong reason.
  const interior = makeGrid(W, H, (col, row) =>
    col >= 6 && col <= 9 && row >= 6 && row <= 9 ? 10 : 30);
  const [inland] = simulateFlood(interior, [15], [{ col: 7, row: 7 }], null, identity);
  check("the identical basin, away from every edge, is not flagged", inland.truncated === false);
}

// ---------------------------------------------------------------------------
console.log("\nSeeding a drawn starting-area polygon, not just a clicked point");
{
  const W = 20, H = 20;
  const dem = makeGrid(W, H, () => 5);

  // A 4x4 cell square in projected space: origin at (0, 20), cellSize 1, so
  // cell (col, row) spans x in [col, col+1), y in [20-row-1, 20-row).
  const ring = [
    [8, 12], [12, 12], [12, 16], [8, 16], [8, 12],
  ];
  const seeds = seedCellsInPolygon(dem, ring);
  check("a 4x4 square rasterises to 16 seed cells", seeds.length === 16, `${seeds.length}`);
  check(
    "every seed actually falls inside the drawn square",
    seeds.every((s) => s.col >= 8 && s.col < 12 && s.row >= 4 && s.row < 8),
  );

  // Flooding from that whole polygon, on a level floor, should behave exactly
  // like flooding from a single interior point of it: the same connected patch.
  const [fromPolygon] = simulateFlood(dem, [6], seeds, null, identity);
  const [fromPoint] = simulateFlood(dem, [6], [{ col: 10, row: 6 }], null, identity);
  check(
    "flooding from the polygon's seed cells reaches the same extent as one point inside it",
    fromPolygon.cells === fromPoint.cells && fromPolygon.cells === W * H,
  );

  check("a polygon with no ground under it seeds nothing", seedCellsInPolygon(dem, [
    [-100, -100], [-99, -100], [-99, -99], [-100, -99], [-100, -100],
  ]).length === 0);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log("\nDisconnected patches stay patches, and never become holes");
{
  /*
   * The regression that motivated `groupRingsIntoPolygons`. `polygonize`
   * returns every ring of a mask flat — outers counter clockwise, holes
   * clockwise — and putting that list straight into a Polygon's `coordinates`
   * declares ring 0 the boundary and everything else a hole *in it*. On Kotba
   * that turned a flood of 207 separate ponds into one pond with 206 holes:
   * MapLibre drew nothing, and an export would have opened in QGIS looking
   * like an answer.
   */
  const W = 30, H = 10;
  // Three separate hollows on a plateau, none of them touching.
  const dem = makeGrid(W, H, (col, row) => {
    const inHollow =
      (col >= 2 && col <= 4) || (col >= 12 && col <= 14) || (col >= 22 && col <= 24);
    return inHollow && row >= 4 && row <= 6 ? 10 : 50;
  });

  const [result] = simulateFlood(dem, [12], null, null, identity);
  const geometry = result.geojson.features[0].geometry;
  check("three separate hollows flood", result.cells === 27, `${result.cells} cells`);
  check("the geometry is a MultiPolygon, not one polygon with the others as holes",
    geometry.type === "MultiPolygon", geometry.type);
  check("with one polygon per hollow, not one polygon with two holes",
    geometry.coordinates.length === 3, `${geometry.coordinates.length} polygons`);
  check("and no polygon has a hole, because none of these hollows has an island",
    geometry.coordinates.every((poly) => poly.length === 1));

  // The areas must still add up: three 3x3 hollows, 27 m2 all told.
  check("the reported area is the three hollows together", result.area_m2 === 27);
}

// ---------------------------------------------------------------------------
console.log("\nA real hole is a hole, and belongs to the patch that contains it");
{
  // A flooded basin with a knoll standing out of the water in the middle: one
  // outer ring, one genuine hole, and they must stay attached to each other.
  const W = 20, H = 20;
  const dem = makeGrid(W, H, (col, row) => {
    const inBasin = col >= 4 && col <= 15 && row >= 4 && row <= 15;
    const onKnoll = col >= 9 && col <= 10 && row >= 9 && row <= 10;
    if (onKnoll) return 50;
    return inBasin ? 10 : 50;
  });

  const [result] = simulateFlood(dem, [12], null, null, identity);
  const geometry = result.geojson.features[0].geometry;
  check("one flooded patch", geometry.coordinates.length === 1, `${geometry.coordinates.length}`);
  check("with the knoll as a hole inside it, not as a separate patch",
    geometry.coordinates[0].length === 2, `${geometry.coordinates[0].length} rings`);
  // 12x12 basin less the 2x2 knoll.
  check("and the knoll is excluded from the area, not counted as water",
    result.area_m2 === 12 * 12 - 2 * 2, `${result.area_m2} m2`);
}

console.log("\nNodata is outside the flood, the same as it is outside the survey");
{
  const W = 12, H = 12;
  const dem = makeGrid(W, H, (col, row) => {
    if (col < 3) return -99999; // nodata strip: unsurveyed ground
    return 10;
  });

  const [result] = simulateFlood(dem, [12], [{ col: 6, row: 6 }], null, identity);
  check("nodata cells never appear as flooded", result.cells === (W - 3) * H);
  check(
    "and the flood is flagged as touching the survey's edge, because it borders unsurveyed ground",
    result.truncated === true,
  );
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
