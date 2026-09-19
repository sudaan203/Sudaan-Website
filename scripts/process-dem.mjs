// Convert a single-band float GeoTIFF DEM into a web-ready, colourised +
// hill-shaded DSM image for the marketing site (transparent nodata).
// Usage: node scripts/process-dem.mjs <input.tif> <output-name>
//
// The palette and relief come from src/lib/geo/elevation-image.mjs, the same
// module the portal renders with. This used to carry its own warm sepia ramp,
// which meant the DSM advertised on the marketing pages looked nothing like the
// DSM a client then opened in the portal. Showing a prospect one picture and a
// customer another is a worse problem than either picture being imperfect.
//
// Note that the checked-in public/insights/*.webp keep the old look until this
// is re-run against the source DEM, which is not in the repository.
import sharp from "sharp";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { denseFloats, renderElevation } from "../src/lib/geo/elevation-image.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2] || "surveys/kotba/DSM/Kotba_DEM.tif";
const outName = process.argv[3] || "kotba-dsm";

// pixel size (m/px): read from the sibling .tfw world file, else fall back
const tfwPath = input.replace(/\.tiff?$/i, ".tfw");
let cell = 0.156831793;
if (existsSync(tfwPath)) {
  const px = parseFloat(readFileSync(tfwPath, "utf8").split(/\r?\n/)[0]);
  if (Number.isFinite(px) && px > 0) cell = px;
}
console.log("pixel size:", cell, "m");

const outDir = join(root, "public", "insights");
mkdirSync(outDir, { recursive: true });

const isNodata = (v) => !Number.isFinite(v) || v < -1e4 || v > 1e5;

const { data, info } = await sharp(input)
  .raw({ depth: "float" })
  .toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const all = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);

const dense = denseFloats(all, {
  pixels: W * H,
  stride: info.channels,
  isValid: (v) => !isNodata(v),
});

const rendered = renderElevation(dense, { width: W, height: H, cellSize: cell });
if (!rendered) {
  console.error("no usable elevations in this raster");
  process.exit(1);
}
console.log("elevation stretch:", rendered.lo.toFixed(1), "->", rendered.hi.toFixed(1), "m");
const out = rendered.rgba;

const targetW = Math.min(1500, W);
await sharp(out, { raw: { width: W, height: H, channels: 4 } })
  .resize({ width: targetW })
  .webp({ quality: 82 })
  .toFile(join(outDir, `${outName}.webp`));

console.log(`wrote public/insights/${outName}.webp (${targetW}px wide)`);
