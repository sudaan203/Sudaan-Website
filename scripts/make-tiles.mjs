/**
 * Cuts a georeferenced raster into web mercator XYZ tiles.
 *
 * This is the fallback tiler, and it exists to prove the numbers and to unblock
 * a machine with no GDAL. The intended production path is different: Sudaan
 * already runs desktop GIS to produce these deliverables, and QGIS ships
 * "Generate XYZ tiles" while GDAL ships gdal2tiles, both of which are faster,
 * battle tested and handle formats this cannot read. See context.md 8j.
 *
 * What it does that a plain resize cannot: reprojects. The source sits on a UTM
 * grid in metres, web tiles are on a spherical mercator grid, and the two do not
 * line up. Every output pixel is mapped back through mercator to lon/lat to UTM
 * to a source pixel, so the imagery lands where the ground actually is.
 *
 * Usage:
 *   node scripts/make-tiles.mjs <site-slug> <layer-key> [maxZoom]
 */

import sharp from "sharp";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TILE = 256;

/* ---------------------------------------------------------- projections --- */

const R = 6378137.0;

/** WGS84 lon/lat to spherical mercator metres, the CRS web tiles are cut on. */
function lonLatToMercator(lon, lat) {
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

function mercatorToLonLat(x, y) {
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** Forward UTM, the direction prepare-map-data.mjs does not need. */
function lonLatToUtm(lon, lat, zone, northern = true) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);

  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;

  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lambda - lambda0);

  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));

  const easting =
    k0 * n * (A + ((1 - t + c) * A ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * A ** 5) / 120) +
    500000;

  let northing =
    k0 *
    (m +
      n *
        Math.tan(phi) *
        ((A * A) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * A ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * A ** 6) / 720));
  if (!northern) northing += 10000000;

  return [easting, northing];
}

/* ---------------------------------------------------------------- tiles --- */

const MERCATOR_EXTENT = 20037508.342789244;

function tileBounds(z, x, y) {
  const size = (2 * MERCATOR_EXTENT) / 2 ** z;
  return {
    west: -MERCATOR_EXTENT + x * size,
    east: -MERCATOR_EXTENT + (x + 1) * size,
    north: MERCATOR_EXTENT - y * size,
    south: MERCATOR_EXTENT - (y + 1) * size,
  };
}

function tileRange(z, bbox) {
  const size = (2 * MERCATOR_EXTENT) / 2 ** z;
  return {
    minX: Math.floor((bbox.west + MERCATOR_EXTENT) / size),
    maxX: Math.floor((bbox.east + MERCATOR_EXTENT) / size),
    minY: Math.floor((MERCATOR_EXTENT - bbox.north) / size),
    maxY: Math.floor((MERCATOR_EXTENT - bbox.south) / size),
  };
}

/* ------------------------------------------------------------------ run --- */

const site = process.argv[2] ?? "kotba-survey";
const layerKey = process.argv[3] ?? "dsm";
const maxZoom = Number(process.argv[4] ?? 20);

const layerDir = join(root, "portal-data", "map", site);
const manifest = JSON.parse(readFileSync(join(layerDir, "manifest.json"), "utf8"));
const layer = manifest.layers.find((l) => l.key === layerKey);
if (!layer || layer.kind !== "raster") {
  console.error(`no raster layer "${layerKey}" in ${site}`);
  process.exit(1);
}

const source = join(layerDir, layer.file);
if (!existsSync(source)) {
  console.error(`missing ${source}`);
  process.exit(1);
}

// Corner order from the manifest: top left, top right, bottom right, bottom left.
const [tl, , br] = layer.coordinates;
const bboxLonLat = { west: tl[0], north: tl[1], east: br[0], south: br[1] };
const [wx, ny] = lonLatToMercator(bboxLonLat.west, bboxLonLat.north);
const [ex, sy] = lonLatToMercator(bboxLonLat.east, bboxLonLat.south);
const bbox = { west: wx, north: ny, east: ex, south: sy };

const image = sharp(source, { limitInputPixels: false });
const meta = await image.metadata();
const { data: src, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
console.log(`source ${meta.width}x${meta.height}, ${info.channels} channels`);

// The source pixel grid is linear in UTM, so we need its UTM extent back.
const zoneMatch = /UTM_zone_(\d+)([NS])/i.exec(
  readFileSync(join(root, "DSM", "Kotba_DEM.prj"), "utf8"),
);
const zone = Number(zoneMatch?.[1] ?? 43);
const northern = (zoneMatch?.[2] ?? "N").toUpperCase() === "N";
const [utmW, utmN] = lonLatToUtm(bboxLonLat.west, bboxLonLat.north, zone, northern);
const [utmE, utmS] = lonLatToUtm(bboxLonLat.east, bboxLonLat.south, zone, northern);

const outRoot = join(layerDir, "tiles", layerKey);
mkdirSync(outRoot, { recursive: true });

let written = 0;
let skipped = 0;
let bytes = 0;

for (let z = Math.max(0, maxZoom - 6); z <= maxZoom; z += 1) {
  const range = tileRange(z, bbox);
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      const tb = tileBounds(z, x, y);
      const out = Buffer.alloc(TILE * TILE * 4); // transparent
      let painted = 0;

      for (let py = 0; py < TILE; py += 1) {
        const my = tb.north - ((py + 0.5) / TILE) * (tb.north - tb.south);
        for (let px = 0; px < TILE; px += 1) {
          const mx = tb.west + ((px + 0.5) / TILE) * (tb.east - tb.west);
          const [lon, lat] = mercatorToLonLat(mx, my);
          const [e, n] = lonLatToUtm(lon, lat, zone, northern);

          // Linear position within the source's UTM extent.
          const u = (e - utmW) / (utmE - utmW);
          const v = (utmN - n) / (utmN - utmS);
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

          const sx = Math.min(info.width - 1, Math.floor(u * info.width));
          const sy2 = Math.min(info.height - 1, Math.floor(v * info.height));
          const si = (sy2 * info.width + sx) * info.channels;
          if (src[si + 3] === 0) continue; // source nodata stays transparent

          const di = (py * TILE + px) * 4;
          out[di] = src[si];
          out[di + 1] = src[si + 1];
          out[di + 2] = src[si + 2];
          out[di + 3] = 255;
          painted += 1;
        }
      }

      // Tiles with no data are simply not written. This is why a 110 km
      // corridor costs what its data covers rather than what its bbox spans.
      if (painted === 0) {
        skipped += 1;
        continue;
      }

      const dir = join(outRoot, String(z), String(x));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${y}.webp`);
      await sharp(out, { raw: { width: TILE, height: TILE, channels: 4 } })
        .webp({ quality: 80, alphaQuality: 90 })
        .toFile(file);
      written += 1;
      bytes += statSync(file).size;
    }
  }
  process.stdout.write(`  z${z}: ${written} tiles so far\n`);
}

const summary = {
  layer: layerKey,
  minZoom: Math.max(0, maxZoom - 6),
  maxZoom,
  tiles: written,
  emptyTilesSkipped: skipped,
  totalBytes: bytes,
  averageTileBytes: Math.round(bytes / Math.max(1, written)),
};
writeFileSync(join(outRoot, "tiles.json"), JSON.stringify(summary, null, 2));

console.log(
  `\n${written} tiles, ${(bytes / 1024 / 1024).toFixed(2)} MB total, ` +
    `${(summary.averageTileBytes / 1024).toFixed(1)} KB average, ` +
    `${skipped} empty tiles skipped\n`,
);
