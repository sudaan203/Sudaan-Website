/**
 * Phase B1: one DTM in, a full hydrology product set out.
 *
 *   node scripts/hydro-run.mjs --dtm <file.tif> --out <dir> [--cell 1] [--threshold 500]
 *
 * The shape this takes is deliberate. `docs/dashboard-tools-plan.md` separates
 * hydrology from the rest of the dashboard because flow routing cannot be
 * windowed: water arrives from outside whatever box you draw, so accumulation
 * has to see the whole grid at once. That forces it into a batch job, and having
 * been forced there it needs nothing from the portal at all. One file in, a
 * directory out, no database, no session, no network.
 *
 * Every raster is written as a plain GeoTIFF in the source CRS at the analysis
 * cell size, so the client can open our answer in Global Mapper and check it
 * against their own. Vectors are GeoJSON in WGS84, as RFC 7946 requires, with
 * the projected easting and northing kept in the properties because that is what
 * a CAD workflow actually consumes.
 *
 * `manifest.json` records what produced each layer and with which parameters.
 * That is not bookkeeping: when a client asks where a stream network came from,
 * the answer has to be a record rather than a memory, and it is what lets a
 * layer be re-run when a threshold changes.
 *
 * Not yet COG, and not yet WhiteboxTools. Both need GDAL, which is not installed
 * on this machine, and both belong in the container. This engine holds several
 * full-grid arrays at once, so it is sized for a survey, not for Dang Forest.
 */

import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { readGeoTiff, writeGeoTiff, resample } from "../src/lib/geo/raster.mjs";
import {
  fillDepressions,
  d8Pointer,
  d8Accumulation,
  streamCells,
  strahlerOrder,
  slopeDegrees,
  basinLabels,
  toEsriCodes,
  watershedFrom,
  snapToChannel,
  connectedFlood,
} from "../src/lib/geo/hydrology.mjs";
import { polygonize, ringArea, vectoriseStreams, toGeoJson } from "../src/lib/geo/vectorise.mjs";

const GENERATOR = "sudaan-hydro/0.1 reference engine";

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { cell: 1, threshold: 500, epsilon: 1e-5 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dtm") { args.dtm = value; i += 1; }
    else if (flag === "--out") { args.out = value; i += 1; }
    else if (flag === "--cell") { args.cell = Number(value); i += 1; }
    else if (flag === "--threshold") { args.threshold = Number(value); i += 1; }
    else if (flag === "--epsilon") { args.epsilon = Number(value); i += 1; }
    else if (flag === "--pour-point") { args.pourPoint = value; i += 1; }
    else if (flag === "--flood-level") { args.floodLevel = Number(value); i += 1; }
    else if (flag === "--flood-seed") { args.floodSeed = value; i += 1; }
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.dtm || !args.out) {
  console.log(`
  node scripts/hydro-run.mjs --dtm <file.tif> --out <dir> [options]

    --dtm        source terrain model, GeoTIFF, single band, projected (UTM)
    --out        directory to write the product set into
    --cell       analysis cell size in metres, default 1
    --threshold  channel initiation threshold in cells, default 500
    --epsilon    drainage gradient imposed across flats, default 0.00001 m

  Interactive operations, phase B2. Both are cheap only because the batch above
  precomputed the grids they walk:

    --pour-point E,N     delineate the catchment draining to a point (tool 26)
    --flood-level Z      inundate to a water level, connected only (tool 28)
    --flood-seed E,N     where the water comes from, defaults to the lowest cell

  Cell size is a real decision, not a formality. Routing across a 2.5 cm surface
  turns every rut into a pit and the stream network into noise. 1 m is what the
  reference dataset used and what this defaults to.
`);
  process.exit(args.help ? 0 : 1);
}

// ---------------------------------------------------------------------------
const t0 = Date.now();
mkdirSync(args.out, { recursive: true });

console.log(`\nReading ${args.dtm}`);
const source = readGeoTiff(args.dtm);
const sourceStats = source.stats();
console.log(`  ${source.width} x ${source.height} at ${source.cellSize} m` +
  `${source.epsg ? `, EPSG:${source.epsg}` : ""}`);
console.log(`  ${sourceStats.min.toFixed(2)} to ${sourceStats.max.toFixed(2)} m, ` +
  `${(sourceStats.validFraction * 100).toFixed(1)}% carries data`);

