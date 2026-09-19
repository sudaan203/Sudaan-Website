/**
 * What a survey will get in the portal, answered before any work is done.
 *
 *   node scripts/site-preflight.mjs --dtm "D:\surveys\reliance\dtm.tif"
 *   node scripts/site-preflight.mjs --slug kotba-survey
 *   node scripts/site-preflight.mjs --all
 *
 * ## Why
 *
 * Publishing a survey is an hour of tiling, routing and streaming, and until it
 * finished nobody could say what the result would be able to do. The answers
 * depend almost entirely on one number — how many cells the DTM has — and that
 * number is in the TIFF directory, which costs tens of kilobytes to read
 * whatever the file weighs. So the question is answerable in a fraction of a
 * second and was being answered in an hour.
 *
 * It is also the question that was never written down. Kiru's hydrology runs at
 * 5 m because someone produced a 5 m DTM by hand; that decision survives only as
 * a filename inside a manifest, and nothing in the repository could reproduce or
 * even explain it. `analysisCellFor` is that decision as a rule, and this is the
 * rule made visible before it is applied rather than after.
 *
 * ## What it reports
 *
 * Two resolutions per survey, because there are two, and conflating them is how
 * "we coarsened your survey" gets said about a portal that did not:
 *
 *   native          tiles, spot levels, profiles, cross sections, cut and fill,
 *                   volumes, and the threshold flood. Never coarsened, at any
 *                   survey size.
 *   analysis cell   the things that need to see the grid whole because water
 *                   arrives from outside any box you draw: flow routing, and
 *                   the spill surface behind the rising flood.
 *
 * For a published site it also reports what is actually there, which was
 * previously answerable only by `ls`.
 */

import { existsSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { analysisCellFor, CONNECTIVITY_CELL_BUDGET } from "./lib/coarsen.mjs";
import { SURVEYS } from "./lib/survey.mjs";

/** Resident bytes per cell for Priority-Flood. Matches `spill-run.mjs`. */
const SPILL_BYTES_PER_CELL = 24;

/**
 * Cells a second, measured rather than guessed.
 *
 * The banded reduction ran 26.3M cells/s over Ektanagar 1 from local disk with
 * LZW decode included. Over R2 it is slower and by how much has not been
 * measured, so every duration printed here is labelled an estimate and rounded
 * hard — a preflight that quotes a confident wrong minute is worse than one
 * that says "about".
 */
const WALK_CELLS_PER_SECOND = 26.3e6;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const about = (seconds) =>
  seconds < 1 ? "under a second" :
  seconds < 90 ? `about ${Math.round(seconds)} s` :
  `about ${Math.round(seconds / 60)} min`;

async function report(label, dtmPath, slug = null) {
  console.log(`\n${"=".repeat(68)}\n${label}`);
  if (!existsSync(dtmPath)) {
    console.log(`  no DTM at ${dtmPath}`);
    return;
  }

  const raster = await openRaster(cached(await fileSource(dtmPath)));
  const cells = raster.width * raster.height;
  const native = raster.cellSize;
  const cell = analysisCellFor(raster);
  const outCells =
    Math.round((raster.width * native) / cell) * Math.round((raster.height * native) / cell);

  console.log(`  ${raster.width} x ${raster.height} = ${(cells / 1e6).toFixed(1)}M cells ` +
    `at ${native.toFixed(4)} m, EPSG:${raster.epsg ?? "?"}` +
    `  (${(statSync(dtmPath).size / 1024 ** 2).toFixed(0)} MB)`);

  if (!raster.utmZone) {
    console.log(`  ⚠ EPSG ${raster.epsg ?? "unknown"} is not a UTM zone. Areas and volumes ` +
      `over it would be meaningless — re-export in UTM before publishing.`);
  }

  console.log(`\n  RESOLUTION`);
  console.log(`    native          ${native.toFixed(4)} m — tiles, measurement, profiles, ` +
    `cut and fill, threshold flood`);
  console.log(
    cell === native
      ? `    analysis cell   ${native.toFixed(4)} m — the survey fits whole, so nothing is coarsened`
      : `    analysis cell   ${cell} m (${(cell / native).toFixed(1)}x) — routing and flood ` +
        `connectivity only.\n` +
        `                    Shoreline, depth, area and volume stay native.`,
  );

  console.log(`\n  WHAT IT WILL GET`);
  const spillNeeded = outCells * SPILL_BYTES_PER_CELL;
  const spillFits = spillNeeded < totalmem() - 1.5 * 1024 ** 3;
  const rows = [
    ["map tiles", "yes", "native, rendered on demand"],
    ["measurement", "yes", `native — no area limit; a polygon of any size reduces over bands`],
    ["cross sections", "yes", "native — sampled, so cost follows the line not the survey"],
    ["threshold flood", "yes", `native, any level, over the whole survey`],
    [
      "rising flood",
      spillFits ? "yes" : "NO",
      spillFits
        ? `spill surface at ${cell} m, ${(spillNeeded / 1024 ** 3).toFixed(2)} GB to build`
        : `needs ${(spillNeeded / 1024 ** 3).toFixed(1)} GB resident, machine has ` +
          `${(totalmem() / 1024 ** 3).toFixed(0)} GB — pass a coarser --cell`,
    ],
    ["level table", "yes", `one pass, ${about(cells / WALK_CELLS_PER_SECOND)} (estimate)`],
  ];
  for (const [what, can, note] of rows) {
    console.log(`    ${what.padEnd(16)} ${can.padEnd(4)} ${note}`);
  }

  if (cells > CONNECTIVITY_CELL_BUDGET) {
    console.log(`\n  Above the ${(CONNECTIVITY_CELL_BUDGET / 1e6).toFixed(0)}M cell budget for ` +
      `whole-grid work, so the analysis cell applies. Measured cost of that,\n  on Ektanagar 1 ` +
      `against its own native spill surface: under 0.5% of flooded area, and\n  0.001% ` +
      `wrongly wet — it under-reports rather than inventing water.`);
  }

  if (slug) {
    console.log(`\n  ALREADY BUILT`);
    const dir = join("portal-data", "terrain", slug);
    const has = (p, what) => {
      const full = existsSync(p) ? p : null;
      console.log(`    ${what.padEnd(16)} ${full ? `yes  ${(statSync(full).size / 1024 ** 2).toFixed(1)} MB` : "no"}`);
    };
    has(join(dir, "dsm.tif"), "dsm");
    has(join(dir, "spill.tif"), "spill surface");
    has(join(dir, "hypsometry.json"), "level table");
    console.log(`    ${"map".padEnd(16)} ${existsSync(join("portal-data", "map", slug, "manifest.json")) ? "yes" : "no"}`);
    console.log(`    ${"hydrology".padEnd(16)} ${existsSync(join("portal-data", "hydrology", slug, "manifest.json")) ? "yes" : "no"}`);
    console.log(`    ${"point cloud".padEnd(16)} ${existsSync(join("portal-data", "cloud", slug)) ? "yes" : "no"}`);
  }

  await raster.close?.();
}

const slug = arg("slug");
const dtm = arg("dtm");

if (process.argv.includes("--all")) {
  for (const s of SURVEYS) {
    await report(s.label, join("portal-data", "terrain", s.slug, "dtm.tif"), s.slug);
  }
} else if (slug) {
  await report(slug, join("portal-data", "terrain", slug, "dtm.tif"), slug);
} else if (dtm) {
  await report(dtm, dtm);
} else {
  console.error(
    "usage: node scripts/site-preflight.mjs --dtm <dtm.tif>\n" +
      "   or: node scripts/site-preflight.mjs --slug <site-slug>\n" +
      "   or: node scripts/site-preflight.mjs --all",
  );
  process.exit(2);
}
console.log();
