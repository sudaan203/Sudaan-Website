/**
 * ESRI Shapefile: read and write the three parts Malhar's tool needs — .shp
 * (geometry), .dbf (attributes) and .prj (projection) — plus enough of the
 * index file (.shx) that software which insists on one still opens the result.
 *
 * Written to the ESRI Shapefile Technical Description directly, the way the
 * LAS reader and the DXF/LandXML writers were, for the same reason: this is a
 * fully specified binary format with exactly three shape types in scope, and a
 * general purpose library would bring geometry engines and CRS databases this
 * portal already has its own answers for.
 *
 * ## Geometry, in and out
 *
 * Everything here speaks plain GeoJSON-shaped geometry objects —
 * `{ type: "Point", coordinates: [x, y] }`, `LineString`, `MultiLineString`,
 * `Polygon`, `MultiPolygon` — in whatever planar x/y the caller hands in. This
 * module never projects anything; the route that calls it does that, the same
 * separation `terrain-analysis.mjs` keeps between "operates on a grid's own
 * projected metres" and "knows about lon/lat at all". A shapefile itself has no
 * opinion on units, which is exactly why the fourth file, `.prj`, exists.
 *
 * ## The one subtlety worth a comment up front: ring winding
 *
 * A shapefile polygon's outer ring is **clockwise** and its holes are
 * **counter-clockwise** — the opposite of GeoJSON's right-hand rule, where the
 * outer ring is counter-clockwise. That means converting a ring between the two
 * formats is always the same operation in both directions: reverse its point
 * order. `toShpRings` and `groupShpRings` below do exactly that and nothing
 * more, and it is worth remembering precisely because it is this simple: a fix
 * that special-cases the read direction from the write direction is solving a
 * problem that does not exist.
 */

const SHAPE_TYPE = { point: 1, polyline: 3, polygon: 5 };
const HEADER_BYTES = 100;

/** Planar signed area, shoelace formula. Positive is counter-clockwise. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/** Every ring a Polygon/MultiPolygon geometry contains, outer rings first within each polygon. */
function ringsOf(geometry) {
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  throw new Error(`ringsOf: not a polygon geometry (${geometry.type})`);
}

/**
 * Every part (a line, or a ring) a geometry contains, as flat point arrays.
 *
 * Never called for `Point`: `writeShapefileGeometry` writes a point record
 * directly, because a shapefile Point has no parts array at all — it is just
 * shape type, X, Y. Point is not a case here for that reason, not by omission.
 */
function partsOf(geometry) {
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    case "Polygon":
    case "MultiPolygon":
      // Reversed here, not conditionally: GeoJSON winding is always the
      // opposite of a shapefile's, so the transform is unconditional in both
      // directions. See the file comment.
      return ringsOf(geometry).map((ring) => [...ring].reverse());
    default:
      throw new Error(`partsOf: unsupported geometry type "${geometry.type}"`);
  }
}

function bboxOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * @param {("point"|"polyline"|"polygon")} kind
 * @param {object[]} geometries GeoJSON-shaped geometry objects, one shapefile record each
 * @returns {{ shp: Buffer, shx: Buffer }}
 */
