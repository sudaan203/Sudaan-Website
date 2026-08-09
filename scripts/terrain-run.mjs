/**
 * Universal tools 1 to 5 and 10, on the command line.
 *
 *   node scripts/terrain-run.mjs --dtm <file.tif> --op spot     --at E,N
 *   node scripts/terrain-run.mjs --dtm <file.tif> --op profile  --line "E,N E,N [...]"
 *   node scripts/terrain-run.mjs --dtm <file.tif> --op grid     --polygon "E,N ..." --spacing 1
 *   node scripts/terrain-run.mjs --dtm <file.tif> --op cutfill  --polygon "E,N ..." --reference plane:340
 *   node scripts/terrain-run.mjs --dtm <file.tif> --op diff     --against <other.tif>
 *
 * Add `--out <dir>` to write the exports, and `--rmse 0.04` to get an
 * uncertainty band on a volume.
 *
 * This is the analysis layer of the client dashboard with the HTTP and UI parts
 * removed, which is deliberate. The numbers are the part that can be quietly
 * wrong, so they are built and tested first, and phase 0 wires them to the map.
 * Everything here reads the source raster directly, at its native resolution in
 * its own projected CRS: no tiles, no Terrain-RGB quantisation, no Web Mercator
 * reprojection. That is what makes the portal stop adding error of its own.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readGeoTiff, writeGeoTiff } from "../src/lib/geo/raster.mjs";
import {
  spotLevel, profile, gridLevels, polygonStats, cutFill, surfaceDifference, REFERENCE,
} from "../src/lib/geo/terrain-analysis.mjs";
import {
  pointsToCsv, pointsToTxt, pointsToDxf, pointsToLandXml, profileToCsv, writePrj,
} from "../src/lib/geo/export-formats.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument ${flag}`);
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) { args[key] = true; continue; }
    args[key] = value;
    i += 1;
  }
  return args;
}

/** "E,N E,N E,N" into [[e,n],...]. Whitespace or semicolons between pairs. */
function parseCoords(text) {
  return String(text)
    .trim()
    .split(/[;\s]+/)
    .filter(Boolean)
    .map((pair) => {
      const [e, n] = pair.split(",").map(Number);
      if (!Number.isFinite(e) || !Number.isFinite(n)) {
        throw new Error(`cannot read "${pair}" as an easting,northing pair`);
      }
      return [e, n];
    });
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.dtm || !args.op) {
  console.log(`
  node scripts/terrain-run.mjs --dtm <file.tif> --op <operation> [options]

    --op spot     --at E,N
    --op profile  --line "E,N E,N [...]"  [--spacing 1]
    --op grid     --polygon "E,N E,N ..." [--spacing 1]
    --op cutfill  --polygon "E,N E,N ..." --reference <plane:Z | boundary | surface:file.tif>
    --op diff     --against <other.tif>

    --out <dir>   write exports (CSV, TXT, DXF, LandXML, .prj, GeoTIFF)
    --rmse <m>    survey vertical accuracy, for the uncertainty band on a volume

  Coordinates are easting and northing in the DTM's own projected CRS, never
  longitude and latitude.
`);
  process.exit(args.help ? 0 : 1);
}

const dem = readGeoTiff(args.dtm);
if (!dem.utmZone) {
  throw new Error(
    `${args.dtm} is EPSG ${dem.epsg ?? "unknown"}, not a UTM zone. Areas and volumes ` +
      `would be meaningless. Re-export in UTM.`,
  );
}
const stats = dem.stats();
const rmseZ = args.rmse === undefined ? null : Number(args.rmse);
const out = typeof args.out === "string" ? args.out : null;
if (out) mkdirSync(out, { recursive: true });

