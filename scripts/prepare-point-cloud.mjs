/**
 * Turn a survey's LAS cloud into something a browser can stream.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/prepare-point-cloud.mjs \
 *     --site aektanagar-survey \
 *     --las "Aektanagar/Aektanagar Lidar Point Cloud.las"
 *
 * ## Why a quadtree and not a viewer
 *
 * Aektanagar's cloud is 50,183,644 points in a 1.7 GB file. No browser opens
 * that, and the portal's whole architecture is already the answer: the rasters
 * are served as windows over byte ranges, and a point cloud node is the same
 * idea with the level of detail baked in instead of derived.
 *
 * A quadtree, not an octree, because a survey cloud is a *surface*. The points
 * occupy a thin shell over 500 m of ground with 74 m of relief; splitting in Z
 * would produce mostly empty nodes and one crowded one at every level.
 *
 * Each node holds points thinned to its own spacing, and a point is written to
 * the first level whose grid cell is still free. That is Potree's scheme and it
 * has the property that matters: a node is a usable picture of its region on its
 * own, and its children *add* detail rather than replacing it, so the viewer can
 * stop descending at any depth and still show a complete cloud.
 *
 * ## What is stored
 *
 * Positions are converted to Web Mercator here, not in the browser. The viewer
 * draws through MapLibre's own camera, so mercator is the coordinate system it
 * needs; doing it in the pipeline means the browser projects nothing and the
 * numbers are computed once in double precision instead of fifty million times
 * in float.
 *
 * Each point is ten bytes: three uint16 quantised into the node's own mercator
 * box, then r, g, b and classification. Quantisation is 8.5 mm at the root node
 * and finer at every level below, against a survey whose stated vertical
 * accuracy is 4 cm, so it is comfortably below the noise. Float32 positions
 * would be more precise and 60% larger for precision nobody could measure.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { streamLasPoints, readLasHeader, CLASSIFICATIONS } from "../src/lib/geo/las.mjs";
import { utmToLonLat } from "../src/lib/geo/projection.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const SITE = args.get("site");
const LAS = args.get("las");
const MAX_DEPTH = Number(args.get("max-depth") ?? 5);
const GRID = Number(args.get("grid") ?? 128);
const OUT_ROOT = args.get("out") ?? path.join(process.cwd(), "portal-data", "cloud");

if (!SITE || !LAS) {
  console.error(
    "usage: --site <slug> --las <file.las> [--max-depth 5] [--grid 128] [--epsg 32643]",
  );
  process.exit(2);
}
if (!Number.isInteger(MAX_DEPTH) || MAX_DEPTH < 0 || MAX_DEPTH > 8) {
  console.error("--max-depth must be 0..8; each level is four times the nodes");
  process.exit(2);
}

const outDir = path.join(OUT_ROOT, SITE);
const nodesDir = path.join(outDir, "nodes");

console.log(`\nReading ${LAS}`);
const header = await readLasHeader(LAS);
console.log(
  `  LAS ${header.versionMajor}.${header.versionMinor}, format ${header.pointDataFormat}, ` +
    `${header.pointCount.toLocaleString("en-GB")} points`,
);
console.log(`  ${header.crsName ?? "no CRS name"} (EPSG:${header.epsg ?? "unknown"})`);

/**
 * `--epsg` asserts a CRS the file does not carry. It is not a way to skip the check.
 *
 * Plenty of exporters write no CRS record at all — Ektanagar 2's 328M point
 * cloud is one, and refusing it outright would mean the survey simply has no
 * point cloud in the portal. But a cloud whose units are degrees, or whose
 * coordinates belong to a different zone, produces a quadtree that looks
 * perfectly reasonable and sits in the wrong place on the map, so the assertion
 * has to be a deliberate act with evidence behind it rather than a default.
 *
 * The evidence is cheap and this refuses without it: the declared zone must put
 * the cloud on ground the site's own DTM covers. That catches the two mistakes
 * worth catching — a geographic CRS, whose degrees land the cloud within a few
 * hundred metres of the equator and nowhere near a UTM easting, and the wrong
 * zone, which shifts the easting by hundreds of kilometres. Both miss the
 * raster's bounding box by far more than any real survey overlaps it.
 *
 * For Ektanagar 2 the two agree to 2 cm on the eastern edge, which is what
 * makes asserting 32643 honest rather than hopeful.
 */
