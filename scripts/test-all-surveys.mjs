/**
 * Run the survey-parameterised suites against every survey on this machine.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/test-all-surveys.mjs
 *   node scripts/test-all-surveys.mjs --offline        # no dev server needed
 *   node scripts/test-all-surveys.mjs --survey=kiru-hydroelectric-survey
 *
 * ## Why this exists
 *
 * Every suite defaults to `kotba-survey`, and Kotba is 1393 x 1575 cells at
 * 24 cm — small, local, and fast. It is also, until now, the only survey
 * anything was ever tested against, and **both recent production failures were
 * on other surveys**:
 *
 * - The flood tool was dead in production for *every* survey, because it read
 *   the DTM with a local-file reader and a serverless filesystem has no local
 *   files. Kotba hid it twice over: small enough to read whole, and present on
 *   the machine.
 * - The flood refused a client's real view on Aektanagar, because a cell budget
 *   calibrated on 24 cm cells becomes a 154 m square at 7.7 cm. Five checks were
 *   later found to be asserting something different per survey because they
 *   sized areas in metres rather than cells.
 *
 * The pattern is not subtle: **the survey that breaks is the one nothing
 * exercises.** This runs the matrix so that stops being true.
 *
 * ## What it does not do
 *
 * It does not make an unportable suite portable. A suite that hardcodes Kotba
 * geometry is listed here as not yet parameterised rather than run and reported
 * as a pass — see `scripts/lib/survey.mjs`, which is where a suite goes to get
 * its geometry from the survey's own header instead of from a constant.
 */