if (!source.utmZone) {
  throw new Error(
    `${args.dtm} is EPSG ${source.epsg ?? "unknown"}, which is not a UTM zone. ` +
      `Area and length would be meaningless, and GeoJSON export impossible. ` +
      `Re-export in UTM.`,
  );
}

// An orthomosaic read as elevation reports a plausible looking range in the
// hundreds and produces a confident, entirely fictional drainage network.
if (sourceStats.max - sourceStats.min > 9000 || sourceStats.min < -500) {
  throw new Error(
    `${args.dtm} spans ${sourceStats.min.toFixed(1)} to ${sourceStats.max.toFixed(1)}, ` +
      `which is not terrain. Is this actually a DEM?`,
  );
}

const dem = resample(source, args.cell);
if (dem !== source) {
  console.log(`  resampled to ${dem.width} x ${dem.height} at ${args.cell} m ` +
    `(${((source.cellSize / args.cell) ** -2).toFixed(0)}x fewer cells)`);
}

// ---------------------------------------------------------------------------
console.log(`\nRouting`);
const { filled, sinks, raisedCells, maxRaise } = fillDepressions(dem, { epsilon: args.epsilon });
console.log(`  filled ${raisedCells.toLocaleString()} cells, deepest ${maxRaise.toFixed(3)} m`);
const dir = d8Pointer(filled);
const accum = d8Accumulation(dir, filled);
const streams = streamCells(accum, args.threshold);
const order = strahlerOrder(dir, streams);
const slope = slopeDegrees(filled);
const labels = basinLabels(dir, dem);

let streamCellCount = 0;
for (let i = 0; i < streams.length; i += 1) streamCellCount += streams.data[i];
console.log(`  ${streamCellCount.toLocaleString()} channel cells above ${args.threshold} cells ` +
  `(${((args.threshold * dem.cellArea) / 10000).toFixed(2)} ha of contributing area)`);

// ---------------------------------------------------------------------------
console.log(`\nWriting`);
const layers = [];
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

const raster = (key, title, grid, description) => {
  const file = `${key}.tif`;
  writeGeoTiff(join(args.out, file), grid);
  const stats = grid.stats();
  layers.push({
    key, title, group: "elevation", format: "geotiff", file, description,
    derivedFrom: basename(args.dtm),
    generator: GENERATOR,
    params: { cellSize: args.cell, epsilon: args.epsilon, streamThresholdCells: args.threshold },
    crs: { epsg: dem.epsg },
    stats: stats.count === 0 ? null : {
      min: Number(stats.min.toFixed(4)),
      max: Number(stats.max.toFixed(4)),
      mean: Number(stats.mean.toFixed(4)),
      dataCells: stats.count,
    },
    sha256: sha(readFileSync(join(args.out, file))),
    bytes: statSync(join(args.out, file)).size,
  });
  console.log(`  ${file.padEnd(22)} ${(statSync(join(args.out, file)).size / 1024).toFixed(0)} KB`);
};

raster("filled", "Filled terrain model", filled,
  "Depressions removed, with a drainage gradient across flats. The routing input.");
raster("sinks", "Sink depth", sinks,
  "How deep each depression was before filling. Tool 27, and where water ponds.");
raster("flow_direction", "Flow direction (D8, ESRI codes)", toEsriCodes(dir),
  "Steepest descent neighbour per cell, distance weighted so diagonals are fair.");
raster("flow_accumulation", "Flow accumulation", accum,
  "Cells draining through each cell. Multiply by cell area for contributing area.");
raster("slope_degrees", "Slope", slope,
  "Horn's method, in degrees. Percent is tan(degrees) x 100 and is NOT the same number.");
raster("stream_order", "Strahler order", order,
  "Order along the channel network. Zero off the network.");

// --- vectors ---------------------------------------------------------------
const segments = vectoriseStreams(dir, streams, order, dem);
const streamFeatures = segments.map((s, i) => ({
  geometry: { type: "LineString", coordinates: s.coords },
  properties: {
    segment_id: i + 1,
    strahler_order: s.order,
    length_m: Number(s.length.toFixed(2)),
    cells: s.cells,
    start_easting: Number(s.coords[0][0].toFixed(3)),
    start_northing: Number(s.coords[0][1].toFixed(3)),
  },
}));
writeFileSync(
  join(args.out, "streams.geojson"),
  JSON.stringify(toGeoJson(streamFeatures, dem), null, 1),
);
const totalLength = segments.reduce((s, x) => s + x.length, 0);
layers.push({
  key: "streams", title: "Channel network", group: "vector", format: "geojson",
  file: "streams.geojson",
  description: "Channel segments between junctions, carrying Strahler order and length.",
  derivedFrom: basename(args.dtm), generator: GENERATOR,
  params: { cellSize: args.cell, streamThresholdCells: args.threshold },
  crs: { epsg: 4326, projectedEpsg: dem.epsg },
  stats: { segments: segments.length, totalLengthM: Number(totalLength.toFixed(1)) },
  sha256: sha(readFileSync(join(args.out, "streams.geojson"))),
});
console.log(`  streams.geojson        ${segments.length} segments, ` +
  `${(totalLength / 1000).toFixed(2)} km`);

