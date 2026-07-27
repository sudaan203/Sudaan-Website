#!/usr/bin/env node
/**
 * Builds a site's imagery previews from that site's own rasters.
 *
 *   node scripts/make-site-previews.mjs <site-slug> --dsm a.tif --dtm b.tif [--ortho c.jpg]
 *
 * Why this exists. The Aektanagar portal was serving Kotba's DSM, DTM and contour
 * previews. Not similar files, not placeholders: byte for byte the same three
 * files, md5 identical, under a different client site's name. Someone copied the
 * folder to get a page working and the images were never replaced, so a client
 * looking at "their" terrain was looking at another survey 100 km away.
 *
 * There is nothing subtle to detect here, which is the point: the previews are
 * generated from the site's own rasters, and scripts/portal-previews-test.mjs
 * fails if any two sites ever share an image again.
 *
 * The colour ramp is the one prepare-site.mjs uses for its tiles, so a preview and
 * the map agree. The reference dashboard's DEM previews are a rainbow ramp with
 * nodata painted black; ours are warm, nodata is transparent, and relief is
 * shaded so the shape reads at a glance.
 */

import sharp from "sharp";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { maskBorderBackground } from "./lib/nodata.mjs";
import {
  isElevation,
  lonLatToUtm,
  readProjection,
  readWorldFile,
} from "./lib/geo.mjs";

/* --------------------------------------------------------------- options --- */

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const slug = positional[0];
if (!slug) {
  console.error(`
Usage: node scripts/make-site-previews.mjs <site-slug> [options]

  --dsm PATH     surface model GeoTIFF
  --dtm PATH     terrain model GeoTIFF
  --ortho PATH   orthomosaic, for the contours overlay
  --client SLUG  client folder (default demo-client)
  --width N      preview width in px (default 1600)
`);
  process.exit(1);
}

const clientSlug = flag("client", "demo-client");
const width = Number(flag("width", 1600));
const dsmPath = flag("dsm", null);
const dtmPath = flag("dtm", null);
const orthoPath = flag("ortho", null);

const mapDir = resolve("portal-data", "map", slug);
const outDir = resolve("portal-data", "files", clientSlug, slug.replace(/-survey$/, ""), "imagery");

/* ----------------------------------------------------------------- ramp --- */

// Same stops as prepare-site.mjs, so a preview and the map layer match.
const RAMP = [
  [0.0, [250, 226, 192]],
  [0.35, [229, 142, 58]],
  [0.65, [180, 83, 9]],
  [1.0, [74, 42, 16]],
];

function rampAt(t) {
  for (let i = 0; i < RAMP.length - 1; i += 1) {
    const [a, ca] = RAMP[i];
    const [b, cb] = RAMP[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      return [0, 1, 2].map((c) => Math.round(ca[c] + (cb[c] - ca[c]) * k));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/* ------------------------------------------------------ DEM to a preview --- */

/**
 * Average a float DEM down to a preview grid, keeping track of which cells had
 * any data. Averaging only valid cells matters: letting a nodata sentinel into
 * the mean drags a whole block to nonsense, which is how a preview ends up with
 * grey smears along every hole.
 */
function downsampleDem(values, w, h, stride, targetW) {
  const targetH = Math.max(1, Math.round((h / w) * targetW));
  const out = new Float32Array(targetW * targetH);
  const ok = new Uint8Array(targetW * targetH);
  const bx = w / targetW;
  const by = h / targetH;

  for (let ty = 0; ty < targetH; ty += 1) {
    const y0 = Math.floor(ty * by);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((ty + 1) * by)));
    for (let tx = 0; tx < targetW; tx += 1) {
      const x0 = Math.floor(tx * bx);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((tx + 1) * bx)));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const v = values[(y * w + x) * stride];
          if (!isElevation(v)) continue;
          sum += v;
          n += 1;
        }
      }
      const i = ty * targetW + tx;
      if (n > 0) {
        out[i] = sum / n;
        ok[i] = 1;
      }
    }
  }
  return { grid: out, ok, width: targetW, height: targetH };
}

