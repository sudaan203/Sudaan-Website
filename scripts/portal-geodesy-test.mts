/**
 * Measurement correctness, checked against numbers derived a different way.
 *
 *   npx tsx scripts/portal-geodesy-test.mts
 *
 * The important check is the first one. The Aektanagar DTM's world file states a
 * pixel size and the GeoTIFF states a pixel count, so the survey's ground
 * dimensions are known by arithmetic that never touches a projection. The
 * manifest separately stores the footprint's lon/lat corners, produced by the
 * pipeline's inverse projection. Measuring those corners and recovering the same
 * dimensions exercises the forward projection, the area formula and the
 * pipeline's inverse projection at once, and they can only agree if all three are
 * right.
 */

import { readFileSync } from "node:fs";
import {
  lonLatToUtm,
  pathLength,
  ringArea,
  densifyPath,
  mercatorAreaInflation,
  formatDistance,
  formatArea,
  type LonLat,
} from "../src/lib/portal/geodesy";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok   ${name}${detail ? " — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const ZONE = 43;

/* ------------------------------------------- the survey's own dimensions --- */

console.log("--- against the Aektanagar DTM's world file ---");

// From "Aekatanagar DTM.tfw" and the GeoTIFF header, no projection involved.
const PX = 0.0768684;
const W_PX = 6409;
const H_PX = 6678;
const truthWidth = PX * W_PX;
const truthHeight = PX * H_PX;
const truthArea = truthWidth * truthHeight;
console.log(`  world file says ${truthWidth.toFixed(1)} m x ${truthHeight.toFixed(1)} m = ${(truthArea / 10000).toFixed(3)} ha`);

const manifest = JSON.parse(
  readFileSync("portal-data/map/aektanagar-survey/manifest.json", "utf8"),
) as { layers: { key: string; coordinates?: LonLat[] }[] };
const dtm = manifest.layers.find((l) => l.key === "aekatanagar-dtm")!;
const corners = dtm.coordinates!;

const [tl, tr, br, bl] = corners;
const topEdge = pathLength([tl, tr], ZONE);
const leftEdge = pathLength([tl, bl], ZONE);
const area = ringArea(corners, ZONE);

check(
  "top edge matches pixel count times pixel size",
  Math.abs(topEdge - truthWidth) < 0.5,
  `${topEdge.toFixed(2)} m vs ${truthWidth.toFixed(2)} m`,
);
check(
  "left edge matches",
  Math.abs(leftEdge - truthHeight) < 0.5,
  `${leftEdge.toFixed(2)} m vs ${truthHeight.toFixed(2)} m`,
);
check(
  "footprint area matches",
  Math.abs(area - truthArea) / truthArea < 0.001,
  `${(area / 10000).toFixed(4)} ha vs ${(truthArea / 10000).toFixed(4)} ha`,
);

/* ------------------------------------------------- the trap being avoided --- */

console.log("\n--- what measuring in Web Mercator would have cost ---");

const lat = 21.889;
const inflation = mercatorAreaInflation(lat);
check(
  "Web Mercator inflates area by about 16% at this latitude",
  inflation > 1.15 && inflation < 1.18,
  `factor ${inflation.toFixed(4)}, so ${(truthArea / 10000).toFixed(2)} ha would read as ${((truthArea * inflation) / 10000).toFixed(2)} ha`,
);

// Measure the same footprint the naive way, treating Mercator metres as ground
// metres, and confirm it is wrong by that factor.
const R = 6378137;
const toMerc = (p: LonLat): [number, number] => [
  (R * p[0] * Math.PI) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (p[1] * Math.PI) / 360)),
];
const merc = corners.map(toMerc);
let s = 0;
for (let i = 0; i < merc.length; i += 1) {
  const a = merc[i];
  const b = merc[(i + 1) % merc.length];
  s += a[0] * b[1] - b[0] * a[1];
}
const mercArea = Math.abs(s) / 2;
check(
  "the naive Mercator area is wrong by exactly that factor",
  Math.abs(mercArea / area - inflation) < 0.01,
  `${(mercArea / 10000).toFixed(2)} ha instead of ${(area / 10000).toFixed(2)} ha`,
);

/* ----------------------------------------------------- projection sanity --- */

console.log("\n--- projection sanity ---");

// The DTM world file's origin, straight from the .tfw, must project back to the
// manifest's top left corner.
const [e0, n0] = lonLatToUtm(tl[0], tl[1], ZONE);
check(
  "top left corner projects back to the world file's easting",
  Math.abs(e0 - (361352.489 - PX / 2)) < 0.5,
  `${e0.toFixed(2)} vs ${(361352.489 - PX / 2).toFixed(2)}`,
);
check(
  "and its northing",
  Math.abs(n0 - (2421418.548 + PX / 2)) < 0.5,
  `${n0.toFixed(2)} vs ${(2421418.548 + PX / 2).toFixed(2)}`,
);

check(
  "a degenerate path measures zero",
  pathLength([tl], ZONE) === 0 && pathLength([], ZONE) === 0,
);
check("a degenerate ring has no area", ringArea([tl, tr], ZONE) === 0);

/* ------------------------------------------------------------- densify --- */

console.log("\n--- profile sampling ---");

const samples = densifyPath([tl, br], 5, ZONE);
const diag = pathLength([tl, br], ZONE);
check("samples span the whole path", samples.length > 2 && Math.abs(samples[samples.length - 1].distance - diag) < 0.01,
  `${samples.length} samples over ${formatDistance(diag)}`);
check("sample distances increase monotonically",
  samples.every((s2, i) => i === 0 || s2.distance >= samples[i - 1].distance));
check("spacing is close to what was asked for",
  Math.abs(samples[1].distance - samples[0].distance - 5) < 1.5,
  `${(samples[1].distance - samples[0].distance).toFixed(2)} m apart`);
check("sampling is capped so a long line cannot ask for thousands of points",
  densifyPath([tl, br], 0.001, ZONE).length <= 512);

/* ------------------------------------------------------------ formatting --- */

console.log("\n--- formatting ---");
check("distances read sensibly", formatDistance(0.5) === "50 cm" && formatDistance(12.345) === "12.35 m" && formatDistance(2500) === "2.500 km",
  `${formatDistance(0.5)}, ${formatDistance(12.345)}, ${formatDistance(2500)}`);
check("areas switch to hectares then km²", formatArea(500) === "500.0 m²" && formatArea(25288).endsWith("ha") && formatArea(2e6).endsWith("km²"),
  `${formatArea(500)}, ${formatArea(25288)}, ${formatArea(2e6)}`);

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