// Basins big enough to carry a channel. Anything smaller is a sliver of
// hillslope draining straight off the edge, and mapping thousands of those
// would bury the ones a client cares about.
const byLabel = new Map();
for (let i = 0; i < labels.length; i += 1) {
  if (labels[i] < 0) continue;
  byLabel.set(labels[i], (byLabel.get(labels[i]) ?? 0) + 1);
}
const significant = [...byLabel.entries()]
  .filter(([, cells]) => cells >= args.threshold)
  .sort((a, b) => b[1] - a[1]);

/**
 * Does water leave the survey at this outlet?
 *
 * True if the cell is on the raster edge or touches nodata, because a drone
 * footprint is ragged and inset: the real boundary of the data is almost never
 * the boundary of the file.
 */
function outletLeavesSurvey(col, row) {
  if (col === 0 || row === 0 || col === dem.width - 1 || row === dem.height - 1) return true;
  for (let dc = -1; dc <= 1; dc += 1) {
    for (let dr = -1; dr <= 1; dr += 1) {
      if (dc === 0 && dr === 0) continue;
      if (!dem.inside(col + dc, row + dr)) return true;
      if (dem.isNoDataAt(col + dc, row + dr)) return true;
    }
  }
  return false;
}

const basinFeatures = [];
for (const [label, cells] of significant) {
  const mask = dem.like(Uint8Array, 0, 0);
  for (let i = 0; i < labels.length; i += 1) if (labels[i] === label) mask.data[i] = 1;
  const rings = polygonize(mask, dem);
  if (rings.length === 0) continue;
  // Outer rings wind counter clockwise, holes clockwise. GeoJSON wants the
  // outer ring first, so sort by descending signed area.
  rings.sort((a, b) => ringArea(b) - ringArea(a));
  const col = label % dem.width;
  const row = (label - col) / dem.width;
  basinFeatures.push({
    geometry: { type: "Polygon", coordinates: rings },
    properties: {
      basin_id: basinFeatures.length + 1,
      area_m2: Number((cells * dem.cellArea).toFixed(1)),
      area_ha: Number(((cells * dem.cellArea) / 10000).toFixed(3)),
      cells,
      outlet_easting: Number(dem.xOf(col).toFixed(3)),
      outlet_northing: Number(dem.yOf(row).toFixed(3)),
      // A basin whose outlet sits on the edge of the data is truncated: its real
      // upstream area continues outside the survey. Saying so is the difference
      // between a number and a misleading number.
      //
      // Checking the grid edge alone is not enough and reported zero truncated
      // basins here, which was wrong. A drone survey footprint is ragged and
      // sits inset from its own bounding box, so water leaves through nodata
      // long before it reaches the edge of the raster.
      truncated_by_survey_edge: outletLeavesSurvey(col, row),
    },
  });
}
writeFileSync(
  join(args.out, "basins.geojson"),
  JSON.stringify(toGeoJson(basinFeatures, dem), null, 1),
);
const truncated = basinFeatures.filter((f) => f.properties.truncated_by_survey_edge).length;
layers.push({
  key: "basins", title: "Catchment basins", group: "vector", format: "geojson",
  file: "basins.geojson",
  description: "One polygon per outlet, for basins large enough to carry a channel.",
  derivedFrom: basename(args.dtm), generator: GENERATOR,
  params: { cellSize: args.cell, minCells: args.threshold },
  crs: { epsg: 4326, projectedEpsg: dem.epsg },
  stats: { basins: basinFeatures.length, truncatedBySurveyEdge: truncated },
  sha256: sha(readFileSync(join(args.out, "basins.geojson"))),
});
console.log(`  basins.geojson         ${basinFeatures.length} basins, ` +
  `${truncated} truncated by the survey edge`);

// --- B2: interactive operations, over the grids the batch just produced ------
const parsePoint = (text) => {
  const [x, y] = String(text).split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`cannot read "${text}" as an easting,northing pair`);
  }
  return [x, y];
};

