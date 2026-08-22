/**
 * Windowed reads must agree with whole file reads, cell for cell.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/raster-window-test.mjs
 *
 * ## The standard this has to meet
 *
 * There is already a reader that is known good: `readGeoTiff` decodes the whole
 * raster and 59 terrain checks plus a SAGA cross validation stand on it. So the
 * windowed reader is not tested against expectations, it is tested against that
 * reader, on the real survey files, and the tolerance is **exact equality**.
 * Not "close": the same bytes decoded twice must produce the same float, and any
 * drift means a tile index or a stride is wrong somewhere.
 *
 * Getting this subtly wrong is the whole risk. An off-by-one in tile addressing
 * shifts terrain by a few centimetres, which no one sees on a map and which
 * turns up later as a volume that will not reconcile.
 *
 * Both layouts are covered because the surveys use both: Aektanagar is BigTIFF
 * tiled 256x256 with overviews, Kotba is a classic stripped TIFF at one row per
 * strip.
 */

import { readGeoTiff } from "../src/lib/geo/raster.mjs";
import { cached, fileSource } from "../src/lib/geo/raster-source.mjs";
import { boundsOf, openRaster } from "../src/lib/geo/raster-window.mjs";
import {
  REFERENCE,
  cutFill,
  polygonStats,
  profile,
  spotLevel,
} from "../src/lib/geo/terrain-analysis.mjs";

const TILED = process.env.TILED ?? "portal-data/terrain/aektanagar-survey/dtm.tif";
const STRIPPED = process.env.STRIPPED ?? "portal-data/terrain/kotba-survey/dtm.tif";

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const near = (label, a, b, tol, unit = "") =>
  check(label, Number.isFinite(a) && Math.abs(a - b) <= tol, `got ${a}, want ${b} ±${tol}${unit}`);

async function open(path) {
  const source = cached(await fileSource(path));
  return { raster: await openRaster(source), source };
}