export function writeShapefileGeometry(kind, geometries) {
  const shapeType = SHAPE_TYPE[kind];
  if (!shapeType) throw new Error(`writeShapefileGeometry: unknown kind "${kind}"`);

  const records = [];
  let allPoints = [];

  for (const geometry of geometries) {
    if (shapeType === 1) {
      if (geometry.type !== "Point") {
        throw new Error(`a point shapefile cannot hold a "${geometry.type}"`);
      }
      const content = Buffer.alloc(20);
      content.writeInt32LE(1, 0);
      content.writeDoubleLE(geometry.coordinates[0], 4);
      content.writeDoubleLE(geometry.coordinates[1], 12);
      records.push(content);
      allPoints.push(geometry.coordinates);
      continue;
    }

    const parts = partsOf(geometry);
    const points = parts.flat();
    if (points.length === 0) throw new Error("a shapefile record needs at least one point");
    const { minX, minY, maxX, maxY } = bboxOf(points);

    const content = Buffer.alloc(44 + parts.length * 4 + points.length * 16);
    content.writeInt32LE(shapeType, 0);
    content.writeDoubleLE(minX, 4);
    content.writeDoubleLE(minY, 12);
    content.writeDoubleLE(maxX, 20);
    content.writeDoubleLE(maxY, 28);
    content.writeInt32LE(parts.length, 36);
    content.writeInt32LE(points.length, 40);

    let partStart = 0;
    parts.forEach((part, i) => {
      content.writeInt32LE(partStart, 44 + i * 4);
      partStart += part.length;
    });
    const pointsOffset = 44 + parts.length * 4;
    points.forEach(([x, y], i) => {
      content.writeDoubleLE(x, pointsOffset + i * 16);
      content.writeDoubleLE(y, pointsOffset + i * 16 + 8);
    });
    records.push(content);
    allPoints = allPoints.concat(points);
  }

  const fileBbox = bboxOf(allPoints.length ? allPoints : [[0, 0]]);

  // ---- lay out .shp, tracking each record's byte offset for .shx ----------
  const shpParts = [];
  const shxRecords = [];
  let byteOffset = HEADER_BYTES;

  records.forEach((content, i) => {
    const header = Buffer.alloc(8);
    header.writeInt32BE(i + 1, 0);
    header.writeInt32BE(content.length / 2, 4); // content length, in 16-bit words
    shpParts.push(header, content);
    shxRecords.push({ offsetWords: byteOffset / 2, lengthWords: content.length / 2 });
    byteOffset += 8 + content.length;
  });

  const fileHeader = (totalBytes) => {
    const h = Buffer.alloc(HEADER_BYTES);
    h.writeInt32BE(9994, 0); // file code
    h.writeInt32BE(totalBytes / 2, 24); // file length, in 16-bit words
    h.writeInt32LE(1000, 28); // version
    h.writeInt32LE(shapeType, 32);
    h.writeDoubleLE(fileBbox.minX, 36);
    h.writeDoubleLE(fileBbox.minY, 44);
    h.writeDoubleLE(fileBbox.maxX, 52);
    h.writeDoubleLE(fileBbox.maxY, 60);
    // Zmin/Zmax/Mmin/Mmax at 68..99 stay zero: nothing here carries Z or M.
    return h;
  };

  const shpBody = Buffer.concat(shpParts);
  const shp = Buffer.concat([fileHeader(HEADER_BYTES + shpBody.length), shpBody]);

  const shxBody = Buffer.alloc(shxRecords.length * 8);
  shxRecords.forEach((r, i) => {
    shxBody.writeInt32BE(r.offsetWords, i * 8);
    shxBody.writeInt32BE(r.lengthWords, i * 8 + 4);
  });
  const shx = Buffer.concat([fileHeader(HEADER_BYTES + shxBody.length), shxBody]);

  return { shp, shx };
}

/** Undo the ring reversal `partsOf` applied, and group rings into polygons. */
function groupShpRings(rings) {
  // A ring's winding tells us whether it starts a new polygon (clockwise, an
  // outer boundary in the *shapefile's* sense) or is a hole in the one before
  // it (counter-clockwise). Reversed back to GeoJSON's convention as it goes,
  // which is the same unconditional flip `partsOf` used to go the other way.
  const polygons = [];
  for (const ring of rings) {
    const geo = [...ring].reverse();
    const outer = signedArea(ring) < 0; // clockwise in shapefile's raw winding
    if (outer || polygons.length === 0) {
      polygons.push([geo]);
    } else {
      polygons[polygons.length - 1].push(geo);
    }
  }
  return polygons;
}

/**
 * @param {Buffer} buffer the .shp file
 * @returns {{ kind: ("point"|"polyline"|"polygon"), geometries: object[] }}
 */
