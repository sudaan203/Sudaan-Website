/**
 * Turns a folder of survey deliverables into a portal ready bundle.
 *
 * This is the tool Sudaan runs, on the machine that already holds the data. It
 * takes whatever came out of the processing software, works out what each file
 * is, and writes a folder that can be dropped into the portal. Nothing about it
 * is specific to one site, and nothing needs editing in code to add another.
 *
 *   node scripts/prepare-site.mjs <input-folder> <site-slug> [--out DIR] [--quality N]
 *
 * Example:
 *   node scripts/prepare-site.mjs ~/surveys/reliance-jamnagar reliance-jamnagar
 *
 * What it does with what it finds:
 *
 *   single band float GeoTIFF  ->  elevation model, colourised, tiled
 *   three band GeoTIFF or PNG  ->  orthomosaic imagery, tiled as is
 *   .shp with .dbf and .prj    ->  contours or other lines, simplified GeoJSON
 *
 * Each raster needs georeferencing: either a GeoTIFF that carries it, or a
 * sidecar .tfw and .prj next to the file. Without that we know what a pixel
 * looks like but not where on earth it belongs, and the tool says so rather than
 * guessing.
 *
 * Why tiles rather than one resized image: quality. A single overlay has to be
 * shrunk to something a browser can hold, which throws away the detail the
 * survey was flown to capture. Tiles keep native resolution and the browser only
 * ever fetches the screenful it is showing, about 70 KB, however large the
 * source is.
 */

import sharp from "sharp";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  isElevation,
  lonLatToUtm,
  utmToLonLat,
  readProjection,
  readWorldFile,
  rasterCorners,
  readDbf,
  readShpPolylines,
  lonLatToMercator,
  mercatorToLonLat,
  tileBounds,
  tileRange,
  TILE_SIZE,
} from "./lib/geo.mjs";
import { maskBorderBackground } from "./lib/nodata.mjs";
import { rampFor } from "../src/lib/geo/colour.mjs";
import { hillshade, renderGrid } from "../src/lib/geo/render.mjs";
import {
  readManifest, emptyManifest, upsertLayer, sortLayers, writeManifest, verify,
} from "./lib/manifest.mjs";

/* --------------------------------------------------------------- options --- */

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const inputDir = positional[0] ? resolve(positional[0]) : null;
const siteSlug = positional[1];
const quality = Number(flag("quality", 80));
const maxZoomOverride = flag("max-zoom", null);

// Tiling holds one decoded raster in memory at four bytes a pixel, so the
// source size sets the peak. 120 Mpx is about 480 MB, which leaves room on an
// 8 GB laptop. Above this a raster is resized on the way in rather than the run
// being killed partway through, which is what happened to the first Aektanagar
// bundle: 750 Mpx wanted 3 GB, the process died after two thirds of a pyramid,
// and because the manifest is written last it was never updated.
const maxPixels = Number(flag("max-pixels", 120_000_000));
// Imagery with no alpha gets its flat border filler made transparent. --no-mask
// turns that off; --mask-tolerance widens what counts as the same flat colour.
const noMask = argv.includes("--no-mask");
const maskTolerance = Number(flag("mask-tolerance", 10));

if (!inputDir || !siteSlug) {
  console.error(`
Usage: node scripts/prepare-site.mjs <input-folder> <site-slug> [options]

  --out DIR        where to write (default portal-data/map/<site-slug>)
  --quality N      WebP quality 1-100 (default 80)
  --max-zoom N     stop at this zoom instead of native resolution
  --max-pixels N   working limit for one raster (default 120000000). Imagery
                   above it is resized to fit and flagged in the manifest.
  --no-mask        keep the flat filler around an orthomosaic footprint opaque
  --mask-tolerance N  how close to the corner colour still counts as filler (10)

Example:
  node scripts/prepare-site.mjs ~/surveys/reliance reliance-jamnagar
`);
  process.exit(1);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug)) {
  console.error(`site slug must be lowercase words and hyphens, got "${siteSlug}"`);
  process.exit(1);
}
if (!existsSync(inputDir)) {
  console.error(`no such folder: ${inputDir}`);
  process.exit(1);
}

