/**
 * Phase F1: candidate boxes in, a full forest inventory product set out.
 *
 *   node scripts/forest-run.mjs --slug <slug> \
 *     --candidates portal-data/forest/<slug>/candidate-boxes.geojson \
 *     --dtm <dtm.tif> --dsm <dsm.tif> \
 *     [--ortho <ortho.jpg> --worldfile <ortho.jgw>] [--las <cloud.las>] \
 *     --out portal-data/forest/<slug> [--cell 0.25]
 *
 * Modelled on `hydro-run.mjs`: one survey in, a directory out. No database, no
 * session, no portal. Run offline, once, and re-run whenever the candidate
 * boxes or a tuning parameter change.
 *
 * ## Why this script never touches a model
 *
 * `docs/forest-tools-plan.md`'s "Addendum, 19 Sep 2026" splits Phase F1 along
 * a seam that makes it parallelisable: a Python track (`forest-detect.py`)
 * runs DeepForest against the orthomosaic and writes candidate tree-crown
 * boxes — nothing here imports a model or reads a checkpoint. Everything
 * downstream of those boxes is this script and `src/lib/geo/forest.mjs`:
 * crown polygon extraction tied to real elevation, the six non-tree
 * discriminators, confidence, DBH, height classification and every served
 * artefact.
 *
 * ## Point cloud and orthomosaic enrichment are real, but optional
 *
 * `--las` and `--ortho`/`--worldfile` are both optional per §2.2's "CHM-first,
 * point-cloud-enriched" rule: every survey gets the CHM-only attributes,
 * regardless of what else is available, and the manifest records honestly
 * which extra evidence a given run actually had. Omit both and every tree
 * still gets a confidence figure — from five inputs instead of seven, and the
 * manifest and `confidenceScore`'s own `note` say so, rather than a Kotba-
 * style survey silently scoring worse for lacking a sensor it never had.
 */

import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { readGeoTiff, writeGeoTiff } from "../src/lib/geo/raster.mjs";
import {
  chmFrom,
  crownFromBox,
  crownMetrics,
  rejectNonTree,
  confidenceScore,
  estimateDbh,
  heightClass,
  DEFAULT_HEIGHT_CLASSES,
  DBH_NOT_RELIABLE,
  boxFromFeature,
} from "../src/lib/geo/forest.mjs";
import { streamLasPoints } from "../src/lib/geo/las.mjs";
import { readWorldFile } from "./lib/geo.mjs";