export function readShapefileGeometry(buffer) {
  if (buffer.length < HEADER_BYTES || buffer.readInt32BE(0) !== 9994) {
    throw new Error("not a .shp file: missing the ESRI file code");
  }
  const headerType = buffer.readInt32LE(32);
  /*
   * Z and M variants (PointZ, PolyLineZM, and so on) lay out their X/Y exactly
   * like the plain type, with Z and M arrays appended after the points — so
   * every variant of a shape reads correctly as its base kind by simply not
   * reading that far. This portal draws and compares in two dimensions, and
   * ignoring a trailing Z array a real GIS package wrote is safer than
   * inventing a use for a height nothing here asked about.
   */
  const KIND_OF_TYPE = {
    1: "point", 11: "point", 21: "point",
    3: "polyline", 13: "polyline", 23: "polyline",
    5: "polygon", 15: "polygon", 25: "polygon",
  };
  const kind = KIND_OF_TYPE[headerType];
  if (!kind) {
    throw new Error(
      `shape type ${headerType} is not point, polyline or polygon (or a Z/M variant of one). ` +
        "MultiPoint and MultiPatch shapefiles are not supported.",
    );
  }

  const geometries = [];
  const rawRings = [];
  let cursor = HEADER_BYTES;

  while (cursor < buffer.length) {
    const contentWords = buffer.readInt32BE(cursor + 4);
    const contentStart = cursor + 8;
    const contentEnd = contentStart + contentWords * 2;
    const shapeType = buffer.readInt32LE(contentStart);

    if (shapeType === 0) {
      cursor = contentEnd;
      continue; // a null record: a gap in the data, not an error
    }

    if (kind === "point") {
      const x = buffer.readDoubleLE(contentStart + 4);
      const y = buffer.readDoubleLE(contentStart + 12);
      geometries.push({ type: "Point", coordinates: [x, y] });
    } else {
      const numParts = buffer.readInt32LE(contentStart + 36);
      const numPoints = buffer.readInt32LE(contentStart + 40);
      const partsAt = contentStart + 44;
      const pointsAt = partsAt + numParts * 4;

      const starts = [];
      for (let i = 0; i < numParts; i += 1) starts.push(buffer.readInt32LE(partsAt + i * 4));

      const points = [];
      for (let i = 0; i < numPoints; i += 1) {
        points.push([
          buffer.readDoubleLE(pointsAt + i * 16),
          buffer.readDoubleLE(pointsAt + i * 16 + 8),
        ]);
      }

      const parts = starts.map((start, i) => points.slice(start, starts[i + 1] ?? numPoints));

      if (kind === "polyline") {
        geometries.push(
          parts.length === 1
            ? { type: "LineString", coordinates: parts[0] }
            : { type: "MultiLineString", coordinates: parts },
        );
      } else {
        // Polygon rings are collected across every record and grouped at the
        // end: a MultiPolygon in the source software may have written its
        // outer rings as separate records with the same overall shape type,
        // and winding is the only signal that says where one polygon ends and
        // the next begins.
        rawRings.push({ record: geometries.length, rings: parts });
        geometries.push(null); // placeholder, filled in below
      }
    }
    cursor = contentEnd;
  }

  if (kind === "polygon") {
    for (const { record, rings } of rawRings) {
      const polygons = groupShpRings(rings);
      geometries[record] =
        polygons.length === 1
          ? { type: "Polygon", coordinates: polygons[0] }
          : { type: "MultiPolygon", coordinates: polygons };
    }
  }

  return { kind, geometries };
}

// ---------------------------------------------------------------------------
// .dbf — the attribute table dBASE III expects
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string|number|boolean|null>[]} records
 * @returns {Buffer}
 */
