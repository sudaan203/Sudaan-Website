/**
 * Does the browser's DEM sampler read the same elevation the source GeoTIFF holds?
 *
 *   npx tsx scripts/portal-dem-test.mts
 *
 * This is the check that matters for every number the measure tool shows. Three
 * independent implementations have to agree:
 *
 *   1. make-terrain-tiles.mjs, which decided which pixel goes in which tile
 *   2. dem-sampler.ts `tileFor`, which the browser uses to find that pixel again
 *   3. the source DTM itself, read directly with sharp
 *
 * A disagreement means the readout is showing the elevation of somewhere else,
 * which would look completely plausible on screen.
 */

import sharp from "sharp";
import { existsSync } from "node:fs";
import { tileFor } from "../src/lib/portal/dem-sampler";
import { readWorldFile, readProjection, lonLatToUtm } from "./lib/geo.mjs";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok   ${name}${detail ? " — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const DEM = "Aektanagar/Aekatanagar DTM.tif";
const TILES = "portal-data/map/aektanagar-survey/tiles/terrain";
const MAX_ZOOM = 20;

if (!existsSync(DEM)) {
  console.log("source DTM not on disk, skipping (it is gitignored)");
  process.exit(0);
}

const decodeMapbox = (r: number, g: number, b: number) => -10000 + (r * 65536 + g * 256 + b) * 0.1;

/* ------------------------------------------------- read the source raster --- */

const world = readWorldFile("Aektanagar/Aekatanagar DTM.tfw");
const proj = readProjection("Aektanagar/Aekatanagar DTM.prj");
const meta = await sharp(DEM, { limitInputPixels: false }).metadata();
const { data, info } = await sharp(DEM, { limitInputPixels: false })
  .raw({ depth: "float" })
  .toBuffer({ resolveWithObject: true });
const width = info.width;
const height = info.height;
const stride = data.byteLength / 4 / (width * height);
const floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);

/** Source elevation under a lon/lat, straight from the GeoTIFF. */
function sourceElevation(lon: number, lat: number): number | null {
  const [e, n] = lonLatToUtm(lon, lat, proj.zone, proj.northern);
  const west = world.originX - world.pxWidth / 2;
  const north = world.originY - world.pxHeight / 2;
  const col = Math.floor((e - west) / world.pxWidth);
  const row = Math.floor((north - n) / -world.pxHeight);
  if (col < 0 || col >= width || row < 0 || row >= height) return null;
  const v = floats[(row * width + col) * stride];
  return v > -500 && v < 9000 ? v : null;
}

console.log(`source DTM ${width}x${height}, pixel ${world.pxWidth.toFixed(4)} m\n`);

/* ------------------------------------------------------- compare at points --- */

console.log("--- sampler tile math against the generated tiles ---");

// A grid of points across the middle of the survey, avoiding the very edges
// where a half pixel of rounding legitimately picks a neighbouring cell.
const bounds = { west: 73.65789550453509, south: 21.886861215066542, east: 73.66270658323366, north: 21.891458896671505 };
const probes: [number, number][] = [];
for (let i = 1; i <= 4; i += 1) {
  for (let j = 1; j <= 4; j += 1) {
    probes.push([
      bounds.west + ((bounds.east - bounds.west) * i) / 5,
      bounds.south + ((bounds.north - bounds.south) * j) / 5,
    ]);
  }
}

let compared = 0;
let missingTiles = 0;
let worstDelta = 0;
const deltas: number[] = [];

for (const [lon, lat] of probes) {
  const t = tileFor(lon, lat, MAX_ZOOM);
  const path = `${TILES}/${t.z}/${t.x}/${t.y}.png`;
  if (!existsSync(path)) { missingTiles += 1; continue; }

  const tile = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (t.py * tile.info.width + t.px) * tile.info.channels;
  const alpha = tile.data[i + 3];
  const fromTile = alpha === 0 ? null : decodeMapbox(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
  const fromSource = sourceElevation(lon, lat);

  if (fromTile === null || fromSource === null) continue;
  compared += 1;
  const delta = Math.abs(fromTile - fromSource);
  deltas.push(delta);
  worstDelta = Math.max(worstDelta, delta);
}

// A missing tile is correct, not a fault: 24% of this DTM is nodata and the
// generator never writes a tile that is entirely holes. The route answers 204 and
// the sampler returns null, which is the honest answer for "no ground here".
// What would be wrong is most of them missing, which would mean the sampler and
// the generator disagree about where tiles live.
check(
  "the sampler asks for tiles that were actually generated",
  missingTiles <= probes.length / 4,
  `${missingTiles} of ${probes.length} absent, expected for a DEM that is 24% nodata`,
);
check("enough points had data to be meaningful", compared >= 8, `${compared} of ${probes.length} compared`);

// One DEM cell is 7.7 cm here, and both sides use nearest neighbour, so a probe
// landing near a cell boundary can legitimately pick either neighbour. Allow one
// cell of vertical difference between adjacent cells, not one cell of position.
check(
  "tile elevations match the source GeoTIFF",
  worstDelta < 1.0,
  `worst difference ${worstDelta.toFixed(3)} m across ${compared} points, median ${deltas.sort((a, b) => a - b)[Math.floor(deltas.length / 2)]?.toFixed(3)} m`,
);
check(
  "most points agree to the encoding's own resolution",
  deltas.filter((d) => d <= 0.1).length >= Math.floor(compared * 0.6),
  `${deltas.filter((d) => d <= 0.1).length} of ${compared} within 10 cm`,
);

/* ---------------------------------------------------------- tile math edge --- */

console.log("\n--- tile math ---");
const t0 = tileFor(0, 0, 0);
check("zoom 0 puts null island in tile 0/0/0", t0.x === 0 && t0.y === 0);
const tz1 = tileFor(0.001, 0.001, 1);
check("just north east of null island is tile 1/1/0 at zoom 1", tz1.x === 1 && tz1.y === 0, `got ${tz1.x}/${tz1.y}`);
const clamped = tileFor(179.9999, 85, 2);
check("extremes stay inside the tile grid", clamped.x <= 3 && clamped.y >= 0 && clamped.px < 256 && clamped.py < 256);

const a = tileFor(bounds.west + 1e-9, bounds.north - 1e-9, MAX_ZOOM);
check("pixel offsets are inside a tile", a.px >= 0 && a.px < 256 && a.py >= 0 && a.py < 256, `px ${a.px}, py ${a.py}`);

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