const GENERATOR = "sudaan-forest/0.1 engine (candidate-box pipeline)";

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    cell: 0.25,
    padRadius: 2,
    thresholdFraction: 0.4,
    minHeight: 2,
    maxCrownRadius: 6,
    flatBand: 0.25,
    rejectFlatnessMin: 0.7,
    rejectRectangularityMin: 0.85,
    minScore: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--slug") { args.slug = value; i += 1; }
    else if (flag === "--candidates") { args.candidates = value; i += 1; }
    else if (flag === "--dtm") { args.dtm = value; i += 1; }
    else if (flag === "--dsm") { args.dsm = value; i += 1; }
    else if (flag === "--ortho") { args.ortho = value; i += 1; }
    else if (flag === "--worldfile") { args.worldfile = value; i += 1; }
    else if (flag === "--las") { args.las = value; i += 1; }
    else if (flag === "--out") { args.out = value; i += 1; }
    else if (flag === "--cell") { args.cell = Number(value); i += 1; }
    else if (flag === "--pad-radius") { args.padRadius = Number(value); i += 1; }
    else if (flag === "--threshold-fraction") { args.thresholdFraction = Number(value); i += 1; }
    else if (flag === "--min-height") { args.minHeight = Number(value); i += 1; }
    else if (flag === "--max-crown-radius") { args.maxCrownRadius = Number(value); i += 1; }
    else if (flag === "--flat-band") { args.flatBand = Number(value); i += 1; }
    else if (flag === "--reject-flatness-min") { args.rejectFlatnessMin = Number(value); i += 1; }
    else if (flag === "--reject-rectangularity-min") { args.rejectRectangularityMin = Number(value); i += 1; }
    else if (flag === "--min-score") { args.minScore = Number(value); i += 1; }
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.slug || !args.candidates || !args.dtm || !args.dsm || !args.out) {
  console.log(`
  node scripts/forest-run.mjs --slug <slug> --candidates <boxes.geojson> \\
    --dtm <dtm.tif> --dsm <dsm.tif> --out <dir> [options]

    --slug          site slug, recorded in the manifest
    --candidates    DeepForest's candidate boxes: a FeatureCollection of
                     axis-aligned rectangle Polygons in EPSG:32643, each with
                     "score" and "box_id" properties
    --dtm, --dsm    terrain model and surface model GeoTIFFs, same CRS as the
                     candidate boxes -- read whole, per docs/forest-tools-
                     plan.md's note that 4M cells at Ektanagar 1's scale fits
                     comfortably in memory (matches hydro-run.mjs's own rule)
    --out           directory to write the product set into
    --cell          analysis cell size in metres, default 0.25 (plan §2.3)

    --ortho, --worldfile   orthomosaic + its .jgw/.tfw, for the greenness
                            discriminator. Both or neither.
    --las           the survey's own LAS (never the portal's decimated
                     quadtree -- see the header of prepare-point-cloud.mjs and
                     the R2 upload facts note this pipeline was built against).
                     Enables return porosity, point density and the DBH
                     attempt. Omitted entirely if not given, honestly, not
                     penalised.

    --pad-radius                  m past a box's own edge to search, default 2
    --threshold-fraction          of the box's own apex height, default 0.4
    --min-height                  m, floor under the threshold, default 2
    --max-crown-radius            m, the fence that separates touching
                                   crowns, default 6
    --flat-band                   m, flatness discriminator band, default 0.25
    --reject-flatness-min         default 0.7
    --reject-rectangularity-min   default 0.85
    --min-score                   discard candidates below this DeepForest
                                   box score before crown extraction, default
                                   none (every candidate is extracted and
                                   left to the geometric/confidence pipeline,
                                   the original production behaviour). A
                                   tuning knob added 2026-09-19 per
                                   docs/forest-validation-2026-09-19.md --
                                   the model's own score turned out to
                                   differentially suppress candidates over
                                   bare ground more than over real canopy,
                                   even though it does not cleanly separate
                                   individual false positives from true ones.
`);
  process.exit(args.help ? 0 : 1);
}

const t0 = Date.now();
mkdirSync(args.out, { recursive: true });

// ---------------------------------------------------------------------------
console.log(`\nReading terrain`);
const dtmSource = readGeoTiff(args.dtm);
const dsmSource = readGeoTiff(args.dsm);
console.log(`  DTM ${dtmSource.width} x ${dtmSource.height} at ${dtmSource.cellSize} m` +
  `${dtmSource.epsg ? `, EPSG:${dtmSource.epsg}` : ""}`);
console.log(`  DSM ${dsmSource.width} x ${dsmSource.height} at ${dsmSource.cellSize} m` +
  `${dsmSource.epsg ? `, EPSG:${dsmSource.epsg}` : ""}`);

console.log(`\nBuilding the analysis CHM at ${args.cell} m`);
const chm = chmFrom(dsmSource, dtmSource, { cellSize: args.cell });
const chmStats = chm.stats();
console.log(`  ${chm.width} x ${chm.height} = ${(chm.width * chm.height).toLocaleString()} cells, ` +
  `${(chmStats.validFraction * 100).toFixed(1)}% carry data, ` +
  `height ${chmStats.min?.toFixed(2)} to ${chmStats.max?.toFixed(2)} m`);

// ---------------------------------------------------------------------------
console.log(`\nReading candidate boxes`);
const candidatesRaw = JSON.parse(readFileSync(args.candidates, "utf8"));
// The contract (per docs/forest-tools-plan.md's addendum) only promises the
// EPSG code is "findable" somewhere at the top level, not which key it is
// under -- the actual detection track's output carries it as `crs.epsg`
// rather than a bare top-level `epsg`, so every shape seen so far is checked
// rather than just the one first assumed.
const candidateEpsg = candidatesRaw.epsg ?? candidatesRaw.crs?.epsg
  ?? (/EPSG::?(\d+)/.exec(candidatesRaw.crs?.properties?.name ?? "")?.[1]
    ? Number(/EPSG::?(\d+)/.exec(candidatesRaw.crs.properties.name)[1]) : null);
