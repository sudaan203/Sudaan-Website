/**
 * Turns raw survey deliverables into georeferenced layers the portal map can draw.
 *
 * Inputs are the real Kotba survey sitting in the gitignored folders: a float
 * GeoTIFF DEM with its world file, and an ESRI shapefile of contours. Outputs go
 * to portal-data/map/<site>/, which is OUTSIDE public/ on purpose: these are a
 * client's deliverables and must only ever be reachable through the authorised
 * route, never as a static file.
 *
 * Two jobs that nothing else in the repo does:
 *
 *   1. Work out where a raster actually sits on the earth. A world file gives
 *      pixel size and a top left corner in UTM metres; the map needs WGS84
 *      degrees, so the corners are unprojected here. Getting this wrong does not
 *      throw, it silently draws the survey in the wrong field, which is why the
 *      script prints the result and sanity checks the hemisphere and zone.
 *
 *   2. Read the contour shapefile without GDAL, which is not available on this
 *      machine. .shp geometry and .dbf attributes are both simple enough to
 *      parse directly, and doing so keeps the elevation value attached to each
 *      line so the map can label it.
 *
 * Usage:
 *   node scripts/prepare-map-data.mjs
 */

import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "kotba-survey";
const OUT = join(root, "portal-data", "map", SITE);

/* ------------------------------------------------------------------ UTM --- */

/**
 * Inverse UTM to WGS84. Standard series expansion, accurate to millimetres over
 * a zone, which is far beyond what a survey overlay needs.
 *
 * Written out rather than pulling in proj4: this is the only projection the
 * pipeline handles, and the .prj files confirm every input is UTM 43N on WGS84.
 */
function utmToLonLat(easting, northing, zone, northern = true) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);

  const x = easting - 500000;
  const y = northern ? northing : northing - 10000000;

  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const n1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const t1 = tanPhi1 * tanPhi1;
  const c1 = ep2 * cosPhi1 * cosPhi1;
  const r1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const d = x / (n1 * k0);

  const lat =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);

  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
    cosPhi1;

  const lonOrigin = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  return [((lon + lonOrigin) * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** Reads a .prj far enough to know the zone and hemisphere. */
function readProjection(prjPath) {
  const wkt = readFileSync(prjPath, "utf8");
  const zone = /UTM_zone_(\d+)([NS])/i.exec(wkt);
  if (!zone) throw new Error(`cannot read a UTM zone from ${prjPath}`);
  return { zone: Number(zone[1]), northern: zone[2].toUpperCase() === "N", wkt };
}

/** World file: pixel size, rotations, then the centre of the top left pixel. */
function readWorldFile(tfwPath) {
  const n = readFileSync(tfwPath, "utf8").split(/\r?\n/).map(parseFloat);
  const [pxWidth, rotY, rotX, pxHeight, originX, originY] = n;
  if (rotY !== 0 || rotX !== 0) {
    throw new Error(`${tfwPath} is rotated, which this pipeline does not handle`);
  }
  return { pxWidth, pxHeight, originX, originY };
}

/**
 * Corner coordinates in the order MapLibre wants for an image source:
 * top left, top right, bottom right, bottom left.
 */
function rasterCorners(world, width, height, proj) {
  // The world file references pixel centres, the extent needs pixel edges.
  const west = world.originX - world.pxWidth / 2;
  const north = world.originY - world.pxHeight / 2;
  const east = west + width * world.pxWidth;
  const south = north + height * world.pxHeight; // pxHeight is negative

  const to = (e, n) => utmToLonLat(e, n, proj.zone, proj.northern);
  return {
    coordinates: [to(west, north), to(east, north), to(east, south), to(west, south)],
    utm: { west, south, east, north },
  };
}

/* ------------------------------------------------------------ shapefile --- */

/** Field descriptors and records from a .dbf. Enough for attribute columns. */
function readDbf(path) {
  const buf = readFileSync(path);
  const recordCount = buf.readUInt32LE(4);
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);

  const fields = [];
  for (let pos = 32; buf[pos] !== 0x0d && pos < headerLength; pos += 32) {
    fields.push({
      name: buf.toString("ascii", pos, pos + 11).replace(/\0.*$/, "").trim(),
      type: String.fromCharCode(buf[pos + 11]),
      length: buf[pos + 16],
    });
  }

  const rows = [];
  for (let r = 0; r < recordCount; r += 1) {
    let pos = headerLength + r * recordLength + 1; // +1 skips the deletion flag
    const row = {};
    for (const field of fields) {
      const raw = buf.toString("ascii", pos, pos + field.length).trim();
      row[field.name] = field.type === "N" || field.type === "F" ? Number(raw) : raw;
      pos += field.length;
      // Keep the untouched text too: this export stores elevation as the
      // character string "338 m", so the numeric columns are not the only
      // place a height can hide.
      row[`${field.name}__raw`] = raw;
    }
    rows.push(row);
  }
  return { fields, rows };
}

/** Polyline geometry from a .shp. Shape type 3 only, which is what contours are. */
function readShpPolylines(path) {
  const buf = readFileSync(path);
  const fileLength = buf.readInt32BE(24) * 2; // header stores 16 bit words
  const shapes = [];

  let pos = 100; // past the file header
  while (pos < fileLength) {
    const contentLength = buf.readInt32BE(pos + 4) * 2;
    const body = pos + 8;
    const type = buf.readInt32LE(body);

    if (type === 3) {
      const numParts = buf.readInt32LE(body + 36);
      const numPoints = buf.readInt32LE(body + 40);
      const partsAt = body + 44;
      const pointsAt = partsAt + numParts * 4;

      const parts = [];
      for (let i = 0; i < numParts; i += 1) parts.push(buf.readInt32LE(partsAt + i * 4));

      const lines = [];
      for (let p = 0; p < numParts; p += 1) {
        const start = parts[p];
        const end = p + 1 < numParts ? parts[p + 1] : numPoints;
        const line = [];
        for (let i = start; i < end; i += 1) {
          line.push([
            buf.readDoubleLE(pointsAt + i * 16),
            buf.readDoubleLE(pointsAt + i * 16 + 8),
          ]);
        }
        lines.push(line);
      }
      shapes.push(lines);
    } else {
      shapes.push(null); // keep indices aligned with the .dbf
    }
    pos = body + contentLength;
  }
  return shapes;
}

/* ------------------------------------------------------------------ run --- */

mkdirSync(OUT, { recursive: true });
const manifest = { site: SITE, generatedAt: new Date().toISOString(), layers: [] };

function requireFile(path, what) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    console.error("Raw survey data is gitignored, so this only runs on a machine that has it.");
    process.exit(1);
  }
}

