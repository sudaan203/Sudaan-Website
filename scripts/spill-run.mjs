/**
 * Build a survey's **spill surface**: the level water stands at, per cell, when
 * it rises from outside the survey.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/spill-run.mjs --slug kotba-survey
 *   node scripts/spill-run.mjs --dtm portal-data/terrain/kotba-survey/dtm.tif
 *
 * ## What this is for
 *
 * The flood tool used to refuse a whole-survey run, because a connected flood
 * is a traversal of every cell and a level ladder is that traversal once per
 * level. On Ektanagar 2 that is 734 million cells per level.
 *
 * It is the wrong thing to compute at request time. `fillDepressions` is
 * Priority-Flood seeded from the survey's boundary and its nodata edges, so the
 * `trueLevel` surface falling out of it is the *minimax* elevation from outside
 * the survey to each cell — the lowest "highest ground you must cross" over
 * every path in. Which gives
 *
 *     water rising from outside at level L covers exactly { c : spill[c] <= L }
 *
 * So the traversal is done once, here, at publish time, and every level a
 * client ever asks for becomes a comparison against this raster.
 *
 * ## The connectivity grid, and what is deliberately *not* coarsened
 *
 * Priority-Flood cannot be windowed — water arrives from outside whatever box
 * you draw — so it has to see the grid whole, and the two largest surveys do
 * not fit whole at native resolution: Ektanagar 2 needs 16.4 GB and Kiru 60.6,
 * against a laptop's 8. That is the same wall `hydro-run.mjs` hit, and it takes
 * the same answer: a coarser **analysis cell**, chosen by rule in
 * `lib/coarsen.mjs` rather than by hand — Kiru's 5 m grid was picked by a
 * person once and recorded only as a filename inside a manifest.
 *
 * What that costs is precise and small, because the coarse grid decides **only
 * connectivity**. The portal combines it with the *native* DTM at query time:
 *
 *     flooded(c) = spill_coarse(c) <= L   AND   dem_native(c) <= L
 *     depth(c)   = L - dem_native(c)
 *
 * so the shoreline, the depth, the area and the volume are all still at the
 * survey's own resolution. The only thing the analysis cell can get wrong is a
 * berm or a channel narrower than itself. Measured against Ektanagar 1's own
 * native spill surface: 0.30% of flooded area at 6.5x coarsening, and
 * wrongly-wet — flooding ground that should be dry — at 0.001%, about 1.3 m²
 * out of twenty million flooded cells. The error is almost entirely
 * conservative, which is the right direction for a flood tool to be wrong in.
 *
 * Kotba and Ektanagar 1 fit whole and are not coarsened at all.
 *
 * ## Reading from R2
 *
 * With `--slug` and no local file, the DTM is read out of R2 by signed range
 * requests, windowed, and never downloaded. A machine with four gigabytes free
 * can publish a survey it could not store. See `lib/r2-raster.mjs`.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeGeoTiff } from "../src/lib/geo/raster.mjs";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { spillLevel } from "../src/lib/geo/hydrology.mjs";
import { coarsenRaster, analysisCellFor } from "./lib/coarsen.mjs";
import { openTerrainSource } from "./lib/r2-raster.mjs";

/**
 * Resident bytes per cell for the Priority-Flood pass.
 *
 * The grid as read (4), the spill surface (4), `fillDepressions`'s own `filled`
 * copy (4) and `trueLevel` (8), the visited mask (1), and the heap (key 8,
 * index 4, sequence 4, allocated at capacity). Conservative in the direction of
 * refusing: a refused run costs a message, and an accepted one that does not
 * fit costs the machine — the walk order is random with respect to the grid, so
 * swapping it is not slow, it is unusable.
 */
const BYTES_PER_CELL = 24;
const HEADROOM_BYTES = 1.5 * 1024 * 1024 * 1024;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg("slug");
const dtmArg = arg("dtm");
if (!slug && !dtmArg) {
  console.error(
    "usage: node scripts/spill-run.mjs --slug <site-slug> [--cell <m>] [--out <spill.tif>]\n" +
      "   or: node scripts/spill-run.mjs --dtm <dtm.tif> [--cell <m>] [--out <spill.tif>]",
  );
  process.exit(2);
}

const localDtm = dtmArg ?? join("portal-data", "terrain", slug, "dtm.tif");
const outPath =
  arg("out") ??
  (slug
    ? join("portal-data", "terrain", slug, "spill.tif")
    : join(dirname(localDtm), "spill.tif"));