/** Standard hillshade, 315 degrees azimuth and 45 degrees altitude. */
function hillshade(grid, ok, w, h, cellSize, zFactor = 2) {
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const shade = new Float32Array(w * h).fill(1);
  const at = (x, y) => {
    const cx = Math.min(w - 1, Math.max(0, x));
    const cy = Math.min(h - 1, Math.max(0, y));
    const i = cy * w + cx;
    return ok[i] ? grid[i] : null;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!ok[i]) continue;
      const c = grid[i];
      const v = (dx, dy) => at(x + dx, y + dy) ?? c;
      const dzdx =
        (v(1, -1) + 2 * v(1, 0) + v(1, 1) - (v(-1, -1) + 2 * v(-1, 0) + v(-1, 1))) /
        (8 * cellSize);
      const dzdy =
        (v(-1, 1) + 2 * v(0, 1) + v(1, 1) - (v(-1, -1) + 2 * v(0, -1) + v(1, -1))) /
        (8 * cellSize);
      const slope = Math.atan(zFactor * Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      let ill =
        Math.cos(Math.PI / 2 - alt) * Math.cos(slope) +
        Math.sin(Math.PI / 2 - alt) * Math.sin(slope) * Math.cos(az - aspect);
      // Keep it a shading pass, not a black and white picture.
      shade[i] = 0.55 + 0.45 * Math.max(0, Math.min(1, ill));
    }
  }
  return shade;
}

async function demPreview(path, label) {
  const meta = await sharp(path, { limitInputPixels: false }).metadata();
  if (meta.channels !== 1 || meta.depth !== "float") {
    console.warn(`  ! ${label}: ${meta.channels} channel ${meta.depth}, not a float DEM. Skipped.`);
    return null;
  }
  const { data, info } = await sharp(path, { limitInputPixels: false })
    .raw({ depth: "float" })
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const stride = data.byteLength / 4 / (w * h);
  const values = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);

  const { grid, ok, width: pw, height: ph } = downsampleDem(values, w, h, stride, width);

  // Colour across the 2nd to 98th percentile, for the reason prepare-site.mjs
  // does: one outlier otherwise flattens the whole survey to a single shade.
  const sample = [];
  for (let i = 0; i < grid.length; i += 1) if (ok[i]) sample.push(grid[i]);
  if (sample.length === 0) {
    console.warn(`  ! ${label}: no usable elevations. Skipped.`);
    return null;
  }
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.02)];
  const hi = sample[Math.floor(sample.length * 0.98)];
  const span = hi - lo || 1;

  let world = null;
  try {
    world = readWorldFile(path.replace(/\.[^.]+$/, "") + ".tfw");
  } catch { /* cell size falls back below */ }
  const cellSize = world ? Math.abs(world.pxWidth) * (w / pw) : 1;
  const shade = hillshade(grid, ok, pw, ph, cellSize);

  const rgba = Buffer.alloc(pw * ph * 4);
  for (let i = 0; i < grid.length; i += 1) {
    if (!ok[i]) continue; // stays transparent, rather than black
    const t = Math.min(1, Math.max(0, (grid[i] - lo) / span));
    const [r, g, b] = rampAt(t);
    const s = shade[i];
    rgba[i * 4] = Math.round(r * s);
    rgba[i * 4 + 1] = Math.round(g * s);
    rgba[i * 4 + 2] = Math.round(b * s);
    rgba[i * 4 + 3] = 255;
  }

  console.log(
    `  ${label}: ${pw}x${ph} from ${w}x${h}, ` +
      `${sample[0].toFixed(2)} to ${sample[sample.length - 1].toFixed(2)} m, ` +
      `${((sample.length / grid.length) * 100).toFixed(0)}% covered`,
  );
  return sharp(rgba, { raw: { width: pw, height: ph, channels: 4 } })
    .webp({ quality: 88 })
    .toBuffer();
}

/**
 * The orthomosaic at preview size, with its flat filler made transparent.
 *
 * The tiles already get this treatment in prepare-site.mjs, but the previews did
 * not, so two of the four thumbnails carried a white slab while the DSM and DTM
 * showed through to the card background. Same bug, second location: fixing it in
 * one place and not the other is how the inconsistency arose.
 */
async function orthoRgba(width) {
  const meta = await sharp(orthoPath, { limitInputPixels: false }).metadata();
  const ph = Math.max(1, Math.round((meta.height / meta.width) * width));
  const { data } = await sharp(orthoPath, { limitInputPixels: false })
    .resize({ width })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const masked = meta.hasAlpha ? null : maskBorderBackground(data, width, ph);
  return { data, width, height: ph, masked, sourceWidth: meta.width, sourceHeight: meta.height };
}

async function orthoPreview() {
  if (!orthoPath || !existsSync(orthoPath)) {
    console.warn("  ! ortho: no orthomosaic given, skipped");
    return null;
  }
  const o = await orthoRgba(width);
  console.log(
    `  ortho: ${o.width}x${o.height} from ${o.sourceWidth}x${o.sourceHeight}` +
      (o.masked ? `, background rgb(${o.masked.background.join(",")}) cleared (${(o.masked.share * 100).toFixed(0)}%)` : ""),
  );
  return sharp(o.data, { raw: { width: o.width, height: o.height, channels: 4 } })
    .webp({ quality: 86 })
    .toBuffer();
}