if (Number.isFinite(candidateEpsg) && candidateEpsg !== 32643) {
  throw new Error(`${args.candidates} declares EPSG:${candidateEpsg}, not 32643. Reprojection is out of scope here.`);
}
if (!Number.isFinite(candidateEpsg)) {
  console.warn(`  ! ${args.candidates} does not declare an EPSG code anywhere findable; assuming 32643 per the contract.`);
}
const allBoxes = candidatesRaw.features.map(boxFromFeature);
console.log(`  ${allBoxes.length} candidate boxes`);

// A pre-filter on DeepForest's own box score, per docs/forest-validation-
// 2026-09-19.md: applied before crown extraction rather than folded into
// `rejectNonTree` below, since it never looks at the CHM at all -- it is a
// property of the candidate box alone, cheaper to apply first, and honest to
// report separately from the geometric rejections that follow.
const belowMinScore = args.minScore != null ? allBoxes.filter((b) => !(b.score >= args.minScore)).length : 0;
const boxes = args.minScore != null ? allBoxes.filter((b) => b.score >= args.minScore) : allBoxes;
if (args.minScore != null) {
  console.log(`  ${belowMinScore} dropped below --min-score ${args.minScore} (score not >= threshold, ` +
    `including any missing/NaN score), ${boxes.length} remain`);
}

// ---------------------------------------------------------------------------
console.log(`\nExtracting crowns and rejecting non-trees`);
const rejectedCounts = { below_min_score: belowMinScore, below_min_height: 0, no_data_in_footprint: 0, apex_not_in_mask: 0, no_polygon: 0, flat_and_rectangular: 0 };
const cropOptions = {
  padRadius: args.padRadius, thresholdFraction: args.thresholdFraction,
  minHeight: args.minHeight, maxCrownRadius: args.maxCrownRadius,
};
const rejectOptions = {
  flatBandM: args.flatBand, rejectFlatnessMin: args.rejectFlatnessMin,
  rejectRectangularityMin: args.rejectRectangularityMin,
};

/** @type {{ box: object, segment: object, metrics: object, discriminators: object }[]} */
const candidateTrees = [];
for (const box of boxes) {
  const segment = crownFromBox(box, chm, cropOptions);
  if (!segment) { rejectedCounts.no_data_in_footprint += 1; continue; }
  if (segment.rejected) { rejectedCounts[segment.rejected] = (rejectedCounts[segment.rejected] ?? 0) + 1; continue; }

  const metrics = crownMetrics(segment.polygon);
  const combined = { ...segment, area: metrics.area, minAreaRectArea: metrics.minAreaRectArea };

  // A cheap first pass with no point cloud or greenness: isStructure depends
  // only on flatness and rectangularity, both purely geometric, so this
  // correctly decides the structure/tree split before either enrichment
  // pass runs, and lets those two (LAS streaming, per-tree image crops) skip
  // every segment that would be discarded anyway.
  const cheapRejection = rejectNonTree(combined, chm, rejectOptions);
  if (cheapRejection.isStructure) { rejectedCounts.flat_and_rectangular += 1; continue; }

  candidateTrees.push({ box, segment: combined, metrics, discriminators: cheapRejection.discriminators });
}
console.log(`  ${candidateTrees.length} candidate trees after geometric rejection ` +
  `(${boxes.length - candidateTrees.length} dropped: ${JSON.stringify(rejectedCounts)})`);

// ---------------------------------------------------------------------------
// A cell -> candidate-tree-index lookup, built once, so the LAS pass below is
// a single O(points) streaming read rather than an O(points x trees) search.
const cellOwner = new Int32Array(chm.width * chm.height).fill(-1);
candidateTrees.forEach((tree, index) => {
  for (const { col, row } of tree.segment.cells) cellOwner[row * chm.width + col] = index;
});
candidateTrees.forEach((tree) => { tree.stemBandPoints = []; });

let pointCloudNote = "No point cloud was read for this run. Return porosity, point density and DBH " +
  "were not attempted, and every tree's confidence reflects that smaller evidence set rather than " +
  "being penalised for a sensor this run did not have.";

