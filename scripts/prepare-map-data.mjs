/**
 * Turns raw survey deliverables into georeferenced layers the portal map can draw.
 *
 * Inputs are the real Kotba survey sitting in the gitignored folders: a float
 * GeoTIFF DEM with its world file, and an ESRI shapefile of contours. Outputs go
 * to portal-data/map/<site>/, which is OUTSIDE public/ on purpose: these are a
 * client's deliverables and must only ever be reachable through the authorised
 * route, never as a static file.
 *
 * Two jobs that nothing else in the repo does:
 *
 *   1. Work out where a raster actually sits on the earth. A world file gives
 *      pixel size and a top left corner in UTM metres; the map needs WGS84
 *      degrees, so the corners are unprojected here. Getting this wrong does not
 *      throw, it silently draws the survey in the wrong field, which is why the
 *      script prints the result and sanity checks the hemisphere and zone.
 *
 *   2. Read the contour shapefile without GDAL, which is not available on this
 *      machine. .shp geometry and .dbf attributes are both simple enough to
 *      parse directly, and doing so keeps the elevation value attached to each
 *      line so the map can label it.
 *
 * Usage:
 *   node scripts/prepare-map-data.mjs
 */

import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isElevation,
  utmToLonLat,
  readProjection,
  readWorldFile,
  rasterCorners,
  readDbf,
  readShpPolylines,
} from "./lib/geo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where each site's raw deliverables live.
 *
 * Adding a site is a data change here, not a code change. Paths are relative to
 * the repo root and all of them are gitignored, so this only runs on a machine
 * that holds the survey.
 *
 * Usage:
 *   node scripts/prepare-map-data.mjs            all configured sites
 *   node scripts/prepare-map-data.mjs kotba-survey   just one
 */
const SITES = {
  "kotba-survey": {
    rasters: [
      { key: "dsm", title: "Surface model (DSM)", tif: "DSM/Kotba_DEM.tif" },
      { key: "dtm", title: "Terrain model (DTM)", tif: "DTM/Kotba_DTM.tif" },
    ],
    vectors: [
      { key: "contours", title: "Contours", shapefile: "Contours/Kotba Contours" },
    ],
  },
  "aektanagar-survey": {
    rasters: [
      { key: "dsm", title: "Surface model (DSM)", tif: "Aektanagar/Aekatanagar DSM.tif" },
      { key: "dtm", title: "Terrain model (DTM)", tif: "Aektanagar/Aekatanagar DTM.tif" },
    ],
    vectors: [
      { key: "contours", title: "Contours", shapefile: "Aektanagar/Contours/Contours/Contours" },
    ],
  },
};

const requested = process.argv[2];
if (requested && !SITES[requested]) {
  console.error(`unknown site "${requested}". Configured: ${Object.keys(SITES).join(", ")}`);
  process.exit(1);
}
const SITE = requested ?? Object.keys(SITES)[0];
const CONFIG = SITES[SITE];
const OUT = join(root, "portal-data", "map", SITE);

/* ------------------------------------------------------------------ run --- */

mkdirSync(OUT, { recursive: true });
const manifest = { site: SITE, generatedAt: new Date().toISOString(), layers: [] };

function requireFile(path, what) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    console.error("Raw survey data is gitignored, so this only runs on a machine that has it.");
    process.exit(1);
  }
}

// ---- rasters -----------------------------------------------------------
const rasters = CONFIG.rasters;

/** Warm elevation ramp, matching the marketing site's DEM renders. */
const ramp = [
  [0.0, [250, 226, 192]],
  [0.35, [229, 142, 58]],
  [0.65, [180, 83, 9]],
  [1.0, [74, 42, 16]],
];
function elevColor(t) {
  for (let i = 0; i < ramp.length - 1; i += 1) {
    const [a, ca] = ramp[i];
    const [b, cb] = ramp[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      return [0, 1, 2].map((c) => Math.round(ca[c] + (cb[c] - ca[c]) * k));
    }
  }
  return ramp[ramp.length - 1][1];
}