const assertedEpsg = args.get("epsg") ? Number(args.get("epsg")) : null;
if (assertedEpsg !== null && !Number.isInteger(assertedEpsg)) {
  console.error(`--epsg must be an integer EPSG code, got "${args.get("epsg")}"`);
  process.exit(2);
}

const epsg = header.epsg ?? assertedEpsg;

if (!epsg) {
  console.error(
    "\nThis cloud declares no projected CRS. Everything below assumes a metre is a " +
      "metre in both directions, which is exactly what a geographic CRS is not, so " +
      "refusing is the only honest answer.\n\n" +
      "If you know the CRS, pass it explicitly with --epsg (for example --epsg 32643).\n" +
      "It is checked against this site's DTM before anything is written.",
  );
  process.exit(1);
}
const zone = epsg >= 32601 && epsg <= 32660 ? epsg - 32600 : null;
const northern = epsg >= 32601 && epsg <= 32660;
if (zone === null) {
  console.error(`\nEPSG:${epsg} is not a northern-hemisphere UTM zone; unsupported.`);
  process.exit(1);
}
if (header.epsg && assertedEpsg && header.epsg !== assertedEpsg) {
  console.error(
    `\nThe file declares EPSG:${header.epsg} but --epsg says ${assertedEpsg}. ` +
      `Refusing to overrule a cloud that already knows what it is.`,
  );
  process.exit(1);
}

if (!header.epsg) {
  /*
   * Checked against the DTM the portal already serves for this site, which is
   * the only independent statement of where this survey is on the earth.
   */
  const { openSurvey } = await import("./lib/survey.mjs");
  let survey;
  try {
    survey = await openSurvey(SITE, "dtm");
  } catch (error) {
    console.error(
      `\n--epsg needs this site's DTM to check against, and it could not be opened:\n  ` +
        `${error.message}`,
    );
    process.exit(1);
  }
  const b = header.bounds;
  const west = survey.originX;
  const east = survey.originX + survey.width * survey.cellSize;
  const south = survey.originY - survey.height * survey.cellSize;
  const north = survey.originY;
  const overlapX = Math.min(b.maxX, east) - Math.max(b.minX, west);
  const overlapY = Math.min(b.maxY, north) - Math.max(b.minY, south);
  const spanX = b.maxX - b.minX;
  const spanY = b.maxY - b.minY;
  await survey.close();

  if (survey.epsg !== epsg) {
    console.error(
      `\nYou asserted EPSG:${epsg} but this site's DTM is EPSG:${survey.epsg}. ` +
        `A cloud and a raster of the same ground have to be in the same CRS.`,
    );
    process.exit(1);
  }
  // Half the cloud's own extent: generous enough for a cloud that covers more
  // ground than the raster, strict enough that a wrong zone cannot pass.
  if (!(overlapX > spanX * 0.5 && overlapY > spanY * 0.5)) {
    console.error(
      `\nEPSG:${epsg} does not put this cloud on the same ground as ${SITE}'s DTM.\n` +
        `  cloud  X ${b.minX.toFixed(0)}..${b.maxX.toFixed(0)}  Y ${b.minY.toFixed(0)}..${b.maxY.toFixed(0)}\n` +
        `  DTM    X ${west.toFixed(0)}..${east.toFixed(0)}  Y ${south.toFixed(0)}..${north.toFixed(0)}\n` +
        `  overlap ${overlapX.toFixed(0)} m x ${overlapY.toFixed(0)} m\n` +
        `That is the wrong zone or the wrong file, not a CRS worth asserting.`,
    );
    process.exit(1);
  }
  console.log(
    `  no CRS in the file; asserting EPSG:${epsg}, which overlaps the DTM by ` +
      `${overlapX.toFixed(0)} m x ${overlapY.toFixed(0)} m`,
  );
}

const { minX, minY, maxX, maxY, minZ, maxZ } = header.bounds;
// A square root region, so a node is square at every level and "spacing" means
// the same thing in both directions.
const side = Math.max(maxX - minX, maxY - minY);
const rootX = minX;
const rootY = minY;
const rootSpacing = side / GRID;

console.log(
  `\nQuadtree: ${side.toFixed(1)} m square, ${GRID}×${GRID} per node, depth 0..${MAX_DEPTH}`,
);
console.log(
  `  root spacing ${rootSpacing.toFixed(2)} m, finest ${(rootSpacing / 2 ** MAX_DEPTH).toFixed(3)} m`,
);