// ---- rasters -----------------------------------------------------------
const rasters = [
  { key: "dsm", title: "Surface model (DSM)", tif: "DSM/Kotba_DEM.tif", zFactor: 1.4 },
  { key: "dtm", title: "Terrain model (DTM)", tif: "DTM/Kotba_DTM.tif", zFactor: 1.4 },
];

/** Warm elevation ramp, matching the marketing site's DEM renders. */
const ramp = [
  [0.0, [250, 226, 192]],
  [0.35, [229, 142, 58]],
  [0.65, [180, 83, 9]],
  [1.0, [74, 42, 16]],
];
function elevColor(t) {
  for (let i = 0; i < ramp.length - 1; i += 1) {
    const [a, ca] = ramp[i];
    const [b, cb] = ramp[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      return [0, 1, 2].map((c) => Math.round(ca[c] + (cb[c] - ca[c]) * k));
    }
  }
  return ramp[ramp.length - 1][1];
}

for (const raster of rasters) {
  const tif = join(root, raster.tif);
  const tfw = tif.replace(/\.tiff?$/i, ".tfw");
  const prj = tif.replace(/\.tiff?$/i, ".prj");
  requireFile(tif, "GeoTIFF");
  requireFile(tfw, "world file");
  requireFile(prj, "projection file");

  const proj = readProjection(prj);
  const world = readWorldFile(tfw);
  const image = sharp(tif);
  const meta = await image.metadata();
  const { coordinates, utm } = rasterCorners(world, meta.width, meta.height, proj);

  // Single band float elevation -> warm colourised RGBA, nodata transparent.
  //
  // depth: "float" is not optional. Plain .raw() quietly hands back 8 bit RGB
  // for a float TIFF, and reinterpreting those bytes as float32 produces
  // convincing nonsense: the first run of this script reported the DSM spanning
  // -24 to 0 metres and the DTM 0 to 0.
  const { data, info } = await image
    .raw({ depth: "float" })
    .toBuffer({ resolveWithObject: true });

  // sharp expands the single elevation band to three identical channels, so
  // step over them rather than assuming one float per pixel.
  const pixels = info.width * info.height;
  const stride = data.byteLength / 4 / pixels;
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(
      `cannot read float elevation: ${data.byteLength} bytes for ${pixels} pixels ` +
        `(${info.channels} channels, depth ${info.depth})`,
    );
  }
  const all = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const floats = stride === 1 ? all : all.filter((_, i) => i % stride === 0);

  let min = Infinity;
  let max = -Infinity;
  for (const v of floats) {
    if (!Number.isFinite(v) || v < -1e4 || v > 1e5) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    throw new Error(`${raster.key}: no usable elevation range (${min} to ${max})`);
  }

  /**
   * Colour across the 2nd to 98th percentile, not the full range.
   *
   * A surface model picks up a handful of wild values, and this one bottoms out
   * at 143 m while almost every pixel sits between 337 and 438. Stretching the
   * ramp over the outliers renders the entire survey as one flat orange, which
   * is what the first version produced. Clipping puts the contrast where the
   * terrain is; the true range is still reported in the manifest.
   */
  const sample = [];
  for (let i = 0; i < floats.length; i += Math.max(1, Math.floor(floats.length / 200000))) {
    const v = floats[i];
    if (Number.isFinite(v) && v >= -1e4 && v <= 1e5) sample.push(v);
  }
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.02)] ?? min;
  const hi = sample[Math.floor(sample.length * 0.98)] ?? max;
  const span = hi - lo || 1;
  console.log(`     colour ramp clipped to ${lo.toFixed(1)} - ${hi.toFixed(1)} m`);

  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const v = floats[i];
    const nodata = !Number.isFinite(v) || v < -1e4 || v > 1e5;
    if (nodata) continue; // leaves 0,0,0,0
    const [r, g, b] = elevColor(Math.min(1, Math.max(0, (v - lo) / span)));
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }

  const file = `${raster.key}.webp`;
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ quality: 82 })
    .toFile(join(OUT, file));

  manifest.layers.push({
    key: raster.key,
    kind: "raster",
    title: raster.title,
    file,
    coordinates,
    elevation: { min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) },
  });

  console.log(
    `${raster.key}: ${info.width}x${info.height}, ${min.toFixed(1)} to ${max.toFixed(1)} m, ` +
      `corners ${coordinates[0].map((n) => n.toFixed(5)).join(",")} -> ` +
      `${coordinates[2].map((n) => n.toFixed(5)).join(",")}`,
  );
  console.log(`     UTM extent ${JSON.stringify(utm)}`);
}

