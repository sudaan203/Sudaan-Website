#!/usr/bin/env node
/**
 * A survey's elevation overview for the base map, at any survey size.
 *
 *   node scripts/make-overview.mjs --slug suigam-survey --kind dtm
 *
 * ## Why this exists beside make-site-previews.mjs
 *
 * That script needs two things Suigam does not have and cannot be given: a
 * `.tfw` and `.prj` beside the raster, and a file small enough for
 * `readFileSync`. Suigam's DTM is a 2.1 GB GeoTIFF carrying its own
 * georeferencing — 51,071 x 257,149 cells, thirteen billion of them — so it
 * fails both, and the failure is not the surveyor's to fix.
 *
 * This reads through the windowed reader instead, so the source may be any
 * size and may live in R2 rather than on disk, and it takes the projection from
 * the file's own tags. Kiru went the same way for the same reason: an overview
 * image for the base map, with the dynamic tiler serving real resolution on
 * demand. The overview is what makes a survey *appear*; the tiler is what makes
 * it readable.
 *
 * ## Colour is not this file's decision
 *
 * `renderElevation` from `src/lib/geo/elevation-image.mjs` owns the ramp, the
 * clip and the hillshade, and the map tiles and the dynamic tiler call the same
 * function. This file's own sepia stops are exactly the bug that module was
 * extracted to prevent — an overview and the map that replaces it when you zoom
 * were two different pictures of the same ground.
 *
 * The cell size passed to it is the **overview's**, not the source raster's.
 * Relief against the source spacing would be wrong by the decimation factor,
 * and would look entirely convincing.
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { utmToLonLat } from "../src/lib/geo/projection.mjs";
import { renderElevation } from "../src/lib/geo/elevation-image.mjs";
import { coarsenRaster } from "./lib/coarsen.mjs";
import { openTerrainSource } from "./lib/r2-raster.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg("slug");
const kind = arg("kind", "dtm");
if (!slug) {
  console.error("usage: node scripts/make-overview.mjs --slug <site-slug> [--kind dtm|dsm] [--width 2400]");
  process.exit(2);
}

/**
 * Longest side of the overview, in pixels.
 *
 * Suigam is a 21 km road corridor five times longer than it is wide, so a
 * square budget would either blur the corridor or waste most of the image on
 * empty ground. Sized by the longest side and let the other fall where the
 * aspect ratio puts it.
 */
const MAX_SIDE = Number(arg("width", "2400"));

const terrainDir = join("portal-data", "terrain", slug);
const opened = await openTerrainSource(slug, kind, { localPath: join(terrainDir, `${kind}.tif`) });
const raster = await openRaster(opened.source);

console.log(`Overview for ${slug} (${kind})`);
console.log(`  source   ${opened.from}`);
console.log(`  native   ${raster.width} x ${raster.height} = ` +
  `${((raster.width * raster.height) / 1e6).toFixed(1)}M cells at ${raster.cellSize.toFixed(4)} m`);

if (!raster.utmZone) {
  console.error(`\n  refused: EPSG ${raster.epsg ?? "unknown"} is not a UTM zone, so the ` +
    `overview cannot be placed on a lon/lat map.`);
  process.exit(1);
}

// The cell size that lands the longest side on the budget.
const cell = Math.max(
  raster.cellSize,
  (Math.max(raster.width, raster.height) * raster.cellSize) / MAX_SIDE,
);
console.log(`  overview ${cell.toFixed(3)} m cells (${(cell / raster.cellSize).toFixed(0)}x decimated)`);

const grid = await coarsenRaster(raster, cell, {
  onProgress: (done, total) =>
    process.stdout.write(`\r  reading  ${((done / total) * 100).toFixed(0)}%   `),
});
process.stdout.write("\n");

/*
 * `renderElevation` takes NaN for nodata rather than a sentinel, because a
 * sentinel like -32767 participates in the colour range and in the hillshade
 * kernel, and both go wrong quietly: the ramp stretches to an elevation nothing
 * has, and the relief invents a cliff at every survey edge.
 */
const dense = new Float32Array(grid.data.length);
for (let i = 0; i < grid.data.length; i += 1) {
  const v = grid.data[i];
  dense[i] = grid.isNoData(v) ? NaN : v;
}

const rendered = renderElevation(dense, {
  width: grid.width,
  height: grid.height,
  cellSize: cell,
});
if (!rendered) {
  console.error(`\n  refused: the ${kind.toUpperCase()} holds no usable elevations.`);
  process.exit(1);
}
console.log(`  elevation ${rendered.min.toFixed(2)} to ${rendered.max.toFixed(2)} m, ` +
  `${(rendered.coverage * 100).toFixed(1)}% of the image carries data`);

const mapDir = join("portal-data", "map", slug);
mkdirSync(mapDir, { recursive: true });
const file = `${kind}-overview.webp`;
await sharp(rendered.rgba, {
  raw: { width: rendered.width, height: rendered.height, channels: 4 },
})
  .webp({ quality: 88 })
  .toFile(join(mapDir, file));

/*
 * Four corners, not two.
 *
 * A UTM rectangle is not a lon/lat rectangle: grid convergence rotates it by up
 * to half a degree here, so a box built from two opposite corners leaves ground
 * uncovered along one diagonal and claims ground it does not have along the
 * other. MapLibre's image source takes four, and the same trap cost #48 a day.
 */
const zone = raster.utmZone;
const [x0, y0, x1, y1] = raster.bounds;
const corner = (x, y) => {
  const [lon, lat] = utmToLonLat(x, y, zone.zone, zone.northern);
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
};
const coordinates = [corner(x0, y1), corner(x1, y1), corner(x1, y0), corner(x0, y0)];

const manifestPath = join(mapDir, "manifest.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(manifestPath, "utf8")))
  : { site: slug, layers: [] };
manifest.site = slug;
manifest.generatedAt = new Date().toISOString();
manifest.layers = (manifest.layers ?? []).filter((l) => l.key !== `${kind}-overview`);
manifest.layers.push({
  key: `${kind}-overview`,
  kind: "raster",
  title: kind === "dsm" ? "Surface model (DSM), overview" : "Terrain model (DTM), overview",
  file,
  coordinates,
  elevation: { min: Number(rendered.min.toFixed(2)), max: Number(rendered.max.toFixed(2)) },
  note:
    "decimated overview for the base map; the dynamic tiler and analysis API read the native raster",
});
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");

console.log(`  wrote ${join(mapDir, file)} ` +
  `(${rendered.width} x ${rendered.height}, ${(statSync(join(mapDir, file)).size / 1024).toFixed(0)} KB)`);
console.log(`  updated ${manifestPath}`);
await raster.close?.();