if (args.las) {
  console.log(`\nReading the point cloud: ${args.las}`);
  const pulses = new Map(); // index -> { total, multi, ground }
  let seen = 0;
  const header = await streamLasPoints(args.las, (x, y, z, r, g, b, classification, intensity, returnNumber, numberOfReturns) => {
    seen += 1;
    const at = dtmSource.cellAt(x, y);
    if (!at) return;
    const ground = dtmSource.get(at.col, at.row);
    if (dtmSource.isNoData(ground)) return;
    const above = z - ground;

    const chmCol = Math.floor((x - chm.originX) / chm.cellSize);
    const chmRow = Math.floor((chm.originY - y) / chm.cellSize);
    if (chmCol < 0 || chmRow < 0 || chmCol >= chm.width || chmRow >= chm.height) return;
    const treeIndex = cellOwner[chmRow * chm.width + chmCol];
    if (treeIndex < 0) return;

    // Counted once per PULSE (its first return), not once per return record,
    // so a canopy pulse that produced three returns is one pulse in the
    // density and multi-return figures, not three.
    if (returnNumber === 1 || returnNumber === 0) {
      const stat = pulses.get(treeIndex) ?? { total: 0, multi: 0, ground: 0 };
      stat.total += 1;
      if (numberOfReturns > 1) stat.multi += 1;
      pulses.set(treeIndex, stat);
    }
    if (classification === 2) {
      const stat = pulses.get(treeIndex) ?? { total: 0, multi: 0, ground: 0 };
      stat.ground += 1;
      pulses.set(treeIndex, stat);
    }
    if (above >= 1.0 && above <= 2.0) {
      candidateTrees[treeIndex].stemBandPoints.push([x, y]);
    }
  });
  console.log(`  ${seen.toLocaleString()} points, LAS ${header.versionMajor}.${header.versionMinor} ` +
    `format ${header.pointDataFormat}`);

  for (const [treeIndex, stat] of pulses) {
    candidateTrees[treeIndex].pointStats = {
      multiReturnFraction: stat.total > 0 ? stat.multi / stat.total : 0,
      groundReturnsBeneath: stat.ground,
      pulseCount: stat.total,
    };
  }
  const withPoints = candidateTrees.filter((t) => t.pointStats).length;
  pointCloudNote = `Point cloud read from ${basename(args.las)} (LAS ${header.versionMajor}.${header.versionMinor}, ` +
    `format ${header.pointDataFormat}), ${seen.toLocaleString()} points. ${withPoints} of ` +
    `${candidateTrees.length} candidate trees had at least one pulse under their crown footprint.`;
}

// ---------------------------------------------------------------------------
if (args.ortho && args.worldfile) {
  console.log(`\nSampling greenness from the orthomosaic`);
  const { default: sharp } = await import("sharp");
  const world = readWorldFile(args.worldfile);
  const base = sharp(args.ortho, { limitInputPixels: false });
  const meta = await base.metadata();

  const pixelOf = (x, y) => ({
    col: (x - world.originX) / world.pxWidth,
    row: (y - world.originY) / world.pxHeight,
  });

  let sampled = 0;
  for (const tree of candidateTrees) {
    const { minX, maxX, minY, maxY } = tree.box;
    const corners = [pixelOf(minX, minY), pixelOf(maxX, minY), pixelOf(minX, maxY), pixelOf(maxX, maxY)];
    const c0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.col))));
    const c1 = Math.min(meta.width - 1, Math.ceil(Math.max(...corners.map((c) => c.col))));
    const r0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.row))));
    const r1 = Math.min(meta.height - 1, Math.ceil(Math.max(...corners.map((c) => c.row))));
    if (c1 <= c0 || r1 <= r0) continue;

    // A bounding-box crop, not an exact crown-polygon mask: sampling the
    // exact footprint would mean rasterising the polygon into image space
    // per tree, which is real work for a discriminator that is already the
    // weakest-weighted of the seven. The box the model itself drew is a
    // reasonable proxy for "roughly where this tree's canopy is", and the
    // approximation is stated here rather than silently shipped as exact.
    const { data, info } = await base.clone()
      .extract({ left: c0, top: r0, width: c1 - c0, height: r1 - r0 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0;
    let n = 0;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      sum += 2 * data[i + 1] - data[i] - data[i + 2];
      n += 1;
    }
    if (n > 0) { tree.greenness = { excessGreenMean: sum / n }; sampled += 1; }
  }
  console.log(`  greenness sampled for ${sampled} of ${candidateTrees.length} candidate trees ` +
    `(bounding-box average, not an exact crown mask)`);
}

