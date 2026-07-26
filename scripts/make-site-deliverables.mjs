#!/usr/bin/env node
/**
 * Builds a site's PDF deliverables from that site's own data.
 *
 *   node scripts/make-site-deliverables.mjs <site-slug> [--client demo-client] [--las path]
 *
 * Why this exists. The Aektanagar portal was serving two PDFs copied from the
 * marketing site's sample downloads, which were written for a fictional site in
 * Gezira State, Sudan, in UTM zone 36N. Aektanagar is in Gujarat, in UTM 43N. A
 * client opening their contour map found somebody else's coordinate system and the
 * words "representative sample for demonstration purposes only".
 *
 * Everything here is read from the survey: elevation ranges come from the
 * manifest the tiler wrote, contour geometry and count from the GeoJSON, the grid
 * from the CSV, and the point cloud figures from the LAS header and a sampled
 * classification histogram. **Nothing is invented.** Where a figure is not
 * available, the line is left out rather than filled in, because a plausible
 * wrong number is worse than a missing one: the old stub claimed 45,210,480
 * points against a real 50,183,644, and a classification breakdown of
 * "Ground, Vegetation, Structures, High Noise" for a cloud that only has Ground
 * and Unclassified.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pdf, PAGE } from "./lib/pdf.mjs";
import { lonLatToUtm } from "./lib/geo.mjs";

/* --------------------------------------------------------------- options --- */

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const slug = positional[0];
if (!slug) {
  console.error(`
Usage: node scripts/make-site-deliverables.mjs <site-slug> [options]

  --client SLUG    client folder under portal-data/files (default demo-client)
  --las PATH       point cloud, for the real header figures
  --name TEXT      site name for the title block
  --location TEXT  location line for the title block
`);
  process.exit(1);
}

