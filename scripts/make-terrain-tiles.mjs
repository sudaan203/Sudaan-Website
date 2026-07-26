/**
 * Turns an elevation GeoTIFF into Terrain-RGB tiles, so the browser gets metres
 * back rather than a picture of metres.
 *
 *   node scripts/make-terrain-tiles.mjs <dem.tif> <site-slug> [--layer KEY] [--max-zoom N]
 *
 * Why this exists, and why it is not the same as the colourised tiles that
 * prepare-site.mjs already writes:
 *
 * A colourised DEM tile is a dead end. The moment elevation becomes an orange
 * pixel, the value is gone: no elevation readout, no profile along a line, no
 * hillshade the client can adjust, no volume. The reference dashboard has exactly
 * this problem, visible in docs/reference/dashboard/03-orthomaps-dtm.jpg, where
 * the nodata gaps are painted black because the styling was baked at ingest and
 * cannot be changed now.
 *
 * Terrain-RGB packs the elevation into the three channels losslessly at 0.1 m
 * resolution, using Mapbox's encoding, which MapLibre reads natively as a
 * `raster-dem` source:
 *
 *   elevation = -10000 + ((R * 65536 + G * 256 + B) * 0.1)
 *
 * From that one source the client gets hillshade, 3D terrain, and
 * `queryTerrainElevation()` for free. The same bytes serve the picture and the
 * measurement, which is the whole point.
 *
 * Nodata is written as the encoding of the survey's minimum elevation, with
 * alpha 0. There is no nodata concept in Terrain-RGB, so a hole has to decode to
 * *something*; a flat floor at the minimum is a visible, harmless artifact,
 * whereas leaving the channels at zero decodes to -10000 m and tears a crater
 * through the hillshade.
 */

import sharp from "sharp";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  isElevation,
  lonLatToUtm,
  readProjection,
  readWorldFile,
  rasterCorners,
  lonLatToMercator,
  mercatorToLonLat,
  tileBounds,
  tileRange,
  TILE_SIZE,
} from "./lib/geo.mjs";

/* --------------------------------------------------------------- options --- */

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const input = positional[0] ? resolve(positional[0]) : null;
const siteSlug = positional[1];

if (!input || !siteSlug) {
  console.error(`
Usage: node scripts/make-terrain-tiles.mjs <dem.tif> <site-slug> [options]

  --layer KEY      layer key, default "terrain"
  --out DIR        default portal-data/map/<site-slug>
  --max-zoom N     stop at this zoom instead of native resolution
`);
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`no such file: ${input}`);
  process.exit(1);
}

const layerKey = flag("layer", "terrain");
const outDir = resolve(flag("out", join("portal-data", "map", siteSlug)));
const maxZoomOverride = flag("max-zoom", null);

/* ------------------------------------------------------------- encoding --- */

/**
 * Mapbox Terrain-RGB. 0.1 m quantisation, which is an order of magnitude finer
 * than the plus or minus 3 to 4 cm this survey claims, so the encoding is not
 * what limits accuracy.
 */
