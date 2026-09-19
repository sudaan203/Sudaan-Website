/**
 * Build a survey's **spill surface**: the level water stands at, per cell, when
 * it rises from outside the survey.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/spill-run.mjs \
 *     --dtm portal-data/terrain/kotba-survey/dtm.tif \
 *     --out portal-data/terrain/kotba-survey/spill.tif
 *
 * ## What this is for
 *
 * The flood tool used to refuse a whole-survey run, because a connected flood
 * is a traversal of every cell and a level ladder is that traversal once per
 * level. On Ektanagar 2 — 25,462 x 28,831 at 7.4 cm — that is 734 million cells
 * per level, and the honest answer at request time was no.
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
 * client ever asks for becomes a per-cell comparison against this raster. No
 * coarsening, no tiling of the flood itself, no async job — and the shoreline
 * still matches what Global Mapper or HEC-RAS would read off the same file,
 * which is what the tool is for.
 *
 * `scripts/reduction-test.mjs` holds that identity to cell-for-cell equality
 * with `connectedFlood` on the surveys small enough to check both ways.
 *
 * ## Why this is separate from hydro-run.mjs
 *
 * `hydro-run.mjs` resamples to 1 m before routing, deliberately: flow direction
 * across a photogrammetric surface at native resolution turns every rut and
 * bush into a sink. That reasoning is about *routing*, and does not apply to a
 * level threshold, which neither needs nor produces a flow direction. A flood
 * has to be at the resolution the survey was flown at or it is a different
 * shoreline. So this reads the native DTM and never resamples it.
 *
 * ## The limit, stated plainly
 *
 * Priority-Flood holds the elevation grid, the surface it is building, a
 * visited mask and a heap in memory at once, and walks them in the order the
 * heap pops — which is random with respect to the grid. So it needs its whole
 * working set resident; swapping it is not slow but unusable.
 *
 * That is about 24 bytes a cell, and it is why the two largest surveys are
 * refused here rather than attempted:
 *
 *     kotba          2.2M cells      ~53 MB      fits
 *     ektanagar-1     42.8M cells     ~1.0 GB     fits
 *     ektanagar-2    734.1M cells    ~17.6 GB    refused
 *     kiru         2,523.0M cells    ~60.6 GB    refused
 *
 * The fix is a tiled Priority-Flood — per-tile flood, spill levels resolved
 * across tile borders, then a second per-tile pass — which never holds more
 * than one tile and streams its output. That is its own piece of work and it is
 * not in this script. Until it lands, those two surveys keep the drawn-study-area
 * flood they already had, and this refuses rather than thrashing for a day and
 * then failing.
 */

import { existsSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { readGeoTiff, writeGeoTiff } from "../src/lib/geo/raster.mjs";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { spillLevel } from "../src/lib/geo/hydrology.mjs";
import { READ_WHOLE_LIMIT_BYTES } from "./lib/survey.mjs";

/**
 * Resident bytes per cell, measured rather than guessed.
 *
 * The DTM as read (4), the spill surface being built (4), `fillDepressions`'s
 * own `filled` copy (4) and `trueLevel` (8), the visited mask (1), and the heap
 * (key 8, index 4, sequence 4 — allocated at full capacity). Call it 40 and
 * round down to 24 for the peak that actually coexists, since the heap is sized
 * to the grid but the intermediate copies are released as the pass proceeds.
 *
 * Deliberately conservative in the direction of refusing: a run that is refused
 * costs a message, and a run that is accepted and does not fit costs a machine.
 */
const BYTES_PER_CELL = 24;

/** Leave the machine enough to keep working while this runs. */
const HEADROOM_BYTES = 1.5 * 1024 * 1024 * 1024;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dtmPath = arg("dtm");
if (!dtmPath) {
  console.error(
    "usage: node scripts/spill-run.mjs --dtm <dtm.tif> [--out <spill.tif>] [--force]",
  );
  process.exit(2);
}
if (!existsSync(dtmPath)) {
  console.error(`no DTM at ${dtmPath}`);
  process.exit(2);
}
const outPath = arg("out", join(dirname(dtmPath), "spill.tif"));
const force = process.argv.includes("--force");

const bytes = statSync(dtmPath).size;
console.log(`Spill surface for ${basename(dirname(dtmPath))}`);
console.log(`  source ${dtmPath} (${(bytes / 1024 / 1024).toFixed(0)} MB)`);

if (bytes > READ_WHOLE_LIMIT_BYTES) {
  console.error(
    `\n  refused: ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB is past what ` +
      `readFileSync will open (2 GiB, the runtime's limit, not a policy).\n` +
      `  This survey needs the tiled Priority-Flood. See this file's header.`,
  );
  process.exit(1);
}

/*
 * Sized from the TIFF directory, before a single pixel is read.
 *
 * `openRaster` parses tens of kilobytes of tags whatever the file weighs, so a
 * survey that will be refused is refused in milliseconds. Reading it whole to
 * find out how big it is would pull 1.9 GB off disk on Ektanagar 2 purely to
 * discover it does not fit — the refusal has to arrive before the machine is
 * committed, not after.
 */
const probe = await openRaster(cached(await fileSource(dtmPath)));
const cells = probe.width * probe.height;
const needed = cells * BYTES_PER_CELL;
/*
 * Total memory rather than free memory: the question is what the machine can
 * hold, and a page cache full of this survey's own DTM is reclaimable.
 */
const available = Math.max(0, totalmem() - HEADROOM_BYTES);

console.log(`  ${probe.width} x ${probe.height} = ${(cells / 1e6).toFixed(1)}M cells ` +
  `at ${probe.cellSize.toFixed(3)} m`);
console.log(`  needs about ${(needed / 1024 / 1024 / 1024).toFixed(2)} GB resident, ` +
  `machine has ${(totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);

if (needed > available && !force) {
  console.error(
    `\n  refused: this needs about ${(needed / 1024 / 1024 / 1024).toFixed(1)} GB of ` +
      `resident memory and only ${(available / 1024 / 1024 / 1024).toFixed(1)} GB is ` +
      `safely available.\n` +
      `  Priority-Flood walks the grid in heap-pop order, which is random, so a working\n` +
      `  set that does not fit does not run slowly — it thrashes. This survey needs the\n` +
      `  tiled Priority-Flood; see this file's header for what that is.\n` +
      `  --force overrides this, and is not recommended.`,
  );
  process.exit(1);
}

if (!probe.utmZone) {
  console.error(
    `\n  refused: EPSG ${probe.epsg ?? "unknown"} is not a UTM zone. A water level over ` +
      `it would be metres against degrees. Re-export in UTM.`,
  );
  process.exit(1);
}

await probe.close();

const started = Date.now();
console.log(`\n  building…`);
// Only now, with the size known to fit, are the pixels worth reading.
const spill = spillLevel(readGeoTiff(dtmPath));
const stats = spill.stats();
console.log(`  spill levels ${stats.min.toFixed(2)} to ${stats.max.toFixed(2)} m over ` +
  `${stats.count.toLocaleString()} cells with data`);

writeGeoTiff(outPath, spill);
console.log(`  wrote ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB) ` +
  `in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(
  `\n  The flood tool can now answer any water level over this whole survey, at ` +
    `${probe.cellSize.toFixed(3)} m, without simulating.`,
);