if (args.pourPoint) {
  const [x, y] = parsePoint(args.pourPoint);
  const at = dem.cellAt(x, y);
  if (!at) throw new Error(`--pour-point ${x},${y} falls outside the survey`);
  // Snapping first, because a point digitised by hand is almost never exactly on
  // the modelled channel, and one cell off returns a hillslope sliver instead of
  // the basin.
  const snapped = snapToChannel(accum, at.col, at.row, 5);
  const shed = watershedFrom(dir, snapped.col, snapped.row);
  let cells = 0;
  for (let i = 0; i < shed.length; i += 1) cells += shed.data[i];
  const rings = polygonize(shed, dem);
  rings.sort((a, b) => ringArea(b) - ringArea(a));

  const outlet = { col: snapped.col, row: snapped.row };
  const leavesSurvey = outletLeavesSurvey(outlet.col, outlet.row);
  writeFileSync(
    join(args.out, "catchment.geojson"),
    JSON.stringify(toGeoJson([{
      geometry: { type: "Polygon", coordinates: rings },
      properties: {
        area_m2: Number((cells * dem.cellArea).toFixed(1)),
        area_ha: Number(((cells * dem.cellArea) / 10000).toFixed(3)),
        outlet_easting: Number(dem.xOf(outlet.col).toFixed(3)),
        outlet_northing: Number(dem.yOf(outlet.row).toFixed(3)),
        snapped_cells: Number(Math.hypot(snapped.col - at.col, snapped.row - at.row).toFixed(2)),
        truncated_by_survey_edge: leavesSurvey,
      },
    }], dem), null, 1),
  );
  console.log(`  catchment.geojson      ${(cells * dem.cellArea / 10000).toFixed(3)} ha` +
    `${leavesSurvey ? ", truncated by the survey edge" : ""}`);
}

if (args.floodLevel !== undefined) {
  // Default the seed to the lowest cell in the survey, which is where standing
  // water would actually be, rather than an arbitrary corner.
  let seed = null;
  if (args.floodSeed) {
    const [x, y] = parsePoint(args.floodSeed);
    seed = dem.cellAt(x, y);
    if (!seed) throw new Error(`--flood-seed ${x},${y} falls outside the survey`);
  } else {
    let lowest = Infinity;
    for (let row = 0; row < dem.height; row += 1) {
      for (let col = 0; col < dem.width; col += 1) {
        const v = dem.get(col, row);
        if (dem.isNoData(v) || v >= lowest) continue;
        lowest = v;
        seed = { col, row };
      }
    }
  }
  const flood = connectedFlood(dem, args.floodLevel, [seed]);
  writeGeoTiff(join(args.out, "flood_depth.tif"), flood.depth);
  console.log(`  flood_depth.tif        ${args.floodLevel} m level: ` +
    `${(flood.area / 10000).toFixed(3)} ha inundated, ` +
    `${flood.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })} m3 stored`);
  console.log(`                         connected from the seed, not a bathtub fill`);
}

// ---------------------------------------------------------------------------
const manifest = {
  generator: GENERATOR,
  generatedAt: new Date().toISOString(),
  source: {
    file: basename(args.dtm),
    sha256: sha(readFileSync(args.dtm)),
    width: source.width,
    height: source.height,
    cellSize: source.cellSize,
    epsg: source.epsg,
    elevationRange: [Number(sourceStats.min.toFixed(3)), Number(sourceStats.max.toFixed(3))],
  },
  analysis: {
    cellSize: args.cell,
    width: dem.width,
    height: dem.height,
    epsilon: args.epsilon,
    streamThresholdCells: args.threshold,
    streamThresholdArea_m2: args.threshold * dem.cellArea,
    filledCells: raisedCells,
    maxFillDepth_m: Number(maxRaise.toFixed(4)),
    surveyArea_ha: Number(((dem.stats().count * dem.cellArea) / 10000).toFixed(3)),
  },
  // Stated rather than assumed. Every area and length above is computed in the
  // projected CRS, never in degrees, and the numbers are only valid because of it.
  measurement: {
    computedIn: `EPSG:${dem.epsg}`,
    note: "Areas and lengths are computed in projected metres, never in WGS84 degrees.",
  },
  layers,
};
writeFileSync(join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`  manifest.json          ${layers.length} layers with provenance`);

console.log(`\nDone in ${Date.now() - t0} ms -> ${args.out}\n`);