export function writeDbf(records) {
  // A shapefile's dbf must have at least one field and one record per
  // geometry, in the same order the .shp writes them; a shapefile with an
  // empty attribute table is not one most software will open.
  const rows = records.length ? records : [{ id: 1 }];
  const fieldNames = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (fieldNames.length === 0) fieldNames.push("id");

  const fields = fieldNames.map((name) => {
    const sample = rows.find((r) => r[name] !== undefined && r[name] !== null)?.[name];
    if (typeof sample === "number") {
      const width = Math.max(
        10,
        ...rows.map((r) => String(r[name] ?? 0).length),
      );
      return { name, type: "N", width: Math.min(width, 18), decimals: 0 };
    }
    if (typeof sample === "boolean") return { name, type: "L", width: 1, decimals: 0 };
    const width = Math.max(1, ...rows.map((r) => String(r[name] ?? "").length));
    return { name, type: "C", width: Math.min(width, 254), decimals: 0 };
  });

  const recordSize = 1 + fields.reduce((sum, f) => sum + f.width, 0);
  const headerSize = 32 + fields.length * 32 + 1;

  const header = Buffer.alloc(headerSize);
  header[0] = 0x03; // dBASE III, no memo
  const now = new Date();
  header[1] = Math.max(0, now.getFullYear() - 1900);
  header[2] = now.getMonth() + 1;
  header[3] = now.getDate();
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt16LE(headerSize, 8);
  header.writeUInt16LE(recordSize, 10);

  fields.forEach((field, i) => {
    const at = 32 + i * 32;
    header.write(field.name.slice(0, 10), at, "latin1");
    header[at + 11] = field.type.charCodeAt(0);
    header[at + 16] = field.width;
    header[at + 17] = field.decimals;
  });
  header[headerSize - 1] = 0x0d; // field descriptor terminator

  const body = Buffer.alloc(recordSize * rows.length);
  rows.forEach((row, r) => {
    const at = r * recordSize;
    body[at] = 0x20; // not deleted
    let col = at + 1;
    for (const field of fields) {
      const raw = row[field.name];
      let text;
      if (field.type === "N") text = raw == null ? "" : String(raw);
      else if (field.type === "L") text = raw == null ? "?" : raw ? "T" : "F";
      else text = raw == null ? "" : String(raw);

      const padded =
        field.type === "N"
          ? text.slice(0, field.width).padStart(field.width, " ")
          : text.slice(0, field.width).padEnd(field.width, " ");
      body.write(padded, col, "latin1");
      col += field.width;
    }
  });

  return Buffer.concat([header, body, Buffer.from([0x1a])]);
}

/** @param {Buffer} buffer @returns {{ fields: {name:string,type:string}[], records: Record<string, unknown>[] }} */
export function readDbf(buffer) {
  if (buffer.length < 32) throw new Error("not a .dbf file: too short for a header");
  const headerSize = buffer.readUInt16LE(8);
  const recordSize = buffer.readUInt16LE(10);
  const recordCount = buffer.readUInt32LE(4);

  const fields = [];
  for (let at = 32; at < headerSize - 1; at += 32) {
    if (buffer[at] === 0x0d) break;
    const name = buffer.toString("latin1", at, at + 11).replace(/\0.*$/, "");
    const type = String.fromCharCode(buffer[at + 11]);
    const width = buffer[at + 16];
    fields.push({ name, type, width });
  }

  const records = [];
  for (let r = 0; r < recordCount; r += 1) {
    const at = headerSize + r * recordSize;
    if (at >= buffer.length) break;
    if (buffer[at] === 0x2a) continue; // marked deleted
    let col = at + 1;
    const row = {};
    for (const field of fields) {
      const raw = buffer.toString("latin1", col, col + field.width).trim();
      if (field.type === "N" || field.type === "F") {
        row[field.name] = raw === "" ? null : Number(raw);
      } else if (field.type === "L") {
        row[field.name] = /[TtYy]/.test(raw) ? true : /[FfNn]/.test(raw) ? false : null;
      } else if (field.type === "D") {
        row[field.name] = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw || null;
      } else {
        row[field.name] = raw;
      }
      col += field.width;
    }
    records.push(row);
  }
  return { fields, records };
}

// ---------------------------------------------------------------------------
// .prj — WKT projection, read and write
// ---------------------------------------------------------------------------

/**
 * The WKT `.prj` sidecar for a UTM zone on WGS84 — the same string
 * `export-formats.mjs` writes for every other export, so a shapefile downloaded
 * from here and a DXF downloaded from here claim the identical projection.
 */
