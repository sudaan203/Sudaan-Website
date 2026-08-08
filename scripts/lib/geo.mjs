/**
 * Shared geospatial helpers for the survey pipeline.
 *
 * One implementation of each of these rather than a copy per script.
 * Deliberately free of dependencies apart from sharp: this runs on a surveyor's
 * laptop, and "install GDAL first" is not an instruction that survives contact
 * with a delivery deadline.
 */

import { readFileSync } from "node:fs";

/**
 * Is this a real ground height, or a nodata marker?
 *
 * The previous test was `v < -1e4 || v > 1e5`, which lets through -9999: the
 * single most common nodata sentinel in DEMs, and one this pipeline had never
 * met only because the Kotba export happens to use NaN. A -9999 filled corner
 * would have been drawn as terrain and dragged the reported minimum with it.
 *
 * Bounding by what an elevation on this planet can actually be catches every
 * sentinel in one rule: -9999, -32767, -32768 and -3.4e38 are all outside it,
 * and so is anything else a package invents. The floor allows for ellipsoidal
 * heights, which run below sea level where the geoid separation is large.
 */
const MIN_ELEVATION_M = -500;
const MAX_ELEVATION_M = 9000;
const isElevation = (v) =>
  Number.isFinite(v) && v > MIN_ELEVATION_M && v < MAX_ELEVATION_M;

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

/** Human names, so an unsupported file says what it actually contains. */
const SHAPE_NAMES = {
  0: "Null", 1: "Point", 3: "PolyLine", 5: "Polygon", 8: "MultiPoint",
  11: "PointZ", 13: "PolyLineZ", 15: "PolygonZ", 18: "MultiPointZ",
  21: "PointM", 23: "PolyLineM", 25: "PolygonM", 28: "MultiPointM",
};

/**
 * Line geometry from a .shp.
 *
 * Handles PolyLine (3), PolyLineZ (13) and PolyLineM (23), plus the polygon
 * equivalents read as closed lines. The Z and M variants carry extra arrays
 * *after* the XY points, so the part and point layout this reads is byte for
 * byte identical and only the record length differs.
 *
 * That matters more than it sounds: contours exported from most survey packages
 * are PolyLineZ, because each line carries its height. Reading only type 3
 * would have produced an empty layer with no error at all for most real files.
 * The Kotba export happens to be plain PolyLine, so nothing here caught it.
 */
function readShpPolylines(path) {
  const buf = readFileSync(path);
  const fileLength = buf.readInt32BE(24) * 2; // header stores 16 bit words
  const shapes = [];
  const seen = new Map();

  const LINE_TYPES = new Set([3, 13, 23, 5, 15, 25]);

  let pos = 100; // past the file header
  while (pos < fileLength) {
    const contentLength = buf.readInt32BE(pos + 4) * 2;
    const body = pos + 8;
    const type = buf.readInt32LE(body);
    seen.set(type, (seen.get(type) ?? 0) + 1);

    if (LINE_TYPES.has(type)) {
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

  // Say what was skipped. Silently dropping geometry is how a layer ends up
  // half drawn with nobody noticing.
  const skipped = [...seen].filter(([type]) => !LINE_TYPES.has(type) && type !== 0);
  if (skipped.length > 0) {
    console.warn(
      `     SKIPPED unsupported geometry in ${path}: ` +
        skipped.map(([t, n]) => `${SHAPE_NAMES[t] ?? `type ${t}`} x${n}`).join(", "),
    );
  }
  const used = [...seen].filter(([type]) => LINE_TYPES.has(type));
  console.log(
    `     geometry: ${used.map(([t, n]) => `${SHAPE_NAMES[t] ?? t} x${n}`).join(", ") || "none"}`,
  );

  return shapes;
}

/**
 * Point geometry from a .shp.
 *
 * Handles Point (1), PointZ (11) and PointM (21). All three start with the same
 * X and Y pair and differ only in what follows, so one read covers them.
 *
 * Added for pour points, which is the one shapefile in the hydrology fixture
 * that is not lines or polygons. Reading it with readShpPolylines returns a row
 * of nulls, silently, which is exactly the failure mode that file warns about.
 */
function readShpPoints(path) {
  const buf = readFileSync(path);
  const fileLength = buf.readInt32BE(24) * 2;
  const POINT_TYPES = new Set([1, 11, 21]);
  const points = [];
  const seen = new Map();

  let pos = 100;
  while (pos < fileLength) {
    const contentLength = buf.readInt32BE(pos + 4) * 2;
    const body = pos + 8;
    const type = buf.readInt32LE(body);
    seen.set(type, (seen.get(type) ?? 0) + 1);
    if (POINT_TYPES.has(type)) {
      points.push([buf.readDoubleLE(body + 4), buf.readDoubleLE(body + 12)]);
    } else {
      points.push(null); // keep indices aligned with the .dbf
    }
    pos = body + contentLength;
  }

  const skipped = [...seen].filter(([type]) => !POINT_TYPES.has(type) && type !== 0);
  if (skipped.length > 0) {
    console.warn(
      `     SKIPPED non point geometry in ${path}: ` +
        skipped.map(([t, n]) => `${SHAPE_NAMES[t] ?? `type ${t}`} x${n}`).join(", "),
    );
  }
  return points;
}

const TILE_SIZE = 256;
const R = 6378137.0;

/** WGS84 lon/lat to spherical mercator metres, the CRS web tiles are cut on. */
function lonLatToMercator(lon, lat) {
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

function mercatorToLonLat(x, y) {
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** Forward UTM, the direction prepare-map-data.mjs does not need. */
function lonLatToUtm(lon, lat, zone, northern = true) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);

  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;

  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lambda - lambda0);

  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));

  const easting =
    k0 * n * (A + ((1 - t + c) * A ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * A ** 5) / 120) +
    500000;

  let northing =
    k0 *
    (m +
      n *
        Math.tan(phi) *
        ((A * A) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * A ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * A ** 6) / 720));
  if (!northern) northing += 10000000;

  return [easting, northing];
}

/* ---------------------------------------------------------------- tiles --- */

const MERCATOR_EXTENT = 20037508.342789244;

function tileBounds(z, x, y) {
  const size = (2 * MERCATOR_EXTENT) / 2 ** z;
  return {
    west: -MERCATOR_EXTENT + x * size,
    east: -MERCATOR_EXTENT + (x + 1) * size,
    north: MERCATOR_EXTENT - y * size,
    south: MERCATOR_EXTENT - (y + 1) * size,
  };
}

function tileRange(z, bbox) {
  const size = (2 * MERCATOR_EXTENT) / 2 ** z;
  return {
    minX: Math.floor((bbox.west + MERCATOR_EXTENT) / size),
    maxX: Math.floor((bbox.east + MERCATOR_EXTENT) / size),
    minY: Math.floor((MERCATOR_EXTENT - bbox.north) / size),
    maxY: Math.floor((MERCATOR_EXTENT - bbox.south) / size),
  };
}

export {
  MIN_ELEVATION_M, MAX_ELEVATION_M, isElevation,
  utmToLonLat, lonLatToUtm, readProjection, readWorldFile, rasterCorners,
  readDbf, readShpPolylines, readShpPoints, SHAPE_NAMES,
  lonLatToMercator, mercatorToLonLat, tileBounds, tileRange, MERCATOR_EXTENT, TILE_SIZE,
};
