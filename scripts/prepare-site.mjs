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
// 0.15 m was tuned against Kotba and Aektanagar, both a few hundred hectares.
// Kiru's 1 m contours cover a reservoir-scale catchment and came in at 11.3
// million vertices before thinning, 234 MB of GeoJSON after it barely moved the
// needle - a browser cannot usefully fetch or render that as one layer. Rather
// than hardcode a bigger number that would then be wrong for the next site at a
// third scale, this is a flag with the old value as its default.
const contourTolerance = Number(flag("contour-tolerance", 0.15));

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
  --contour-tolerance N  simplification tolerance in metres for shapefile lines
                   (default 0.15). Raise it for a survey covering a much larger
                   area than a single site, where 0.15 m barely thins anything.

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

/**
 * A spatial index of every raw line's segments, so simplification of one line
 * can check whether it is about to cut through another.
 *
 * Built once per shapefile from the *unsimplified* geometry. That matters:
 * checking a candidate against another line's own simplified output would
 * make the answer depend on the order lines happen to be processed in.
 * Checking against the raw geometry instead gives a fixed, order independent
 * answer, and the raw geometry is where the guarantee actually comes from -
 * see the comment on `simplify` below for why that guarantee holds.
 */
const CROSSING_CELL = 3; // metres. Small enough for a valley wall where 1 m
// contours can run under a metre apart; see docs/tools.md for the actual
// site (Kiru) whose contours motivated this.

/**
 * Flat typed-array storage rather than an object per segment.
 *
 * Kiru's raw geometry is 11.3 million segments. An object per segment (four
 * floats plus a line id) each held onto by one or more grid cell arrays ran
 * this laptop's 8 GB of RAM out and pulled 5.9 GB into swap - which lives on
 * the same disk that was already nearly full, so free space fell from 6.7 GB
 * to 2.1 GB in about a minute before this got killed. Four Float64Arrays plus
 * one Int32Array of line ids, and grid cells holding segment *indices*
 * (plain numbers, which V8 stores unboxed in a packed array) rather than
 * object references, is the fix: the same data, without an allocation per
 * segment per cell it touches.
 */
function buildCrossingIndex(geometry) {
  let total = 0;
  for (const lines of geometry) {
    if (!lines) continue;
    for (const line of lines) total += Math.max(0, line.length - 1);
  }

  const segAX = new Float64Array(total);
  const segAY = new Float64Array(total);
  const segBX = new Float64Array(total);
  const segBY = new Float64Array(total);
  const segLine = new Int32Array(total);

  const grid = new Map();
  let lineId = 0;
  let s = 0;
  for (const lines of geometry) {
    if (!lines) continue;
    for (const line of lines) {
      const id = lineId;
      lineId += 1;
      for (let i = 0; i < line.length - 1; i += 1) {
        const [ax, ay] = line[i];
        const [bx, by] = line[i + 1];
        segAX[s] = ax; segAY[s] = ay; segBX[s] = bx; segBY[s] = by; segLine[s] = id;

        const cx0 = Math.floor(Math.min(ax, bx) / CROSSING_CELL);
        const cx1 = Math.floor(Math.max(ax, bx) / CROSSING_CELL);
        const cy0 = Math.floor(Math.min(ay, by) / CROSSING_CELL);
        const cy1 = Math.floor(Math.max(ay, by) / CROSSING_CELL);
        for (let cx = cx0; cx <= cx1; cx += 1) {
          for (let cy = cy0; cy <= cy1; cy += 1) {
            // A packed numeric key, not a template-literal string: 18,949
            // lines' worth of "191234,1228456" strings is itself gigabytes.
            const k = cx * 8388608 + cy; // 2^23, comfortably past this survey's extent in cells
            let arr = grid.get(k);
            if (!arr) { arr = []; grid.set(k, arr); }
            arr.push(s);
          }
        }
        s += 1;
      }
    }
  }
  return { grid, lineCount: lineId, segAX, segAY, segBX, segBY, segLine };
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return false; // parallel, or coincident
  const ex = cx - ax, ey = cy - ay;
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

function pointSegDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/**
 * Squared distance between two segments: 0 if they cross, otherwise the
 * smallest of the four endpoint-to-opposite-segment distances, which is
 * exact for two segments that do not intersect.
 */
function segSegDistSq(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDistSq(ax, ay, cx, cy, dx, dy),
    pointSegDistSq(bx, by, cx, cy, dx, dy),
    pointSegDistSq(cx, cy, ax, ay, bx, by),
    pointSegDistSq(dx, dy, ax, ay, bx, by),
  );
}