// ---------------------------------------------------------------------------
console.log(`\nScoring confidence, height class and DBH`);
const trees = [];
const dbhStats = { attempted: 0, accepted: 0 };
for (const tree of candidateTrees) {
  const discriminators = {
    ...tree.discriminators,
    returnPorosity: tree.pointStats
      ? { available: true, multiReturnFraction: tree.pointStats.multiReturnFraction, groundReturnsBeneath: tree.pointStats.groundReturnsBeneath }
      : { available: false },
    greenness: tree.greenness ? { available: true, excessGreenMean: tree.greenness.excessGreenMean } : { available: false },
  };
  const confidence = confidenceScore(discriminators, tree.box.score ?? NaN);

  const apexHeight = chm.get(tree.segment.apex.col, tree.segment.apex.row);
  const band = heightClass(apexHeight, DEFAULT_HEIGHT_CLASSES);

  let dbh = { dbh: DBH_NOT_RELIABLE, reason: "no point cloud was read for this run" };
  if (tree.stemBandPoints.length > 0) {
    dbhStats.attempted += 1;
    dbh = estimateDbh(tree.stemBandPoints);
    if (dbh.dbh !== DBH_NOT_RELIABLE) dbhStats.accepted += 1;
  }

  const apexX = chm.xOf(tree.segment.apex.col);
  const apexY = chm.yOf(tree.segment.apex.row);
  // The apex is an index into the CHM's own grid (0.25 m analysis cells),
  // never into the DTM's native grid (0.077-0.24 m depending on survey) --
  // the two do not share an index space, only a projected CRS. Sampling the
  // DTM by the CHM's raw col/row here (an earlier version of this line did
  // exactly that) reads whichever unrelated native-grid cell happens to
  // share that index, which on Ektanagar 1 is off the DTM's own extent for
  // most apexes and reads back its nodata sentinel as if it were an
  // elevation. Ground truth for "where is this apex" is the world
  // coordinate, so the DTM is sampled by that, at its own native resolution.
  const groundAt = dtmSource.cellAt(apexX, apexY);
  const groundElevation = groundAt ? dtmSource.get(groundAt.col, groundAt.row) : dtmSource.nodata;
  // The durable, spatial tree id (plan §6.2): a hash of the apex position
  // quantised to the analysis cell size, never an ordinal counter. A re-run
  // that adds or removes candidates upstream must not silently reassign a
  // client's manual corrections to the wrong physical tree, and an ordinal
  // id does exactly that the moment the candidate list changes at all.
  const qx = Math.round(apexX / args.cell) * args.cell;
  const qy = Math.round(apexY / args.cell) * args.cell;
  const id = createHash("sha256").update(`${qx.toFixed(4)},${qy.toFixed(4)}`).digest("hex").slice(0, 16);

  trees.push({
    id,
    boxId: tree.box.boxId,
    modelScore: tree.box.score,
    easting: apexX,
    northing: apexY,
    height: apexHeight,
    groundElevation,
    treeTopElevation: apexHeight + groundElevation,
    crownArea: tree.metrics.area,
    crownPerimeter: tree.metrics.perimeter,
    crownDiameterMax: tree.metrics.maxDiameter,
    crownDiameterMin: tree.metrics.minDiameter,
    crownDiameterAvg: tree.metrics.avgDiameter,
    heightClass: band?.label ?? null,
    confidence: confidence.score,
    confidenceComponents: confidence.components,
    confidenceNote: confidence.note,
    dbh,
    polygon: tree.segment.polygon,
  });
}
console.log(`  ${trees.length} trees scored`);
console.log(`  DBH attempted on ${dbhStats.attempted}, accepted on ${dbhStats.accepted} ` +
  `(${dbhStats.attempted > 0 ? ((dbhStats.accepted / dbhStats.attempted) * 100).toFixed(1) : "0"}% ` +
  `of attempts — the plan expects this to be mostly refusals, which is the correct result, not a defect)`);

