/**
 * Two implementations of the same primitive must agree cell for cell.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/geo-differential-test.mjs
 *   GEO_NATIVE=../rust-kernels/pkg/geo_kernels.js node scripts/geo-differential-test.mjs
 *
 * ## Why this exists
 *
 * The performance plan replaces JavaScript inner loops with native ones, and the
 * rule for every one of those replacements is that it agrees with the function it
 * replaces exactly — not closely. `raster-window-test.mjs` already argues why, in
 * the same words: an off-by-one in tile addressing shifts terrain by a few
 * centimetres, which nobody sees on a map and which turns up months later as a
 * volume that will not reconcile. A native decoder that gets one cell in forty
 * million wrong produces a picture indistinguishable from a correct one.
 *
 * So this is not a test of the engine. The engine has known-answer tests already
 * (`hydro-test.mjs`, `flood-test.mjs`, `terrain-test.mjs`). This is a test of
 * *equivalence*: given the same input, do two implementations produce the same
 * bits.
 *
 * ## The trap this file is built around
 *
 * A differential harness wired with the same implementation on both sides passes
 * unconditionally. It would pass if the comparator only checked array lengths.
 * It would pass if the comparator were `return true`. Standing that up and
 * declaring the seam ready is how a phase later ships a native kernel against a
 * harness that cannot see the error.
 *
 * Every primitive is therefore checked twice:
 *
 *   1. **agreement** — the reference against itself, which must match exactly.
 *   2. **sensitivity** — the reference against itself with a single element moved
 *      by one unit in the last place, which must be *reported as different*.
 *
 * The second check is the one that gives the first one meaning. One ULP in one
 * cell of a forty-million-cell grid is the smallest error that can exist, and a
 * comparator that catches it will catch anything a real port gets wrong.
 *
 * ## Plugging in the native side
 *
 * Set `GEO_NATIVE` to a module specifier — a wasm-bindgen `--target nodejs`
 * output, a napi addon wrapper, anything importable — and every primitive whose
 * name that module exports is additionally compared against it:
 *
 *   GEO_NATIVE=../rust-kernels/pkg/geo_kernels.js node scripts/geo-differential-test.mjs
 *
 * The expected export names and signatures are listed against each primitive in
 * `PRIMITIVES` below, and are deliberately identical to the JavaScript ones, so
 * the native module is a drop-in rather than something this file has to adapt.
 * A module that exports only some of them is fine: the rest report SKIP and say
 * which name was missing. That is what makes this usable from the first kernel
 * onwards rather than only when the whole port is finished.
 *
 * ## Fixtures
 *
 * Real survey data where it is present, at `portal-data/terrain/<site>/dtm.tif`
 * under `PORTAL_TERRAIN_DIR`, because agreement on a smooth synthetic surface is
 * a weaker claim than agreement on ground with nodata holes, ragged edges and
 * vegetation noise in it. Where the rasters are absent — they are gitignored — a
 * synthetic grid stands in and the run says so, and the primitives that need
 * actual compressed bytes skip rather than pretending.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Grid, lzwDecode, resample } from "../src/lib/geo/raster.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import { connectedFlood, thresholdFlood } from "../src/lib/geo/hydrology.mjs";
import { polygonize } from "../src/lib/geo/vectorise.mjs";
import { hillshade, renderGrid } from "../src/lib/geo/render.mjs";
import { rampFor } from "../src/lib/geo/colour.mjs";
import { polygonStats } from "../src/lib/geo/terrain-analysis.mjs";

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const option = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const site = option("site", "kotba-survey");
const terrainDir =
  option("terrain-dir") ??
  process.env.PORTAL_TERRAIN_DIR ??
  join(process.cwd(), "portal-data", "terrain");
const dtmPath = join(terrainDir, site, "dtm.tif");
const haveRaster = existsSync(dtmPath);

// Small on purpose. This proves equivalence, and equivalence does not get more
// true on a bigger grid — it gets slower to check. 360x360 is large enough to
// cross tile and strip boundaries and small enough to run in a few seconds.
const SIDE = Number(option("side", 360));

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};
const skip = (label, why) => {
  console.log(`  skip ${label} — ${why}`);
  skipped += 1;
};

// ---------------------------------------------------------------------------
// Comparators
//
// Each returns { equal, detail }. `detail` names the first disagreement in a
// form that can be pasted into a debugger, because "arrays differ" costs the
// next engineer an hour that "index 4,182,003: 1342.5 vs 1342.4999" does not.

/**
 * Element-by-element with `Object.is`, not `===`.
 *
 * Two differences from `===`, and both are wanted here:
 *
 * - `Object.is(NaN, NaN)` is true. Nodata is often NaN, and `===` would report
 *   every nodata cell as a mismatch, burying the real ones.
 * - `Object.is(0, -0)` is **false**. Those are different bit patterns, and a
 *   native port that produces -0 where the reference produces 0 has a sign
 *   convention that differs somewhere. It is worth a failure: it is harmless in
 *   this cell and is evidence of something that will not be harmless in another.
 */
