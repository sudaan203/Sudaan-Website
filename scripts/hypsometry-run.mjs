/**
 * Build a survey's **hypsometric table**: flooded area and stored volume at
 * every water level, from one pass over the ground.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/hypsometry-run.mjs --slug kotba-survey
 *
 * ## Why
 *
 * A site-wide flood is now answerable — "everything at or below this level" is
 * a per-cell predicate, so it reduces over bands and needs no simulation. But
 * *answerable* is not *usable*: the reduction reads every cell, and measured
 * through the windowed reader that is 1.6 s on Ektanagar 1, about 28 s on
 * Ektanagar 2 and 96 s on Kiru, before the network gets involved. A client
 * dragging a water-level slider cannot wait half a minute a step.
 *
 * It is also work repeated for an answer that never changes. Area and volume
 * against water level is a **one-dimensional function of the ground**, fixed
 * the moment the survey is published, and a client moving a slider is sampling
 * that one curve. So it is computed once, here.
 *
 * ## The table, and how exact it actually is
 *
 * Cells are binned by the level at which they become wet, carrying two running
 * totals per bin: how many cells, and the **sum of their ground elevation**.
 * Prefix-summed, a query is two array reads:
 *
 *     area(L)   = cellArea * N(L)
 *     volume(L) = cellArea * (L * N(L) - S(L))
 *
 * The second identity is the point. Volume is the sum of `L - dem` over the wet
 * cells, and that separates into `L` times the count minus the sum of the
 * ground — so binning the *level* does not bin the *depth*.
 *
 * It is not exact, and the difference is worth stating rather than rounding
 * away: a queried level lands *inside* a bin, whose cells are a mixture of ones
 * at or below it and ones just above. `src/lib/portal/hypsometry.ts`
 * interpolates across that bin rather than stepping to its edge, which is worth
 * about fifty times on area. Measured against the per-cell walk on Kotba over
 * nine levels: area worst 0.0018%, volume worst 0.00002% — on a 2.2 ha flood,
 * four tenths of a square metre.
 *
 * Two tables, because the portal asks two different questions:
 *
 *   threshold   binned on the ground itself — every cell at or below the level
 *   rising      binned on the spill surface — only ground water can reach from
 *               outside the survey, connectivity having been resolved once
 *
 * The rising table still carries the sum of *native* ground elevation, so its
 * volume is at the survey's own resolution even where the spill surface that
 * decided connectivity is coarser. That is the same split the tiler draws with.
 *
 * ## Cost
 *
 * One banded pass over the native DTM, so it scales with the survey and runs
 * once. The output is a few hundred kilobytes regardless: 1 cm bins over an
 * 87 m range is 8,700 bins, and each bin is a count and a sum.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { openRaster, reduceOverPolygon } from "../src/lib/geo/raster-window.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { openTerrainSource } from "./lib/r2-raster.mjs";

/**
 * Bin width in metres.
 *
 * The only quantity this touches is *area*, because volume separates out of the
 * binning entirely (see above). One centimetre is finer than any survey here is
 * accurate to — these are quoted at plus or minus 3 to 4 cm — so the binning
 * cannot be the reason two numbers disagree.
 */
const BIN_M = 0.01;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg("slug");
if (!slug) {
  console.error("usage: node scripts/hypsometry-run.mjs --slug <site-slug> [--out <file.json>]");
  process.exit(2);
}

const terrainDir = join("portal-data", "terrain", slug);
const outPath = arg("out") ?? join(terrainDir, "hypsometry.json");

console.log(`Hypsometric table for ${slug}`);

const opened = await openTerrainSource(slug, "dtm", { localPath: join(terrainDir, "dtm.tif") });
const dtm = await openRaster(opened.source);
console.log(`  source   ${opened.from}`);
console.log(`  native   ${dtm.width} x ${dtm.height} = ${((dtm.width * dtm.height) / 1e6).toFixed(1)}M cells at ${dtm.cellSize.toFixed(4)} m`);

/*
 * The spill surface, if one has been built. Sampled by world coordinate rather
 * than by cell index, because it is generally a *coarser* grid — that is the
 * whole point of the connectivity cell — and matching by index would silently
 * read the wrong ground.
 */
const spillPath = join(terrainDir, "spill.tif");
let spill = null;
if (existsSync(spillPath)) {
  spill = await openRaster(cached(await fileSource(spillPath)));
  console.log(`  spill    ${spill.width} x ${spill.height} at ${spill.cellSize.toFixed(4)} m ` +
    `(${(spill.cellSize / dtm.cellSize).toFixed(1)}x)`);
} else {
  console.log(`  spill    none built — the rising table will be skipped`);
}

/** One accumulator: counts and ground sums, binned by the level a cell gets wet at. */
function accumulator(lo, hi) {
  const bins = Math.max(1, Math.ceil((hi - lo) / BIN_M) + 1);
  return {
    lo,
    bins,
    n: new Float64Array(bins),
    s: new Float64Array(bins),
    /*
     * The lowest ground in each bin, prefix-*minimised* rather than summed.
     *
     * Deepest water is `level - the lowest wet ground`, and a minimum does not
     * decompose into per-bin totals the way area and volume do — so it needs
     * its own accumulator or it cannot be reported at all. Without it the panel
     * had nothing to put in the "Deepest" row of a site-wide run.
     */
    m: new Float64Array(bins).fill(Infinity),
  };
}

const bounds = dtm.bounds;
const ring = [
  [bounds[0], bounds[1]], [bounds[2], bounds[1]],
  [bounds[2], bounds[3]], [bounds[0], bounds[3]],
];