const outDir = resolve(flag("out", join("portal-data", "map", siteSlug)));

/* ------------------------------------------------------------- discovery --- */

/** Georeferencing for a raster: from sidecars, or nothing. */
function georeferenceFor(file) {
  const stem = file.replace(/\.[^.]+$/, "");
  const worldExts = [".tfw", ".pgw", ".jgw", ".wld"];
  const tfw = worldExts.map((e) => stem + e).find(existsSync);
  const prj = existsSync(stem + ".prj") ? stem + ".prj" : null;
  if (!tfw || !prj) return null;
  try {
    return { world: readWorldFile(tfw), proj: readProjection(prj), tfw, prj };
  } catch (err) {
    console.warn(`  ! ${basename(file)}: ${err.message}`);
    return null;
  }
}

/**
 * A name a client should see, from a filename they should not.
 *
 * "Kotba_DEM" is what the processing software wrote; "Surface model (DSM)" is
 * what the person paying for the survey calls it. Falls back to a tidied
 * filename when nothing matches, so an unusual layer still reads sensibly.
 */
function friendlyTitle(stem) {
  // Separators first: "_" is a word character, so \bdem\b never matches
  // "Kotba_DEM" and every layer falls through to the filename.
  const n = stem.toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(dsm|dem|surface)\b/.test(n)) return "Surface model (DSM)";
  if (/\b(dtm|terrain|bare.?earth)\b/.test(n)) return "Terrain model (DTM)";
  if (/contour/.test(n)) return "Contours";
  if (/ortho|mosaic|rgb/.test(n)) return "Orthomosaic";
  if (/ndvi/.test(n)) return "Vegetation index (NDVI)";
  if (/hillshade|shade/.test(n)) return "Hillshade";
  if (/drainage/.test(n)) return "Drainage";
  if (/gcp|control/.test(n)) return "Ground control";
  return stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The world file for a resized copy of the same ground.
 *
 * What must not move is the extent, so the outer edges are held fixed. A world
 * file names the centre of the top left pixel rather than its corner, so both
 * the pixel size and the origin have to change: scaling only the pixel size
 * leaves the layer half a pixel out, which at 2 cm data is invisible on screen
 * and wrong in every measurement taken off it.
 */
function scaleWorld(world, fromWidth, fromHeight, toWidth, toHeight) {
  const pxWidth = (world.pxWidth * fromWidth) / toWidth;
  const pxHeight = (world.pxHeight * fromHeight) / toHeight;
  return {
    pxWidth,
    pxHeight,
    originX: world.originX - world.pxWidth / 2 + pxWidth / 2,
    originY: world.originY - world.pxHeight / 2 + pxHeight / 2,
  };
}

async function classify(file) {
  let meta;
  try {
    meta = await sharp(file, { limitInputPixels: false }).metadata();
  } catch {
    return null; // not an image sharp can open
  }
  const elevation = meta.channels === 1 && meta.depth === "float";
  return { file, meta, kind: elevation ? "elevation" : "imagery" };
}

console.log(`\nreading ${inputDir}`);
const entries = readdirSync(inputDir, { recursive: true })
  .map((f) => join(inputDir, String(f)))
  .filter((f) => statSync(f).isFile());

const rasterFiles = entries.filter((f) =>
  [".tif", ".tiff", ".png", ".jpg", ".jpeg"].includes(extname(f).toLowerCase()),
);
const shapefiles = entries.filter((f) => extname(f).toLowerCase() === ".shp");

