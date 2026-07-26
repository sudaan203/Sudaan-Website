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
import {
  lonLatToUtm,
  lonLatToMercator,
  mercatorToLonLat,
  tileBounds,
  tileRange,
  TILE_SIZE as TILE,
} from "./lib/geo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