// ---- contours ----------------------------------------------------------
{
  const base = join(root, "Contours", "Kotba Contours");
  requireFile(`${base}.shp`, "contour shapefile");
  requireFile(`${base}.dbf`, "contour attributes");
  requireFile(`${base}.prj`, "contour projection");

  const proj = readProjection(`${base}.prj`);
  const geometry = readShpPolylines(`${base}.shp`);
  const { fields, rows } = readDbf(`${base}.dbf`);
  console.log(`contours: ${geometry.length} shapes, fields ${fields.map((f) => f.name).join(", ")}`);

  // Whichever column holds the height. Named ELEV, CONTOUR, Z or similar
  // depending on which package exported it.
  const elevField =
    fields.find((f) => /^(elev|elevation|contour|height|z|level)$/i.test(f.name))?.name ??
    fields.find((f) => f.type === "N" || f.type === "F")?.name;
  if (!elevField) throw new Error("no numeric field to use as elevation");

  /**
   * This export stores elevation as text with the unit attached, "338 m", so a
   * plain Number() returns NaN and every contour silently loses its height.
   * Pull the leading number out instead.
   */
  const heightOf = (row) => {
    const direct = row?.[elevField];
    if (Number.isFinite(direct)) return direct;
    const text = row?.[`${elevField}__raw`] ?? "";
    const match = /-?\d+(?:\.\d+)?/.exec(String(text));
    return match ? Number(match[0]) : null;
  };
  console.log(`contours: using "${elevField}" as elevation`);

  /**
   * Ramer-Douglas-Peucker, run in metres before unprojecting.
   *
   * The survey traces contours at sub centimetre spacing, which is 94,000 points
   * over a 350 metre site: several megabytes of JSON to describe lines that are
   * a pixel wide on screen. A tolerance near the DEM's own cell size throws away
   * detail the raster never resolved in the first place.
   */
  function simplify(points, tolerance) {
    if (points.length < 3) return points;

    const sqTol = tolerance * tolerance;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let maxSq = 0;
      let index = 0;

      const [x1, y1] = points[first];
      const [x2, y2] = points[last];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = dx * dx + dy * dy;

      for (let i = first + 1; i < last; i += 1) {
        const [px, py] = points[i];
        let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = x1 + t * dx - px;
        const ey = y1 + t * dy - py;
        const sq = ex * ex + ey * ey;
        if (sq > maxSq) {
          maxSq = sq;
          index = i;
        }
      }

      if (maxSq > sqTol && index) {
        keep[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  const TOLERANCE_M = 0.15; // about one DEM cell
  let before = 0;
  let after = 0;

  const features = [];
  for (let i = 0; i < geometry.length; i += 1) {
    const lines = geometry[i];
    if (!lines) continue;
    const elevation = heightOf(rows[i]);
    for (const line of lines) {
      before += line.length;
      const thinned = simplify(line, TOLERANCE_M);
      if (thinned.length < 2) continue;
      after += thinned.length;

      features.push({
        type: "Feature",
        properties: { elevation },
        geometry: {
          type: "LineString",
          coordinates: thinned.map(([e, n]) => {
            const [lon, lat] = utmToLonLat(e, n, proj.zone, proj.northern);
            // Six decimals is about 0.1 m, past what the survey resolves.
            return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
          }),
        },
      });
    }
  }
  console.log(`contours: simplified ${before} points to ${after} at ${TOLERANCE_M} m`);

  const elevations = features.map((f) => f.properties.elevation).filter(Number.isFinite);
  const file = "contours.geojson";
  writeFileSync(join(OUT, file), JSON.stringify({ type: "FeatureCollection", features }));

  manifest.layers.push({
    key: "contours",
    kind: "vector",
    title: "Contours",
    file,
    featureCount: features.length,
    elevation: { min: Math.min(...elevations), max: Math.max(...elevations) },
  });

  console.log(
    `contours: ${features.length} lines, ${Math.min(...elevations)} to ${Math.max(...elevations)} m`,
  );
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nwrote ${manifest.layers.length} layers to portal-data/map/${SITE}\n`);