import { spawnSync } from "node:child_process";
import { SURVEYS, describeSurvey, openSurvey, rasterPath, surveyPresent } from "./lib/survey.mjs";
import { existsSync } from "node:fs";
import { statSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--survey="))?.split("=")[1];
const offlineOnly = args.has("--offline");
const withBrowser = args.has("--browser");

if (args.has("--help")) {
  console.log(`test-all-surveys — the suites, against every survey present

  --offline           only suites that need no dev server
  --browser           also run the Puppeteer suites (slow)
  --survey=SLUG       just this one
  --help`);
  process.exit(0);
}

/**
 * What each suite needs to run, because the answer differs and a runner that
 * pretends otherwise reports failures that are really missing infrastructure.
 *
 * `offline` reads rasters and nothing else. `http` needs `next dev` listening on
 * :3000 and a reachable database. `browser` needs both of those plus Puppeteer.
 */
const SUITES = [
  { name: "analysis-contract-test", needs: "offline" },
  { name: "analysis-api-test", needs: "http" },
  { name: "surface-api-test", needs: "http" },
  { name: "alignment-api-test", needs: "http" },
  { name: "shapefile-api-test", needs: "http" },
  { name: "render-api-test", needs: "http" },
  { name: "hydrology-api-test", needs: "http" },
  { name: "portal-map-browser-test", needs: "browser" },
  { name: "portal-flood-browser-test", needs: "browser" },
  { name: "portal-surface-browser-test", needs: "browser" },
];

/**
 * Suites that read `SITE` but are not yet safe to point at another survey.
 *
 * Every one of these hardcodes geometry taken from Kotba — a polygon, a line, a
 * stretch of elevations — so on another survey it is not merely wrong, it is off
 * the map, and the suite fails for a reason that says nothing about the product.
 * They still run on Kotba, which is the survey their geometry was written for
 * and where they pass — skipping them everywhere would trade a coverage gap on
 * two surveys for a coverage gap on three. On the others they are skipped with
 * the reason named, so the matrix reports honest coverage: a cell that says
 * "hardcodes Kotba geometry" is useful, and a red one that really means "the
 * test asked about ground that is not there" is not.
 *
 * `scripts/lib/survey.mjs` is where a suite goes to stop being on this list.
 * Two are already off it: `analysis-api-test` and `analysis-contract-test`.
 */
/** The survey every suite's hardcoded geometry was written against. */
const HOME_SURVEY = "kotba-survey";

const NOT_YET_PORTABLE = {
  "surface-api-test": "hardcodes a Kotba polygon; off the map on any other survey",
  "alignment-api-test": "hardcodes a Kotba centreline; off the map on any other survey",
  "render-api-test":
    "its colour-ramp thresholds are calibrated to Kotba's flow-accumulation distribution",
};

const surveys = (only ? SURVEYS.filter((s) => s.slug === only) : SURVEYS).map((s) => ({
  ...s,
  present: surveyPresent(s.slug),
}));

if (surveys.length === 0) {
  console.log(only ? `No survey named ${only}.` : "No surveys configured.");
  process.exit(1);
}

const serverUp = await fetch("http://localhost:3000", { signal: AbortSignal.timeout(2000) })
  .then(() => true)
  .catch(() => false);

console.log("\nSurveys on this machine\n");
for (const s of surveys) {
  if (!s.present) {
    console.log(`  ${s.slug.padEnd(28)} raster absent, skipped`);
    continue;
  }
  // `describeSurvey` wants the header, not the slug — reading it costs a few
  // tens of kilobytes even on Kiru's 2.3 GB file, because `openSurvey` parses
  // the directory and stops.
  const bytes = statSync(rasterPath(s.slug)).size;
  const header = await openSurvey(s.slug).catch(() => null);
  console.log(
    header
      ? `  ${describeSurvey(header)}, ${(bytes / 1e6).toFixed(0)} MB`
      : `  ${s.slug.padEnd(28)} header unreadable, skipped`,
  );
  if (!header) s.present = false;
}

const wanted = SUITES.filter((s) => {
  if (s.needs === "browser") return withBrowser;
  if (s.needs === "http") return !offlineOnly;
  return true;
});

if (!serverUp && wanted.some((s) => s.needs !== "offline")) {
  console.log(`
  No dev server on :3000, so only the offline suites can run. Start one with
  PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dev, or pass --offline to
  stop asking for the others.`);
}

const present = surveys.filter((s) => s.present);
const results = new Map();
let failed = 0;
let ran = 0;

console.log("");
for (const suite of wanted) {
  if (!existsSync(`scripts/${suite.name}.mjs`)) continue;
  if (suite.needs !== "offline" && !serverUp) continue;

  for (const survey of present) {
    const key = `${suite.name}|${survey.slug}`;
    // Their home survey is the one they were written against, so they run
    // there and are skipped only where their hardcoded geometry does not exist.
    const why = survey.slug === HOME_SURVEY ? null : NOT_YET_PORTABLE[suite.name];
    if (why) {
      results.set(key, { state: "skip", detail: why });
      continue;
    }

    process.stdout.write(`  ${suite.name} on ${survey.slug} ... `);
    const run = spawnSync(
      process.execPath,
      ["--max-old-space-size=6000", `scripts/${suite.name}.mjs`],
      {
        encoding: "utf8",
        env: { ...process.env, SITE: survey.slug, DTM: rasterPath(survey.slug) },
        timeout: 20 * 60 * 1000,
      },
    );
    const tail = (run.stdout ?? "").trim().split("\n").slice(-1)[0] ?? "";
    const passed = tail.match(/all (\d+) checks passed/);
    const broke = tail.match(/(\d+) of (\d+) checks FAILED/);
    ran += 1;

    if (passed) {
      results.set(key, { state: "pass", detail: `${passed[1]}` });
      console.log(`${passed[1]} checks`);
    } else if (broke) {
      results.set(key, { state: "fail", detail: `${broke[1]}/${broke[2]} failed` });
      failed += 1;
      console.log(`FAILED ${broke[1]} of ${broke[2]}`);
    } else {
      // No summary line at all is the shape a crash takes, and it has hidden a
      // real bug here before — a suite that dies on import prints nothing and
      // reads exactly like a suite that was never run.
      const err = (run.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "no output";
      results.set(key, { state: "fail", detail: `no summary: ${err.slice(0, 60)}` });
      failed += 1;
      console.log(`NO SUMMARY — ${err.slice(0, 70)}`);
    }
  }
}

// --- the matrix -------------------------------------------------------------
console.log("\n");
const nameWidth = Math.max(...wanted.map((s) => s.name.length), 8);
const col = 16;
process.stdout.write("suite".padEnd(nameWidth + 2));
for (const s of present) process.stdout.write(s.slug.slice(0, col - 1).padEnd(col));
console.log("");
console.log("-".repeat(nameWidth + 2 + col * present.length));

for (const suite of wanted) {
  const row = present.map((s) => results.get(`${suite.name}|${s.slug}`));
  if (row.every((r) => r === undefined)) continue;
  process.stdout.write(suite.name.padEnd(nameWidth + 2));
  for (const r of row) {
    const cell = !r
      ? "-"
      : r.state === "pass"
        ? `${r.detail} ok`
        : r.state === "skip"
          ? "skipped"
          : r.detail;
    process.stdout.write(cell.padEnd(col));
  }
  console.log("");
}

const skipped = [...results.values()].filter((r) => r.state === "skip");
if (skipped.length) {
  console.log("\nSkipped, with reasons:");
  for (const [key, r] of results) {
    if (r.state !== "skip") continue;
    console.log(`  ${key.replace("|", " on ")} — ${r.detail}`);
  }
}

console.log(
  `\n${failed === 0 ? `all ${ran} suite runs passed` : `${failed} of ${ran} suite runs FAILED`}\n`,
);
process.exit(failed ? 1 : 0);
