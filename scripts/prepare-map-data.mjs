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
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import { rampFor } from "../src/lib/geo/colour.mjs";
import { hillshade, renderGrid } from "../src/lib/geo/render.mjs";
import { readManifest, emptyManifest, upsertLayer, writeManifest } from "./lib/manifest.mjs";
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
  /*
   * No contours delivered for this flight yet, so `vectors` is empty rather
   * than absent — the loop below iterates it either way.
   *
   * The rasters here are 1.9 GB tiled BigTIFFs. Only a decimated overview is
   * written for the base map; every measurement the portal makes goes through
   * the dynamic tiler and the analysis API against the native raster, so the
   * preview being coarse costs nothing but bytes on the wire.
   */
  "ektanagar-2-survey": {
    rasters: [
      { key: "dsm", title: "Surface model (DSM)", tif: "ektanagar/Ektanagar 2 DSM.tif" },
      { key: "dtm", title: "Terrain model (DTM)", tif: "ektanagar/Ektanagar 2 DTM.tif" },
    ],
    vectors: [],
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
/*
 * Start from the manifest that is already there, not from an empty one.
 *
 * This used to build a fresh manifest and overwrite whatever existed on every
 * run — the exact trap `manifest.mjs`'s own docstring describes and
 * `prepare-site.mjs` was fixed for: re-running this for Ektanagar 2's DSM/DTM
 * silently dropped the orthomosaic layer `prepare-site.mjs` had added, because
 * neither script knows about the other's layers. Layers this run produces are
 * upserted by key; layers it did not touch are left alone.
 */
const manifest = readManifest(OUT) ?? emptyManifest(SITE);

function requireFile(path, what) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    console.error("Raw survey data is gitignored, so this only runs on a machine that has it.");
    process.exit(1);
  }
}

// ---- rasters -----------------------------------------------------------
const rasters = CONFIG.rasters;

/**
 * The same rainbow ramp the dynamic tiler and `prepare-site.mjs` use.
 *
 * This used to be a warm sepia gradient with no relief shading, "matching the
 * marketing site's DEM renders" — which was exactly the bug Malhar caught in
 * `prepare-site.mjs`'s own tiles (see the comment there): a DSM and a DTM of
 * the same ground came out as two nearly identical brown washes, unreadable and
 * indistinguishable, while the rendered-layers panel drew a properly graded
 * picture from the same raster through a different code path. That fix never
 * reached this script, so every site this one generates the overview for —
 * Ektanagar 2 and Kiru, since e701a84 stopped baking full tile pyramids for
 * them — kept the old sepia look, inconsistent with Kotba and Ektanagar 1's.
 */
const ELEVATION_RAMP = rampFor("rainbow");

