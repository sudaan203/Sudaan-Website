/**
 * The two identities the unlimited tools rest on.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/reduction-test.mjs
 *
 * Both replace a refusal with an answer, and in both cases the answer is only
 * worth having if it is the *same* answer the refused path would have given.
 * So this suite does not check that the new paths are reasonable. It checks
 * that they agree with the implementations they are replacing, on real terrain.
 *
 * ## 1. The spill surface, against a connected flood
 *
 * `fillDepressions` is Priority-Flood seeded from the survey's boundary and its
 * nodata edges, so its `trueLevel` surface is the minimax elevation from
 * outside the survey to each cell: the lowest "highest ground you must cross"
 * over every path in. Which gives
 *
 *     water rising from outside at level L covers exactly { c : spill[c] <= L }
 *
 * and turns a whole-survey flood from a per-level traversal of hundreds of
 * millions of cells into a comparison against a raster built once. The claim is
 * cell-for-cell equality with `connectedFlood` seeded from the same boundary,
 * at levels spanning the survey's relief — not "close", not "the same area".
 *
 * ## 2. Tiled reduction, against the whole-grid answer
 *
 * Cut and fill and polygon statistics are reductions, so they compose over a
 * partition, so a polygon larger than memory can be measured by walking it in
 * tiles and carrying the accumulator. The claim is that this returns what the
 * whole-grid call returns.
 *
 * **Why the tolerance is not zero, and what it is tied to.** A windowed read
 * hands back a grid whose origin is the window's own corner, and
 * `(originY - row0*cs) - localRow*cs` is not bit-identical to
 * `originY - (row0+localRow)*cs`. Measured on Kotba the disagreement is 4.7e-10
 * m — two parts in a billion of a cell. That is enough to flip the
 * inside/outside test for a lattice corner sitting within half a nanometre of
 * the ring, which redistributes a fraction of a cell's coverage around the
 * perimeter. It is the same drift PR #79 reconciled between the windowed and
 * whole-file readers, it is inherent to windowed reads rather than to tiling,
 * and it is bounded by the perimeter rather than the area — so it does not grow
 * as more ground is measured.
 *
 * The tolerance is therefore relative and very tight — 1e-6 — with an absolute
 * floor of **one cell's area**, and the floor is the part that is actually
 * reasoned rather than picked. What the drift can do is reclassify cells that
 * sit within half a nanometre of a boundary, and what that costs is a fraction
 * of a cell's worth of coverage. So the bound on the disagreement is a small
 * multiple of one cell, not a proportion of the answer.
 *
 * That distinction matters for the quantities driven by the *nodata* boundary
 * rather than the polygon's own. Kotba's survey has ragged holes in it, so
 * `nodataArea` is a small number — under a thousand square metres — accumulated
 * along a boundary far longer than the ring, and it disagreed by 0.0036 m2:
 * four hundredths of one cell, and 3.8e-6 of the total, which a purely relative
 * bound called a failure. A cell-sized floor calls it what it is.
 *
 * It stays far too tight to hide a partitioning bug. Double-counting a single
 * tile boundary row on Kotba is 1,393 cells — eighty square metres, three
 * orders of magnitude past the floor — and the suite runs partitions down to
 * nine thousand cells a tile precisely so such a bug would have hundreds of
 * boundaries to show itself on. For scale in the other direction: these surveys
 * are quoted at plus or minus 3 to 4 cm, which over a hectare is 400 m3.
 *
 * Several partitions are run, including deliberately tiny ones, because a
 * partition that is only ever one tile proves nothing about partitioning.
 */

import { readGeoTiff } from "../src/lib/geo/raster.mjs";
import { openRaster, reduceOverPolygon } from "../src/lib/geo/raster-window.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { spillLevel, connectedFlood } from "../src/lib/geo/hydrology.mjs";
import {
  polygonStats,
  cutFill,
  newPolygonStats,
  accumulatePolygonStats,
  finalisePolygonStats,
  newCutFill,
  accumulateCutFill,
  finaliseCutFill,
  REFERENCE,
} from "../src/lib/geo/terrain-analysis.mjs";
import { SURVEYS, rasterPath, surveyPresent, READ_WHOLE_LIMIT_BYTES } from "./lib/survey.mjs";
import { statSync } from "node:fs";