const write = (name, contents) => {
  if (!out) return;
  writeFileSync(join(out, name), contents);
  console.log(`  wrote ${name}`);
};
const m3 = (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} m3`;

console.log(`\n${args.dtm}`);
console.log(`  ${dem.width} x ${dem.height} at ${dem.cellSize.toFixed(4)} m, EPSG:${dem.epsg}`);
console.log(`  ${stats.min.toFixed(3)} to ${stats.max.toFixed(3)} m, ` +
  `${(stats.validFraction * 100).toFixed(1)}% carries data`);

// ---------------------------------------------------------------------------
if (args.op === "spot") {
  const [[x, y]] = parseCoords(args.at);
  const z = spotLevel(dem, x, y);
  console.log(`\nSpot level`);
  if (z === null) {
    console.log(`  ${x}, ${y} has no data. Outside the survey, or in a hole.`);
  } else {
    console.log(`  easting   ${x.toFixed(3)}`);
    console.log(`  northing  ${y.toFixed(3)}`);
    console.log(`  elevation ${z.toFixed(3)} m` +
      (rmseZ === null ? "" : `  +/- ${rmseZ.toFixed(3)} m`));
    console.log(`  bilinear from the source raster, EPSG:${dem.epsg}`);
    const points = [{ name: 1, easting: x, northing: y, elevation: z }];
    write("spot-level.csv", pointsToCsv(points, { epsg: dem.epsg }));
    write("spot-level.prj", writePrj(dem.epsg));
  }
}

// ---------------------------------------------------------------------------
else if (args.op === "profile") {
  const line = parseCoords(args.line);
  if (line.length < 2) throw new Error("--line needs at least two points");
  const spacing = args.spacing ? Number(args.spacing) : dem.cellSize;
  const p = profile(dem, line, { spacing });
  console.log(`\nCross section`);
  console.log(`  length        ${p.length.toFixed(2)} m, ${p.points.length} samples ` +
    `every ${spacing.toFixed(3)} m`);
  console.log(`  elevation     ${p.min === null ? "no data" : `${p.min.toFixed(3)} to ${p.max.toFixed(3)} m`}`);
  console.log(`  gain / loss   ${p.gain.toFixed(2)} m up, ${p.loss.toFixed(2)} m down`);
  console.log(`  grade         ${p.gradePercent === null ? "n/a" : `${p.gradePercent.toFixed(2)}% end to end`}`);
  console.log(`  steepest      ${p.maxSlopePercent.toFixed(2)}% between samples`);
  if (p.samplesWithoutData > 0) {
    console.log(`  WARNING       ${p.samplesWithoutData} samples fall outside the survey`);
  }
  write("section.csv", profileToCsv(p, { epsg: dem.epsg }));
  write("section.prj", writePrj(dem.epsg));
}

// ---------------------------------------------------------------------------
else if (args.op === "grid") {
  const ring = parseCoords(args.polygon);
  const spacing = args.spacing ? Number(args.spacing) : 1;
  const info = polygonStats(dem, ring);
  const g = gridLevels(dem, ring, spacing);
  console.log(`\nGrid levels`);
  console.log(`  polygon       ${info.area.toFixed(1)} m2 (${info.areaHectares.toFixed(3)} ha), ` +
    `perimeter ${info.perimeter.toFixed(1)} m`);
  console.log(`  elevation     ${info.min === null ? "no data" : `${info.min.toFixed(3)} to ${info.max.toFixed(3)} m, mean ${info.mean.toFixed(3)}`}`);
  console.log(`  points        ${g.points.length.toLocaleString()} at ${spacing} m spacing, ` +
    `snapped to the projected grid`);
  if (g.pointsOutsideSurvey > 0) {
    console.log(`  WARNING       ${g.pointsOutsideSurvey} grid nodes fall outside the survey`);
  }
  const named = g.points.map((p, i) => ({ ...p, name: i + 1 }));
  write("grid-levels.csv", pointsToCsv(named, { epsg: dem.epsg, label: `Grid levels at ${spacing} m` }));
  write("grid-levels.txt", pointsToTxt(named));
  write("grid-levels.dxf", pointsToDxf(named));
  write("grid-levels.xml", pointsToLandXml(named, { epsg: dem.epsg }));
  write("grid-levels.prj", writePrj(dem.epsg));
}

// ---------------------------------------------------------------------------
else if (args.op === "cutfill") {
  const ring = parseCoords(args.polygon);
  const spec = String(args.reference ?? "");
  let reference;
  if (spec.startsWith("plane:")) reference = REFERENCE.plane(Number(spec.slice(6)));
  else if (spec === "boundary") reference = REFERENCE.boundaryPlane(dem, ring);
  else if (spec.startsWith("surface:")) reference = REFERENCE.surface(readGeoTiff(spec.slice(8)));
  else {
    throw new Error(
      `--reference is required and must be plane:<elevation>, boundary, or surface:<file.tif>. ` +
        `A volume against an unstated reference is not a measurement.`,
    );
  }

  const r = cutFill(dem, ring, reference, { rmseZ });
  console.log(`\nCut and fill`);
  console.log(`  reference     ${r.reference}${spec.startsWith("plane:") ? ` at ${spec.slice(6)} m` : ""}`);
  console.log(`  area          ${r.polygonArea.toFixed(1)} m2 requested, ` +
    `${r.measuredArea.toFixed(1)} m2 measured`);
  console.log(`  cut           ${m3(r.cut)}  over ${r.cutArea.toFixed(0)} m2, deepest ${r.maxCutDepth.toFixed(3)} m`);
  console.log(`  fill          ${m3(r.fill)}  over ${r.fillArea.toFixed(0)} m2, deepest ${r.maxFillDepth.toFixed(3)} m`);
  console.log(`  net           ${m3(r.net)}  (cut minus fill, positive means material to export)`);
  console.log(`  mean depth    ${r.meanDepth === null ? "n/a" : `${r.meanDepth.toFixed(4)} m`}`);
  console.log(`  computed in   ${r.computedIn}, never in degrees`);
  if (r.uncertainty !== null) {
    console.log(`  uncertainty   +/- ${m3(r.uncertainty)} at ${r.rmseZ} m systematic vertical error`);
    const share = r.net === 0 ? Infinity : Math.abs(r.uncertainty / r.net) * 100;
    console.log(`                which is ${share === Infinity ? "unbounded" : `${share.toFixed(1)}%`} of the net volume`);
  } else {
    console.log(`  uncertainty   not stated. Pass --rmse to get a band; a bare volume invites`);
    console.log(`                a client to treat it as exact.`);
  }
  if (!r.complete) {
    console.log(`  WARNING       incomplete: ${r.nodataArea.toFixed(0)} m2 has no survey data, ` +
      `${r.referenceMissingArea.toFixed(0)} m2 has no reference`);
  }
  write("cut-fill.json", JSON.stringify(r, null, 2));
}

// ---------------------------------------------------------------------------
else if (args.op === "diff") {
  const older = readGeoTiff(args.against);
  const d = surfaceDifference(dem, older);
  console.log(`\nSurface comparison against ${args.against}`);
  console.log(`  compared      ${d.comparedArea.toFixed(0)} m2 where both surfaces carry data`);
  console.log(`  gained        ${m3(d.volumeGained)}`);
  console.log(`  lost          ${m3(d.volumeLost)}`);
  console.log(`  net           ${m3(d.netVolume)}`);
  console.log(`  change range  ${d.minChange === null ? "n/a" : `${d.minChange.toFixed(3)} to ${d.maxChange.toFixed(3)} m, mean ${d.meanChange.toFixed(4)}`}`);
  if (out) {
    writeGeoTiff(join(out, "difference.tif"), d.grid);
    console.log(`  wrote difference.tif`);
    write("difference.prj", writePrj(dem.epsg));
  }
} else {
  throw new Error(`unknown --op ${args.op}`);
}

console.log("");
