/**
 * Write a coarser DTM from one of any size, without ever holding it in memory.
 *
 *   node scripts/coarsen-dtm.mjs --dtm <in.tif> --cell 1 --out <out.tif>
 *
 * ## Why this exists
 *
 * `hydro-run.mjs` resamples internally, but only after `readGeoTiff(args.dtm)`,
 * which reads the whole file. That caps it at surveys small enough to load
 * twice over: `readFileSync` refuses anything past 2 GiB outright, and even
 * under that a 734M cell DTM is a 2.9 GB Float32Array before resampling starts.
 *
 * So the two largest surveys cannot go through it. Kiru did not: someone
 * produced `kiru-dtm-5m.tif` by hand and fed hydrology that instead, which is
 * why its manifest records a 5 m source. That step was never written down and
 * cannot be repeated from the repository. This is that step.
 *
 * Hydrology is the caller that needs it. Flow routing cannot be windowed —
 * water arrives from outside whatever box you draw — so accumulation has to see
 * the whole grid at once, and the only way a large survey fits is at a coarser
 * analysis cell.
 *
 * ## How
 *
 * One streaming pass over the source in horizontal bands, accumulating each
 * source cell into the output cells it overlaps, weighted by the overlapping
 * area. That is the same area-weighted average `resample()` in raster.mjs
 * computes, arranged so the source is consumed a band at a time instead of
 * whole: the accumulators are sized by the *output*, which is small, and the
 * band is the only part of the source ever resident.
 *
 * Averaging rather than sampling is deliberate. Taking every Nth cell would
 * keep whichever cells happened to land on the lattice, and on a drainage
 * network that means a one cell channel either survives at full depth or
 * vanishes, depending on its phase. Averaging carries it through as a shallower
 * channel, which is what a coarser model of the same ground should look like.
 *
 * nodata is carried by weight: a cell with no valid source coverage is written
 * as nodata rather than zero, because zero is an elevation and would read as a
 * hole at sea level.
 */

import { Grid, writeGeoTiff } from "../src/lib/geo/raster.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { openRaster } from "../src/lib/geo/raster-window.mjs";

function parseArgs(argv) {
  const args = { cell: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dtm") { args.dtm = value; i += 1; }
    else if (flag === "--out") { args.out = value; i += 1; }
    else if (flag === "--cell") { args.cell = Number(value); i += 1; }
    else if (flag === "--band") { args.band = Number(value); i += 1; }
    else { console.error(`Unknown flag ${flag}`); process.exit(1); }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dtm || !args.out) {
  console.error("Usage: node scripts/coarsen-dtm.mjs --dtm <in.tif> --out <out.tif> [--cell 1]");
  process.exit(1);
}
if (!Number.isFinite(args.cell) || args.cell <= 0) {
  console.error(`--cell must be a positive number of metres, got ${args.cell}`);
  process.exit(1);
}

const raster = await openRaster(cached(await fileSource(args.dtm)));
const { width, height, cellSize, originX, originY, epsg, nodata } = raster;

if (args.cell < cellSize - 1e-12) {
  console.error(
    `Refusing to upsample from ${cellSize} m to ${args.cell} m: that would invent ` +
      `detail the survey does not contain.`,
  );
  process.exit(1);
}

const outWidth = Math.max(1, Math.round((width * cellSize) / args.cell));
const outHeight = Math.max(1, Math.round((height * cellSize) / args.cell));

console.log(`\n${args.dtm}`);
console.log(`  source   ${width} x ${height} at ${cellSize.toFixed(4)} m (${(width * height / 1e6).toFixed(1)}M cells), EPSG:${epsg}`);
console.log(`  output   ${outWidth} x ${outHeight} at ${args.cell} m (${(outWidth * outHeight / 1e6).toFixed(2)}M cells)`);

/*
 * Float64 accumulators: a 734M cell survey summing into 4M output cells puts
 * tens of thousands of additions through each one, and Float32 loses the low
 * bits of a running total long before that. The output is written as Float32,
 * which is what the format holds, but the arithmetic getting there is not.
 */
const sums = new Float64Array(outWidth * outHeight);
const weights = new Float64Array(outWidth * outHeight);

/** Source rows per band. Bounded by memory, not by correctness. */
const bandRows = args.band ?? Math.max(1, Math.floor((32 * 1024 * 1024) / (width * 4)));
const ratio = cellSize / args.cell;

let done = 0;
const startedAt = Date.now();
for (let top = 0; top < height; top += bandRows) {
  const rows = Math.min(bandRows, height - top);
  const window = raster.windowFor([
    originX,
    originY - (top + rows) * cellSize,
    originX + width * cellSize,
    originY - top * cellSize,
  ]);
  if (!window) continue;
  const band = await raster.readWindow(window);

  for (let r = 0; r < band.height; r += 1) {
    // This source row's extent in output rows.
    const y0 = (top + r) * ratio;
    const y1 = (top + r + 1) * ratio;
    const outR0 = Math.max(0, Math.floor(y0));
    const outR1 = Math.min(outHeight - 1, Math.ceil(y1) - 1);

    for (let c = 0; c < band.width; c += 1) {
      const v = band.data[r * band.width + c];
      if (band.isNoData(v)) continue;
      const x0 = c * ratio;
      const x1 = (c + 1) * ratio;
      const outC0 = Math.max(0, Math.floor(x0));
      const outC1 = Math.min(outWidth - 1, Math.ceil(x1) - 1);

      for (let outR = outR0; outR <= outR1; outR += 1) {
        const hy = Math.min(y1, outR + 1) - Math.max(y0, outR);
        if (hy <= 0) continue;
        for (let outC = outC0; outC <= outC1; outC += 1) {
          const hx = Math.min(x1, outC + 1) - Math.max(x0, outC);
          if (hx <= 0) continue;
          const at = outR * outWidth + outC;
          const w = hx * hy;
          sums[at] += v * w;
          weights[at] += w;
        }
      }
    }
  }

  done += rows;
  const pct = ((done / height) * 100).toFixed(0);
  process.stdout.write(`\r  reading  ${pct}% (${done} of ${height} rows)`);
}
process.stdout.write("\n");

const NODATA = Number.isFinite(nodata) ? nodata : -9999;
const data = new Float32Array(outWidth * outHeight);
let covered = 0;
for (let i = 0; i < data.length; i += 1) {
  if (weights[i] > 0) { data[i] = sums[i] / weights[i]; covered += 1; }
  else data[i] = NODATA;
}

const out = new Grid({
  width: outWidth,
  height: outHeight,
  cellSize: args.cell,
  originX,
  originY,
  data,
  nodata: NODATA,
  crs: null,
  epsg,
});

writeGeoTiff(args.out, out, { epsg });
await raster.close();

console.log(`  covered  ${((covered / data.length) * 100).toFixed(1)}% of output cells carry data`);
console.log(`  wrote    ${args.out} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