if (rasterFiles.length === 0 && shapefiles.length === 0) {
  console.error("nothing to do: no .tif/.png/.jpg rasters and no .shp files here");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

/**
 * Start from the manifest that is already there, not from an empty one.
 *
 * This used to build a fresh manifest and overwrite whatever existed, which makes
 * any partial run destructive. Re-tiling one raster from a subfolder took
 * Aektanagar from five declared layers to one while all four pyramids sat on disk
 * untouched, so the portal would have shown a single layer with no error
 * anywhere. Exactly the silent shape of the stale manifest bug in context.md 8l,
 * arrived at from the opposite direction.
 *
 * Layers produced by this run are upserted by key; layers this run did not touch
 * are left alone and reported, so re-running for one file is safe.
 */
const manifest = readManifest(outDir) ?? emptyManifest(siteSlug);
const layersBefore = new Set(manifest.layers.map((l) => l.key));
const touched = new Set();
const report = [];

/* --------------------------------------------------------------- rasters --- */

/**
 * Elevation models are coloured with the same ramp and the same hillshade the
 * dynamic tiler uses, from `src/lib/geo/colour.mjs` and `render.mjs`.
 *
 * They were not, and Malhar was right to notice. These tiles were baked before
 * the tiler existed, with the site's own warm brand ramp and no relief at all,
 * so a DSM and a DTM of the same ground came out as two nearly identical sepia
 * washes. You could not read a height off either, you could not tell them apart,
 * and the client's own note asks for "a Global Mapper type of image".
 *
 * Worse, the two representations disagreed: the layer tree drew the brown
 * version while the rendered-layers panel drew a properly graded one from the
 * same raster, so the same data had two appearances depending on which control
 * you found. Sharing the palette makes them the same picture.
 */
const ELEVATION_RAMP = rampFor("rainbow");

/** Colourised RGBA for an elevation model, plus its true range. */
async function elevationToRgba(file, geo) {
  const { data, info } = await sharp(file, { limitInputPixels: false })
    .raw({ depth: "float" })
    .toBuffer({ resolveWithObject: true });

  const pixels = info.width * info.height;
  const stride = data.byteLength / 4 / pixels;
  const all = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const at = (i) => all[i * stride];

  let min = Infinity;
  let max = -Infinity;
  const sample = [];
  const step = Math.max(1, Math.floor(pixels / 200000));
  for (let i = 0; i < pixels; i += 1) {
    const v = at(i);
    if (!isElevation(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    if (i % step === 0) sample.push(v);
  }
  if (!Number.isFinite(min)) throw new Error("no usable elevations in this raster");

  // Colour across the middle of the distribution, so one wild value cannot
  // flatten the whole survey into a single shade.
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.02)] ?? min;
  const hi = sample[Math.floor(sample.length * 0.98)] ?? max;
  const span = hi - lo || 1;

  /*
   * A grid shaped the way `render.mjs` expects, over the raster's own floats.
   *
   * Copied into a dense Float32Array rather than passed as the strided view the
   * decoder returns: hillshade reads eight neighbours per pixel and a stride of
   * anything but one would silently sample the wrong ones. `NaN` marks nodata,
   * which is what `isNoData` tests for and what leaves those pixels transparent.
   */
  const dense = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const v = at(i);
    dense[i] = isElevation(v) ? v : NaN;
  }
  const grid = {
    width: info.width,
    height: info.height,
    data: dense,
    /*
     * Metres per pixel, from the world file, so the hillshade has real
     * gradients.
     *
     * Not optional and not defaultable. A relief computed against a cell size of
     * 1 on Kotba's 24 cm raster exaggerates every slope by four, which turns
     * gentle ground into a mountain range and looks, at a glance, entirely
     * convincing. The world file's first term is the x pixel size in projected
     * units, which for every survey here is metres.
     */
    cellSize: Math.abs(geo?.world?.[0]) || 1,
    isNoData: (v) => !Number.isFinite(v),
  };

  const relief = hillshade(grid, { azimuth: 315, altitude: 45, exaggeration: 1.6 });
  const shaded = renderGrid(grid, { stops: ELEVATION_RAMP, min: lo, max: hi, relief });

  return {
    rgba: Buffer.from(shaded.buffer, shaded.byteOffset, shaded.byteLength),
    width: info.width,
    height: info.height,
    min,
    max,
    lo,
    hi,
  };
}

/**
 * Native zoom: the level where a tile pixel is about the size of a source
 * pixel. Going further invents detail, stopping earlier throws it away, and
 * this is the whole reason tiles beat a resized overlay on quality.
 */
