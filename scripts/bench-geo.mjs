/**
 * Timing the geospatial engine's hot primitives, so later claims are measured.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/bench-geo.mjs
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/bench-geo.mjs --site=aektanagar-survey --size=medium
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/bench-geo.mjs --json > before.json
 *
 * ## Why this exists
 *
 * Profiling a flood request found the portal is CPU bound inside JavaScript
 * rather than waiting on disk: decompressing a 1.6 km window cost 1,267 ms
 * against 51 ms of actual I/O, and the flood traversal and vectorisation on top
 * of it cost another 13.8 seconds. The plan from here replaces those inner loops
 * with native kernels.
 *
 * That plan is worth nothing without this file. "The Rust version is faster" is
 * an assertion; a number from the same harness before and after is a
 * measurement. So this runs *first*, before anything is optimised, and its
 * output is the baseline every later phase is diffed against with `--json`.
 *
 * ## What it deliberately does not do
 *
 * It does not average. A benchmark on a laptop competes with Spotlight, a
 * browser and whatever the OS decided to index this minute, and the mean of a
 * clean run and an interrupted one is a number that describes neither. The
 * median of several runs is reported alongside the min and the max, so a reader
 * can see the spread and distrust a row whose max is triple its min.
 *
 * It does not report the first run. V8 executes a hot loop interpreted before it
 * tiers up, so the first pass through `connectedFlood` can be several times
 * slower than the tenth. Production runs these functions warm, inside a server
 * process that has already served requests, so a cold first pass would flatter
 * the eventual native rewrite by measuring the interpreter rather than the
 * algorithm. One warmup run is discarded and that is stated in the output.
 *
 * It does not invent a number when a fixture is missing. A missing raster prints
 * SKIP and the reason. Reporting zero, or quietly substituting a synthetic grid
 * without saying so, would put a fabricated baseline into the JSON that a later
 * phase then "beats".
 *
 * ## Fixtures, and why the default is the small one
 *
 * `portal-data/terrain/<site>/dtm.tif`, overridable with `PORTAL_TERRAIN_DIR` or
 * `--terrain-dir`, which is the same lookup `src/lib/portal/terrain-source.ts`
 * does. The rasters are gitignored, so this must survive their absence.
 *
 * The default is `kotba-survey`: 6.8 MB, 2.2 M cells, and a stripped TIFF rather
 * than a tiled one. It runs in seconds and it is the one that is always present.
 * The larger surveys are opt-in through `--site` because the machine this runs on
 * is disk constrained and reading a 2.2 GB file to time a decoder is a poor
 * trade when a 6.8 MB one exercises the same code path.
 *
 * Where a benchmark needs a grid and no raster is available it synthesises one,
 * and the table says so in the scale column. The synthetic surface is ridged and
 * dissected rather than a plane, because a flood over a plane fills in one
 * rectangle and polygonises to four points, which would time the *absence* of
 * the work these functions exist to do.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { Grid, lzwDecode, resample, undoHorizontalPredictor } from "../src/lib/geo/raster.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { openRaster } from "../src/lib/geo/raster-window.mjs";
import { connectedFlood, thresholdFlood } from "../src/lib/geo/hydrology.mjs";
import { polygonize } from "../src/lib/geo/vectorise.mjs";
import { hillshade, renderGrid } from "../src/lib/geo/render.mjs";
import { rampFor } from "../src/lib/geo/colour.mjs";
import { polygonStats } from "../src/lib/geo/terrain-analysis.mjs";
import { simulateFlood } from "../src/lib/geo/flood.mjs";

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (flag("help")) {
  console.log(`
bench-geo — baseline timings for the geospatial engine's hot primitives

  --site=NAME         survey under the terrain directory (default kotba-survey)
  --size=NAME|CELLS   small (250k), medium (4M), large (40M), or a cell count
  --reps=N            measured runs per primitive (default scales with size)
  --only=A,B          run only primitives whose name contains one of these
  --list              print the primitive names and exit
  --terrain-dir=PATH  where <site>/dtm.tif lives (default PORTAL_TERRAIN_DIR)
  --json              emit machine-readable results instead of a table
`);
  process.exit(0);
}

/**
 * Sizes are cell counts, not window widths in metres.
 *
 * A metre window means something different on every survey — 1.6 km is 39.7 M
 * cells at Kiru's 0.254 m and 434 M cells at Aektanagar's 0.077 m — and the
 * thing being timed scales with cells. Naming the sizes in cells is what makes a
 * `small` run on one survey comparable to a `small` run on another.
 */
