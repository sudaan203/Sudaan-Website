// Convert a single-band float GeoTIFF DEM into a web-ready, colourised +
// hill-shaded DSM image (warm on-brand palette, transparent nodata).
// Usage: node scripts/process-dem.mjs <input.tif> <output-name> [zFactor]
import sharp from "sharp";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2] || "DSM/Kotba_DEM.tif";
const outName = process.argv[3] || "kotba-dsm";
const zFactor = Number(process.argv[4] || 1.4);

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

// warm elevation ramp: pale sand -> soft orange -> burnt amber -> dark brown
const ramp = [
  [0.0, [250, 226, 192]],
  [0.35, [229, 142, 58]],
  [0.65, [180, 83, 9]],
  [1.0, [74, 42, 16]],
];
function elevColor(t) {
  for (let i = 0; i < ramp.length - 1; i++) {
    const [a, ca] = ramp[i];
    const [b, cb] = ramp[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      return [
        ca[0] + (cb[0] - ca[0]) * k,
        ca[1] + (cb[1] - ca[1]) * k,
        ca[2] + (cb[2] - ca[2]) * k,
      ];
    }
  }
  return ramp[ramp.length - 1][1];
}

const { data, info } = await sharp(input)
  .raw({ depth: "float" })
  .toBuffer({ resolveWithObject: true });
const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
const f = new Float32Array(ab);
const W = info.width;
const H = info.height;
const C = info.channels;

// elevation at (x,y), NaN if nodata
const z = new Float32Array(W * H);
const sample = [];
for (let i = 0; i < W * H; i++) {
  const v = f[i * C];
  if (isNodata(v)) {
    z[i] = NaN;
  } else {
    z[i] = v;
    if (i % 97 === 0) sample.push(v);
  }
}
sample.sort((a, b) => a - b);
const lo = sample[Math.floor(0.02 * sample.length)];
const hi = sample[Math.floor(0.98 * sample.length)];
const span = hi - lo || 1;
console.log("elevation stretch:", lo.toFixed(1), "->", hi.toFixed(1), "m");

// hillshade params (sun from NW, 45deg altitude)
const az = (315 * Math.PI) / 180;
const zen = ((90 - 45) * Math.PI) / 180;
const cosZen = Math.cos(zen);
const sinZen = Math.sin(zen);

const out = Buffer.alloc(W * H * 4);
const at = (x, y) => z[y * W + x];

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    const c = z[idx];
    const o = idx * 4;
    if (Number.isNaN(c)) {
      out[o + 3] = 0; // transparent nodata
      continue;
    }
    const t = Math.min(1, Math.max(0, (c - lo) / span));
    let [r, g, b] = elevColor(t);

    // hillshade (skip near borders / nodata neighbours)
    let hs = 1;
    if (x > 0 && x < W - 1 && y > 0 && y < H - 1) {
      const a = at(x - 1, y - 1),
        bb = at(x, y - 1),
        cc = at(x + 1, y - 1),
        d = at(x - 1, y),
        e = at(x + 1, y),
        ff = at(x - 1, y + 1),
        gg = at(x, y + 1),
        hh = at(x + 1, y + 1);
      if (
        !Number.isNaN(a) && !Number.isNaN(bb) && !Number.isNaN(cc) &&
        !Number.isNaN(d) && !Number.isNaN(e) && !Number.isNaN(ff) &&
        !Number.isNaN(gg) && !Number.isNaN(hh)
      ) {
        const dzdx = (cc + 2 * e + hh - (a + 2 * d + ff)) / (8 * cell);
        const dzdy = (ff + 2 * gg + hh - (a + 2 * bb + cc)) / (8 * cell);
        const slope = Math.atan(zFactor * Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        hs =
          cosZen * Math.cos(slope) +
          sinZen * Math.sin(slope) * Math.cos(az - aspect);
        hs = Math.max(0, hs);
      }
    }
    const shade = 0.55 + 0.6 * hs;
    out[o] = Math.min(255, r * shade);
    out[o + 1] = Math.min(255, g * shade);
    out[o + 2] = Math.min(255, b * shade);
    out[o + 3] = 255;
  }
}

const targetW = Math.min(1500, W);
await sharp(out, { raw: { width: W, height: H, channels: 4 } })
  .resize({ width: targetW })
  .webp({ quality: 82 })
  .toFile(join(outDir, `${outName}.webp`));

console.log(`wrote public/insights/${outName}.webp (${targetW}px wide)`);