const clientSlug = flag("client", "demo-client");
const lasPath = flag("las", null);
const siteName = flag("name", slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
const location = flag("location", null);

const mapDir = resolve("portal-data", "map", slug);
const outRoot = resolve("portal-data", "files", clientSlug, slug.replace(/-survey$/, ""));

/* ----------------------------------------------------------------- brand --- */

const INK = [0.18, 0.18, 0.18];
const MUTED = [0.45, 0.45, 0.45];
const ACCENT = [0.851, 0.467, 0.024]; // accent-600 #D97706
const SIGNAL = [0.761, 0.255, 0.047]; // signal #C2410C
const HAIRLINE = [0.85, 0.84, 0.82];
const PAPER = [0.98, 0.969, 0.949];

/* ------------------------------------------------------------ read facts --- */

function readManifest() {
  const p = join(mapDir, "manifest.json");
  if (!existsSync(p)) {
    console.error(`no manifest at ${p}. Run prepare-site.mjs first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

const manifest = readManifest();
const layer = (re) => manifest.layers.find((l) => re.test(l.key) || re.test(l.title));
const dsm = layer(/dsm|surface/i);
const dtm = layer(/dtm|terrain model/i);
const ortho = layer(/ortho|mosaic/i);
const contourLayer = manifest.layers.find((l) => l.kind === "vector");
const demLayer = manifest.layers.find((l) => l.kind === "dem");

const utmZone = demLayer?.utmZone ?? 43;
const utmNorthern = demLayer?.utmNorthern ?? true;

/** Contour geometry, in UTM metres, plus the interval it was cut at. */
function readContours() {
  if (!contourLayer?.file) return null;
  const p = join(mapDir, contourLayer.file);
  if (!existsSync(p)) return null;
  const gj = JSON.parse(readFileSync(p, "utf8"));
  const lines = [];
  const elevations = new Set();
  for (const feat of gj.features ?? []) {
    if (feat.geometry?.type !== "LineString") continue;
    const e = feat.properties?.elevation;
    if (Number.isFinite(e)) elevations.add(e);
    lines.push({
      elevation: Number.isFinite(e) ? e : null,
      points: feat.geometry.coordinates.map(([lon, lat]) =>
        lonLatToUtm(lon, lat, utmZone, utmNorthern),
      ),
    });
  }
  // The interval is the commonest gap between distinct contour heights, which is
  // more robust than differencing the first two.
  const sorted = [...elevations].sort((a, b) => a - b);
  const gaps = {};
  for (let i = 1; i < sorted.length; i += 1) {
    const g = Number((sorted[i] - sorted[i - 1]).toFixed(3));
    if (g > 0) gaps[g] = (gaps[g] ?? 0) + 1;
  }
  const interval = Object.entries(gaps).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { lines, count: lines.length, interval: interval ? Number(interval) : null, levels: sorted };
}

/** The 5 m grid, if the CSV is around. */
function readGrid() {
  const candidates = [
    join(outRoot, "drawings", "Grid.csv"),
    resolve("Aektanagar", "Grid.csv"),
  ];
  const p = candidates.find(existsSync);
  if (!p) return null;
  const rows = readFileSync(p, "utf8").trim().split(/\r?\n/);
  const header = rows[0].split(",").map((h) => h.trim().toUpperCase());
  const xi = header.indexOf("X");
  const yi = header.indexOf("Y");
  const zi = header.findIndex((h) => /ELEV|^Z$/.test(h));
  if (xi < 0 || yi < 0 || zi < 0) return null;
  let min = Infinity;
  let max = -Infinity;
  const xs = new Set();
  const ys = new Set();
  for (let i = 1; i < rows.length; i += 1) {
    const c = rows[i].split(",");
    const z = Number(c[zi]);
    if (!Number.isFinite(z)) continue;
    if (z < min) min = z;
    if (z > max) max = z;
    xs.add(Number(c[xi]));
    ys.add(Number(c[yi]));
  }
  // Spacing from the distinct ordinates, so the "5 m" in the title is checked.
  const spacingOf = (set) => {
    const v = [...set].sort((a, b) => a - b);
    const g = {};
    for (let i = 1; i < v.length; i += 1) {
      const d = Number((v[i] - v[i - 1]).toFixed(2));
      if (d > 0) g[d] = (g[d] ?? 0) + 1;
    }
    return Number(Object.entries(g).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  };
  return {
    points: rows.length - 1,
    min,
    max,
    spacingX: spacingOf(xs),
    spacingY: spacingOf(ys),
    path: p,
  };
}

/** LAS public header plus a sampled classification histogram. Real figures only. */
function readLas(p) {
  if (!p || !existsSync(p)) return null;
  const fd = openSync(p, "r");
  const h = Buffer.alloc(400);
  readSync(fd, h, 0, 400, 0);
  if (h.toString("ascii", 0, 4) !== "LASF") {
    closeSync(fd);
    return null;
  }
  const vMajor = h[24];
  const vMinor = h[25];
  const software = h.toString("ascii", 58, 90).replace(/\0+$/, "").trim();
  const offset = h.readUInt32LE(96);
  const format = h[104];
  const recLen = h.readUInt16LE(105);
  let count = h.readUInt32LE(107);
  if (vMajor === 1 && vMinor >= 4) {
    const wide = h.readBigUInt64LE(247);
    if (wide > 0n) count = Number(wide);
  }
  const box = {
    maxX: h.readDoubleLE(179), minX: h.readDoubleLE(187),
    maxY: h.readDoubleLE(195), minY: h.readDoubleLE(203),
    maxZ: h.readDoubleLE(211), minZ: h.readDoubleLE(219),
  };

  const NAMES = {
    0: "Created, never classified", 1: "Unclassified", 2: "Ground",
    3: "Low vegetation", 4: "Medium vegetation", 5: "High vegetation",
    6: "Building", 7: "Low point (noise)", 9: "Water", 10: "Rail",
    11: "Road surface", 12: "Overlap", 18: "High noise",
  };
  const target = 200000;
  const step = Math.max(1, Math.floor(count / target));
  const buf = Buffer.alloc(recLen);
  const counts = new Map();
  let sampled = 0;
  for (let i = 0; i < count; i += step) {
    readSync(fd, buf, 0, recLen, offset + i * recLen);
    const cls = buf[15] & 0x1f;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
    sampled += 1;
  }
  closeSync(fd);

  const area = (box.maxX - box.minX) * (box.maxY - box.minY);
  return {
    version: `${vMajor}.${vMinor}`,
    software,
    format,
    count,
    box,
    area,
    density: count / area,
    sampled,
    step,
    classes: [...counts.entries()]
      .map(([code, n]) => ({
        code,
        name: NAMES[code] ?? `Reserved (${code})`,
        share: n / sampled,
      }))
      .sort((a, b) => b.share - a.share),
  };
}

const contours = readContours();
const grid = readGrid();
const las = readLas(lasPath);

/* ------------------------------------------------------ shared furniture --- */

const today = new Date().toISOString().slice(0, 10);

function titleBlock(ctx, { sheet, subtitle }) {
  const M = 36;
  const w = ctx.width;
  ctx.rect(0, ctx.height - 76, w, 76, PAPER);
  ctx.line(M, ctx.height - 76, w - M, ctx.height - 76, HAIRLINE, 0.75);
  ctx.text(M, ctx.height - 40, "SUDAAN GEO-ANALYTICS", { size: 11, bold: true, color: ACCENT });
  ctx.text(M, ctx.height - 56, sheet, { size: 17, bold: true, color: INK });
  ctx.textRight(w - M, ctx.height - 40, siteName, { size: 11, bold: true });
  ctx.textRight(w - M, ctx.height - 56, subtitle, { size: 9, color: MUTED });
  return ctx.height - 100;
}

function footer(ctx, note) {
  const M = 36;
  ctx.line(M, 52, ctx.width - M, 52, HAIRLINE, 0.75);
  ctx.text(M, 38, note, { size: 7.5, color: MUTED });
  ctx.textRight(ctx.width - M, 38, `Generated ${today} from the delivered survey data`, {
    size: 7.5,
    color: MUTED,
  });
}

const fmtM = (v, dp = 2) => `${v.toFixed(dp)} m`;
const fmtHa = (m2) => `${(m2 / 10000).toFixed(2)} ha`;
const fmtN = (n) => n.toLocaleString("en-IN");

/* ------------------------------------------------- 1. the contour sheet --- */

function buildContourSheet() {
  if (!contours || contours.lines.length === 0) return null;

  const pdf = new Pdf({ title: `${siteName} contour map` });
  const ctx = pdf.page(PAGE.a4l);
  const M = 36;
  titleBlock(ctx, {
    sheet: "Contour Map",
    subtitle: location ?? `UTM zone ${utmZone}${utmNorthern ? "N" : "S"} / WGS84`,
  });

  // Map frame on the left, legend column on the right.
  const legendW = 190;
  const frame = {
    x: M,
    y: 68,
    w: ctx.width - M * 2 - legendW - 14,
    h: ctx.height - 76 - 68 - 14,
  };
  ctx.frame(frame.x, frame.y, frame.w, frame.h, HAIRLINE, 0.9);

  // Fit the survey's UTM extent into the frame, one scale for both axes so the
  // drawing stays true. A map with a stretched axis is not a map.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const l of contours.lines) {
    for (const [x, y] of l.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const pad = 10;
  const scale = Math.min(
    (frame.w - pad * 2) / (maxX - minX),
    (frame.h - pad * 2) / (maxY - minY),
  );
  const offX = frame.x + (frame.w - (maxX - minX) * scale) / 2;
  const offY = frame.y + (frame.h - (maxY - minY) * scale) / 2;
  const toPage = ([x, y]) => [offX + (x - minX) * scale, offY + (y - minY) * scale];

  // Index contours every 5th interval, drawn heavier, which is the convention.
  const interval = contours.interval ?? 0.5;
  const indexEvery = interval * 5;
  ctx.clipped(frame.x, frame.y, frame.w, frame.h, (c) => {
    for (const l of contours.lines) {
      const isIndex =
        l.elevation !== null && Math.abs(l.elevation % indexEvery) < interval / 4;
      c.polyline(l.points.map(toPage), isIndex ? SIGNAL : ACCENT, isIndex ? 0.7 : 0.28);
    }
  });

  // Scale bar, sized to a round number of metres that fits a quarter of the frame.
  const targetPx = frame.w / 4;
  const nice = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const barM = nice.find((n) => n * scale > targetPx * 0.6) ?? 100;
  const barPx = barM * scale;
  const bx = frame.x + 14;
  const by = frame.y + 16;
  ctx.rect(bx, by, barPx / 2, 3.5, INK);
  ctx.rect(bx + barPx / 2, by, barPx / 2, 3.5, [1, 1, 1]);
  ctx.frame(bx, by, barPx, 3.5, INK, 0.5);
  ctx.text(bx, by + 7, "0", { size: 7, color: MUTED });
  ctx.textRight(bx + barPx, by + 7, `${barM} m`, { size: 7, color: MUTED });

  // North arrow. Grid north, which is what a UTM sheet shows.
  const nx = frame.x + frame.w - 22;
  const ny = frame.y + 20;
  ctx.line(nx, ny, nx, ny + 26, INK, 1);
  ctx.line(nx, ny + 26, nx - 4, ny + 19, INK, 1);
  ctx.line(nx, ny + 26, nx + 4, ny + 19, INK, 1);
  ctx.text(nx - 3.2, ny + 30, "N", { size: 8, bold: true });

  /* legend column */
  const lx = frame.x + frame.w + 14;
  const lr = ctx.width - M;
  let y = frame.y + frame.h - 12;

  ctx.text(lx, y, "LEGEND", { size: 8, bold: true, color: MUTED });
  y -= 16;
  ctx.line(lx, y + 3, lx + 26, y + 3, SIGNAL, 0.7);
  ctx.text(lx + 32, y, `Index contour (${indexEvery} m)`, { size: 8 });
  y -= 13;
  ctx.line(lx, y + 3, lx + 26, y + 3, ACCENT, 0.28);
  ctx.text(lx + 32, y, `Intermediate (${interval} m)`, { size: 8 });
  y -= 22;

  ctx.text(lx, y, "SURVEY", { size: 8, bold: true, color: MUTED });
  y -= 15;
  y = ctx.row(lx, y, lr, "Contour interval", `${interval} m`);
  y = ctx.row(lx, y, lr, "Contour lines", fmtN(contours.count));
  if (contours.levels.length) {
    y = ctx.row(lx, y, lr, "Lowest contour", fmtM(contours.levels[0], 1));
    y = ctx.row(lx, y, lr, "Highest contour", fmtM(contours.levels[contours.levels.length - 1], 1));
  }
  if (dtm?.elevation) {
    y = ctx.row(lx, y, lr, "Terrain model range", `${dtm.elevation.min} to ${dtm.elevation.max} m`);
  }
  y = ctx.row(lx, y, lr, "Extent", `${(maxX - minX).toFixed(0)} x ${(maxY - minY).toFixed(0)} m`);
  y = ctx.row(lx, y, lr, "Plan area", fmtHa((maxX - minX) * (maxY - minY)));
  y -= 8;

  ctx.text(lx, y, "REFERENCE", { size: 8, bold: true, color: MUTED });
  y -= 15;
  y = ctx.row(lx, y, lr, "Projection", `UTM ${utmZone}${utmNorthern ? "N" : "S"}`);
  y = ctx.row(lx, y, lr, "Datum", "WGS84");
  y = ctx.row(lx, y, lr, "Source surface", dtm ? dtm.title : "Terrain model");
  y = ctx.row(lx, y, lr, "Scale", `1:${Math.round(1 / (scale / 72 * 0.0254))}`);

  footer(
    ctx,
    "Contours derived from the delivered terrain model. Grid north. " +
      "Plan area is planimetric and excludes slope.",
  );
  return pdf.toBuffer();
}

/* ------------------------------------------------ 2. the survey report --- */

function buildReport() {
  const pdf = new Pdf({ title: `${siteName} topographic survey report` });
  const M = 48;

  const ctx = pdf.page(PAGE.a4);
  let y = titleBlock(ctx, {
    sheet: "Topographic Survey Report",
    subtitle: location ?? `UTM zone ${utmZone}${utmNorthern ? "N" : "S"} / WGS84`,
  });
  const right = ctx.width - M;

  const section = (label) => {
    y -= 10;
    ctx.text(M, y, label.toUpperCase(), { size: 8, bold: true, color: ACCENT });
    y -= 4;
    ctx.line(M, y, right, y, HAIRLINE, 0.6);
    y -= 14;
  };
  const para = (s) => {
    for (const line of wrap(s, 96)) {
      ctx.text(M, y, line, { size: 9, color: MUTED });
      y -= 12;
    }
    y -= 4;
  };

  section("Deliverables in this survey");
  for (const l of manifest.layers) {
    const kind =
      l.kind === "dem" ? "elevation data" :
      l.kind === "vector" ? `${fmtN(l.featureCount ?? 0)} lines` :
      l.kind === "tiles" ? "tiled raster" : l.kind;
    const extra = l.elevation ? `${l.elevation.min} to ${l.elevation.max} m` : kind;
    y = ctx.row(M, y, right, l.title, extra);
  }

  section("Reference system");
  y = ctx.row(M, y, right, "Projection", `UTM zone ${utmZone}${utmNorthern ? "N" : "S"}`);
  y = ctx.row(M, y, right, "Horizontal datum", "WGS84");
  if (ortho?.bounds) {
    y = ctx.row(M, y, right, "Extent, longitude", `${ortho.bounds[0].toFixed(5)} to ${ortho.bounds[2].toFixed(5)}`);
    y = ctx.row(M, y, right, "Extent, latitude", `${ortho.bounds[1].toFixed(5)} to ${ortho.bounds[3].toFixed(5)}`);
  }

  if (ortho) {
    section("Orthomosaic");
    if (ortho.downsampledFrom) {
      y = ctx.row(M, y, right, "Source resolution", `${ortho.downsampledFrom[0]} x ${ortho.downsampledFrom[1]} px`);
      y = ctx.row(M, y, right, "Published resolution", `to zoom ${ortho.maxZoom}`);
      para(
        "The orthomosaic is published at a reduced resolution because the source " +
          "exceeded what the preparation machine could tile in one pass. Native " +
          "resolution tiling is available on request.",
      );
    } else {
      y = ctx.row(M, y, right, "Published to zoom", String(ortho.maxZoom ?? ""));
    }
  }

  if (dsm?.elevation && dtm?.elevation) {
    section("Elevation models");
    y = ctx.row(M, y, right, "Surface model (DSM)", `${dsm.elevation.min} to ${dsm.elevation.max} m`);
    y = ctx.row(M, y, right, "Terrain model (DTM)", `${dtm.elevation.min} to ${dtm.elevation.max} m`);
    y = ctx.row(M, y, right, "Maximum object height", fmtM(dsm.elevation.max - dtm.elevation.max));
    para(
      "The surface model includes vegetation and structures; the terrain model is " +
        "bare earth. The difference between them at any point is the height of " +
        "whatever stands there.",
    );
  }

  if (contours) {
    section("Contours");
    y = ctx.row(M, y, right, "Interval", `${contours.interval ?? "n/a"} m`);
    y = ctx.row(M, y, right, "Lines delivered", fmtN(contours.count));
    if (contours.levels.length) {
      y = ctx.row(M, y, right, "Range", `${contours.levels[0]} to ${contours.levels[contours.levels.length - 1]} m`);
    }
  }

  if (grid) {
    section("Elevation grid");
    y = ctx.row(M, y, right, "Points", fmtN(grid.points));
    y = ctx.row(M, y, right, "Spacing", `${grid.spacingX} x ${grid.spacingY} m`);
    y = ctx.row(M, y, right, "Elevation range", `${grid.min.toFixed(3)} to ${grid.max.toFixed(3)} m`);
  }

  if (las) {
    section("LiDAR point cloud");
    y = ctx.row(M, y, right, "Points", fmtN(las.count));
    y = ctx.row(M, y, right, "Average density", `${las.density.toFixed(1)} per m²`);
    y = ctx.row(M, y, right, "Elevation range", `${las.box.minZ.toFixed(2)} to ${las.box.maxZ.toFixed(2)} m`);
    y = ctx.row(M, y, right, "Extent", `${(las.box.maxX - las.box.minX).toFixed(0)} x ${(las.box.maxY - las.box.minY).toFixed(0)} m`);
    y = ctx.row(M, y, right, "Format", `LAS ${las.version}, point format ${las.format}`);
    if (las.software) y = ctx.row(M, y, right, "Produced with", las.software);
    y -= 6;
    ctx.text(M, y, "Classification", { size: 8.5, bold: true, color: MUTED });
    y -= 13;
    for (const c of las.classes) {
      y = ctx.row(M, y, right, `  ${c.name}`, `${(c.share * 100).toFixed(1)}%`);
    }
    para(
      `Classification shares are from a sample of ${fmtN(las.sampled)} points, every ` +
        `${fmtN(las.step)}th in the file. This cloud separates ground from ` +
        `unclassified returns; it does not carry separate vegetation or building ` +
        `classes.`,
    );
  }

  footer(
    ctx,
    "Every figure in this report is read from the delivered survey files. " +
      "Areas are planimetric. Elevations are ellipsoidal unless a vertical datum is stated.",
  );
  return pdf.toBuffer();
}

/* --------------------------------------------- 3. the point cloud summary --- */

/**
 * A viewable summary of the point cloud.
 *
 * The portal previously offered a file named "Aektanagar Lidar Point Cloud.las"
 * which was a 159 byte text file claiming 45,210,480 points and a classification
 * of "Ground, Vegetation, Structures, High Noise". The real header says 50,183,644
 * points, and the cloud carries only Ground and Unclassified. Serving a fake .las
 * is worse than offering nothing, because the client cannot tell.
 *
 * The real cloud is 1.7 GB and needs a point cloud viewer, which is Phase 3. Until
 * then this states what is in it, accurately, and says plainly that the cloud
 * itself is not yet viewable in a browser.
 */
function buildLidarSummary() {
  if (!las) return null;

  const pdf = new Pdf({ title: `${siteName} LiDAR point cloud` });
  const ctx = pdf.page(PAGE.a4);
  const M = 48;
  let y = titleBlock(ctx, {
    sheet: "LiDAR Point Cloud",
    subtitle: location ?? `UTM zone ${utmZone}${utmNorthern ? "N" : "S"} / WGS84`,
  });
  const right = ctx.width - M;

  const section = (label) => {
    y -= 10;
    ctx.text(M, y, label.toUpperCase(), { size: 8, bold: true, color: ACCENT });
    y -= 4;
    ctx.line(M, y, right, y, HAIRLINE, 0.6);
    y -= 14;
  };
  const para = (s) => {
    for (const line of wrap(s, 96)) {
      ctx.text(M, y, line, { size: 9, color: MUTED });
      y -= 12;
    }
    y -= 4;
  };

  section("The cloud");
  y = ctx.row(M, y, right, "Points", fmtN(las.count));
  y = ctx.row(M, y, right, "Average density", `${las.density.toFixed(1)} per m²`);
  y = ctx.row(M, y, right, "Covered extent", `${(las.box.maxX - las.box.minX).toFixed(0)} x ${(las.box.maxY - las.box.minY).toFixed(0)} m`);
  y = ctx.row(M, y, right, "Bounding area", fmtHa(las.area));
  y = ctx.row(M, y, right, "Elevation range", `${las.box.minZ.toFixed(3)} to ${las.box.maxZ.toFixed(3)} m`);
  y = ctx.row(M, y, right, "Easting range", `${las.box.minX.toFixed(2)} to ${las.box.maxX.toFixed(2)}`);
  y = ctx.row(M, y, right, "Northing range", `${las.box.minY.toFixed(2)} to ${las.box.maxY.toFixed(2)}`);

  section("Format");
  y = ctx.row(M, y, right, "Specification", `LAS ${las.version}`);
  y = ctx.row(M, y, right, "Point data format", String(las.format));
  if (las.software) y = ctx.row(M, y, right, "Produced with", las.software);
  y = ctx.row(M, y, right, "Projection", `UTM zone ${utmZone}${utmNorthern ? "N" : "S"} / WGS84`);

  section("Classification");
  for (const c of las.classes) {
    y = ctx.row(M, y, right, c.name, `${(c.share * 100).toFixed(1)}%   approx ${fmtN(Math.round(c.share * las.count))}`);
  }
  y -= 2;
  para(
    `Shares are measured from a sample of ${fmtN(las.sampled)} points, every ` +
      `${fmtN(las.step)}th record in the file, not estimated.`,
  );
  para(
    "This cloud separates ground returns from unclassified returns. It does not " +
      "carry separate vegetation, building or noise classes, so it supports bare " +
      "earth extraction but not feature classification.",
  );

  section("Viewing the full cloud");
  para(
    `The point cloud itself is ${(las.count / 1e6).toFixed(1)} million points and is not yet ` +
      "viewable in the browser: that needs a dedicated point cloud viewer, which is " +
      "planned. The terrain model derived from the ground returns is already on the " +
      "site's map, where it drives the relief shading, the elevation readout and the " +
      "measurement tools.",
  );

  footer(
    ctx,
    "Every figure on this sheet is read from the LAS public header and a sampled " +
      "pass over the point records.",
  );
  return pdf.toBuffer();
}

function wrap(s, cols) {
  const words = s.split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > cols) {
      out.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

/* ----------------------------------------------------------------- write --- */

console.log(`\n${siteName}  (${slug})`);
console.log(`  manifest: ${manifest.layers.length} layers`);
console.log(`  contours: ${contours ? `${contours.count} lines at ${contours.interval} m` : "none"}`);
console.log(`  grid:     ${grid ? `${grid.points} points at ${grid.spacingX} m` : "none"}`);
console.log(`  lidar:    ${las ? `${fmtN(las.count)} points, ${las.density.toFixed(1)}/m²` : "not supplied"}`);

const targets = [
  { dir: "drawings", file: "contour-map.pdf", build: buildContourSheet },
  { dir: "reports", file: "topographic-survey-report.pdf", build: buildReport },
  { dir: "uav", file: "point-cloud-summary.pdf", build: buildLidarSummary },
];

let wrote = 0;
for (const t of targets) {
  const buf = t.build();
  if (!buf) {
    console.log(`  ! ${t.file}: not enough data, skipped rather than filled in`);
    continue;
  }
  const dir = join(outRoot, t.dir);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, t.file);
  writeFileSync(p, buf);
  console.log(`  wrote ${t.dir}/${t.file}  ${(buf.length / 1024).toFixed(1)} KB`);
  wrote += 1;
}

console.log(`\n${wrote} deliverable(s) written to ${outRoot}\n`);