const SIZES = { small: 250_000, medium: 4_000_000, large: 40_000_000 };

const sizeArg = option("size", "small");
const targetCells = SIZES[sizeArg] ?? Number(sizeArg);
if (!Number.isFinite(targetCells) || targetCells < 100) {
  console.error(`bench-geo: --size must be one of ${Object.keys(SIZES).join(", ")} or a cell count, got "${sizeArg}"`);
  process.exit(2);
}

// Fewer repetitions as the work grows, so a large run stays minutes rather than
// hours. Three is the fewest that still has a middle value to take.
const defaultReps = targetCells <= SIZES.small ? 7 : targetCells <= SIZES.medium ? 5 : 3;
const reps = Number(option("reps", defaultReps));

const site = option("site", "kotba-survey");
const terrainDir =
  option("terrain-dir") ??
  process.env.PORTAL_TERRAIN_DIR ??
  join(process.cwd(), "portal-data", "terrain");
const dtmPath = join(terrainDir, site, "dtm.tif");

const onlyList = (option("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const wanted = (name) => onlyList.length === 0 || onlyList.some((p) => name.includes(p));

const asJson = flag("json");
// Progress goes to stderr so `--json > file` stays valid JSON while still
// showing which primitive a long run is currently stuck inside.
const progress = (line) => { if (asJson) process.stderr.write(line + "\n"); };

// ---------------------------------------------------------------------------
// Measurement

/**
 * Run something several times and keep every duration.
 *
 * The median is the *lower* median on an even count — an actually observed
 * duration rather than the average of two, which is a number no run produced and
 * which drifts when a future version of this file changes `reps`.
 */
async function measure(fn, { runs = reps, warmup = 1 } = {}) {
  for (let i = 0; i < warmup; i += 1) await fn();
  const samples = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    last = await fn();
    samples.push(performance.now() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples,
    value: last,
  };
}

const MB = 1048576;
const num = (n) => Math.round(n).toLocaleString("en-US");
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(1)} ms`);

/** Throughput in whatever unit the primitive counts, chosen so it reads well. */
function rate(scale, unit, milliseconds) {
  if (!scale || !milliseconds) return "—";
  const perSecond = scale / (milliseconds / 1000);
  if (unit === "bytes") return `${(perSecond / MB).toFixed(0)} MB/s`;
  if (unit === "cells") {
    return perSecond >= 1e6
      ? `${(perSecond / 1e6).toFixed(1)} Mcell/s`
      : `${num(perSecond)} cell/s`;
  }
  return `${num(perSecond)} ${unit}/s`;
}

/** How the scale column reads, so a row states what it processed, not just how fast. */
function scaleLabel(scale, unit) {
  if (!scale) return "—";
  if (unit === "bytes") return `${(scale / MB).toFixed(1)} MB`;
  if (unit === "cells") return `${num(scale)} cells`;
  return `${num(scale)} ${unit}`;
}

/** Keep the note column from wrapping a terminal; the full text stays in --json. */
const clip = (text, at = 62) => (text.length <= at ? text : `${text.slice(0, at - 1)}…`);

// ---------------------------------------------------------------------------
// Fixtures

/**
 * A synthetic surface with real structure, for when no raster is present.
 *
 * Ridged and dissected on purpose. `connectedFlood` on a plane visits every cell
 * in one uninterrupted sweep and `polygonize` traces one rectangle, so a plane
 * would time the easy case and call it the engine's speed. Interfering sine
 * ridges plus a valley falling to the south produce a flood that has to squeeze
 * between ridges and a mask with hundreds of separate rings, which is the shape
 * of the work a real DTM causes.
 */
function syntheticGrid(width, height, { cellSize = 0.25 } = {}) {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const valley = Math.abs(col - width / 2) * 0.004 - row * 0.0015;
      const ridges =
        Math.sin(col / 23) * 1.4 +
        Math.cos(row / 17) * 1.1 +
        Math.sin((col + row) / 9) * 0.35;
      data[row * width + col] = 120 + valley + ridges;
    }
  }
  return new Grid({
    width, height, cellSize, originX: 400_000, originY: 2_400_000 + height * cellSize,
    data, nodata: -32767, epsg: 32643,
  });
}

/**
 * The compressed chunks of a TIFF, with the size each one decodes to.
 *
 * `openRaster` deliberately does not expose these: nothing in production wants a
 * tile's raw bytes, only the cells that come out of it, and widening that
 * interface for a benchmark would be the benchmark changing the thing it
 * measures. So the directory is walked again here, for the five tags this needs
 * and nothing else.
 *
 * Feeding `lzwDecode` a real tile with its real `expectedBytes` is the whole
 * point. A synthetic buffer of repeated bytes compresses to almost nothing and
 * decodes at a speed that has no bearing on survey data, and passing a wrong
 * `expectedBytes` changes how many dictionary walks the decoder does before it
 * stops.
 */
async function tiffChunks(source) {
  const head = await source.read(0, 16);
  const little = head.readUInt16LE(0) === 0x4949;
  const version = little ? head.readUInt16LE(2) : head.readUInt16BE(2);
  const big = version === 43;

  const u16 = (b, o) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const u64 = (b, o) => {
    const lo = little ? b.readUInt32LE(o) : b.readUInt32BE(o + 4);
    const hi = little ? b.readUInt32LE(o + 4) : b.readUInt32BE(o);
    return hi * 4294967296 + lo;
  };
  const TYPE_BYTES = { 1: 1, 3: 2, 4: 4, 12: 8, 16: 8 };

  const ifdOffset = big ? u64(head, 8) : u32(head, 4);
  const countBytes = await source.read(ifdOffset, big ? 8 : 2);
  const count = big ? u64(countBytes, 0) : u16(countBytes, 0);
  const entrySize = big ? 20 : 12;
  const valueOffsetAt = big ? 12 : 8;
  const inlineCapacity = big ? 8 : 4;
  const table = await source.read(ifdOffset + (big ? 8 : 2), count * entrySize);

  const tags = new Map();
  for (let i = 0; i < count; i += 1) {
    const e = i * entrySize;
    const tag = u16(table, e);
    const type = u16(table, e + 2);
    const n = big ? u64(table, e + 4) : u32(table, e + 4);
    const unit = TYPE_BYTES[type] ?? 1;
    const size = unit * n;
    let bytes = table;
    let base = e + valueOffsetAt;
    if (size > inlineCapacity) {
      const at = big ? u64(table, e + valueOffsetAt) : u32(table, e + valueOffsetAt);
      bytes = await source.read(at, size);
      base = 0;
    }
    const values = [];
    for (let k = 0; k < n; k += 1) {
      const o = base + k * unit;
      if (type === 3) values.push(u16(bytes, o));
      else if (type === 4) values.push(u32(bytes, o));
      else if (type === 16) values.push(u64(bytes, o));
      else values.push(bytes[o]);
    }
    tags.set(tag, values);
  }

  const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag)[0] : fallback);
  const width = one(256);
  const height = one(257);
  const compression = one(259, 1);
  const bytesPerSample = one(258, 32) / 8;
  const predictor = one(317, 1);
  const tiled = tags.has(324);
  const offsets = tiled ? tags.get(324) : tags.get(273);
  const counts = tiled ? tags.get(325) : tags.get(279);
  const tileWidth = tiled ? one(322) : width;
  const tileHeight = tiled ? one(323) : one(278, height);

  return { compression, predictor, tiled, tileWidth, tileHeight, bytesPerSample, offsets, counts, width, height };
}

// ---------------------------------------------------------------------------
// Setting up

const results = [];
const record = (row) => { results.push(row); return row; };
const skip = (name, reason) => record({ name, status: "skip", reason });

const haveRaster = existsSync(dtmPath);
const missingReason =
  `no raster at ${dtmPath} — point --terrain-dir or PORTAL_TERRAIN_DIR at a directory containing <site>/dtm.tif`;

/**
 * The grid every in-memory primitive is timed against.
 *
 * Read from the survey where one exists, so the elevations, the nodata edges and
 * the local roughness are real. A window is placed in the middle of the raster
 * and sized to the requested cell count; where the raster has fewer cells than
 * asked for, the whole raster is used and the shortfall is stated rather than
 * padded, because padding with anything at all would be inventing terrain.
 */
let grid = null;
let gridProvenance = "";
let rasterInfo = null;
/**
 * One window, agreed on once and used by every raster-backed row.
 *
 * Shared rather than recomputed so the `lzwDecode` row decodes exactly the
 * chunks the `readWindow` row reads. If the two rows sized themselves
 * independently, subtracting one from the other to find the cost of addressing
 * and copying would be subtracting two different amounts of work, and the
 * conclusion drawn from it would be wrong in whichever direction the mismatch
 * happened to fall.
 */
let windowPlan = null;

if (haveRaster) {
  const source = cached(await fileSource(dtmPath));
  const raster = await openRaster(source);
  rasterInfo = {
    path: dtmPath,
    width: raster.width,
    height: raster.height,
    cellSize: raster.cellSize,
    tiled: raster.tiled,
    fileBytes: source.size,
  };

  const available = raster.width * raster.height;
  const side = Math.min(
    Math.floor(Math.sqrt(Math.min(targetCells, available))),
    Math.min(raster.width, raster.height),
  );
  windowPlan = {
    col0: Math.max(0, Math.floor((raster.width - side) / 2)),
    row0: Math.max(0, Math.floor((raster.height - side) / 2)),
    cols: side,
    rows: side,
  };

  progress(`reading a ${side}x${side} window from ${site}...`);
  grid = await raster.readWindow(windowPlan);
  gridProvenance =
    available < targetCells
      ? `${site} window (raster holds only ${num(available)} cells, ${num(targetCells)} asked for)`
      : `${site} window`;
  await raster.close();
} else {
  const side = Math.floor(Math.sqrt(targetCells));
  grid = syntheticGrid(side, side);
  gridProvenance = "synthetic (no raster present)";
}

const cells = grid.length;
const stats = grid.stats();
if (stats.count === 0) {
  console.error(`bench-geo: the ${gridProvenance} is entirely nodata, nothing to measure`);
  process.exit(2);
}

/**
 * A water level a quarter of the way up the surface, and seeds along the bottom.
 *
 * Both are derived from the grid rather than hardcoded, so the same run makes
 * sense on any survey. Seeding every cell in the lowest 2% of the range stands
 * in for the polygon a client draws over a river: one seed cell on a dissected
 * DTM often reaches almost nothing, which would time a traversal that never
 * happened.
 */
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

// ---------------------------------------------------------------------------
// The benchmarks

/**
 * The chunk byte ranges a windowed read touches, and their decoded size.
 *
 * Shared by the two rows that split "reading a window" into its halves, so
 * neither can drift from the other. Returns null when there is no raster.
 */
async function windowChunks() {
  const source = cached(await fileSource(dtmPath));
  const t = await tiffChunks(source);
  const { col0, row0, cols, rows } = windowPlan;
  const indices = [];
  if (t.tiled) {
    const across = Math.ceil(t.width / t.tileWidth);
    for (let ty = Math.floor(row0 / t.tileHeight); ty <= Math.floor((row0 + rows - 1) / t.tileHeight); ty += 1) {
      for (let tx = Math.floor(col0 / t.tileWidth); tx <= Math.floor((col0 + cols - 1) / t.tileWidth); tx += 1) {
        const index = ty * across + tx;
        if (index < t.offsets.length) indices.push(index);
      }
    }
  } else {
    for (let s = Math.floor(row0 / t.tileHeight); s <= Math.floor((row0 + rows - 1) / t.tileHeight); s += 1) {
      if (s < t.offsets.length) indices.push(s);
    }
  }
  // A strip is the raster's full width; a tile is square. Both decode to their
  // own cell count times the sample size.
  const cellsPerChunk = t.tiled ? t.tileWidth * t.tileHeight : t.tileHeight * t.width;
  return { source, tiff: t, indices, expected: cellsPerChunk * t.bytesPerSample };
}

const BENCHES = [
  {
    name: "source.read (I/O only)",
    /**
     * The same byte ranges the window needs, fetched and not decoded.
     *
     * This row exists because the entire optimisation plan rests on the claim
     * that the portal is CPU bound rather than waiting on disk, and that claim
     * should be a measurement in the same table rather than a remembered figure
     * from a profiling session. Read it against the `lzwDecode` row directly
     * beneath: if these are the same order of magnitude, a native decoder buys
     * nothing and the plan is wrong.
     *
     * Honest caveat, and it is a large one: the file's pages are in the OS cache
     * by the time this runs, because the setup already read this window to build
     * the grid. So this is the warm number — what a server that has served this
     * area before pays. A cold first request pays real disk on top, and this
     * harness cannot measure that without dropping the page cache, which needs
     * privileges a benchmark should not ask for.
     */
    async run() {
      if (!haveRaster) return { skip: missingReason };
      const { source, tiff, indices } = await windowChunks();
      await source.close();
      if (indices.length === 0) return { skip: "the window covers no chunk of this raster" };

      let bytes = 0;
      const timing = await measure(async () => {
        // A fresh handle per run, so this is the syscall path rather than the
        // span cache handing back what the previous run already fetched.
        const raw = await fileSource(dtmPath);
        bytes = 0;
        for (const i of indices) bytes += (await raw.read(tiff.offsets[i], tiff.counts[i])).length;
        await raw.close();
      });
      return {
        timing,
        scale: bytes,
        unit: "bytes",
        note: `${indices.length} ranges, warm page cache`,
      };
    },
  },

  {
    name: "lzwDecode",
    /**
     * The single most important row. 96% of the cost of "reading" a window is
     * this function, not the disk, so it is the first thing a native kernel
     * should replace and the first thing whose replacement has to be proved.
     *
     * Timed over a run of consecutive chunks rather than one, because a single
     * 256x256 tile decodes in well under a millisecond and `performance.now()`
     * would be measuring its own resolution.
     */
    async run() {
      if (!haveRaster) return { skip: missingReason };
      const { source, tiff, indices, expected } = await windowChunks();
      if (tiff.compression !== 5) {
        await source.close();
        return { skip: `${site}/dtm.tif is not LZW compressed (compression tag ${tiff.compression})` };
      }
      if (indices.length === 0) {
        await source.close();
        return { skip: "the window covers no chunk of this raster" };
      }

      // Fetched outside the timer. The row above times the fetching; this one
      // must be the decompression alone or neither number means anything.
      const chunks = [];
      let compressed = 0;
      for (const i of indices) {
        const bytes = await source.read(tiff.offsets[i], tiff.counts[i]);
        chunks.push(bytes);
        compressed += bytes.length;
      }
      await source.close();

      const raw = chunks.length * expected;
      const timing = await measure(() => {
        for (const bytes of chunks) {
          const out = lzwDecode(bytes, expected);
          if (tiff.predictor === 2) undoHorizontalPredictor(out, tiff.tileWidth, 1, tiff.bytesPerSample * 8);
        }
      });
      return {
        timing,
        scale: raw,
        unit: "bytes",
        note: `${chunks.length} ${tiff.tiled ? "tiles" : "strips"}, ${(compressed / MB).toFixed(1)} MB in, ${(raw / compressed).toFixed(1)}x ratio`,
      };
    },
  },

  {
    name: "openRaster (directory)",
    /**
     * Included to show it is *not* where the time goes. Kiru's directory lists
     * 38,000 tile offsets and it is tempting to blame the header parse for a
     * slow first request; this row settles that in one line rather than in an
     * argument.
     */
    async run() {
      if (!haveRaster) return { skip: missingReason };
      const timing = await measure(async () => {
        const source = cached(await fileSource(dtmPath));
        const raster = await openRaster(source);
        await raster.close();
      });
      return { timing, scale: 0, unit: "", note: "parse only, no image data" };
    },
  },

  {
    name: "readWindow",
    /**
     * Decode plus addressing plus the Float32 copy, which is the number a
     * request actually pays. It should sit slightly above the lzwDecode row; the
     * gap is the per-cell `pixelReader` call and the strided writes, and if that
     * gap is large it is worth its own kernel.
     */
    async run() {
      if (!haveRaster) return { skip: missingReason };
      let readBytes = 0;
      const timing = await measure(async () => {
        // Reopened every run. A cached source would serve the second run from
        // memory and report a decode-free window read as the cost of reading.
        const source = cached(await fileSource(dtmPath));
        const raster = await openRaster(source);
        await raster.readWindow(windowPlan);
        readBytes = source.stats.bytes;
        await raster.close();
      });
      return {
        timing,
        scale: windowPlan.cols * windowPlan.rows,
        unit: "cells",
        note: `${(readBytes / MB).toFixed(1)} MB of file touched, same window as lzwDecode`,
      };
    },
  },

  {
    name: "resample",
    /** Downsampling to 1 m is what makes hydrology tractable, so it is on the
     * path of every catchment request rather than an occasional utility. */
    async run() {
      const target = Math.max(1, grid.cellSize * 4);
      const timing = await measure(() => resample(grid, target));
      const out = timing.value;
      return {
        timing,
        scale: cells,
        unit: "cells",
        note: `${grid.cellSize.toFixed(3)} m to ${target.toFixed(2)} m, ${num(out.length)} cells out`,
      };
    },
  },

  {
    name: "hillshade",
    /** A 3x3 Horn kernel per cell with a hypot and two trig calls. Runs on every
     * rendered tile, under the colour. */
    async run() {
      const timing = await measure(() => hillshade(grid));
      return { timing, scale: cells, unit: "cells" };
    },
  },

  {
    name: "renderGrid + relief",
    /** The colour pass, given a relief computed once outside the timer, so this
     * row is the ramp sampling and the RGBA writes alone. */
    async run() {
      const stops = rampFor("terrain");
      const relief = hillshade(grid);
      const timing = await measure(() =>
        renderGrid(grid, { stops, min: stats.min, max: stats.max, relief }),
      );
      return { timing, scale: cells, unit: "cells", note: "hillshade computed outside the timer" };
    },
  },

  {
    name: "thresholdFlood",
    /** One linear pass, no traversal. The floor that connectedFlood's stack
     * discipline is paid on top of. */
    async run() {
      const timing = await measure(() => thresholdFlood(grid, floodLevel));
      return {
        timing,
        scale: cells,
        unit: "cells",
        note: `level ${floodLevel.toFixed(2)} m, ${num(timing.value.cells)} cells wet`,
      };
    },
  },

  {
    name: "connectedFlood",
    /** The same work plus an eight-way flood fill over an explicit stack. The
     * difference between this row and the one above is the cost of being right
     * about hilltop hollows. */
    async run() {
      if (seeds.length === 0) return { skip: "no cell sits low enough to seed a flood on this grid" };
      const timing = await measure(() => connectedFlood(grid, floodLevel, seeds));
      return {
        timing,
        scale: cells,
        unit: "cells",
        note: `${num(seeds.length)} seeds, ${num(timing.value.cells)} cells wet`,
      };
    },
  },

  {
    name: "polygonize",
    /** Tracing the flood mask. Cost is driven by the boundary rather than the
     * area, so a fragmented mask is far more expensive than a large simple one
     * of the same cell count — which is why the note reports the ring count. */
    async run() {
      const { depth } = thresholdFlood(grid, floodLevel);
      const mask = grid.like(Uint8Array, 0, 255);
      let wet = 0;
      for (let i = 0; i < depth.length; i += 1) {
        const d = depth.data[i];
        const isWet = !depth.isNoData(d) && d > 0;
        mask.data[i] = isWet ? 1 : 0;
        if (isWet) wet += 1;
      }
      if (wet === 0) return { skip: "nothing floods at this level, so there is no mask to trace" };
      const timing = await measure(() => polygonize(mask, grid));
      const rings = timing.value;
      const points = rings.reduce((sum, r) => sum + r.length, 0);
      return {
        timing,
        scale: cells,
        unit: "cells",
        note: `${num(rings.length)} rings, ${num(points)} points, from ${num(wet)} wet cells`,
      };
    },
  },

  {
    name: "polygonStats (4-point ring)",
    /** The drawn-polygon measurement path, and with it `cellCoverage`. */
    async run() {
      const [minX, minY, maxX, maxY] = grid.bounds;
      const insetX = (maxX - minX) * 0.1;
      const insetY = (maxY - minY) * 0.1;
      const ring = [
        [minX + insetX, minY + insetY],
        [maxX - insetX, minY + insetY],
        [maxX - insetX, maxY - insetY],
        [minX + insetX, maxY - insetY],
        [minX + insetX, minY + insetY],
      ];
      const timing = await measure(() => polygonStats(grid, ring));
      return {
        timing,
        scale: cells,
        unit: "cells",
        note: `${num(timing.value.coveredArea)} m² covered`,
      };
    },
  },

  {
    name: "polygonStats (64-point ring)",
    /**
     * The same area drawn as a circle instead of a box.
     *
     * Worth a second row because `cellCoverage` calls `pointInPolygon` at least
     * four times per candidate cell and `pointInPolygon` is linear in the ring's
     * vertex count, so the measurement is O(cells x vertices). A client tracing a
     * reservoir freehand produces hundreds of vertices, and if this row is many
     * times the one above then the vertex count, not the area, is what makes a
     * drawn measurement slow — which changes what is worth optimising.
     */
    async run() {
      const [minX, minY, maxX, maxY] = grid.bounds;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const r = Math.min(maxX - minX, maxY - minY) * 0.4;
      const ring = [];
      for (let i = 0; i <= 64; i += 1) {
        const a = (i / 64) * Math.PI * 2;
        ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      const timing = await measure(() => polygonStats(grid, ring));
      return { timing, scale: cells, unit: "cells", note: "65 vertices, same ground" };
    },
  },

  {
    name: "simulateFlood (12 levels)",
    /**
     * The composite the profiling actually complained about: twelve levels, each
     * a flood, a mask pass, a polygonize and a coordinate projection. It is here
     * so the sum of the primitive rows can be checked against the whole request,
     * and so a later phase cannot show a fast kernel while the request it sits
     * inside stays slow.
     */
    async run() {
      if (seeds.length === 0) return { skip: "no cell sits low enough to seed a flood on this grid" };
      const levels = [];
      for (let i = 1; i <= 12; i += 1) levels.push(stats.min + (range * 0.5 * i) / 12);
      const identity = ([x, y]) => [x, y];
      // One run each: at 40 M cells a single pass is already a minute, and the
      // spread of the primitives above already says how noisy the machine is.
      const runs = targetCells >= SIZES.large ? 1 : Math.min(3, reps);
      const timing = await measure(() => simulateFlood(grid, levels, seeds, range * 0.5 / 12, identity), {
        runs,
        warmup: 0,
      });
      const wettest = timing.value[timing.value.length - 1];
      return {
        timing,
        scale: cells * 12,
        unit: "cells",
        note: `${runs} run${runs === 1 ? "" : "s"}, no warmup; top level ${num(wettest.cells)} cells wet`,
      };
    },
  },
];

if (flag("list")) {
  for (const b of BENCHES) console.log(b.name);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Run

for (const bench of BENCHES) {
  if (!wanted(bench.name)) continue;
  progress(`  ${bench.name}...`);
  let outcome;
  try {
    outcome = await bench.run();
  } catch (error) {
    record({ name: bench.name, status: "error", reason: error.message });
    continue;
  }
  if (outcome.skip) {
    skip(bench.name, outcome.skip);
    continue;
  }
  const { timing, scale, unit, note } = outcome;
  record({
    name: bench.name,
    status: "ok",
    scale,
    unit,
    medianMs: Number(timing.median.toFixed(3)),
    minMs: Number(timing.min.toFixed(3)),
    maxMs: Number(timing.max.toFixed(3)),
    runs: timing.samples.length,
    perSecond: scale ? Number((scale / (timing.median / 1000)).toFixed(1)) : null,
    note: note ?? "",
  });
}

// ---------------------------------------------------------------------------
// Report

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // Not a checkout, or no git. The results are still valid, just harder to place.
}

/**
 * Everything needed to know whether two JSON runs are comparable.
 *
 * A speedup measured against a baseline taken on a different machine, a
 * different survey or a different cell count is not a speedup, and without this
 * block nothing in the file would say so.
 */
const environment = {
  when: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  cores: cpus().length,
  memoryGB: Number((totalmem() / 1024 ** 3).toFixed(1)),
  commit,
  site,
  size: sizeArg,
  targetCells,
  reps,
  grid: {
    provenance: gridProvenance,
    width: grid.width,
    height: grid.height,
    cells,
    cellSize: grid.cellSize,
    validFraction: Number(stats.validFraction.toFixed(4)),
    min: stats.min,
    max: stats.max,
  },
  raster: rasterInfo,
};

if (asJson) {
  console.log(JSON.stringify({ schema: 1, environment, results }, null, 2));
} else {
  const header = [
    "",
    `geo engine baseline — ${site}, size ${sizeArg}`,
    `  grid       ${grid.width} x ${grid.height} = ${num(cells)} cells at ${grid.cellSize.toFixed(3)} m, ${gridProvenance}`,
    `  elevation  ${stats.min.toFixed(2)} to ${stats.max.toFixed(2)} m, ${(stats.validFraction * 100).toFixed(1)}% of cells carry data`,
    rasterInfo
      ? `  raster     ${rasterInfo.width} x ${rasterInfo.height}, ${(rasterInfo.fileBytes / MB).toFixed(1)} MB, ${rasterInfo.tiled ? "tiled" : "stripped"}`
      : `  raster     none — ${missingReason}`,
    `  method     median of ${reps} runs after 1 discarded warmup, on ${cpus()[0]?.model ?? "unknown"} / node ${process.version}`,
    "",
  ];
  console.log(header.join("\n"));

  const rows = results.map((r) =>
    r.status === "ok"
      ? [r.name, scaleLabel(r.scale, r.unit), ms(r.medianMs), ms(r.minMs), ms(r.maxMs), rate(r.scale, r.unit, r.medianMs), clip(r.note)]
      : [r.name, r.status === "skip" ? "SKIP" : "ERROR", "", "", "", "", clip(r.reason)],
  );
  const head = ["primitive", "scale", "median", "min", "max", "throughput", ""];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells_) =>
    cells_
      .map((c, i) => (i === 0 || i === 6 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join("  ")
      .trimEnd();

  console.log("  " + line(head));
  console.log("  " + widths.slice(0, 6).map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log("  " + line(row));

  const failed = results.filter((r) => r.status === "error");
  const skipped = results.filter((r) => r.status === "skip");
  console.log(
    `\n  ${results.filter((r) => r.status === "ok").length} measured` +
      (skipped.length ? `, ${skipped.length} skipped` : "") +
      (failed.length ? `, ${failed.length} FAILED` : "") +
      ". Re-run with --json to record a baseline.\n",
  );
}

// A skipped benchmark is a missing fixture, not a broken engine, so it does not
// fail the run. An error inside a primitive does.
process.exit(results.some((r) => r.status === "error") ? 1 : 0);