function encodeElevation(metres) {
  const v = Math.round((metres + 10000) * 10);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** The inverse, used only to prove the round trip below. */
function decodeElevation(r, g, b) {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

/* ------------------------------------------------------------------ read --- */

const stem = basename(input).replace(/\.[^.]+$/, "");
const worldExts = [".tfw", ".pgw", ".wld"];
const tfw = worldExts.map((e) => join(input.replace(/\.[^.]+$/, "") + e)).find(existsSync);
const prj = existsSync(input.replace(/\.[^.]+$/, "") + ".prj")
  ? input.replace(/\.[^.]+$/, "") + ".prj"
  : null;
if (!tfw || !prj) {
  console.error(`${stem}: needs a .tfw and .prj beside it. Refusing to guess where this is.`);
  process.exit(1);
}
const world = readWorldFile(tfw);
const proj = readProjection(prj);

const meta = await sharp(input, { limitInputPixels: false }).metadata();
if (meta.channels !== 1 || meta.depth !== "float") {
  console.error(
    `${stem}: this is ${meta.channels} channel ${meta.depth}, not a single band float DEM. ` +
      `An orthomosaic fed in here would encode colour as metres.`,
  );
  process.exit(1);
}

console.log(`\n${stem}: ${meta.width}x${meta.height} float DEM`);

const { data, info } = await sharp(input, { limitInputPixels: false })
  .raw({ depth: "float" })
  .toBuffer({ resolveWithObject: true });

const width = info.width;
const height = info.height;
const pixels = width * height;
// sharp expands one band to three for a float TIFF, so step by stride.
const stride = data.byteLength / 4 / pixels;
const all = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
const at = (i) => all[i * stride];

let min = Infinity;
let max = -Infinity;
let valid = 0;
for (let i = 0; i < pixels; i += 1) {
  const v = at(i);
  if (!isElevation(v)) continue;
  valid += 1;
  if (v < min) min = v;
  if (v > max) max = v;
}
if (!Number.isFinite(min)) {
  console.error("no usable elevations in this raster");
  process.exit(1);
}
const nodataFill = encodeElevation(min);
console.log(
  `  range ${min.toFixed(2)} to ${max.toFixed(2)} m, ` +
    `${((valid / pixels) * 100).toFixed(1)}% of pixels carry data`,
);

// Prove the encoding round trips before writing 300 tiles that might not.
for (const probe of [min, max, (min + max) / 2]) {
  const [r, g, b] = encodeElevation(probe);
  const back = decodeElevation(r, g, b);
  if (Math.abs(back - probe) > 0.05) {
    console.error(`encoding round trip failed: ${probe} -> ${back}`);
    process.exit(1);
  }
}
console.log(`  encoding round trips within 5 cm at min, max and midpoint`);

/* ----------------------------------------------------------------- tiles --- */

const { coordinates } = rasterCorners(world, width, height, proj);
const [tl, , br] = coordinates;
const [wx, ny] = lonLatToMercator(tl[0], tl[1]);
const [ex, sy] = lonLatToMercator(br[0], br[1]);
const bbox = { west: wx, north: ny, east: ex, south: sy };

const [utmW, utmN] = lonLatToUtm(tl[0], tl[1], proj.zone, proj.northern);
const [utmE, utmS] = lonLatToUtm(br[0], br[1], proj.zone, proj.northern);

function nativeZoom() {
  const metresAcross = bbox.east - bbox.west;
  for (let z = 24; z >= 0; z -= 1) {
    const tileMetres = (2 * 20037508.342789244) / 2 ** z;
    if ((metresAcross / tileMetres) * TILE_SIZE <= width) return z;
  }
  return 0;
}

const maxZoom = maxZoomOverride ? Number(maxZoomOverride) : nativeZoom();
const minZoom = Math.max(0, maxZoom - 6);

const tileRoot = join(outDir, "tiles", layerKey);
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
          const [e, n] = lonLatToUtm(lon, lat, proj.zone, proj.northern);
          const u = (e - utmW) / (utmE - utmW);
          const v = (utmN - n) / (utmN - utmS);
          const di = (py * TILE_SIZE + px) * 4;

          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

          const sx = Math.min(width - 1, Math.floor(u * width));
          const sy2 = Math.min(height - 1, Math.floor(v * height));
          const value = at(sy2 * width + sx);

          if (!isElevation(value)) {
            // A hole has to decode to something. Flat floor, invisible alpha.
            out[di] = nodataFill[0];
            out[di + 1] = nodataFill[1];
            out[di + 2] = nodataFill[2];
            out[di + 3] = 0;
            continue;
          }

          const [r, g, b] = encodeElevation(value);
          out[di] = r;
          out[di + 1] = g;
          out[di + 2] = b;
          out[di + 3] = 255;
          painted += 1;
        }
      }

      /**
       * Every tile inside the bounds is written, even one that is entirely
       * nodata. This is the opposite of what prepare-site.mjs does for imagery,
       * and the difference is not an oversight.
       *
       * A DEM pyramid has to be gapless. MapLibre builds a hillshade by reading
       * a tile plus its eight neighbours, and `backfillBorder` throws
       * "dem dimension mismatch" the moment a neighbour has a different size. Our
       * layer route answers 204 for a tile that was never generated, which is
       * correct for imagery and fatal here: MapLibre decodes the empty body into
       * a zero dimension DEM and the whole hillshade dies with it.
       *
       * An all nodata tile is cheap, about 300 bytes once PNG has run over a flat
       * field, so completeness costs almost nothing.
       */
      if (painted === 0) skipped += 1;

      const dir = join(tileRoot, String(z), String(x));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${y}.png`);
      // PNG, not WebP. Terrain-RGB has to be lossless: WebP would shift channel
      // values by a few units, and one unit is 0.1 m of elevation error, which
      // would show up as noise in the hillshade and in every measurement.
      await sharp(out, { raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 } })
        .png({ compressionLevel: 9, palette: false })
        .toFile(path);
      written += 1;
      bytes += statSync(path).size;
    }
  }
}

console.log(
  `  ${written} tiles z${minZoom}-${maxZoom}, ${(bytes / 1024 / 1024).toFixed(2)} MB, ` +
    `${skipped} of them all nodata but written anyway for gapless coverage`,
);
console.log(`
Add to ${join(outDir, "manifest.json")}:

  {
    "key": "${layerKey}",
    "kind": "dem",
    "title": "Terrain (elevation data)",
    "tiles": "tiles/${layerKey}/{z}/{x}/{y}.png",
    "encoding": "mapbox",
    "minZoom": ${minZoom},
    "maxZoom": ${maxZoom},
    "bounds": [${Math.min(tl[0], br[0])}, ${Math.min(tl[1], br[1])}, ${Math.max(tl[0], br[0])}, ${Math.max(tl[1], br[1])}],
    "elevation": { "min": ${Number(min.toFixed(2))}, "max": ${Number(max.toFixed(2))} },
    "utmZone": ${proj.zone},
    "utmNorthern": ${proj.northern}
  }
`);