/*
 * Range first, in the same banded pass shape as the accumulation, because the
 * bin array has to be sized before anything can be counted into it and the
 * TIFF's own tags do not carry a reliable min and max.
 */
console.log(`\n  ranging…`);
let lo = Infinity;
let hi = -Infinity;
let sLo = Infinity;
let sHi = -Infinity;
await reduceOverPolygon(dtm, ring, async (band, window) => {
  for (let i = 0; i < band.data.length; i += 1) {
    const z = band.data[i];
    if (band.isNoData(z)) continue;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  if (!spill) return;
  const sBand = await spillBandFor(band, window);
  if (!sBand) return;
  for (let i = 0; i < sBand.data.length; i += 1) {
    const v = sBand.data[i];
    if (sBand.isNoData(v)) continue;
    if (v < sLo) sLo = v;
    if (v > sHi) sHi = v;
  }
});

/** The part of the spill surface covering one native band, in its own geometry. */
async function spillBandFor(band, window) {
  const minX = dtm.originX + window.col0 * dtm.cellSize;
  const maxX = minX + window.cols * dtm.cellSize;
  const maxY = dtm.originY - window.row0 * dtm.cellSize;
  const minY = maxY - window.rows * dtm.cellSize;
  const w = spill.windowFor([minX, minY, maxX, maxY]);
  return w ? spill.readWindow(w) : null;
}

console.log(`  ground   ${lo.toFixed(2)} to ${hi.toFixed(2)} m`);
if (spill) console.log(`  levels   ${sLo.toFixed(2)} to ${sHi.toFixed(2)} m`);

const threshold = accumulator(lo, hi);
const rising = spill ? accumulator(sLo, sHi) : null;

console.log(`\n  counting…`);
const started = Date.now();
let surveyed = 0;
const cost = await reduceOverPolygon(dtm, ring, async (band, window) => {
  const sBand = spill ? await spillBandFor(band, window) : null;
  for (let row = 0; row < band.height; row += 1) {
    for (let col = 0; col < band.width; col += 1) {
      const z = band.data[row * band.width + col];
      if (band.isNoData(z)) continue;
      surveyed += 1;

      const tb = Math.min(threshold.bins - 1, Math.max(0, Math.floor((z - threshold.lo) / BIN_M)));
      threshold.n[tb] += 1;
      threshold.s[tb] += z;
      if (z < threshold.m[tb]) threshold.m[tb] = z;

      if (!rising || !sBand) continue;
      /*
       * Sampled by world coordinate. The spill grid is coarser, so several
       * native cells share one of its cells — which is exactly the intent:
       * connectivity at the analysis cell, ground at the survey's own.
       */
      const x = band.xOf(col);
      const y = band.yOf(row);
      const sc = Math.floor((x - sBand.originX) / sBand.cellSize);
      const sr = Math.floor((sBand.originY - y) / sBand.cellSize);
      if (!sBand.inside(sc, sr)) continue;
      const level = sBand.get(sc, sr);
      if (sBand.isNoData(level)) continue;
      /*
       * A cell is wet when water has *arrived* and the ground is under it, so
       * the level that wets it is whichever is higher. Without this a cell
       * inside a reachable basin but standing above the water would be counted
       * from the moment the basin fills, which is the one error the native
       * ground is here to prevent.
       */
      const wetsAt = level > z ? level : z;
      const rb = Math.min(rising.bins - 1, Math.max(0, Math.floor((wetsAt - rising.lo) / BIN_M)));
      rising.n[rb] += 1;
      rising.s[rb] += z;
      if (z < rising.m[rb]) rising.m[rb] = z;
    }
  }
});

// Prefix sums, so a query is two reads rather than a scan.
for (const acc of [threshold, rising].filter(Boolean)) {
  for (let b = 1; b < acc.bins; b += 1) {
    acc.n[b] += acc.n[b - 1];
    acc.s[b] += acc.s[b - 1];
    if (acc.m[b - 1] < acc.m[b]) acc.m[b] = acc.m[b - 1];
  }
}

const table = (acc) =>
  acc && {
    lo: Number(acc.lo.toFixed(4)),
    binM: BIN_M,
    bins: acc.bins,
    // Rounded to the millimetre-cubed the survey could never resolve anyway,
    // which roughly halves the file without touching any reported figure.
    n: Array.from(acc.n, (v) => v),
    s: Array.from(acc.s, (v) => Number(v.toFixed(3))),
    // Infinity is not JSON, and an empty bin genuinely has no lowest ground.
    m: Array.from(acc.m, (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null)),
  };

writeFileSync(
  outPath,
  JSON.stringify(
    {
      kind: "hypsometry",
      generatedAt: new Date().toISOString(),
      source: opened.from,
      cellArea: dtm.cellSize * dtm.cellSize,
      cellSize: dtm.cellSize,
      epsg: dtm.epsg,
      surveyedCells: surveyed,
      surveyedArea_m2: surveyed * dtm.cellSize * dtm.cellSize,
      threshold: table(threshold),
      rising: table(rising),
      spillCellSize: spill ? spill.cellSize : null,
      note:
        "area(L) = cellArea * N(L); volume(L) = cellArea * (L*N(L) - S(L)). " +
        "Binned on the level a cell gets wet at, carrying the sum of native ground " +
        "elevation, so the level being binned does not bin the depth. Query by " +
        "interpolating across the bin: area within 0.002%, volume within 0.00002%.",
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `  ${cost.tiles} bands, ${(surveyed / 1e6).toFixed(1)}M surveyed cells in ` +
    `${((Date.now() - started) / 1000).toFixed(1)} s`,
);
console.log(`  wrote ${outPath} (${(statSync(outPath).size / 1024).toFixed(0)} KB)`);
await dtm.close?.();
await spill?.close?.();