function compareArrays(a, b) {
  if (a.length !== b.length) {
    return { equal: false, detail: `lengths differ: ${a.length} vs ${b.length}` };
  }
  let differing = 0;
  let first = null;
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (Object.is(a[i], b[i])) continue;
    differing += 1;
    first ??= `index ${i.toLocaleString("en-US")}: ${a[i]} vs ${b[i]}`;
    const gap = Math.abs(a[i] - b[i]);
    if (Number.isFinite(gap) && gap > worst) worst = gap;
  }
  return differing === 0
    ? { equal: true, detail: `${a.length.toLocaleString("en-US")} elements identical` }
    : {
        equal: false,
        detail: `${differing.toLocaleString("en-US")} of ${a.length.toLocaleString("en-US")} differ, worst by ${worst}, first at ${first}`,
      };
}

/** Named numeric fields, same strictness. */
function compareScalars(a, b, fields) {
  for (const f of fields) {
    if (!Object.is(a[f], b[f])) return { equal: false, detail: `${f}: ${a[f]} vs ${b[f]}` };
  }
  return { equal: true, detail: fields.join(", ") + " all identical" };
}

/**
 * Rings, in order, to full coordinate precision.
 *
 * Order is part of the contract rather than an accident: two ports that emit the
 * same rings in a different order will serialise to different GeoJSON, and a
 * client diffing two exports would see every polygon as changed. But the two
 * failures are worth telling apart, because "same shapes, different order" is a
 * traversal-order difference that is cheap to fix and "different shapes" is a
 * geometry bug, so the detail says which one happened.
 */
function compareRings(a, b) {
  if (a.length !== b.length) {
    return { equal: false, detail: `ring counts differ: ${a.length} vs ${b.length}` };
  }
  const keyOf = (ring) => ring.map(([x, y]) => `${x},${y}`).join(" ");
  for (let r = 0; r < a.length; r += 1) {
    if (a[r].length !== b[r].length) {
      return { equal: false, detail: `ring ${r} has ${a[r].length} points vs ${b[r].length}` };
    }
    for (let p = 0; p < a[r].length; p += 1) {
      if (Object.is(a[r][p][0], b[r][p][0]) && Object.is(a[r][p][1], b[r][p][1])) continue;
      const sameSet =
        new Set(a.map(keyOf)).size === new Set([...a, ...b].map(keyOf)).size;
      return {
        equal: false,
        detail: sameSet
          ? `the same rings came back in a different order, first at ring ${r} point ${p}`
          : `ring ${r} point ${p}: [${a[r][p]}] vs [${b[r][p]}]`,
      };
    }
  }
  const points = a.reduce((sum, r) => sum + r.length, 0);
  return { equal: true, detail: `${a.length} rings, ${points.toLocaleString("en-US")} points identical` };
}