// ---------------------------------------------------------------------------
console.log(`\nWriting`);
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

// --- chm.tif ---
writeGeoTiff(join(args.out, "chm.tif"), chm, { epsg: chm.epsg ?? 32643 });
console.log(`  chm.tif                ${(statSync(join(args.out, "chm.tif")).size / 1024).toFixed(0)} KB`);

// --- crowns.geojson ---
// A single file, not a tile pyramid. `docs/forest-tools-plan.md` §4 asks for
// a pyramid, simplified per zoom, but that exists to keep a large survey's
// crown geometry off the wire in one lump — Ektanagar 2 at 389 ha, Kiru at
// 16,279 ha. Ektanagar 1 is 25 ha and (per the manifest below) a few thousand
// trees at most, comfortably one plain GeoJSON file, so the pyramid is
// deferred rather than built for a survey it has nothing to solve here.
// Every attribute the plan's popup (§8) needs, each labelled measured or
// estimated, and the confidence breakdown stored component by component
// (§3.6) rather than collapsed to the single number `trees.bin` carries --
// that number can say a tree scored 0.4, only this file can say why.
const crownFeatures = trees.map((t) => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [t.polygon.rings[0], ...t.polygon.rings.slice(1)] },
  properties: {
    tree_id: t.id, box_id: t.boxId, model_score: t.modelScore,
    height_m: Number(t.height.toFixed(3)),
    ground_elevation_m: Number(t.groundElevation.toFixed(3)),
    tree_top_elevation_m: Number(t.treeTopElevation.toFixed(3)),
    crown_area_m2: Number(t.crownArea.toFixed(3)),
    crown_perimeter_m: Number(t.crownPerimeter.toFixed(3)),
    crown_diameter_max_m: Number(t.crownDiameterMax.toFixed(3)),
    crown_diameter_min_m: Number(t.crownDiameterMin.toFixed(3)),
    crown_diameter_avg_m: Number(t.crownDiameterAvg.toFixed(3)),
    height_class: t.heightClass,
    confidence: Number(t.confidence.toFixed(4)),
    confidence_components: t.confidenceComponents,
    confidence_note: t.confidenceNote,
    dbh_cm: t.dbh.dbh === DBH_NOT_RELIABLE ? DBH_NOT_RELIABLE : Number((t.dbh.dbh * 100).toFixed(2)),
    dbh_estimated: t.dbh.dbh !== DBH_NOT_RELIABLE,
    girth_m: t.dbh.girth ?? null,
    dbh_reason: t.dbh.reason ?? null,
  },
}));
writeFileSync(join(args.out, "crowns.geojson"), JSON.stringify({
  type: "FeatureCollection",
  crs: { type: "name", properties: { name: "EPSG:32643" } },
  features: crownFeatures,
}, null, 1));
console.log(`  crowns.geojson         ${crownFeatures.length} crown polygons ` +
  `(EPSG:32643 -- not reprojected to WGS84, since this is analysis geometry read back by the ` +
  `render/filter routes in the survey's own CRS, not a client-facing export)`);

