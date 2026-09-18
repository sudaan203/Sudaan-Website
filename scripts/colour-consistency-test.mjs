#!/usr/bin/env node
/**
 * Holds the line that every representation of height is the same picture.
 *
 *   node scripts/colour-consistency-test.mjs
 *
 * ## Why a test and not a code review
 *
 * On 18 Sep 2026 this repository shipped **five** different elevation ramps. The
 * baked tiles and the dynamic tiler shared one; the site previews, the marketing
 * DEM renderer, the overview baker and both point clouds each had their own.
 * Three of them carried a comment claiming they matched another file, and every
 * one of those comments had been true when it was written.
 *
 * That is the tell. Nobody copied a ramp carelessly — they copied it correctly,
 * and then the original moved. A review cannot catch that, because the diff that
 * breaks it is a change to a *different* file than the one that ends up wrong.
 * So the invariant gets asserted instead.
 *
 * Two things are checked, and the second matters more than the first.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { rampFor } from "../src/lib/geo/colour.mjs";
import { renderElevation, SUN } from "../src/lib/geo/elevation-image.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const fail = (what, detail) => {
  failures += 1;
  console.error(`  FAIL  ${what}`);
  if (detail) console.error(detail.replace(/^/gm, "        "));
};
const pass = (what) => console.log(`  ok    ${what}`);

/* ------------------------------------------------- 1. no private palettes --- */

/**
 * Files allowed to contain literal colour stops, each for a stated reason.
 *
 * This list is meant to stay short. Adding to it is a decision about the product
 * looking consistent, not a formality, so each entry says why it is exempt.
 */
const ALLOWED = new Map([
  ["src/lib/geo/colour.mjs", "defines the ramps; the stops have to live somewhere"],
  ["src/components/HeroSequence.tsx", "brand animation, not a rendering of survey data"],
  ["src/components/visuals/scene.ts", "brand animation, not a rendering of survey data"],
]);

/** Directories that render or display survey data. */
const SCANNED = ["src", "scripts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js"]);

/**
 * A colour stop reads as `[0.35, [229, 142, 58]]` or `[0.4, 92, 178, 96]`: an
 * array opening with a position in 0..1. One such line is a coincidence; three
 * in a file is a ramp.
 */
const STOP = /^\s*\[\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*,/;
const THRESHOLD = 3;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(extname(entry))) yield full;
  }
}

const offenders = [];
for (const dir of SCANNED) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(root, file).split("\\").join("/");
    if (ALLOWED.has(rel)) continue;
    // This file quotes stop-shaped lines in its own documentation.
    if (rel === "scripts/colour-consistency-test.mjs") continue;

    const hits = readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => (STOP.test(line) ? i + 1 : 0))
      .filter(Boolean);
    if (hits.length >= THRESHOLD) offenders.push({ rel, lines: hits });
  }
}

if (offenders.length === 0) {
  pass(`no private colour ramps outside ${ALLOWED.size} allowed files`);
} else {
  fail(
    "a file defines its own colour ramp",
    offenders.map((o) => `${o.rel}  lines ${o.lines.join(", ")}`).join("\n") +
      "\n\nUse rampFor() from src/lib/geo/colour.mjs, or renderElevation() from\n" +
      "elevation-image.mjs for a whole elevation grid. If this really is brand\n" +
      "artwork rather than survey data, add it to ALLOWED above with a reason.",
  );
}

/* ------------------------------- 2. the relief is lit from the upper left --- */

/**
 * The bug this catches is the one that actually shipped.
 *
 * `make-site-previews.mjs` computed its north-south gradient as (south row)
 * minus (north row) and used it without the negation `render.mjs` documents, so
 * every preview was lit from the south-east and every ridge read as a valley.
 * It survived because an inverted hillshade still looks like terrain — there is
 * nothing to notice unless you know the ground.
 *
 * Isolating it takes care. A radial hill does **not** work: with a sun in the
 * north-west the east-west component of the lighting stays correct under the
 * inversion, so a north-west slope still comes out brighter than a south-east
 * one and the test passes on broken code. That was the first version of this
 * check, and it passed when the bug was deliberately put back.
 *
 * So the fixture is a ridge that varies **only** north to south: `dz/dcol` is
 * zero everywhere, the east-west term contributes nothing, and the north-south
 * sign is the only thing left that can decide the answer. The two flanks sit at
 * equal height, so they take an identical colour from the ramp and every
 * difference in brightness is relief.
 */
{
  const w = 32;
  const h = 32;

  /** A ridge running east-west: rises to the middle row, constant along a row. */
  const dense = new Float32Array(w * h);
  for (let row = 0; row < h; row += 1) {
    const dy = Math.abs(row - (h - 1) / 2) / ((h - 1) / 2);
    for (let col = 0; col < w; col += 1) dense[row * w + col] = 20 * (1 - dy);
  }

  const out = renderElevation(dense, { width: w, height: h, cellSize: 1 });
  if (!out) {
    fail("renderElevation returned nothing for a synthetic ridge");
  } else {
    const brightness = (row) => {
      const o = (row * w + Math.round(w / 2)) * 4;
      return out.rgba[o] + out.rgba[o + 1] + out.rgba[o + 2];
    };
    // Mirrored about the crest: same elevation, opposite aspect.
    const northFlank = brightness(Math.round(h * 0.25));
    const southFlank = brightness(h - 1 - Math.round(h * 0.25));

    if (northFlank > southFlank) {
      pass(
        `relief lit from azimuth ${SUN.azimuth}: north flank ${northFlank} > ` +
          `south flank ${southFlank}`,
      );
    } else {
      fail(
        "the hillshade is lit from the wrong quarter",
        `north flank ${northFlank}, south flank ${southFlank}.\n` +
          "Equal means no relief; reversed means the north-south gradient is not\n" +
          "negated. Rows increase southward, so dz/drow is the gradient going\n" +
          "south and the northward gradient is its negation. An inverted\n" +
          "hillshade still looks like terrain, which is why this is a test.",
      );
    }
  }
}

/* ----------------------------------- 3. nodata is transparent, not black --- */

{
  const w = 8;
  const h = 8;
  const dense = new Float32Array(w * h).fill(NaN);
  for (let i = 0; i < w * h; i += 1) if (i % 2 === 0) dense[i] = i;

  const out = renderElevation(dense, { width: w, height: h, cellSize: 1 });
  const alphas = new Set();
  for (let i = 0; i < w * h; i += 1) alphas.add(out.rgba[i * 4 + 3]);

  const holesClear = [...Array(w * h).keys()]
    .filter((i) => i % 2 === 1)
    .every((i) => out.rgba[i * 4 + 3] === 0);

  if (holesClear && alphas.has(255)) {
    pass("nodata is fully transparent, data is opaque");
  } else {
    fail(
      "nodata is not transparent",
      "Painting nodata black puts a hard edge around every survey, and painting\n" +
        "it the bottom of the ramp claims the ground is at the lowest elevation\n" +
        "in the file, which reads as real terrain and cannot be caught by eye.",
    );
  }
}

/* ------------------------------------ 4. a signed quantity cannot rainbow --- */

{
  let refused = false;
  try {
    rampFor("rainbow", { signed: true });
  } catch {
    refused = true;
  }
  if (refused) pass("rampFor refuses a rainbow for a signed quantity");
  else fail("rampFor allowed a rainbow for a signed quantity, losing the sign");
}

/* ------------------------------------------------------------------------- */

console.log("");
if (failures > 0) {
  console.error(`colour consistency: ${failures} failure${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("colour consistency: all checks passed");