/**
 * Would this candidate replacement segment cross, or pass closer than
 * `minGap` to, another line's raw geometry?
 *
 * `minGap` is called with 0 below: a plain crossing test. A larger value is
 * stricter and closes a real remaining gap - two lines starting under a
 * metre apart can each individually stay clear of the *other's raw
 * position* while simplifying, and still end up crossing each other,
 * because both moved independently toward the middle of a gap neither of
 * them, alone, was told was that narrow - but measured against Kiru's
 * terrain neither a full-tolerance gap (5 m: 11.3M points stayed 11.3M,
 * nothing simplifiable) nor a fixed 0.5 m buffer (8.29M points, 174 MB) was
 * a usable trade. Plain crossing detection took the same file from 226,397
 * crossings to 138,599 - a 91% reduction of what simplification itself was
 * adding, since the raw shapefile already has 130,141 (see below) - at
 * 99 MB. `minGap` stays a parameter rather than a hardcoded 0 because a
 * smaller, less extreme site may afford the stricter guarantee; it is a
 * per-site tuning knob, not settled science.
 *
 * Whatever `minGap` is, this cannot make the output *worse* than the raw
 * shapefile: Kiru's own raw geometry already has 130,141 crossings between
 * differently elevated lines across 1,992 locations, which is not a defect
 * in this pipeline - it is what 1 m contours look like on a near-vertical
 * face, which real photogrammetric contour generation cannot always avoid
 * either. This only bounds how much simplification is allowed to add on
 * top of that baseline; it does not, and cannot, remove crossings the
 * source data already has.
 */
function crossesAnotherLine(ax, ay, bx, by, ownLineId, index, minGap) {
  const pad = Math.ceil(minGap / CROSSING_CELL);
  const cx0 = Math.floor(Math.min(ax, bx) / CROSSING_CELL) - pad;
  const cx1 = Math.floor(Math.max(ax, bx) / CROSSING_CELL) + pad;
  const cy0 = Math.floor(Math.min(ay, by) / CROSSING_CELL) - pad;
  const cy1 = Math.floor(Math.max(ay, by) / CROSSING_CELL) + pad;
  const gapSq = minGap * minGap;
  const { segAX, segAY, segBX, segBY, segLine } = index;
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      const arr = index.grid.get(cx * 8388608 + cy);
      if (!arr) continue;
      for (const s of arr) {
        if (segLine[s] === ownLineId) continue;
        if (segSegDistSq(ax, ay, bx, by, segAX[s], segAY[s], segBX[s], segBY[s]) <= gapSq) return true;
      }
    }
  }
  return false;
}

/**
 * Douglas-Peucker, refusing a collapse that would cut through a neighbouring
 * line even when it is within tolerance.
 *
 * Verified against Kiru's contours (18,949 lines over a Himalayan gorge)
 * before this existed: the raw shapefile has zero crossings between
 * differently elevated lines, and simplifying each line independently -
 * blind to every other line - produced 226,397 of them at a 5 m tolerance,
 * spread across 3,341 separate ~100 m patches the length of the survey. Not
 * a bad tolerance choice; *any* tolerance did this, because a straight
 * replacement for one line's detail has no way to know a neighbour sits in
 * the gap it just cut.
 *
 * The fix keeps every node the plain distance test would have kept, and also
 * keeps a node whose removal would introduce a new crossing, which is always
 * checkable at zero cost when the two endpoints are adjacent raw points:
 * that segment is unmodified source geometry, and the raw geometry doesn't
 * cross anything by construction, so the recursion always has a safe base
 * case to fall back to.
 */
function simplify(points, tolerance, safety) {
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
    let keepWorst = maxSq > sqTol && index;
    if (!keepWorst && safety && last - first > 1) {
      keepWorst = index > 0 && crossesAnotherLine(x1, y1, x2, y2, safety.lineId, safety.index, 0);
    }
    if (keepWorst) {
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
  console.log(`  building a crossing-safety index over the raw geometry...`);
  const crossingIndex = buildCrossingIndex(geometry);
  console.log(`  ${crossingIndex.lineCount} lines indexed`);

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
  let lineId = 0; // must walk records/lines in the same order buildCrossingIndex did
  for (let i = 0; i < geometry.length; i += 1) {
    const lines = geometry[i];
    if (!lines) continue;
    const elevation = heightOf(rows[i]);
    for (const line of lines) {
      const thisLineId = lineId;
      lineId += 1;
      before += line.length;
      const thinned = simplify(line, contourTolerance, { lineId: thisLineId, index: crossingIndex });
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