// ---------------------------------------------------------------------------
// Perturbation, for the sensitivity check
//
// The smallest change the type can represent, applied to one element in the
// middle. Not a large obvious change: a comparator that only catches a big error
// is a comparator that ships a small one.

/** The next representable float32 above `value`, through its bit pattern. */
function nextFloat32Up(value) {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = value;
  // Zero and NaN have no meaningful successor by increment; step off zero to the
  // smallest subnormal instead, which is still one ULP.
  if (Number.isNaN(value)) return 1;
  if (f[0] === 0) return 1.401298464324817e-45;
  u[0] += f[0] > 0 ? 1 : -1;
  return f[0];
}

function perturbArray(array) {
  const copy = array.slice();
  const at = Math.floor(copy.length / 2);
  if (copy instanceof Float32Array || copy instanceof Float64Array) {
    copy[at] = nextFloat32Up(copy[at]);
  } else {
    // An integer array: the smallest change is one count, wrapped so a byte at
    // 255 still moves.
    copy[at] = (copy[at] + 1) % 256;
  }
  return copy;
}

function perturbRings(rings) {
  const copy = rings.map((ring) => ring.map(([x, y]) => [x, y]));
  const r = Math.floor(copy.length / 2);
  copy[r][0][0] = nextFloat32Up(copy[r][0][0]);
  return copy;
}

// ---------------------------------------------------------------------------
// The candidate implementation
//
// Absent until a native kernel exists, which is the normal state of this file
// for the whole of phase 0. An import that fails is reported and does not stop
// the run, because a broken candidate must not be able to hide the reference
// checks that would have caught it.

const nativeSpecifier = process.env.GEO_NATIVE ?? option("native");
let native = null;
let nativeError = null;
if (nativeSpecifier) {
  try {
    native = await import(nativeSpecifier);
  } catch (error) {
    nativeError = error.message;
  }
}

// ---------------------------------------------------------------------------
// Fixtures

function syntheticGrid(width, height, { cellSize = 0.25 } = {}) {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      // A hole in the middle, because agreement on nodata handling is exactly
      // what a port gets wrong: the reference treats -32767 as absent and a
      // native version that treats it as an elevation still produces a picture.
      const hole = col > width * 0.6 && col < width * 0.7 && row > height * 0.3 && row < height * 0.5;
      data[row * width + col] = hole
        ? -32767
        : 120 +
          Math.abs(col - width / 2) * 0.004 -
          row * 0.0015 +
          Math.sin(col / 23) * 1.4 +
          Math.cos(row / 17) * 1.1 +
          Math.sin((col + row) / 9) * 0.35;
    }
  }
  return new Grid({
    width, height, cellSize, originX: 400_000, originY: 2_400_000 + height * cellSize,
    data, nodata: -32767, epsg: 32643,
  });
}

let grid;
let provenance;
if (haveRaster) {
  const source = cached(await fileSource(dtmPath));
  const raster = await openRaster(source);
  const side = Math.min(SIDE, raster.width, raster.height);
  grid = await raster.readWindow({
    col0: Math.floor((raster.width - side) / 2),
    row0: Math.floor((raster.height - side) / 2),
    cols: side,
    rows: side,
  });
  provenance = `${site} ${side}x${side} window`;
  await raster.close();
} else {
  grid = syntheticGrid(SIDE, SIDE);
  provenance = `synthetic ${SIDE}x${SIDE} grid (no raster at ${dtmPath})`;
}

const stats = grid.stats();
const range = stats.max - stats.min;
const floodLevel = stats.min + range * 0.25;
const seedCeiling = stats.min + range * 0.02;
const seeds = [];
for (let i = 0; i < grid.length; i += 1) {
  const v = grid.data[i];
  if (grid.isNoData(v) || v > seedCeiling) continue;
  const col = i % grid.width;
  seeds.push({ col, row: (i - col) / grid.width });
}