/**
 * Biggest survey this suite will check, in bytes of DTM.
 *
 * Both identities are checked *against the implementation they replace*, and
 * both of those implementations need the whole grid in memory — that is the
 * entire reason the replacements exist. So the surveys this suite can check are
 * exactly the ones that did not need fixing, and the ones that did cannot be
 * checked this way by construction.
 *
 * That is not the hole it sounds like. Both claims are structural rather than
 * statistical: the spill identity is a property of Priority-Flood's pop order,
 * and the reduction identity is the associativity of addition. Neither can hold
 * on 2 million cells and fail on 500 million — what changes with size is cost,
 * not arithmetic. A survey small enough to check proves the property; a survey
 * too large to check is the one that needed it.
 *
 * 400 MB covers Kotba and Ektanagar 1 (2.2M and 42.8M cells) and leaves out
 * Ektanagar 2 and Kiru, which are 1.9 and 2.1 GB and would need tens of
 * gigabytes of resident memory to build a reference answer for.
 */
const CHECKABLE_BYTES = 400 * 1024 * 1024;

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Relative agreement, floored at one cell.
 *
 * `floor` is the survey's own cell area. See the header: the disagreement a
 * windowed read can introduce is bounded by fractions of a cell along a
 * boundary, so that — and not a proportion of the answer — is the right scale
 * to forgive at.
 */
const TOLERANCE = 1e-6;
function agrees(a, b, floor) {
  if (a === null && b === null) return true;
  if (typeof a !== "number" || typeof b !== "number") return a === b;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Object.is(a, b);
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * TOLERANCE + floor;
}

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

/** Every cell water can enter the survey from: its border, and its nodata edges. */
function boundarySeeds(dem) {
  const seeds = [];
  const { width, height } = dem;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (dem.isNoData(dem.data[row * width + col])) continue;
      let edge = row === 0 || col === 0 || row === height - 1 || col === width - 1;
      if (!edge) {
        for (let dr = -1; dr <= 1 && !edge; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const nc = col + dc;
            const nr = row + dr;
            if (nc < 0 || nr < 0 || nc >= width || nr >= height) { edge = true; break; }
            if (dem.isNoData(dem.data[nr * width + nc])) { edge = true; break; }
          }
        }
      }
      if (edge) seeds.push({ col, row });
    }
  }
  return seeds;
}