export function writeShapefilePrj(epsg) {
  const north = epsg >= 32601 && epsg <= 32660;
  const south = epsg >= 32701 && epsg <= 32760;
  if (!north && !south) {
    throw new Error(`writeShapefilePrj: EPSG ${epsg} is not a WGS84 UTM zone`);
  }
  const zone = north ? epsg - 32600 : epsg - 32700;
  const centralMeridian = zone * 6 - 183;
  return (
    `PROJCS["WGS_1984_UTM_Zone_${zone}${north ? "N" : "S"}",` +
    `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",` +
    `SPHEROID["WGS_1984",6378137.0,298.257223563]],` +
    `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],` +
    `PROJECTION["Transverse_Mercator"],` +
    `PARAMETER["False_Easting",500000.0],` +
    `PARAMETER["False_Northing",${north ? "0.0" : "10000000.0"}],` +
    `PARAMETER["Central_Meridian",${centralMeridian}.0],` +
    `PARAMETER["Scale_Factor",0.9996],` +
    `PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`
  );
}

/**
 * Read a `.prj` back to an EPSG code, or refuse.
 *
 * Refuses rather than guesses, on purpose, matching every other reader in this
 * codebase: a shapefile with no recognisable CRS is not safely placeable on the
 * earth, and drawing it somewhere plausible is worse than declining to draw it
 * at all.
 *
 * Two shapes are understood. A bare geographic WGS84 CRS (no `PROJCS`) is taken
 * to be longitude and latitude directly. A UTM projection on WGS84 is read
 * first by its own name — "UTM_Zone_43N" or "UTM zone 43N", however the writer
 * spelled it — and, failing that, worked out from its central meridian and
 * false northing, because not every package that writes a `.prj` names the zone
 * in the string it writes.
 */
export function parseShapefilePrj(wkt) {
  const text = wkt.trim();
  if (!text) throw new Error("the .prj file is empty");

  const isProjected = /PROJCS/i.test(text);
  const isWgs84 = /WGS[_ ]?1984|WGS[_ ]?84/i.test(text);

  if (!isProjected) {
    if (!/GEOGCS/i.test(text) || !isWgs84) {
      throw new Error(
        "the .prj is not a recognised CRS: expected geographic WGS84 or a WGS84 UTM zone",
      );
    }
    return { epsg: 4326, description: "WGS 84 (longitude, latitude)" };
  }

  if (!isWgs84) {
    throw new Error("the .prj is a projected CRS that is not on the WGS84 datum this pipeline supports");
  }

  const named = text.match(/UTM[_ ]?Zone[_ ]?(\d{1,2})\s*([NnSs])/);
  if (named) {
    const zone = Number(named[1]);
    const north = /n/i.test(named[2]);
    return {
      epsg: (north ? 32600 : 32700) + zone,
      description: `WGS 84 / UTM zone ${zone}${north ? "N" : "S"}`,
    };
  }

  // Fall back to the parameters themselves: not every writer names the zone in
  // the PROJCS string, but a Transverse Mercator on WGS84 with these two
  // parameters is a UTM zone whichever software wrote it, and the zone is
  // recoverable from where its central meridian actually sits.
  const meridian = text.match(/Central_Meridian["\s,]+(-?\d+(?:\.\d+)?)/i);
  const falseNorthing = text.match(/False_Northing["\s,]+(-?\d+(?:\.\d+)?)/i);
  if (meridian) {
    const zone = Math.round((Number(meridian[1]) + 183) / 6);
    const north = !falseNorthing || Math.abs(Number(falseNorthing[1])) < 1;
    if (zone >= 1 && zone <= 60) {
      return {
        epsg: (north ? 32600 : 32700) + zone,
        description: `WGS 84 / UTM zone ${zone}${north ? "N" : "S"} (recovered from its central meridian)`,
      };
    }
  }

  throw new Error(
    "could not determine a UTM zone from this .prj. Re-export it from a UTM zone on WGS84.",
  );
}