/**
 * The true longitude/latitude box of a UTM rectangle.
 *
 * Two corners are not enough, and the error is not academic. UTM grid north is
 * not true north away from the zone's central meridian — Aektanagar sits 1.35°
 * west of it, so the grid is turned about half a degree — which means the north
 * west corner of a rectangle is further west than the south west corner. A box
 * built from (minX, minY) and (maxX, maxY) alone therefore misses ground the
 * rectangle actually covers, by about 5 m over half a kilometre.
 *
 * That is enough to matter twice: the viewer culls nodes against these boxes, so
 * an undersized one makes a node at the edge blink out; and anything checking
 * that the points landed on the survey would find a fringe of them outside.
 *
 * All four corners, plus the midpoint of each edge, because the transform is
 * curved and the extreme need not be at a corner.
 */
function lonLatBox(x0, y0, x1, y1) {
  const xs = [x0, (x0 + x1) / 2, x1];
  const ys = [y0, (y0 + y1) / 2, y1];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const [lon, lat] = utmToLonLat(x, y, zone, northern);
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return [west, south, east, north];
}

/**
 * One node's occupancy grid and its points, in the file's own CRS.
 *
 * Points are held as the raw uint16 quantisation into the node's UTM square,
 * because that is the smallest thing that survives until the projection pass,
 * and holding 50 million doubles is not an option on a laptop.
 */
class Node {
  constructor(level, col, row) {
    this.level = level;
    this.col = col;
    this.row = row;
    this.size = side / 2 ** level;
    this.x0 = rootX + col * this.size;
    this.y0 = rootY + row * this.size;
    this.taken = new Uint8Array(GRID * GRID);
    this.count = 0;
    /** uint16 qx, qy, qz then r, g, b, classification. */
    this.data = null;
  }

  /** Try to place a point. False when this node's cell is already taken. */
  place(x, y, z, r, g, b, classification) {
    const fx = (x - this.x0) / this.size;
    const fy = (y - this.y0) / this.size;
    let cx = Math.floor(fx * GRID);
    let cy = Math.floor(fy * GRID);
    // A point exactly on the far edge lands one cell outside; clamping is right
    // here because the alternative is dropping the only point in a strip.
    if (cx >= GRID) cx = GRID - 1;
    if (cy >= GRID) cy = GRID - 1;
    /*
     * Outside this node entirely, which can only happen for a point outside the
     * root square. Reported as not placed rather than as placed-and-discarded:
     * the caller then tries the next level, fails there too, and counts it as
     * dropped. Returning true here would add it to the stored total while
     * writing nothing, so the manifest's point count would not match the sum of
     * its nodes.
     */
    if (cx < 0 || cy < 0) return false;
    const cell = cy * GRID + cx;
    if (this.taken[cell]) return false;
    this.taken[cell] = 1;

    if (!this.data) this.data = new Uint16Array(GRID * GRID * 5);
    const at = this.count * 5;
    this.data[at] = clamp16(fx * 65535);
    this.data[at + 1] = clamp16(fy * 65535);
    this.data[at + 2] = clamp16(((z - minZ) / Math.max(maxZ - minZ, 1e-9)) * 65535);
    // Colour and classification packed two per uint16 to keep one typed array.
    this.data[at + 3] = ((r < 0 ? 0 : r) & 0xff) | (((g < 0 ? 0 : g) & 0xff) << 8);
    this.data[at + 4] = ((b < 0 ? 0 : b) & 0xff) | ((classification & 0xff) << 8);
    this.count += 1;
    return true;
  }
}

function clamp16(v) {
  return v <= 0 ? 0 : v >= 65535 ? 65535 : v | 0;
}

/** Nodes, created on demand and keyed "level/col/row". */
const nodes = new Map();
function nodeAt(level, col, row) {
  const key = `${level}/${col}/${row}`;
  let node = nodes.get(key);
  if (!node) {
    node = new Node(level, col, row);
    nodes.set(key, node);
  }
  return node;
}

let placed = 0;
let dropped = 0;
let hasColour = false;
const classes = new Map();
let lastReport = Date.now();