// --- trees.bin ---
/*
 * Columnar pack, per docs/forest-tools-plan.md §2.5. Fixed layout, documented
 * here because a client-side reader has to match it byte for byte and there
 * is nowhere else this is written down:
 *
 *   offset  0   4 bytes  ASCII magic "TRB1"
 *   offset  4   2 bytes  uint16 LE  format version (1)
 *   offset  6   2 bytes  uint16 LE  record length in bytes (34)
 *   offset  8   4 bytes  uint32 LE  tree count
 *   offset 12   ...      `count` records of 34 bytes each:
 *
 *     +0   8 bytes  raw bytes, the first 8 bytes of the tree's id (a SHA-256
 *                   hex string truncated to 16 chars elsewhere; stored here as
 *                   the 8 raw bytes those 16 hex characters decode to, so the
 *                   id travels in the pack without doubling its size as text)
 *     +8   4 bytes  int32 LE  easting, CENTIMETRES (not metres: a UTM easting
 *                   as float32 loses centimetre precision to its own integer
 *                   part, which is exactly why the plan calls for int32 here)
 *     +12  4 bytes  int32 LE  northing, centimetres
 *     +16  4 bytes  float32 LE  height, metres (apex CHM value)
 *     +20  4 bytes  float32 LE  crown area, square metres
 *     +24  4 bytes  float32 LE  crown diameter, metres -- the equivalent-
 *                   circle (avg) diameter specifically; the other two
 *                   diameter definitions and the perimeter are richer
 *                   attributes that belong on crowns.geojson, not in a pack
 *                   sized for instant client-side filtering
 *     +28  4 bytes  float32 LE  ground elevation, metres (DTM at the apex)
 *     +32  2 bytes  uint16 LE  confidence, 0..65535 mapped from 0..1
 */
const RECORD_LEN = 34;
const HEADER_LEN = 12;
const bin = Buffer.alloc(HEADER_LEN + trees.length * RECORD_LEN);
bin.write("TRB1", 0, "ascii");
bin.writeUInt16LE(1, 4);
bin.writeUInt16LE(RECORD_LEN, 6);
bin.writeUInt32LE(trees.length, 8);
trees.forEach((t, i) => {
  const at = HEADER_LEN + i * RECORD_LEN;
  Buffer.from(t.id, "hex").copy(bin, at, 0, 8);
  bin.writeInt32LE(Math.round(t.easting * 100), at + 8);
  bin.writeInt32LE(Math.round(t.northing * 100), at + 12);
  bin.writeFloatLE(t.height, at + 16);
  bin.writeFloatLE(t.crownArea, at + 20);
  bin.writeFloatLE(t.crownDiameterAvg, at + 24);
  bin.writeFloatLE(t.groundElevation, at + 28);
  bin.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(t.confidence * 65535))), at + 32);
});
writeFileSync(join(args.out, "trees.bin"), bin);
console.log(`  trees.bin              ${trees.length} trees, ${(bin.length / 1024).toFixed(1)} KB`);

// --- summary.json ---
const surveyAreaHa = (chmStats.count * chm.cellArea) / 10000;
const heights = trees.map((t) => t.height);
const areas = trees.map((t) => t.crownArea);
const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const totalCoveredArea = areas.reduce((s, v) => s + v, 0);

const heightClassHistogram = DEFAULT_HEIGHT_CLASSES.map((c) => ({
  label: c.label, count: trees.filter((t) => t.heightClass === c.label).length,
}));

// Elevation-vs-height scatter: every tree if the count is small, a stable
// deterministic sample if it is not, so the chart never silently balloons
// into megabytes on a survey with tens of thousands of trees.
const SCATTER_CAP = 5000;
const scatterStep = Math.max(1, Math.ceil(trees.length / SCATTER_CAP));
const elevationVsHeight = trees.filter((_, i) => i % scatterStep === 0)
  .map((t) => ({ groundElevation: Number(t.groundElevation.toFixed(2)), height: Number(t.height.toFixed(2)) }));

function histogram(values, binCount = 10) {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = (max - min) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({ binMin: min + i * width, binMax: min + (i + 1) * width, count: 0 }));
  for (const v of values) {
    const i = Math.min(binCount - 1, Math.floor((v - min) / width));
    bins[i].count += 1;
  }
  return bins.map((b) => ({ binMin: Number(b.binMin.toFixed(3)), binMax: Number(b.binMax.toFixed(3)), count: b.count }));
}

// A coarse per-hectare density grid, §11's "tree-density-by-hectare-if-
// gridded" chart series: a 100 m analysis grid over the survey extent, one
// cell per hectare, counted from the same apex positions trees.bin carries.
const GRID_CELL_M = 100;
const gridCols = Math.max(1, Math.ceil((chm.width * chm.cellSize) / GRID_CELL_M));
const gridRows = Math.max(1, Math.ceil((chm.height * chm.cellSize) / GRID_CELL_M));
const densityGrid = [];
for (let row = 0; row < gridRows; row += 1) {
  for (let col = 0; col < gridCols; col += 1) {
    const cellMinX = chm.originX + col * GRID_CELL_M;
    const cellMaxX = cellMinX + GRID_CELL_M;
    const cellMaxY = chm.originY - row * GRID_CELL_M;
    const cellMinY = cellMaxY - GRID_CELL_M;
    const count = trees.filter((t) => t.easting >= cellMinX && t.easting < cellMaxX && t.northing >= cellMinY && t.northing < cellMaxY).length;
    if (count > 0) densityGrid.push({ col, row, count, treesPerHa: Number((count / (GRID_CELL_M * GRID_CELL_M / 10000)).toFixed(2)) });
  }
}