for (const raster of rasters) {
  const tif = join(root, raster.tif);
  const tfw = tif.replace(/\.tiff?$/i, ".tfw");
  const prj = tif.replace(/\.tiff?$/i, ".prj");
  requireFile(tif, "GeoTIFF");
  requireFile(tfw, "world file");
  requireFile(prj, "projection file");

  const proj = readProjection(prj);
  const world = readWorldFile(tfw);
  const image = sharp(tif, { limitInputPixels: false });
  const meta = await image.metadata();

  /**
   * Refuse anything that is not a single band of floating point height.
   *
   * Point this at an orthomosaic and, without the check, it reads the red
   * channel as metres and reports an "elevation range" of 120 to 120. No throw,
   * no warning, just a nonsense layer. An ortho is a colour image and belongs on
   * a different path, not this one.
   */
  if (meta.channels !== 1 || meta.depth !== "float") {
    throw new Error(
      `${raster.tif} is ${meta.channels} channel(s) at depth ${meta.depth}, ` +
        `not a single band float elevation model. If this is an orthomosaic it ` +
        `needs the imagery path, which is not built yet (see context.md 8h).`,
    );
  }
  const { coordinates, utm } = rasterCorners(world, meta.width, meta.height, proj);

  // Single band float elevation -> warm colourised RGBA, nodata transparent.
  //
  // depth: "float" is not optional. Plain .raw() quietly hands back 8 bit RGB
  // for a float TIFF, and reinterpreting those bytes as float32 produces
  // convincing nonsense: the first run of this script reported the DSM spanning
  // -24 to 0 metres and the DTM 0 to 0.
  const { data, info } = await image
    .raw({ depth: "float" })
    .toBuffer({ resolveWithObject: true });

  // sharp expands the single elevation band to three identical channels, so
  // step over them rather than assuming one float per pixel.
  const pixels = info.width * info.height;
  const stride = data.byteLength / 4 / pixels;
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(
      `cannot read float elevation: ${data.byteLength} bytes for ${pixels} pixels ` +
        `(${info.channels} channels, depth ${info.depth})`,
    );
  }
  const all = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const floats = stride === 1 ? all : all.filter((_, i) => i % stride === 0);

  let min = Infinity;
  let max = -Infinity;
  for (const v of floats) {
    if (!isElevation(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    throw new Error(`${raster.key}: no usable elevation range (${min} to ${max})`);
  }

  /**
   * Colour across the 2nd to 98th percentile, not the full range.
   *
   * A surface model picks up a handful of wild values, and this one bottoms out
   * at 143 m while almost every pixel sits between 337 and 438. Stretching the
   * ramp over the outliers renders the entire survey as one flat orange, which
   * is what the first version produced. Clipping puts the contrast where the
   * terrain is; the true range is still reported in the manifest.
   */
  const sample = [];
  for (let i = 0; i < floats.length; i += Math.max(1, Math.floor(floats.length / 200000))) {
    const v = floats[i];
    if (isElevation(v)) sample.push(v);
  }
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.02)] ?? min;
  const hi = sample[Math.floor(sample.length * 0.98)] ?? max;
  const span = hi - lo || 1;
  console.log(`     colour ramp clipped to ${lo.toFixed(1)} - ${hi.toFixed(1)} m`);

  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const v = floats[i];
    const nodata = !isElevation(v);
    if (nodata) continue; // leaves 0,0,0,0
    const [r, g, b] = elevColor(Math.min(1, Math.max(0, (v - lo) / span)));
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }

  const file = `${raster.key}.webp`;
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ quality: 82 })
    .toFile(join(OUT, file));

  manifest.layers.push({
    key: raster.key,
    kind: "raster",
    title: raster.title,
    file,
    coordinates,
    elevation: { min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) },
  });

  console.log(
    `${raster.key}: ${info.width}x${info.height}, ${min.toFixed(1)} to ${max.toFixed(1)} m, ` +
      `corners ${coordinates[0].map((n) => n.toFixed(5)).join(",")} -> ` +
      `${coordinates[2].map((n) => n.toFixed(5)).join(",")}`,
  );
  console.log(`     UTM extent ${JSON.stringify(utm)}`);
}