console.log(`Spill surface for ${slug ?? basename(dirname(localDtm))}`);

/*
 * Opened from the TIFF directory alone, before a pixel is read. `openRaster`
 * parses tens of kilobytes whatever the file weighs, so the analysis cell is
 * chosen — and an impossible run refused — in milliseconds rather than after
 * pulling gigabytes off disk or out of R2 to discover the size.
 */
let raster;
let from;
if (existsSync(localDtm)) {
  raster = await openRaster(cached(await fileSource(localDtm)));
  from = localDtm;
} else if (slug) {
  const opened = await openTerrainSource(slug, "dtm", { localPath: localDtm });
  raster = await openRaster(opened.source);
  from = opened.from;
} else {
  console.error(`no DTM at ${localDtm}`);
  process.exit(2);
}
console.log(`  source   ${from}`);

const native = raster.cellSize;
const cells = raster.width * raster.height;
const asked = Number(arg("cell"));
const cell = asked > 0 ? asked : analysisCellFor(raster);
const outWidth = Math.max(1, Math.round((raster.width * native) / cell));
const outHeight = Math.max(1, Math.round((raster.height * native) / cell));
const outCells = outWidth * outHeight;

console.log(`  native   ${raster.width} x ${raster.height} = ${(cells / 1e6).toFixed(1)}M cells at ${native.toFixed(4)} m`);
console.log(
  cell === native
    ? `  analysis at the survey's own resolution — it fits whole`
    : `  analysis ${cell} m connectivity grid — ${outWidth} x ${outHeight} = ` +
      `${(outCells / 1e6).toFixed(2)}M cells, ${(cell / native).toFixed(1)}x coarser ` +
      `(shoreline and depth stay native)`,
);

if (!raster.utmZone) {
  console.error(
    `\n  refused: EPSG ${raster.epsg ?? "unknown"} is not a UTM zone. A water level over ` +
      `it would be metres against degrees. Re-export in UTM.`,
  );
  process.exit(1);
}

const needed = outCells * BYTES_PER_CELL;
const available = Math.max(0, totalmem() - HEADROOM_BYTES);
if (needed > available && !process.argv.includes("--force")) {
  console.error(
    `\n  refused: a ${cell} m grid still needs about ${(needed / 1024 ** 3).toFixed(1)} GB ` +
      `resident and only ${(available / 1024 ** 3).toFixed(1)} GB is safely available.\n` +
      `  Pass --cell with a coarser analysis cell, or run this where there is more memory.`,
  );
  process.exit(1);
}

const started = Date.now();
let grid;
if (cell === native) {
  console.log(`\n  reading…`);
  grid = await raster.readWindow({ col0: 0, row0: 0, cols: raster.width, rows: raster.height });
} else {
  console.log(`\n  coarsening…`);
  grid = await coarsenRaster(raster, cell, {
    onProgress: (done, total) =>
      process.stdout.write(`\r  coarsening ${((done / total) * 100).toFixed(0)}%   `),
  });
  process.stdout.write("\n");
}

console.log(`  flooding…`);
const spill = spillLevel(grid);
const stats = spill.stats();
console.log(
  `  spill levels ${stats.min.toFixed(2)} to ${stats.max.toFixed(2)} m over ` +
    `${stats.count.toLocaleString()} cells with data`,
);

writeGeoTiff(outPath, spill);

/*
 * The analysis cell, recorded beside the raster rather than left to be inferred.
 *
 * The portal has to know it to combine the two surfaces correctly, and reading
 * it back off the TIFF would work right up until someone rebuilt the surface at
 * a different cell and nothing noticed. Kiru's 5 m grid existed for months as a
 * number inside a filename; this is that mistake not repeated.
 */
const sidecar = outPath.replace(/\.tif$/, ".json");
writeFileSync(
  sidecar,
  JSON.stringify(
    {
      kind: "spill",
      generatedAt: new Date().toISOString(),
      source: from,
      nativeCellSize: native,
      analysisCellSize: cell,
      coarsening: Number((cell / native).toFixed(3)),
      width: spill.width,
      height: spill.height,
      epsg: spill.epsg,
      levelRange: [Number(stats.min.toFixed(3)), Number(stats.max.toFixed(3))],
      note:
        cell === native
          ? "Built at the survey's own resolution."
          : "Connectivity only. Shoreline and depth come from the native DTM at query time.",
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `  wrote ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB) ` +
    `and ${basename(sidecar)} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
await raster.close?.();