console.log("\nWalking the cloud");
await streamLasPoints(
  LAS,
  (x, y, z, r, g, b, classification) => {
    if (r >= 0) hasColour = true;
    classes.set(classification, (classes.get(classification) ?? 0) + 1);
    for (let level = 0; level <= MAX_DEPTH; level += 1) {
      const per = side / 2 ** level;
      let col = Math.floor((x - rootX) / per);
      let row = Math.floor((y - rootY) / per);
      const span = 2 ** level;
      if (col >= span) col = span - 1;
      if (row >= span) row = span - 1;
      if (col < 0) col = 0;
      if (row < 0) row = 0;
      if (nodeAt(level, col, row).place(x, y, z, r, g, b, classification)) {
        placed += 1;
        return;
      }
    }
    // Every level down to the finest already has a point within its spacing of
    // this one. Dropping it loses nothing a viewer could draw.
    dropped += 1;
  },
  {
    onProgress(done, total) {
      if (Date.now() - lastReport < 3000) return;
      lastReport = Date.now();
      const pct = ((done / total) * 100).toFixed(1);
      process.stdout.write(
        `\r  ${pct}%  ${done.toLocaleString("en-GB")} read, ` +
          `${placed.toLocaleString("en-GB")} kept, ${nodes.size} nodes   `,
      );
    },
  },
);
process.stdout.write("\n");

console.log(
  `  kept ${placed.toLocaleString("en-GB")} of ${header.pointCount.toLocaleString("en-GB")}` +
    ` (${((placed / header.pointCount) * 100).toFixed(1)}%), ` +
    `${dropped.toLocaleString("en-GB")} beyond the finest spacing`,
);

// ---------------------------------------------------------------------------
// Project to mercator and write the nodes
// ---------------------------------------------------------------------------

/**
 * Web Mercator, the normalised form MapLibre uses: [0,1] across the world.
 *
 * Written here rather than imported from maplibre-gl because this is a Node
 * script and the package is a browser bundle. It is four lines and the
 * definition has not changed since 2005.
 */
function mercator(lon, lat) {
  const x = (180 + lon) / 360;
  const y =
    (180 -
      (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) /
    360;
  return [x, y];
}
/** Mercator units per metre at a latitude: the scale the z axis needs. */
function metresToMercator(lat) {
  return 1 / (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180));
}

await rm(outDir, { recursive: true, force: true });
await mkdir(nodesDir, { recursive: true });

const manifestNodes = [];
let bytes = 0;
const sorted = [...nodes.values()]
  .filter((n) => n.count > 0)
  .sort((a, b) => a.level - b.level || a.row - b.row || a.col - b.col);

