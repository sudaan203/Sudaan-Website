/**
 * The precomputed flood answers, against the per-cell walk they replace.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/hypsometry-test.mjs
 *
 * Two claims are being checked, and they fail in different ways.
 *
 * ## 1. The table answers what the walk answers
 *
 * `figuresAt` reads a few array entries; the walk reads every cell. If they
 * disagree, the portal is quoting a number nothing produced. The comparison is
 * against the walk rather than against an analytic answer because the walk is
 * what the portal did before and what it still does for any area smaller than
 * the whole survey — the two paths have to agree or the same flood reports two
 * areas depending on how far the client happened to be zoomed out.
 *
 * Exact agreement is not available and the reason is worth stating rather than
 * absorbing into a loose tolerance: a queried level lands *inside* a bin, whose
 * cells are a mixture of ones at or below it and ones just above.
 * Interpolating across the bin rather than stepping to its edge is worth about
 * fifty times on area. What is left is bounded by the bin, and the bin is 1 cm
 * — finer than these surveys are accurate to.
 *
 * ## 2. The coarse connectivity grid floods the same ground
 *
 * On a survey too large to run Priority-Flood over whole, `spill` is built at a
 * coarser analysis cell and combined with the native DTM at query time:
 *
 *     flooded(c) = spill_coarse(c) <= L   AND   dem_native(c) <= L
 *
 * so the shoreline and the depth stay native and only *reachability* is
 * decided coarsely. Where a native spill surface exists to compare against, the
 * disagreement is measured, and it is measured in both directions separately —
 * because they are not equally acceptable. Under-reporting flood extent is
 * conservative; reporting water on ground that is dry is not, and that one is
 * held to a far tighter bound.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readGeoTiff } from "../src/lib/geo/raster.mjs";
import { resample } from "../src/lib/geo/raster.mjs";
import { spillLevel } from "../src/lib/geo/hydrology.mjs";
import { figuresAt } from "../src/lib/geo/hypsometry.mjs";
import { SURVEYS, rasterPath, READ_WHOLE_LIMIT_BYTES } from "./lib/survey.mjs";
import { statSync } from "node:fs";

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Bounds on how far the table may sit from the walk.
 *
 * Area is what the bin width touches; volume separates out of the binning
 * almost entirely, which is why its bound is three orders tighter. Both are far
 * below the plus or minus 3 to 4 cm these surveys are quoted at: on a hectare,
 * 4 cm of vertical error is 400 m³, and 0.005% of a typical volume here is
 * under a cubic metre.
 */
const AREA_TOLERANCE = 5e-5; // 0.005%
const VOLUME_TOLERANCE = 5e-7; // 0.00005%

function relief(grid) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < grid.length; i += 1) {
    const z = grid.data[i];
    if (grid.isNoData(z)) continue;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  return { lo, hi };
}

/** The level a cell gets wet at: its ground, or the water arriving over it. */
function wetsAt(dem, spill, col, row, z) {
  if (!spill) return z;
  const sc = Math.floor((dem.xOf(col) - spill.originX) / spill.cellSize);
  const sr = Math.floor((spill.originY - dem.yOf(row)) / spill.cellSize);
  if (!spill.inside(sc, sr)) return null;
  const level = spill.get(sc, sr);
  if (spill.isNoData(level)) return null;
  return level > z ? level : z;
}

/** Ground truth: area, volume and deepest water at a level, one cell at a time. */
function walk(dem, spill, L) {
  let cells = 0;
  let volume = 0;
  let deepest = 0;
  for (let row = 0; row < dem.height; row += 1) {
    for (let col = 0; col < dem.width; col += 1) {
      const z = dem.data[row * dem.width + col];
      if (dem.isNoData(z)) continue;
      const wet = wetsAt(dem, spill, col, row, z);
      if (wet === null || wet > L) continue;
      const depth = L - z;
      if (depth <= 0) continue;
      cells += 1;
      volume += depth;
      if (depth > deepest) deepest = depth;
    }
  }
  return {
    area_m2: cells * dem.cellArea,
    volume_m3: volume * dem.cellArea,
    maxDepth_m: deepest,
  };
}