async function run(slug, label) {
  const path = rasterPath(slug, "dtm");
  console.log(`\n${label} (${slug})`);

  const bytes = statSync(path).size;
  if (bytes > Math.min(CHECKABLE_BYTES, READ_WHOLE_LIMIT_BYTES)) {
    console.log(`  skipped — ${(bytes / 1024 / 1024).toFixed(0)} MB of DTM, past what a ` +
      `whole-grid reference answer can be built for on one machine. This is the ` +
      `survey the new paths exist for, not the one they can be checked on.`);
    return;
  }

  const dem = readGeoTiff(path);
  console.log(`  ${dem.width} x ${dem.height} = ${(dem.length / 1e6).toFixed(1)}M cells ` +
    `at ${dem.cellSize.toFixed(3)} m`);

  // ---- 1. spill threshold == connected flood, cell for cell -----------------
  const spill = spillLevel(dem);
  const seeds = boundarySeeds(dem);
  const { lo, hi } = relief(dem);

  let mismatched = 0;
  for (const f of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const level = lo + (hi - lo) * f;
    const flood = connectedFlood(dem, level, seeds);
    let bad = 0;
    for (let i = 0; i < dem.length; i += 1) {
      if (dem.isNoData(dem.data[i])) continue;
      const bySpill = spill.data[i] <= level;
      const byFlood = !flood.depth.isNoData(flood.depth.data[i]);
      if (bySpill !== byFlood) bad += 1;
    }
    mismatched += bad;
    check(
      `flood at ${level.toFixed(2)} m matches the spill surface`,
      bad === 0,
      `${flood.cells.toLocaleString()} cells flooded${bad ? `, ${bad} disagree` : ""}`,
    );
  }
  check(`the spill identity holds at every level on ${label}`, mismatched === 0);

  // ---- 2. tiled reduction == whole-grid answer ------------------------------
  const raster = await openRaster(cached(await fileSource(path)));
  const [bx0, by0, bx1, by1] = raster.bounds;
  const w = bx1 - bx0;
  const h = by1 - by0;
  /*
   * Deliberately not axis-aligned and deliberately concave, so a large share of
   * the cells are partially covered. A rectangle would have whole-cell coverage
   * almost everywhere and would not exercise `cellCoverage` at all, which is
   * the part tiling could plausibly break.
   */
  const ring = [
    [bx0 + w * 0.06, by0 + h * 0.30],
    [bx0 + w * 0.47, by0 + h * 0.05],
    [bx0 + w * 0.55, by0 + h * 0.44],
    [bx0 + w * 0.94, by0 + h * 0.38],
    [bx0 + w * 0.71, by0 + h * 0.93],
    [bx0 + w * 0.19, by0 + h * 0.81],
  ];
  const reference = REFERENCE.plane((lo + hi) / 2);

  const wholeStats = polygonStats(dem, ring);
  const wholeCut = cutFill(dem, ring, reference, { rmseZ: 0.04 });

  const partitions = [8_000_000, 200_000, 50_000, 9_000];
  for (const tileCells of partitions) {
    const sAcc = newPolygonStats();
    const cAcc = newCutFill();
    const cost = await reduceOverPolygon(
      raster,
      ring,
      (grid) => {
        accumulatePolygonStats(sAcc, grid, ring);
        accumulateCutFill(cAcc, grid, ring, reference);
      },
      { tileCells },
    );
    const tiledStats = finalisePolygonStats(sAcc, ring);
    const tiledCut = finaliseCutFill(cAcc, ring, { rmseZ: 0.04, reference });

    const fields = [
      ...["area", "perimeter", "min", "max", "mean", "coveredArea", "nodataArea", "complete"]
        .map((k) => [`stats.${k}`, wholeStats[k], tiledStats[k]]),
      ...["cut", "fill", "net", "cutArea", "fillArea", "measuredArea", "maxCutDepth",
        "maxFillDepth", "meanDepth", "nodataArea", "referenceMissingArea", "complete",
        "uncertainty", "computedIn"]
        .map((k) => [`cutFill.${k}`, wholeCut[k], tiledCut[k]]),
    ];
    const off = fields.filter(([, a, b]) => !agrees(a, b, dem.cellArea));
    check(
      `${String(cost.tiles).padStart(3)} tiles agree with the whole grid`,
      off.length === 0,
      off.length
        ? off.map(([k, a, b]) => `${k} ${a} vs ${b}`).join("; ").slice(0, 160)
        : `cut ${tiledCut.cut.toFixed(1)} m3, fill ${tiledCut.fill.toFixed(1)} m3, ` +
          `${(tiledStats.area / 10000).toFixed(2)} ha`,
    );
  }

  // A polygon off the survey must cost nothing and measure nothing, rather than
  // reading tiles full of nodata and reporting a confident zero.
  const away = [
    [bx1 + w, by1 + h], [bx1 + w * 2, by1 + h], [bx1 + w * 2, by1 + h * 2], [bx1 + w, by1 + h * 2],
  ];
  const awayAcc = newPolygonStats();
  const awayCost = await reduceOverPolygon(raster, away, (g) => accumulatePolygonStats(awayAcc, g, away));
  check("a polygon off the survey reads no tiles", awayCost.tiles === 0, `${awayCost.tiles} tiles`);
  check("and measures nothing", finalisePolygonStats(awayAcc, away).mean === null);

  await raster.close();
}

console.log("Reduction and spill identities");
for (const { slug, label } of SURVEYS) {
  if (!surveyPresent(slug, "dtm")) {
    console.log(`\n${label} (${slug})\n  skipped — no DTM published locally`);
    continue;
  }
  await run(slug, label);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