console.log(`\nProjecting and writing ${sorted.length} nodes`);
for (const node of sorted) {
  const xs = new Float64Array(node.count);
  const ys = new Float64Array(node.count);
  const zs = new Float64Array(node.count);
  let mnx = Infinity;
  let mny = Infinity;
  let mnz = Infinity;
  let mxx = -Infinity;
  let mxy = -Infinity;
  let mxz = -Infinity;

  for (let i = 0; i < node.count; i += 1) {
    const at = i * 5;
    const utmX = node.x0 + (node.data[at] / 65535) * node.size;
    const utmY = node.y0 + (node.data[at + 1] / 65535) * node.size;
    const height = minZ + (node.data[at + 2] / 65535) * (maxZ - minZ);
    const [lon, lat] = utmToLonLat(utmX, utmY, zone, northern);
    const [mx, my] = mercator(lon, lat);
    const mz = height * metresToMercator(lat);
    xs[i] = mx;
    ys[i] = my;
    zs[i] = mz;
    if (mx < mnx) mnx = mx;
    if (my < mny) mny = my;
    if (mz < mnz) mnz = mz;
    if (mx > mxx) mxx = mx;
    if (my > mxy) mxy = my;
    if (mz > mxz) mxz = mz;
  }

  /*
   * A node whose points share a coordinate exactly — one point, or a perfectly
   * level strip — has a zero span, and dividing by it would write NaN into every
   * position. A span of one unit is arbitrary and correct: every quantised value
   * is then 0, which dequantises back to the origin, which is where the points
   * are.
   */
  const sx = mxx - mnx || 1;
  const sy = mxy - mny || 1;
  const sz = mxz - mnz || 1;

  const blob = Buffer.alloc(12 + node.count * 10);
  blob.write("SGAPC1", 0, "latin1");
  blob.writeUInt32LE(node.count, 6);
  blob.writeUInt16LE(10, 10);
  for (let i = 0; i < node.count; i += 1) {
    const at = 12 + i * 10;
    blob.writeUInt16LE(clamp16(((xs[i] - mnx) / sx) * 65535), at);
    blob.writeUInt16LE(clamp16(((ys[i] - mny) / sy) * 65535), at + 2);
    blob.writeUInt16LE(clamp16(((zs[i] - mnz) / sz) * 65535), at + 4);
    const packedColour = node.data[i * 5 + 3];
    const packedRest = node.data[i * 5 + 4];
    blob[at + 6] = packedColour & 0xff;
    blob[at + 7] = (packedColour >> 8) & 0xff;
    blob[at + 8] = packedRest & 0xff;
    blob[at + 9] = (packedRest >> 8) & 0xff;
  }

  const name = `${node.level}-${node.col}-${node.row}.pnt`;
  await writeFile(path.join(nodesDir, name), blob);
  bytes += blob.length;

  manifestNodes.push({
    key: `${node.level}/${node.col}/${node.row}`,
    file: `nodes/${name}`,
    level: node.level,
    count: node.count,
    /** Metres between neighbouring points at this level: the LOD criterion. */
    spacing: rootSpacing / 2 ** node.level,
    /** Where the node is on the map, for culling before anything is fetched. */
    lonLatBounds: lonLatBox(node.x0, node.y0, node.x0 + node.size, node.y0 + node.size),
    /*
     * The same box in the survey's own projected metres.
     *
     * Not redundant with the pair above. The quadtree is defined in UTM, so
     * containment — this node lies inside its parent, every node lies inside the
     * root — is exact here and only approximate in longitude and latitude, where
     * meridian convergence tilts the grid: at Aektanagar's easting a node's west
     * edge moves about 2.4 m of longitude over 278 m of northing. An invariant
     * that cannot be checked exactly is an invariant nobody checks.
     */
    utmBounds: [node.x0, node.y0, node.x0 + node.size, node.y0 + node.size],
    /** Dequantisation: mercator = origin + q / 65535 * span. */
    origin: [mnx, mny, mnz],
    span: [sx, sy, sz],
  });
}

const [west, south, east, north] = lonLatBox(minX, minY, maxX, maxY);

const manifest = {
  site: SITE,
  generatedAt: new Date().toISOString(),
  source: path.basename(LAS),
  format: "SGAPC1",
  /*
   * The effective CRS, which is the asserted one when the file carried none.
   * Recording `header.epsg` here would write null into the manifest for a cloud
   * that is perfectly well placed, and the viewer reads this to position it.
   */
  crs: { epsg, name: header.crsName ?? `EPSG:${epsg} (asserted; absent from the file)` },
  sourcePointCount: header.pointCount,
  storedPointCount: placed,
  hasColour,
  /** Only the classes this cloud actually contains, with names and counts. */
  classifications: [...classes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({
      code,
      name: CLASSIFICATIONS[code] ?? `Class ${code}`,
      count,
    })),
  bounds: { minX, minY, maxX, maxY, minZ, maxZ },
  lonLatBounds: [west, south, east, north],
  elevation: { min: minZ, max: maxZ },
  grid: GRID,
  maxDepth: MAX_DEPTH,
  rootSpacing,
  /** The square the quadtree divides, in UTM. Wider than the data where the
   *  survey is not square, which is why it is stated rather than inferred. */
  rootSquare: [rootX, rootY, rootX + side, rootY + side],
  nodes: manifestNodes,
};

await writeFile(path.join(outDir, "cloud.json"), JSON.stringify(manifest, null, 1));

console.log(`\nWrote ${outDir}`);
console.log(
  `  ${manifestNodes.length} nodes, ${(bytes / 1024 / 1024).toFixed(1)} MB, ` +
    `manifest ${(JSON.stringify(manifest).length / 1024).toFixed(0)} KB`,
);
for (let level = 0; level <= MAX_DEPTH; level += 1) {
  const at = manifestNodes.filter((n) => n.level === level);
  if (at.length === 0) continue;
  const points = at.reduce((sum, n) => sum + n.count, 0);
  console.log(
    `  level ${level}: ${String(at.length).padStart(5)} nodes, ` +
      `${points.toLocaleString("en-GB").padStart(12)} points, ` +
      `${(rootSpacing / 2 ** level).toFixed(3)} m spacing`,
  );
}