const ring = (() => {
  const [minX, minY, maxX, maxY] = grid.bounds;
  const ix = (maxX - minX) * 0.15;
  const iy = (maxY - minY) * 0.15;
  return [
    [minX + ix, minY + iy],
    [maxX - ix, minY + iy],
    [maxX - ix, maxY - iy],
    [minX + ix, maxY - iy],
    [minX + ix, minY + iy],
  ];
})();

/** Compressed chunks, for the one primitive whose input is bytes rather than cells. */
async function lzwFixture() {
  if (!haveRaster) return null;
  const source = await fileSource(dtmPath);
  const head = await source.read(0, 16);
  const little = head.readUInt16LE(0) === 0x4949;
  const big = (little ? head.readUInt16LE(2) : head.readUInt16BE(2)) === 43;
  const u16 = (b, o) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const u64 = (b, o) => {
    const lo = little ? b.readUInt32LE(o) : b.readUInt32BE(o + 4);
    const hi = little ? b.readUInt32LE(o + 4) : b.readUInt32BE(o);
    return hi * 4294967296 + lo;
  };
  const TYPE_BYTES = { 1: 1, 3: 2, 4: 4, 12: 8, 16: 8 };

  const ifd = big ? u64(head, 8) : u32(head, 4);
  const cb = await source.read(ifd, big ? 8 : 2);
  const count = big ? u64(cb, 0) : u16(cb, 0);
  const entrySize = big ? 20 : 12;
  const valueAt = big ? 12 : 8;
  const inline = big ? 8 : 4;
  const table = await source.read(ifd + (big ? 8 : 2), count * entrySize);

  const tags = new Map();
  for (let i = 0; i < count; i += 1) {
    const e = i * entrySize;
    const type = u16(table, e + 2);
    const n = big ? u64(table, e + 4) : u32(table, e + 4);
    const unit = TYPE_BYTES[type] ?? 1;
    let bytes = table;
    let base = e + valueAt;
    if (unit * n > inline) {
      bytes = await source.read(big ? u64(table, e + valueAt) : u32(table, e + valueAt), unit * n);
      base = 0;
    }
    const values = [];
    for (let k = 0; k < n; k += 1) {
      const o = base + k * unit;
      values.push(type === 3 ? u16(bytes, o) : type === 4 ? u32(bytes, o) : type === 16 ? u64(bytes, o) : bytes[o]);
    }
    tags.set(u16(table, e), values);
  }

  const one = (tag, fb) => (tags.has(tag) ? tags.get(tag)[0] : fb);
  if (one(259, 1) !== 5) {
    await source.close();
    return null;
  }
  const tiled = tags.has(324);
  const offsets = tiled ? tags.get(324) : tags.get(273);
  const counts = tiled ? tags.get(325) : tags.get(279);
  const width = one(256);
  const perChunk = tiled ? one(322) * one(323) : one(278, one(257)) * width;
  const expected = perChunk * (one(258, 32) / 8);

  // A handful from the middle. Equivalence on one tile and equivalence on six
  // hundred are the same claim; the extra tiles only cost time.
  const start = Math.floor(offsets.length / 2);
  const chunks = [];
  for (let i = start; i < Math.min(start + 6, offsets.length); i += 1) {
    chunks.push(await source.read(offsets[i], counts[i]));
  }
  await source.close();
  return { chunks, expected };
}

const lzw = await lzwFixture();

// ---------------------------------------------------------------------------
// The primitives
//
// `reference` is the JavaScript that is currently in production and is the
// standard. `nativeName` is the export a candidate module must provide, with the
// same signature as the reference, to be compared. `compare` decides what
// agreement means for this shape of result.