/* ------------------------------------------- contours over the orthomosaic --- */

async function contoursOverOrtho() {
  if (!orthoPath || !existsSync(orthoPath)) {
    console.warn("  ! contours: no orthomosaic given, skipped");
    return null;
  }
  const manifestPath = join(mapDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const vector = manifest.layers.find((l) => l.kind === "vector");
  if (!vector?.file) {
    console.warn("  ! contours: no vector layer in the manifest, skipped");
    return null;
  }
  const gj = JSON.parse(readFileSync(join(mapDir, vector.file), "utf8"));

  // The overlay has to be placed in the ORTHO's own frame, not the DEM's. The two
  // do not share a footprint here: they are about 6 m apart east and 12 m north in
  // the source world files, so using the wrong one shifts every line.
  const stem = orthoPath.replace(/\.[^.]+$/, "");
  const worldFile = [".jgw", ".tfw", ".wld", ".pgw"].map((e) => stem + e).find(existsSync);
  if (!worldFile || !existsSync(stem + ".prj")) {
    console.warn("  ! contours: the orthomosaic needs its world file and .prj, skipped");
    return null;
  }
  const world = readWorldFile(worldFile);
  const proj = readProjection(stem + ".prj");
  const meta = await sharp(orthoPath, { limitInputPixels: false }).metadata();

  const pw = width;
  const ph = Math.max(1, Math.round((meta.height / meta.width) * pw));
  const westEdge = world.originX - world.pxWidth / 2;
  const northEdge = world.originY - world.pxHeight / 2;
  const mPerPxX = (world.pxWidth * meta.width) / pw;
  const mPerPxY = (Math.abs(world.pxHeight) * meta.height) / ph;

  const interval = (() => {
    const levels = [...new Set(gj.features.map((f) => f.properties?.elevation).filter(Number.isFinite))].sort((a, b) => a - b);
    return levels.length > 1 ? Number((levels[1] - levels[0]).toFixed(3)) : 1;
  })();

  const paths = [];
  let drawn = 0;
  for (const feat of gj.features ?? []) {
    if (feat.geometry?.type !== "LineString") continue;
    const pts = [];
    for (const [lon, lat] of feat.geometry.coordinates) {
      const [e, n] = lonLatToUtm(lon, lat, proj.zone, proj.northern);
      pts.push([(e - westEdge) / mPerPxX, (northEdge - n) / mPerPxY]);
    }
    if (pts.length < 2) continue;
    const elev = feat.properties?.elevation;
    const isIndex = Number.isFinite(elev) && Math.abs(elev % (interval * 5)) < interval / 4;
    paths.push(
      `<polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" ` +
        `fill="none" stroke="${isIndex ? "#7c2d12" : "#C2410C"}" stroke-width="${isIndex ? 2.2 : 1.1}" ` +
        `stroke-opacity="${isIndex ? 0.95 : 0.75}" stroke-linejoin="round" />`,
    );
    drawn += 1;
  }

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">${paths.join("")}</svg>`,
  );

  // Composite onto the masked raster, so the contour sheet has the same
  // transparent surround as every other preview.
  const o = await orthoRgba(pw);
  const base = await sharp(o.data, { raw: { width: o.width, height: o.height, channels: 4 } })
    .png()
    .toBuffer();

  console.log(`  contours over ortho: ${pw}x${ph}, ${drawn} lines at ${interval} m`);
  return sharp(base)
    .composite([{ input: svg, top: 0, left: 0 }])
    .webp({ quality: 86 })
    .toBuffer();
}

/* ----------------------------------------------------------------- write --- */

console.log(`\n${slug} previews`);
mkdirSync(outDir, { recursive: true });

const jobs = [
  { file: "dsm.webp", make: () => (dsmPath ? demPreview(dsmPath, "dsm") : null) },
  { file: "dtm.webp", make: () => (dtmPath ? demPreview(dtmPath, "dtm") : null) },
  { file: "ortho.webp", make: orthoPreview },
  { file: "contours.webp", make: contoursOverOrtho },
];

let wrote = 0;
for (const j of jobs) {
  const buf = await j.make();
  if (!buf) continue;
  const p = join(outDir, j.file);
  writeFileSync(p, buf);
  console.log(`  wrote ${j.file}  ${(statSync(p).size / 1024).toFixed(0)} KB`);
  wrote += 1;
}
console.log(`\n${wrote} preview(s) written to ${outDir}\n`);