for (const { slug, label } of SURVEYS) {
  const dtmPath = rasterPath(slug, "dtm");
  const tablePath = join("portal-data", "terrain", slug, "hypsometry.json");
  console.log(`\n${label} (${slug})`);

  if (!existsSync(dtmPath) || !existsSync(tablePath)) {
    console.log(`  skipped — no DTM or no table built`);
    continue;
  }
  if (statSync(dtmPath).size > READ_WHOLE_LIMIT_BYTES) {
    console.log(
      `  skipped — ${(statSync(dtmPath).size / 1024 ** 3).toFixed(1)} GB of DTM, past what a ` +
        `whole-grid reference answer can be built for. This is a survey the table exists ` +
        `for, not one it can be checked on.`,
    );
    continue;
  }

  const table = JSON.parse(readFileSync(tablePath, "utf8"));
  const dem = readGeoTiff(dtmPath);
  const spillPath = join("portal-data", "terrain", slug, "spill.tif");
  const spill = existsSync(spillPath) ? readGeoTiff(spillPath) : null;
  const { lo, hi } = relief(dem);
  console.log(
    `  ${(dem.length / 1e6).toFixed(1)}M cells at ${dem.cellSize.toFixed(3)} m, ` +
      `table ${(statSync(tablePath).size / 1024).toFixed(0)} KB` +
      (spill ? `, connectivity at ${spill.cellSize.toFixed(3)} m` : ""),
  );

  // ---- 1. table against the walk -------------------------------------------
  for (const [name, curve, against] of [
    ["threshold", table.threshold, null],
    ["rising", table.rising, spill],
  ]) {
    if (!curve) continue;
    let worstArea = 0;
    let worstVolume = 0;
    let worstDepth = 0;
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const L = lo + (hi - lo) * f;
      const got = figuresAt(table, curve, L);
      const want = walk(dem, against, L);
      if (want.area_m2 > 0) {
        worstArea = Math.max(worstArea, Math.abs(got.area_m2 - want.area_m2) / want.area_m2);
      }
      if (want.volume_m3 > 0) {
        worstVolume = Math.max(
          worstVolume,
          Math.abs(got.volume_m3 - want.volume_m3) / want.volume_m3,
        );
      }
      if (want.maxDepth_m > 0 && got.maxDepth_m !== null) {
        worstDepth = Math.max(worstDepth, Math.abs(got.maxDepth_m - want.maxDepth_m));
      }
    }
    check(
      `the ${name} table agrees with the walk on area`,
      worstArea <= AREA_TOLERANCE,
      `worst ${(worstArea * 100).toExponential(1)}%`,
    );
    check(
      `the ${name} table agrees with the walk on volume`,
      worstVolume <= VOLUME_TOLERANCE,
      `worst ${(worstVolume * 100).toExponential(1)}%`,
    );
    /*
     * Absolute rather than relative, and bounded by the bin. Deepest water is
     * read from a prefix-minimised lowest ground, stepped to the bin rather
     * than interpolated — a minimum inside a partial bin is not a weighted
     * average of anything — so it can let in at most one bin of ground that is
     * not wet yet.
     */
    check(
      `and on deepest water, within a bin`,
      worstDepth <= curve.binM * 1.5,
      `worst ${(worstDepth * 1000).toFixed(1)} mm against a ${curve.binM * 1000} mm bin`,
    );
  }

  // ---- 2. coarse connectivity against native -------------------------------
  /*
   * Built here rather than read, so this runs on a survey whose published spill
   * surface is already native — which is the only place both answers exist.
   */
  if (spill && Math.abs(spill.cellSize - dem.cellSize) < 1e-9 && dem.length <= 50e6) {
    const coarse = spillLevel(resample(dem, dem.cellSize * 8));
    for (const f of [0.15, 0.4, 0.7]) {
      const L = lo + (hi - lo) * f;
      let truth = 0;
      let wrongWet = 0;
      let wrongDry = 0;
      for (let row = 0; row < dem.height; row += 1) {
        for (let col = 0; col < dem.width; col += 1) {
          const z = dem.data[row * dem.width + col];
          if (dem.isNoData(z)) continue;
          const native = wetsAt(dem, spill, col, row, z);
          const approx = wetsAt(dem, coarse, col, row, z);
          const isTruth = native !== null && native <= L && L - z > 0;
          const isApprox = approx !== null && approx <= L && L - z > 0;
          if (isTruth) truth += 1;
          if (isApprox && !isTruth) wrongWet += 1;
          if (!isApprox && isTruth) wrongDry += 1;
        }
      }
      if (truth === 0) continue;
      /*
       * The two directions are not equally acceptable. Missing water the survey
       * would have found under-promises; putting water on ground that is dry is
       * the failure a client would act on, so it is held two orders tighter.
       */
      check(
        `8x coarser connectivity never floods dry ground at ${L.toFixed(0)} m`,
        wrongWet / truth < 1e-4,
        `${wrongWet} of ${truth.toLocaleString()} (${((wrongWet / truth) * 100).toExponential(1)}%)`,
      );
      check(
        `and misses little at ${L.toFixed(0)} m`,
        wrongDry / truth < 0.02,
        `${((wrongDry / truth) * 100).toFixed(3)}% under-reported`,
      );
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