// ---- contours ----------------------------------------------------------
{
  const vector = CONFIG.vectors[0];
  const base = join(root, vector.shapefile);
  requireFile(`${base}.shp`, "contour shapefile");
  requireFile(`${base}.dbf`, "contour attributes");
  requireFile(`${base}.prj`, "contour projection");

  const proj = readProjection(`${base}.prj`);
  const geometry = readShpPolylines(`${base}.shp`);
  const { fields, rows } = readDbf(`${base}.dbf`);
  console.log(`contours: ${geometry.length} shapes, fields ${fields.map((f) => f.name).join(", ")}`);

  // Whichever column holds the height. Named ELEV, CONTOUR, Z or similar
  // depending on which package exported it.
  const elevField =
    fields.find((f) => /^(elev|elevation|contour|height|z|level)$/i.test(f.name))?.name ??
    fields.find((f) => f.type === "N" || f.type === "F")?.name;
  if (!elevField) throw new Error("no numeric field to use as elevation");

  /**
   * This export stores elevation as text with the unit attached, "338 m", so a
   * plain Number() returns NaN and every contour silently loses its height.
   * Pull the leading number out instead.
   */
  const heightOf = (row) => {
    const direct = row?.[elevField];
    if (Number.isFinite(direct)) return direct;
    const text = row?.[`${elevField}__raw`] ?? "";
    const match = /-?\d+(?:\.\d+)?/.exec(String(text));
    return match ? Number(match[0]) : null;
  };
  console.log(`contours: using "${elevField}" as elevation`);

  /**
   * Ramer-Douglas-Peucker, run in metres before unprojecting.
   *
   * The survey traces contours at sub centimetre spacing, which is 94,000 points
   * over a 350 metre site: several megabytes of JSON to describe lines that are
   * a pixel wide on screen. A tolerance near the DEM's own cell size throws away
   * detail the raster never resolved in the first place.
   */
  function simplify(points, tolerance) {
    if (points.length < 3) return points;

    const sqTol = tolerance * tolerance;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let maxSq = 0;
      let index = 0;

      const [x1, y1] = points[first];
      const [x2, y2] = points[last];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = dx * dx + dy * dy;

      for (let i = first + 1; i < last; i += 1) {
        const [px, py] = points[i];
        let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = x1 + t * dx - px;
        const ey = y1 + t * dy - py;
        const sq = ex * ex + ey * ey;
        if (sq > maxSq) {
          maxSq = sq;
          index = i;
        }
      }

      if (maxSq > sqTol && index) {
        keep[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  const TOLERANCE_M = 0.15; // about one DEM cell
  let before = 0;
  let after = 0;

  const features = [];
  for (let i = 0; i < geometry.length; i += 1) {
    const lines = geometry[i];
    if (!lines) continue;
    const elevation = heightOf(rows[i]);
    for (const line of lines) {
      before += line.length;
      const thinned = simplify(line, TOLERANCE_M);
      if (thinned.length < 2) continue;
      after += thinned.length;

      features.push({
        type: "Feature",
        properties: { elevation },
        geometry: {
          type: "LineString",
          coordinates: thinned.map(([e, n]) => {
            const [lon, lat] = utmToLonLat(e, n, proj.zone, proj.northern);
            // Six decimals is about 0.1 m, past what the survey resolves.
            return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
          }),
        },
      });
    }
  }
  console.log(`contours: simplified ${before} points to ${after} at ${TOLERANCE_M} m`);

  const elevations = features.map((f) => f.properties.elevation).filter(Number.isFinite);
  const file = "contours.geojson";
  writeFileSync(join(OUT, file), JSON.stringify({ type: "FeatureCollection", features }));

  manifest.layers.push({
    key: vector.key,
    kind: "vector",
    title: vector.title,
    file,
    featureCount: features.length,
    elevation: { min: Math.min(...elevations), max: Math.max(...elevations) },
  });

  console.log(
    `contours: ${features.length} lines, ${Math.min(...elevations)} to ${Math.max(...elevations)} m`,
  );
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nwrote ${manifest.layers.length} layers to portal-data/map/${SITE}\n`);