for (const [kind, path] of [["tiled", TILED], ["stripped", STRIPPED]]) {
  console.log(`\n${kind}: ${path}`);

  const whole = readGeoTiff(path);
  const { raster, source } = await open(path);

  check("dimensions agree", raster.width === whole.width && raster.height === whole.height,
    `${raster.width}x${raster.height} vs ${whole.width}x${whole.height}`);
  near("cell size agrees", raster.cellSize, whole.cellSize, 1e-12, " m");
  near("origin easting agrees", raster.originX, whole.originX, 1e-9, " m");
  near("origin northing agrees", raster.originY, whole.originY, 1e-9, " m");
  check("EPSG agrees", raster.epsg === whole.epsg, `${raster.epsg} vs ${whole.epsg}`);
  check("nodata agrees", Object.is(raster.nodata, whole.nodata), `${raster.nodata} vs ${whole.nodata}`);
  check("layout detected correctly", raster.tiled === (kind === "tiled"), `tiled=${raster.tiled}`);

  // A window in the middle, well away from every edge.
  const midCol = Math.floor(whole.width / 2);
  const midRow = Math.floor(whole.height / 2);
  const w = raster.windowFor([
    whole.originX + (midCol - 60) * whole.cellSize,
    whole.originY - (midRow + 60) * whole.cellSize,
    whole.originX + (midCol + 60) * whole.cellSize,
    whole.originY - (midRow - 60) * whole.cellSize,
  ]);
  const grid = await raster.readWindow(w);

  check("a window came back", grid !== null);
  check("the window is far smaller than the raster", grid.length < whole.length / 100,
    `${grid.length} of ${whole.length} cells`);

  {
    // Every cell, exactly. This is the check the rest of the file exists to set up.
    let mismatches = 0;
    let firstBad = null;
    for (let r = 0; r < grid.height; r += 1) {
      for (let c = 0; c < grid.width; c += 1) {
        const mine = grid.get(c, r);
        const theirs = whole.get(w.col0 + c, w.row0 + r);
        if (!Object.is(mine, theirs)) {
          mismatches += 1;
          firstBad ??= `at window (${c},${r}) raster (${w.col0 + c},${w.row0 + r}): ${mine} vs ${theirs}`;
        }
      }
    }
    check(`all ${grid.length} cells match the whole file read exactly`, mismatches === 0,
      mismatches ? `${mismatches} differ, first ${firstBad}` : "");
  }

  {
    // The origin shift is the part that makes the window usable by the analysis
    // untouched. If this is wrong every measurement lands in the wrong place
    // while still looking entirely plausible.
    let worst = 0;
    for (let c = 0; c < grid.width; c += 7) {
      worst = Math.max(worst, Math.abs(grid.xOf(c) - whole.xOf(w.col0 + c)));
    }
    for (let r = 0; r < grid.height; r += 7) {
      worst = Math.max(worst, Math.abs(grid.yOf(r) - whole.yOf(w.row0 + r)));
    }
    near("cell centres land at the same world coordinates", worst, 0, 1e-6, " m");
  }

  {
    /*
     * The measurement that matters, taken both ways.
     *
     * Not `Object.is` here, though the raw cells above are compared exactly and
     * must be. A spot level is interpolated, and the window computes its
     * fractional cell position from a shifted origin: `originX + col0 * cellSize`
     * rather than `originX`. Those are the same number in exact arithmetic and
     * differ by a few units in the last place in floating point, around an
     * easting of 367,781 m. The result moves by ~1e-11 m, which is a hundredth
     * of an angstrom against a survey accurate to 4 cm.
     *
     * A micrometre is therefore the standard: tight enough that a real
     * addressing error cannot hide under it, loose enough that it is not
     * measuring IEEE 754.
     */
    const x = whole.xOf(midCol);
    const y = whole.yOf(midRow);
    near("a spot level agrees read either way", spotLevel(grid, x, y), spotLevel(whole, x, y), 1e-6, " m");
  }

  {
    // A polygon, its statistics and its volume, computed on the whole raster and
    // on a window sized to it. These must not merely be close.
    const half = 30 * whole.cellSize;
    const cx = whole.xOf(midCol);
    const cy = whole.yOf(midRow);
    const ring = [
      [cx - half, cy - half],
      [cx + half, cy - half],
      [cx + half, cy + half],
      [cx - half, cy + half],
      [cx - half, cy - half],
    ];
    const windowed = await raster.readWindow(raster.windowFor(boundsOf(ring)));

    const sWhole = polygonStats(whole, ring);
    const sWin = polygonStats(windowed, ring);
    near("polygon area agrees", sWin.area, sWhole.area, 1e-6, " m²");
    check("minimum agrees exactly", Object.is(sWin.min, sWhole.min), `${sWin.min} vs ${sWhole.min}`);
    check("maximum agrees exactly", Object.is(sWin.max, sWhole.max), `${sWin.max} vs ${sWhole.max}`);
    near("mean agrees", sWin.mean, sWhole.mean, 1e-9, " m");
    near("covered area agrees", sWin.coveredArea, sWhole.coveredArea, 1e-6, " m²");

    const vWhole = cutFill(whole, ring, REFERENCE.plane(sWhole.mean), { rmseZ: 0.04 });
    const vWin = cutFill(windowed, ring, REFERENCE.plane(sWhole.mean), { rmseZ: 0.04 });
    near("cut agrees", vWin.cut, vWhole.cut, 1e-6, " m³");
    near("fill agrees", vWin.fill, vWhole.fill, 1e-6, " m³");
    near("net agrees", vWin.net, vWhole.net, 1e-6, " m³");

    // The rim reference samples the polygon boundary, which is exactly where a
    // window with too little margin would run out of cells.
    const rimWhole = cutFill(whole, ring, REFERENCE.boundaryPlane(whole, ring), { rmseZ: 0.04 });
    const rimWin = cutFill(windowed, ring, REFERENCE.boundaryPlane(windowed, ring), { rmseZ: 0.04 });
    near("a rim referenced volume agrees", rimWin.net, rimWhole.net, 1e-6, " m³");
  }

  {
    const cx = whole.xOf(midCol);
    const cy = whole.yOf(midRow);
    const line = [[cx - 40 * whole.cellSize, cy], [cx + 40 * whole.cellSize, cy]];
    const windowed = await raster.readWindow(raster.windowFor(boundsOf(line)));
    const pWhole = profile(whole, line, { spacing: whole.cellSize });
    const pWin = profile(windowed, line, { spacing: whole.cellSize });
    check("the profile has the same number of samples", pWin.points.length === pWhole.points.length);
    let worst = 0;
    for (let i = 0; i < pWhole.points.length; i += 1) {
      const a = pWhole.points[i].elevation;
      const b = pWin.points[i].elevation;
      if (a === null || b === null) {
        if (a !== b) worst = Infinity;
        continue;
      }
      worst = Math.max(worst, Math.abs(a - b));
    }
    near("every profile sample agrees", worst, 0, 1e-9, " m");
  }

  console.log(`  ...windowing read ${(source.stats.bytes / 1048576).toFixed(2)} MB in ${source.stats.requests} ranges`);

  await raster.close();
}