const PRIMITIVES = [
  {
    name: "lzwDecode",
    nativeName: "lzwDecode",
    // (input: Uint8Array, expectedBytes: number) => Uint8Array
    available: () => (lzw ? true : haveRaster ? "the raster is not LZW compressed" : `no raster at ${dtmPath}`),
    reference: (impl) => {
      const out = [];
      for (const bytes of lzw.chunks) out.push(impl.lzwDecode(bytes, lzw.expected));
      // Concatenated so a single comparator call covers every chunk and the
      // reported index points somewhere unambiguous.
      const all = new Uint8Array(out.length * lzw.expected);
      out.forEach((chunk, i) => all.set(chunk, i * lzw.expected));
      return all;
    },
    compare: compareArrays,
    perturb: perturbArray,
  },

  {
    name: "resample",
    nativeName: "resample",
    // (grid: Grid, targetCellSize: number) => Grid
    reference: (impl) => impl.resample(grid, Math.max(1, grid.cellSize * 4)).data,
    compare: compareArrays,
    perturb: perturbArray,
  },

  {
    name: "hillshade",
    nativeName: "hillshade",
    // (grid: Grid, options?) => Float32Array
    reference: (impl) => impl.hillshade(grid),
    compare: compareArrays,
    perturb: perturbArray,
  },

  {
    name: "renderGrid",
    nativeName: "renderGrid",
    // (grid: Grid, { stops, min, max, relief, ... }) => Uint8Array RGBA
    reference: (impl) =>
      impl.renderGrid(grid, {
        stops: rampFor("terrain"),
        min: stats.min,
        max: stats.max,
        relief: hillshade(grid),
      }),
    compare: compareArrays,
    perturb: perturbArray,
  },

  {
    name: "thresholdFlood (depth)",
    nativeName: "thresholdFlood",
    // (dem: Grid, level: number) => { depth: Grid, volume, cells, area }
    reference: (impl) => impl.thresholdFlood(grid, floodLevel).depth.data,
    compare: compareArrays,
    perturb: perturbArray,
  },

  {
    name: "connectedFlood (depth)",
    nativeName: "connectedFlood",
    // (dem: Grid, level: number, seeds: {col,row}[]) => { depth, volume, cells, area }
    available: () => (seeds.length > 0 ? true : "no cell on this grid sits low enough to seed a flood"),
    reference: (impl) => impl.connectedFlood(grid, floodLevel, seeds).depth.data,
    compare: compareArrays,
    perturb: perturbArray,
  },

  {
    name: "connectedFlood (volume and area)",
    nativeName: "connectedFlood",
    /**
     * Separate from the depth grid above because these are the numbers a client
     * is quoted and the ones that reach a report. A depth grid that agrees while
     * the summed volume does not means the summation order changed, and floating
     * point addition is not associative — which is a real and legitimate thing
     * for a parallel native kernel to do, and exactly the kind of divergence that
     * has to be discovered here rather than in a delivered figure.
     */
    available: () => (seeds.length > 0 ? true : "no cell on this grid sits low enough to seed a flood"),
    reference: (impl) => impl.connectedFlood(grid, floodLevel, seeds),
    compare: (a, b) => compareScalars(a, b, ["volume", "cells", "area"]),
    perturb: (result) => ({ ...result, volume: nextFloat32Up(result.volume) }),
  },

  {
    name: "polygonize",
    nativeName: "polygonize",
    // (mask: Grid<Uint8Array>, grid: Grid) => number[][][]
    available: () => {
      const { depth } = thresholdFlood(grid, floodLevel);
      let wet = 0;
      for (let i = 0; i < depth.length; i += 1) if (!depth.isNoData(depth.data[i]) && depth.data[i] > 0) wet += 1;
      return wet > 0 ? true : "nothing floods at this level, so there is no mask to trace";
    },
    reference: (impl) => {
      const { depth } = thresholdFlood(grid, floodLevel);
      const mask = grid.like(Uint8Array, 0, 255);
      for (let i = 0; i < depth.length; i += 1) {
        mask.data[i] = !depth.isNoData(depth.data[i]) && depth.data[i] > 0 ? 1 : 0;
      }
      return impl.polygonize(mask, grid);
    },
    compare: compareRings,
    perturb: perturbRings,
  },

  {
    name: "polygonStats",
    nativeName: "polygonStats",
    // (grid: Grid, ring: number[][]) => { area, min, max, mean, coveredArea, ... }
    reference: (impl) => impl.polygonStats(grid, ring),
    compare: (a, b) =>
      compareScalars(a, b, ["area", "perimeter", "min", "max", "mean", "coveredArea", "nodataArea"]),
    perturb: (result) => ({ ...result, mean: nextFloat32Up(result.mean) }),
  },
];