function nativeZoom(bboxMerc, widthPx) {
  const metresAcross = bboxMerc.east - bboxMerc.west;
  for (let z = 24; z >= 0; z -= 1) {
    const tileMetres = (2 * 20037508.342789244) / 2 ** z;
    const tilesAcross = metresAcross / tileMetres;
    if (tilesAcross * TILE_SIZE <= widthPx) return z;
  }
  return 0;
}

async function tileRaster({ key, title, rgba, width, height, geo, extra }) {
  const { coordinates } = rasterCorners(geo.world, width, height, geo.proj);
  const [tl, , br] = coordinates;
  const [wx, ny] = lonLatToMercator(tl[0], tl[1]);
  const [ex, sy] = lonLatToMercator(br[0], br[1]);
  const bbox = { west: wx, north: ny, east: ex, south: sy };

  const [utmW, utmN] = lonLatToUtm(tl[0], tl[1], geo.proj.zone, geo.proj.northern);
  const [utmE, utmS] = lonLatToUtm(br[0], br[1], geo.proj.zone, geo.proj.northern);

  const maxZoom = maxZoomOverride ? Number(maxZoomOverride) : nativeZoom(bbox, width);
  const minZoom = Math.max(0, maxZoom - 6);

  const tileRoot = join(outDir, "tiles", key);
  mkdirSync(tileRoot, { recursive: true });

  let written = 0;
  let skipped = 0;
  let bytes = 0;

  for (let z = minZoom; z <= maxZoom; z += 1) {
    const range = tileRange(z, bbox);
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const tb = tileBounds(z, x, y);
        const out = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
        let painted = 0;

        for (let py = 0; py < TILE_SIZE; py += 1) {
          const my = tb.north - ((py + 0.5) / TILE_SIZE) * (tb.north - tb.south);
          for (let px = 0; px < TILE_SIZE; px += 1) {
            const mx = tb.west + ((px + 0.5) / TILE_SIZE) * (tb.east - tb.west);
            const [lon, lat] = mercatorToLonLat(mx, my);
            const [e, n] = lonLatToUtm(lon, lat, geo.proj.zone, geo.proj.northern);
            const u = (e - utmW) / (utmE - utmW);
            const v = (utmN - n) / (utmN - utmS);
            if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

            const sx = Math.min(width - 1, Math.floor(u * width));
            const sy2 = Math.min(height - 1, Math.floor(v * height));
            const si = (sy2 * width + sx) * 4;
            if (rgba[si + 3] === 0) continue;

            const di = (py * TILE_SIZE + px) * 4;
            out[di] = rgba[si];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si + 2];
            out[di + 3] = 255;
            painted += 1;
          }
        }

        // Empty tiles are never written. This is what makes a 110 km corridor
        // cost what its data covers instead of what its bounding box spans.
        if (painted === 0) {
          skipped += 1;
          continue;
        }
        const dir = join(tileRoot, String(z), String(x));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${y}.webp`);
        await sharp(out, { raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 } })
          .webp({ quality, alphaQuality: 90 })
          .toFile(path);
        written += 1;
        bytes += statSync(path).size;
      }
    }
  }

  touched.add(key);
  upsertLayer(manifest, {
    key,
    kind: "tiles",
    title,
    tiles: `tiles/${key}/{z}/{x}/{y}.webp`,
    minZoom,
    maxZoom,
    bounds: [
      Math.min(tl[0], br[0]), Math.min(tl[1], br[1]),
      Math.max(tl[0], br[0]), Math.max(tl[1], br[1]),
    ],
    coordinates,
    ...extra,
  });

  report.push({ layer: title, tiles: written, skipped, bytes, maxZoom });
  console.log(
    `  ${title}: ${written} tiles z${minZoom}-${maxZoom}, ` +
      `${(bytes / 1024 / 1024).toFixed(2)} MB, ${skipped} empty skipped`,
  );
}

for (const file of rasterFiles) {
  const info = await classify(file);
  if (!info) continue;

  const geo = georeferenceFor(file);
  if (!geo) {
    console.warn(
      `  ! ${basename(file)}: no georeferencing. Needs a GeoTIFF with a world file, ` +
        `or a sidecar .tfw and .prj beside it. Skipped.`,
    );
    continue;
  }

  const key = basename(file).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  if (info.kind === "elevation") {
    // Not resized to fit, unlike imagery. Averaging a nodata sentinel such as
    // -9999 against real heights invents terrain that reads as real, and the
    // whole point of 8i is that this pipeline refuses rather than guesses.
    const pixels = info.meta.width * info.meta.height;
    if (pixels > maxPixels) {
      console.warn(
        `  ! ${basename(file)}: ${(pixels / 1e6).toFixed(0)} Mpx elevation model is over the ` +
          `${(maxPixels / 1e6).toFixed(0)} Mpx working limit. Skipped rather than resized, ` +
          `because resampling across nodata invents heights. Downsample it with GDAL using ` +
          `nearest neighbour first, or raise --max-pixels if there is memory for it.`,
      );
      continue;
    }
    const { rgba, width, height, min, max } = await elevationToRgba(file, geo);
    console.log(`  ${basename(file)}: elevation ${width}x${height}, ${min.toFixed(1)} to ${max.toFixed(1)} m`);
    await tileRaster({
      key, title: friendlyTitle(basename(file).replace(/\.[^.]+$/, "")), rgba, width, height, geo,
      extra: { elevation: { min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) } },
    });
  } else {
    // Resizing on the way in is nearly free, because libvips streams it, and it
    // bounds the peak instead of hoping. The trade is recorded in the manifest
    // rather than hidden: past this size, native resolution tiles have to come
    // from gdal2tiles or QGIS on the desktop, which is what context.md 8j
    // prescribes for production anyway.
    const sourcePixels = info.meta.width * info.meta.height;
    let pipeline = sharp(file, { limitInputPixels: false });
    const oversized = sourcePixels > maxPixels;

    if (oversized) {
      const scale = Math.sqrt(maxPixels / sourcePixels);
      pipeline = pipeline.resize({ width: Math.round(info.meta.width * scale), fit: "inside" });
      console.warn(
        `  ! ${basename(file)}: ${(sourcePixels / 1e6).toFixed(0)} Mpx is over the ` +
          `${(maxPixels / 1e6).toFixed(0)} Mpx working limit, resizing to fit. Native ` +
          `resolution needs gdal2tiles or QGIS, or --max-pixels if there is memory for it.`,
      );
    }

    const { data, info: raw } = await pipeline
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    console.log(
      `  ${basename(file)}: imagery ${raw.width}x${raw.height}` +
        (oversized ? ` (from ${info.meta.width}x${info.meta.height})` : ""),
    );

    /**
     * Make the flat filler around the footprint transparent.
     *
     * A survey footprint is an irregular polygon inside a rectangular file, and
     * the processing software fills the difference with a flat colour. JPEG and
     * ECW carry no alpha, so ensureAlpha above has just marked all of that opaque,
     * and the portal would draw a white slab over the basemap around the survey.
     * Aektanagar's orthomosaic is 25.8% pure white for exactly this reason.
     *
     * Only filler connected to the image border is cleared, so a white roof in
     * the middle of the site survives. If the imagery reaches its own edges, or
     * the corners are not flat, nothing is done: a cosmetic slab is a much smaller
     * problem than holes punched through real imagery.
     */
    let masked = null;
    if (!info.meta.hasAlpha && !noMask) {
      masked = maskBorderBackground(data, raw.width, raw.height, { tolerance: maskTolerance });
      if (masked) {
        console.log(
          `    background rgb(${masked.background.join(",")}) cleared from the border, ` +
            `${(masked.share * 100).toFixed(1)}% of the image`,
        );
      } else {
        console.log(`    no flat border background detected, imagery left as it is`);
      }
    }
    await tileRaster({
      key, title: friendlyTitle(basename(file).replace(/\.[^.]+$/, "")),
      rgba: data, width: raw.width, height: raw.height,
      geo: oversized
        ? { ...geo, world: scaleWorld(geo.world, info.meta.width, info.meta.height, raw.width, raw.height) }
        : geo,
      extra: {
        ...(oversized ? { downsampledFrom: [info.meta.width, info.meta.height] } : {}),
        ...(masked
          ? { backgroundCleared: { rgb: masked.background, share: Number(masked.share.toFixed(4)) } }
          : {}),
      },
    });
  }
}

/* ---------------------------------------------------------------- vectors --- */

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
      if (sq > maxSq) { maxSq = sq; index = i; }
    }
    if (maxSq > sqTol && index) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

for (const shp of shapefiles) {
  const stem = shp.replace(/\.shp$/i, "");
  if (!existsSync(stem + ".dbf") || !existsSync(stem + ".prj")) {
    console.warn(`  ! ${basename(shp)}: needs its .dbf and .prj alongside. Skipped.`);
    continue;
  }
  const proj = readProjection(stem + ".prj");
  const geometry = readShpPolylines(shp);
  const { fields, rows } = readDbf(stem + ".dbf");

  const elevField =
    fields.find((f) => /^(elev|elevation|contour|height|z|level)$/i.test(f.name))?.name ??
    fields.find((f) => f.type === "N" || f.type === "F")?.name;

  const heightOf = (row) => {
    if (!elevField) return null;
    const direct = row?.[elevField];
    if (Number.isFinite(direct)) return direct;
    const match = /-?\d+(?:\.\d+)?/.exec(String(row?.[`${elevField}__raw`] ?? ""));
    return match ? Number(match[0]) : null;
  };

  const features = [];
  let before = 0;
  let after = 0;
  for (let i = 0; i < geometry.length; i += 1) {
    const lines = geometry[i];
    if (!lines) continue;
    const elevation = heightOf(rows[i]);
    for (const line of lines) {
      before += line.length;
      const thinned = simplify(line, 0.15);
      if (thinned.length < 2) continue;
      after += thinned.length;
      features.push({
        type: "Feature",
        properties: { elevation },
        geometry: {
          type: "LineString",
          coordinates: thinned.map(([e, n]) => {
            const [lon, lat] = utmToLonLat(e, n, proj.zone, proj.northern);
            return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
          }),
        },
      });
    }
  }

  const key = basename(stem).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const file = `${key}.geojson`;
  writeFileSync(join(outDir, file), JSON.stringify({ type: "FeatureCollection", features }));
  const bytes = statSync(join(outDir, file)).size;

  const elevations = features.map((f) => f.properties.elevation).filter(Number.isFinite);
  touched.add(key);
  upsertLayer(manifest, {
    key,
    kind: "vector",
    title: friendlyTitle(basename(stem)),
    file,
    featureCount: features.length,
    ...(elevations.length
      ? { elevation: { min: Math.min(...elevations), max: Math.max(...elevations) } }
      : {}),
  });
  report.push({ layer: basename(stem), features: features.length, bytes });
  console.log(
    `  ${basename(shp)}: ${features.length} lines, ${before} points thinned to ${after}, ` +
      `${(bytes / 1024).toFixed(0)} KB`,
  );
}

/* ----------------------------------------------------------------- write --- */

const preserved = [...layersBefore].filter((k) => !touched.has(k));
sortLayers(manifest);
writeManifest(outDir, manifest);
if (preserved.length) {
  console.log(`\nkept ${preserved.length} layer(s) this run did not touch: ${preserved.join(", ")}`);
}

const problems = verify(outDir, manifest);
if (problems.length) {
  console.error(`\nthe manifest does not match what is on disk:`);
  for (const pr of problems) console.error(`  ! ${pr}`);
  process.exit(1);
}

const totalBytes = report.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
console.log(`
done. ${manifest.layers.length} layer(s) in ${outDir}
total ${(totalBytes / 1024 / 1024).toFixed(2)} MB

A viewer only ever downloads the tiles covering its screen, roughly 70 KB,
whatever the total above says.

Next: copy this folder to portal-data/map/${siteSlug}/ in the site repo, or
upload it to the bucket once storage is wired up.
`);