const summary = {
  count: trees.length,
  treesPerHectare: surveyAreaHa > 0 ? Number((trees.length / surveyAreaHa).toFixed(2)) : 0,
  height: {
    avg: Number(avg(heights).toFixed(3)),
    max: heights.length ? Number(Math.max(...heights).toFixed(3)) : 0,
    min: heights.length ? Number(Math.min(...heights).toFixed(3)) : 0,
  },
  crownArea: {
    avg: Number(avg(areas).toFixed(3)),
    totalCovered: Number(totalCoveredArea.toFixed(3)),
  },
  crownDiameter: {
    avg: Number(avg(trees.map((t) => t.crownDiameterAvg)).toFixed(3)),
    max: trees.length ? Number(Math.max(...trees.map((t) => t.crownDiameterMax)).toFixed(3)) : 0,
  },
  canopyCoveragePct: surveyAreaHa > 0 ? Number(((totalCoveredArea / (surveyAreaHa * 10000)) * 100).toFixed(2)) : 0,
  minCrownDiameter: trees.length ? Number(Math.min(...trees.map((t) => t.crownDiameterMin)).toFixed(3)) : 0,
  dbh: { attempted: dbhStats.attempted, accepted: dbhStats.accepted },
  charts: {
    heightClassHistogram,
    treeDensityByHectareGrid: { cellSizeM: GRID_CELL_M, cols: gridCols, rows: gridRows, cells: densityGrid },
    crownAreaDistribution: histogram(areas),
    treeHeightDistribution: histogram(heights),
    elevationVsHeight,
  },
};
writeFileSync(join(args.out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`  summary.json           ${trees.length} trees, ${summary.treesPerHectare} / ha`);

// --- manifest.json ---
const manifest = {
  generator: GENERATOR,
  generatedAt: new Date().toISOString(),
  slug: args.slug,
  source: {
    dtm: basename(args.dtm), dsm: basename(args.dsm),
    candidates: basename(args.candidates),
    candidateCount: allBoxes.length,
  },
  parameters: {
    cellSize: args.cell,
    padRadius: args.padRadius,
    thresholdFraction: args.thresholdFraction,
    minHeight: args.minHeight,
    maxCrownRadius: args.maxCrownRadius,
    flatBand: args.flatBand,
    rejectFlatnessMin: args.rejectFlatnessMin,
    rejectRectangularityMin: args.rejectRectangularityMin,
    minScore: args.minScore,
  },
  grid: { cellSize: args.cell, width: chm.width, height: chm.height },
  counts: {
    candidates: allBoxes.length,
    rejected: rejectedCounts,
    accepted: trees.length,
  },
  pointCloud: { used: Boolean(args.las), note: pointCloudNote },
  greenness: { used: Boolean(args.ortho && args.worldfile) },
  dbh: dbhStats,
  surveyAreaHa: Number(surveyAreaHa.toFixed(3)),
  // Per Malhar's answer #2 (docs/forest-tools-plan.md §0.1): no field
  // measurement of any kind exists for this survey. Stated here so the fact
  // travels with the data rather than living only in a plan document nobody
  // reads at report time.
  groundTruthNote: "No field-measured tree height, DBH or stem position exists for this survey. " +
    "Every figure in this output is validated against internal consistency and (where a reference " +
    "run exists, per plan Phase F6) another implementation's agreement -- never against a ground " +
    "measurement, because none was ever taken. No real-world accuracy claim is made anywhere in " +
    "this manifest, summary or attribute pack.",
};
writeFileSync(join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`  manifest.json`);

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${args.out}\n`);
