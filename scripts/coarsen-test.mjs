/**
 * `coarsen-dtm.mjs` against the in-memory `resample()` it has to agree with.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/coarsen-test.mjs
 *
 * The streaming coarsener exists because `resample()` needs the whole grid in
 * memory and the two largest surveys do not fit. That makes it a second
 * implementation of an arithmetic that already had one, and a second
 * implementation that quietly disagrees is worse than no second implementation:
 * hydrology would run on a subtly different surface and every catchment
 * boundary would move by an amount nobody could account for.
 *
 * So the check is equality, not similarity, on a survey small enough that both
 * paths can run. Kotba fits; Kiru and Ektanagar 2 are the reason the streaming
 * path exists and cannot be used to check it.
 *
 * Synthetic grids cover the parts real terrain does not exercise: an exact
 * integer ratio, nodata handling, and the refusal to upsample.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Grid, readGeoTiff, resample, writeGeoTiff } from "../src/lib/geo/raster.mjs";

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const work = mkdtempSync(join(tmpdir(), "coarsen-"));
const node = process.execPath;
const script = new URL("./coarsen-dtm.mjs", import.meta.url).pathname;

function coarsen(input, cell, out, expectFailure = false) {
  try {
    execFileSync(node, [script, "--dtm", input, "--cell", String(cell), "--out", out], {
      stdio: "pipe",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Every cell equal, and nodata in exactly the same places. */
function compare(label, a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    check(label, false, `${a.width}x${a.height} against ${b.width}x${b.height}`);
    return;
  }
  let worst = 0;
  let nodataDisagreements = 0;
  let bothData = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    const an = a.isNoData(a.data[i]);
    const bn = b.isNoData(b.data[i]);
    if (an !== bn) { nodataDisagreements += 1; continue; }
    if (an) continue;
    bothData += 1;
    worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
  }
  check(
    label,
    nodataDisagreements === 0 && worst === 0,
    `${bothData} cells compared, ${nodataDisagreements} nodata disagreements, ` +
      `worst ${worst.toExponential(2)} m`,
  );
}

console.log("\nAgainst the in-memory resample, on a survey where both can run");
{
  const source = "portal-data/terrain/kotba-survey/dtm.tif";
  if (!existsSync(source)) {
    console.log(`  SKIPPED: no ${source}; this check needs a real survey on disk.`);
  } else {
    const whole = readGeoTiff(source);
    for (const cell of [1, 2.5]) {
      const out = join(work, `kotba-${cell}.tif`);
      const run = coarsen(source, cell, out);
      if (!run.ok) { check(`coarsening to ${cell} m succeeds`, false, run.message.slice(0, 200)); continue; }
      compare(`at ${cell} m it agrees cell for cell`, resample(whole, cell), readGeoTiff(out));
    }
  }
}

console.log("\nOn a synthetic grid, where the answer is known by hand");
{
  /*
   * A 4x4 ramp at 1 m coarsened to 2 m: each output cell is the mean of an
   * exact 2x2 block, so the expected values can be written down rather than
   * computed by the thing under test.
   */
  const data = new Float32Array([
    1, 2, 3, 4,
    5, 6, 7, 8,
    9, 10, 11, 12,
    13, 14, 15, 16,
  ]);
  const grid = new Grid({
    width: 4, height: 4, cellSize: 1, originX: 100, originY: 200,
    data, nodata: -9999, crs: null, epsg: 32643,
  });
  const input = join(work, "ramp.tif");
  writeGeoTiff(input, grid);
  const out = join(work, "ramp-2m.tif");
  const run = coarsen(input, 2, out);
  check("an exact 2x zoom out succeeds", run.ok, run.ok ? "" : run.message.slice(0, 200));
  if (run.ok) {
    const got = readGeoTiff(out);
    check("it is half the size in each direction", got.width === 2 && got.height === 2,
      `${got.width}x${got.height}`);
    // Means of [1,2,5,6], [3,4,7,8], [9,10,13,14], [11,12,15,16].
    const want = [3.5, 5.5, 11.5, 13.5];
    const same = want.every((v, i) => Math.abs(got.data[i] - v) < 1e-6);
    check("each output cell is the mean of its 2x2 block", same, `got ${Array.from(got.data).join(", ")}`);
    check("the origin is unchanged", got.originX === 100 && got.originY === 200,
      `${got.originX}, ${got.originY}`);
  }
}

console.log("\nnodata is carried, never averaged in as a number");
{
  const data = new Float32Array([
    1, 1, -9999, -9999,
    1, 1, -9999, -9999,
    -9999, -9999, -9999, -9999,
    -9999, -9999, -9999, -9999,
  ]);
  const grid = new Grid({
    width: 4, height: 4, cellSize: 1, originX: 0, originY: 0,
    data, nodata: -9999, crs: null, epsg: 32643,
  });
  const input = join(work, "holes.tif");
  writeGeoTiff(input, grid);
  const out = join(work, "holes-2m.tif");
  const run = coarsen(input, 2, out);
  check("it succeeds with nodata present", run.ok, run.ok ? "" : run.message.slice(0, 200));
  if (run.ok) {
    const got = readGeoTiff(out);
    check("a fully covered block keeps its value", Math.abs(got.data[0] - 1) < 1e-6, String(got.data[0]));
    check(
      "a block with no data at all is nodata, not zero",
      got.isNoData(got.data[1]) && got.isNoData(got.data[2]) && got.isNoData(got.data[3]),
      Array.from(got.data).join(", "),
    );
  }
}

console.log("\nRefusals");
{
  const grid = new Grid({
    width: 4, height: 4, cellSize: 5, originX: 0, originY: 0,
    data: new Float32Array(16), nodata: -9999, crs: null, epsg: 32643,
  });
  const input = join(work, "coarse.tif");
  writeGeoTiff(input, grid);
  const run = coarsen(input, 1, join(work, "nope.tif"));
  check("upsampling is refused rather than inventing detail", !run.ok,
    run.ok ? "it produced a file" : "");
  check("and says why", /invent detail/.test(run.message ?? ""), (run.message ?? "").slice(0, 120));
}

rmSync(work, { recursive: true, force: true });

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
