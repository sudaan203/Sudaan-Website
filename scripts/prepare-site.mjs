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

if (!inputDir || !siteSlug) {
  console.error(`
Usage: node scripts/prepare-site.mjs <input-folder> <site-slug> [options]

  --out DIR        where to write (default portal-data/map/<site-slug>)
  --quality N      WebP quality 1-100 (default 80)
  --max-zoom N     stop at this zoom instead of native resolution

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
const entries = readdirSync(inputDir).map((f) => join(inputDir, f));

const rasterFiles = entries.filter((f) =>
  [".tif", ".tiff", ".png", ".jpg", ".jpeg"].includes(extname(f).toLowerCase()),
);
const shapefiles = entries.filter((f) => extname(f).toLowerCase() === ".shp");

if (rasterFiles.length === 0 && shapefiles.length === 0) {
  console.error("nothing to do: no .tif/.png/.jpg rasters and no .shp files here");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const manifest = { site: siteSlug, generatedAt: new Date().toISOString(), layers: [] };
const report = [];

/* --------------------------------------------------------------- rasters --- */

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

/** Colourised RGBA for an elevation model, plus its true range. */
async function elevationToRgba(file, meta) {
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

  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const v = at(i);
    if (!isElevation(v)) continue;
    const [r, g, b] = elevColor(Math.min(1, Math.max(0, (v - lo) / span)));
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, width: info.width, height: info.height, min, max, lo, hi };
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

  manifest.layers.push({
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
    const { rgba, width, height, min, max } = await elevationToRgba(file, info.meta);
    console.log(`  ${basename(file)}: elevation ${width}x${height}, ${min.toFixed(1)} to ${max.toFixed(1)} m`);
    await tileRaster({
      key, title: basename(file).replace(/\.[^.]+$/, ""), rgba, width, height, geo,
      extra: { elevation: { min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) } },
    });
  } else {
    const { data, info: raw } = await sharp(file, { limitInputPixels: false })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    console.log(`  ${basename(file)}: imagery ${raw.width}x${raw.height}`);
    await tileRaster({
      key, title: basename(file).replace(/\.[^.]+$/, ""),
      rgba: data, width: raw.width, height: raw.height, geo, extra: {},
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
  manifest.layers.push({
    key,
    kind: "vector",
    title: basename(stem),
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

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

const totalBytes = report.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
console.log(`
done. ${manifest.layers.length} layer(s) in ${outDir}
total ${(totalBytes / 1024 / 1024).toFixed(2)} MB

A viewer only ever downloads the tiles covering its screen, roughly 70 KB,
whatever the total above says.

Next: copy this folder to portal-data/map/${siteSlug}/ in the site repo, or
upload it to the bucket once storage is wired up.
`);