for (const raster of rasters) {
  const tif = join(root, raster.tif);
  const tfw = tif.replace(/\.tiff?$/i, ".tfw");
  const prj = tif.replace(/\.tiff?$/i, ".prj");
  requireFile(tif, "GeoTIFF");

  /*
   * The sidecars are optional, because a GeoTIFF already carries everything
   * they say.
   *
   * Kotba and Ektanagar 1 arrived as .tif + .tfw + .prj, so this read the
   * sidecars and refused without them. Ektanagar 2 arrived as a bare tiled
   * BigTIFF — georeferenced perfectly well in its own tags, and rejected here
   * for missing a file that would only have restated them. Writing the sidecars
   * by hand to satisfy this would mean transcribing an origin and a cell size
   * between two files that must agree, which is a way to get them to disagree.
   *
   * So: prefer the sidecars where a delivery includes them, and otherwise read
   * the same numbers out of the raster's own directory.
   */
  const hasSidecars = existsSync(tfw) && existsSync(prj);
  let proj;
  let world;
  if (hasSidecars) {
    proj = readProjection(prj);
    world = readWorldFile(tfw);
  } else {
    const source = cached(await fileSource(tif));
    const header = await openRaster(source);
    if (!header.utmZone) {
      throw new Error(
        `${raster.tif} has no world file and its own CRS (EPSG:${header.epsg}) is not a ` +
          `UTM zone, so there is nothing to place it with.`,
      );
    }
    proj = { zone: header.utmZone.zone, northern: header.utmZone.northern };
    /*
     * A world file states the centre of the top left *pixel*, while a GeoTIFF's
     * tie point states its top left *corner*. Half a cell apart, and on a 7.4 cm
     * survey that is 3.7 cm of shift in the base map — small enough to look
     * right and wrong enough to matter.
     */
    world = {
      pxWidth: header.cellSize,
      pxHeight: -header.cellSize,
      originX: header.originX + header.cellSize / 2,
      originY: header.originY - header.cellSize / 2,
    };
    await header.close();
    console.log(`  no sidecars; placed from the GeoTIFF's own tags (EPSG:${header.epsg})`);
  }
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
  /*
   * Decimated on the way in, not after.
   *
   * What this writes is an overview for the base map — Kiru's is 180 KB — but
   * it was colourising at full resolution first and shrinking at the end.
   * Ektanagar 2 is 25462 x 28831, so that meant a 2.9 GB RGBA buffer beside a
   * 2.9 GB float one, and Node died with "Ineffective mark-compacts near heap
   * limit" after 46 seconds. The two surveys already published are 2.2M and
   * 42.8M cells and never came close.
   *
   * PREVIEW_MAX_PX is generous for something drawn under a map at survey scale,
   * and `fit: "inside"` keeps the aspect ratio so `rasterCorners` still places
   * it correctly — the corners come from the world file and the raster's own
   * dimensions, neither of which this changes.
   *
   * Elevation range is measured after the resize, from the pixels actually
   * written, so the legend describes the image rather than something the viewer
   * cannot see. On a smooth overview that shaves the extremes very slightly,
   * which is the honest reading of a decimated picture.
   */
  const PREVIEW_MAX_PX = 4096;
  const decimating = meta.width > PREVIEW_MAX_PX || meta.height > PREVIEW_MAX_PX;
  if (decimating) {
    console.log(
      `  ${meta.width} x ${meta.height} is larger than ${PREVIEW_MAX_PX} px; ` +
        `decimating for the overview (measurement still reads the native raster)`,
    );
  }
  const { data, info } = await (decimating
    ? image.resize({
        width: PREVIEW_MAX_PX,
        height: PREVIEW_MAX_PX,
        fit: "inside",
        kernel: "nearest",
      })
    : image
  )
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
  console.log(`     colour ramp clipped to ${lo.toFixed(1)} - ${hi.toFixed(1)} m`);

  /*
   * A grid shaped the way `render.mjs` expects, over the decimated floats —
   * dense, not the strided view sharp returns, because hillshade reads eight
   * neighbours per pixel and a stride of anything but one would sample the
   * wrong ones. NaN marks nodata, matching `isNoData` below and leaving those
   * pixels transparent, same as `prepare-site.mjs`'s `elevationToRgba`.
   */
  const dense = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const v = floats[i];
    dense[i] = isElevation(v) ? v : NaN;
  }
  const grid = {
    width: info.width,
    height: info.height,
    data: dense,
    /*
     * Metres per pixel, scaled by however much this overview was decimated —
     * the world file states the *native* raster's cell size, and a hillshade
     * computed against that on a resized grid would read gradients four or
     * five times shallower than they are, the same trap `prepare-site.mjs`
     * warns about for a defaulted cell size.
     */
    cellSize: (Math.abs(world.pxWidth) || 1) * (meta.width / info.width),
    isNoData: (v) => !Number.isFinite(v),
  };
  const relief = hillshade(grid, { azimuth: 315, altitude: 45, exaggeration: 1.6 });
  const shaded = renderGrid(grid, { stops: ELEVATION_RAMP, min: lo, max: hi, relief });
  const rgba = Buffer.from(shaded.buffer, shaded.byteOffset, shaded.byteLength);

  const file = `${raster.key}.webp`;
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ quality: 82 })
    .toFile(join(OUT, file));

  upsertLayer(manifest, {
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
/*
 * Skipped when a delivery has none. This read `CONFIG.vectors[0]`
 * unconditionally, which was fine while both configured sites happened to ship
 * a contour shapefile and threw on the first one that did not. Contours are a
 * separate deliverable, not a property of having a survey.
 */
if (CONFIG.vectors.length === 0) {
  console.log("\nNo contour shapefile configured for this site; skipping that layer.");
} else {
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

  upsertLayer(manifest, {
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

writeManifest(OUT, manifest);
console.log(`\nwrote ${manifest.layers.length} layers to portal-data/map/${SITE}\n`);