console.log("\nWindow geometry, where an off by one hides");
{
  const { raster, source } = await open(STRIPPED);
  const whole = readGeoTiff(STRIPPED);

  const full = raster.windowFor(raster.bounds, 0);
  check("the full extent windows to the whole raster",
    full.col0 === 0 && full.row0 === 0 && full.cols === whole.width && full.rows === whole.height,
    JSON.stringify(full));

  const topLeft = raster.windowFor([
    whole.originX, whole.originY - 2 * whole.cellSize,
    whole.originX + 2 * whole.cellSize, whole.originY,
  ]);
  check("a window at the top left corner clamps rather than going negative",
    topLeft.col0 === 0 && topLeft.row0 === 0, JSON.stringify(topLeft));

  const [minX, minY, maxX, maxY] = raster.bounds;
  const bottomRight = raster.windowFor([maxX - 2 * whole.cellSize, minY, maxX, minY + 2 * whole.cellSize]);
  check("a window at the bottom right stays inside the raster",
    bottomRight.col0 + bottomRight.cols <= whole.width &&
      bottomRight.row0 + bottomRight.rows <= whole.height,
    JSON.stringify(bottomRight));

  check("a box entirely off the raster returns no window",
    raster.windowFor([maxX + 1000, minY - 2000, maxX + 2000, minY - 1000]) === null);

  // A single cell, which is what a spot level asks for, and the case where a
  // missing margin bites: bilinear needs the neighbours.
  const cx = whole.xOf(10);
  const cy = whole.yOf(10);
  const tiny = await raster.readWindow(raster.windowFor([cx, cy, cx, cy]));
  check("a point sized window still carries neighbours for interpolation",
    tiny.width >= 3 && tiny.height >= 3, `${tiny.width}x${tiny.height}`);
  near("and interpolates to the same value as the whole raster",
    spotLevel(tiny, cx, cy), spotLevel(whole, cx, cy), 1e-6, " m");

  // Half on, half off. The window clamps, so the grid is smaller than asked for,
  // and cells with no file behind them must read as nodata rather than zero.
  const edge = raster.windowFor([maxX - 3 * whole.cellSize, minY, maxX + 50, minY + 50]);
  const edgeGrid = await raster.readWindow(edge);
  check("a window straddling the edge is clamped, not padded with zeros",
    edge.col0 + edge.cols === whole.width, JSON.stringify(edge));
  check("and nothing in it reads as a bare zero where the file ends",
    [...edgeGrid.data].every((v) => v !== 0 || !edgeGrid.isNoData(0)),
    "");

  await raster.close();
  void source;
}

console.log("\nCost: a window must not read the whole file");
{
  const { raster, source } = await open(TILED);
  const whole = readGeoTiff(TILED);
  const cx = whole.xOf(Math.floor(whole.width / 2));
  const cy = whole.yOf(Math.floor(whole.height / 2));
  const half = 50; // a 100 m square
  await raster.readWindow(raster.windowFor([cx - half, cy - half, cx + half, cy + half]));

  const readMB = source.stats.bytes / 1048576;
  const fileMB = 145;
  check("a hectare costs a small fraction of the file", readMB < fileMB * 0.15,
    `${readMB.toFixed(2)} MB read`);
  console.log(`  ...${readMB.toFixed(2)} MB in ${source.stats.requests} ranges, against a ${fileMB} MB file`);
  await raster.close();
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