/** The reference module, assembled from the real exports rather than re-imported. */
const JS = {
  lzwDecode, resample, hillshade, renderGrid, thresholdFlood, connectedFlood, polygonize, polygonStats,
};

// ---------------------------------------------------------------------------
// Run

console.log(`\ngeo differential test`);
console.log(`  fixture   ${provenance}`);
console.log(`  reference src/lib/geo/*.mjs`);
console.log(
  `  candidate ${
    native
      ? nativeSpecifier
      : nativeError
        ? `${nativeSpecifier} FAILED TO IMPORT`
        : "none (set GEO_NATIVE to compare a native module)"
  }`,
);
if (nativeError) console.log(`            ${nativeError}`);

console.log("\nAgreement, and whether the comparison could see a disagreement at all");
for (const primitive of PRIMITIVES) {
  const availability = primitive.available ? primitive.available() : true;
  if (availability !== true) {
    skip(primitive.name, availability);
    continue;
  }

  const reference = primitive.reference(JS);

  // 1. The reference against itself. Proves the primitive is deterministic and
  //    that the harness is actually running it.
  const again = primitive.reference(JS);
  const same = primitive.compare(reference, again);
  check(`${primitive.name}: reference agrees with itself`, same.equal, same.detail);

  // 2. The reference against itself with one element moved by one ULP. This must
  //    be caught. A comparator that passes here is not comparing anything, and
  //    every agreement it ever reports afterwards is worthless.
  const nudged = primitive.perturb(again);
  const shouldDiffer = primitive.compare(reference, nudged);
  check(
    `${primitive.name}: a one-ULP change in a single element is caught`,
    !shouldDiffer.equal,
    shouldDiffer.equal ? "the comparator reported them identical, so it is not comparing" : shouldDiffer.detail,
  );
}

console.log("\nThe candidate implementation");
if (!native) {
  console.log(
    nativeError
      ? `  the module named in GEO_NATIVE could not be imported, so nothing was compared against it`
      : `  none supplied. When a native kernel exists, run:\n` +
        `    GEO_NATIVE=<module> node scripts/geo-differential-test.mjs\n` +
        `  and every export it shares with src/lib/geo/*.mjs is compared here, exactly.`,
  );
  if (nativeError) fail += 1;
} else {
  for (const primitive of PRIMITIVES) {
    const availability = primitive.available ? primitive.available() : true;
    if (availability !== true) {
      skip(`${primitive.name} against the candidate`, availability);
      continue;
    }
    if (typeof native[primitive.nativeName] !== "function") {
      skip(
        `${primitive.name} against the candidate`,
        `${nativeSpecifier} does not export ${primitive.nativeName}()`,
      );
      continue;
    }
    // The candidate is called through the same reference closure, with only the
    // named export swapped, so it is given precisely the inputs the reference
    // got — including the grid object, so a divergence cannot be blamed on the
    // harness having built two different fixtures.
    const reference = primitive.reference(JS);
    let candidate;
    try {
      candidate = primitive.reference({ ...JS, [primitive.nativeName]: native[primitive.nativeName] });
    } catch (error) {
      check(`${primitive.name} against the candidate`, false, `threw: ${error.message}`);
      continue;
    }
    const verdict = primitive.compare(reference, candidate);
    check(`${primitive.name} against the candidate`, verdict.equal, verdict.detail);
  }
}

console.log(
  `\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}` +
    (skipped ? `, ${skipped} skipped` : "") +
    "\n",
);
process.exit(fail ? 1 : 0);
