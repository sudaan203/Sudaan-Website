/**
 * Tree point and crown polygon export — SHP, GeoJSON, CSV, KML and KMZ.
 * `docs/forest-tools-plan.md` §7 and §12.
 *
 * Every format writer here is reused, not reimplemented: `shapefile.mjs` for
 * SHP geometry/DBF, `export-formats.mjs` for CSV, `kml.mjs` for KML/KMZ (whose
 * *writer* is new — see that file — the reader already existed),  `zip.mjs`
 * underneath both SHP and KMZ. This module's own job is narrow: turn a crown
 * `Feature` from `crowns.geojson` into the two column sets §12 asks for, and
 * hand each format writer plain geometry plus those columns. Nothing here
 * parses or writes a file format byte by byte.
 *
 * ## The tree point layer's point is not stored anywhere
 *
 * `crowns.geojson` carries exactly one geometry per tree: the crown polygon.
 * There is no separate apex/tree-top coordinate in the file — height and
 * elevation are scalars, not positions, and the detector's local-maximum seed
 * cell is not carried through to the output. So the "tree point" layer's
 * location is the crown polygon's own area centroid (holes subtracted, via
 * the standard signed-area formula below), **not** the true apex the detector
 * found. For a symmetric crown the two coincide closely; for a lopsided one
 * they can differ by a metre or more. This is stated here, in the code,
 * rather than silently presented as an exact treetop position, for the same
 * reason `docs/forest-tools-plan.md` §8 insists every figure says where it
 * came from.
 *
 * ## Projection, format by format
 *
 * - **SHP** — geometry in the survey's own UTM zone with a real `.prj`, the
 *   same convention every other shapefile export in this portal follows
 *   (`shapefile.mjs`'s own header comment; the shapefile route never emits
 *   lon/lat geometry). Latitude/longitude for the point layer are additional
 *   DBF columns, computed with the same `utmToLonLat` reprojection GeoJSON and
 *   KML use for their geometry, so the numbers agree everywhere they appear.
 * - **GeoJSON** — geometry reprojected to WGS84 lon/lat, which RFC 7946 makes
 *   mandatory (the same rule `vectorise.mjs`'s `toGeoJson` already follows).
 *   The original easting/northing travel in `properties`, and a `crs_note` at
 *   the `FeatureCollection` root states the source CRS in words, because
 *   GeoJSON has no `.prj` slot to put it in.
 * - **CSV** — a `# CRS:`-style comment header, `pointsToCsv`'s own convention,
 *   continued by the two new functions in `export-formats.mjs`.
 * - **KML/KMZ** — lon/lat by specification; there is nothing to declare
 *   beyond restating it, which `kml.mjs`'s header comment already explains.
 *
 * Every export is built from whatever subset of `crowns.geojson` the caller
 * hands in — the route is expected to have already applied the client's
 * current filter — so this module never assumes it is exporting all 26,776
 * trees.
 */

import { utmToLonLat } from "./projection.mjs";
import { writeShapefileGeometry, writeDbf, writeShapefilePrj } from "./shapefile.mjs";
import { writeZip } from "./zip.mjs";
import { writeKml, writeKmz } from "./kml.mjs";
import { treePointsToCsv, crownPolygonsToCsv } from "./export-formats.mjs";

const FORMATS = ["shp", "geojson", "csv", "kml", "kmz"];

function assertFormat(format) {
  if (!FORMATS.includes(format)) {
    throw new Error(`Unknown forest export format "${format}". One of: ${FORMATS.join(", ")}.`);
  }
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round(n, dp) {
  return n === null ? null : Number(n.toFixed(dp));
}

/**
 * `dbh_cm` in `crowns.geojson` is already either a number or the literal
 * string `"Not reliably detectable"` (§3.7). This formats the number case and
 * passes the refusal through unchanged — it never invents a number where the
 * engine declined to report one.
 */
export function dbhOrGirthLabel(props) {
  if (typeof props.dbh_cm !== "number") {
    return typeof props.dbh_cm === "string" ? props.dbh_cm : "Not reliably detectable";
  }
  const girth = typeof props.girth_m === "number" ? ` (girth ${props.girth_m.toFixed(2)} m)` : "";
  return `${props.dbh_cm.toFixed(1)} cm${girth}`;
}

// ---------------------------------------------------------------------------
// Polygon centroid — holes subtracted, standard signed-area formula.
// ---------------------------------------------------------------------------

/** Signed area and its area-weighted centroid contribution, for one ring. */
function ringCentroidArea(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;
  return area === 0 ? null : { area, cx: cx / (6 * area), cy: cy / (6 * area) };
}

/**
 * The centroid of a Polygon's rings — outer minus holes.
 *
 * A hole is wound opposite to its outer ring (`shapefile.mjs`'s file comment
 * explains the same convention from the writing side), so its signed area is
 * already negative and the composite sum below needs no special casing for
 * "this ring is a hole" — it falls out of the sign.
 */
export function polygonCentroid([outer, ...holes]) {
  const o = ringCentroidArea(outer);
  if (!o) {
    // A degenerate (zero-area, e.g. collinear) ring: fall back to the plain
    // vertex average rather than divide by zero.
    const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length;
    const cy = outer.reduce((s, p) => s + p[1], 0) / outer.length;
    return [cx, cy];
  }
  let areaSum = o.area;
  let cxSum = o.cx * o.area;
  let cySum = o.cy * o.area;
  for (const hole of holes) {
    const h = ringCentroidArea(hole);
    if (!h) continue;
    areaSum += h.area;
    cxSum += h.cx * h.area;
    cySum += h.cy * h.area;
  }
  if (areaSum === 0) return [o.cx, o.cy];
  return [cxSum / areaSum, cySum / areaSum];
}

/** Every ring of a Polygon or MultiPolygon, reprojected UTM -> lon/lat. */
function reprojectGeometry(geometry, zone) {
  const project = ([x, y]) => {
    const [lon, lat] = utmToLonLat(x, y, zone.zone, zone.northern);
    return [round(lon, 8), round(lat, 8)];
  };
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(project)) };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((poly) => poly.map((ring) => ring.map(project))),
    };
  }
  throw new Error(`reprojectGeometry: unsupported geometry type "${geometry.type}"`);
}

function popupHtml(rows) {
  return `<table>${rows
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `<tr><td><b>${k}</b></td><td>${v}</td></tr>`)
    .join("")}</table>`;
}

// ---------------------------------------------------------------------------
// Tree points
// ---------------------------------------------------------------------------

/** One tree's flattened attributes, computed once and shared by every format. */
function treeRecord(feature, zone) {
  const props = feature.properties ?? {};
  const [easting, northing] = polygonCentroid(feature.geometry.coordinates);
  const [lon, lat] = utmToLonLat(easting, northing, zone.zone, zone.northern);
  return {
    treeId: String(props.tree_id ?? ""),
    easting,
    northing,
    lon,
    lat,
    elevation: numOrNull(props.ground_elevation_m),
    height: numOrNull(props.height_m),
    crownArea: numOrNull(props.crown_area_m2),
    crownDiameter: numOrNull(props.crown_diameter_avg_m),
    dbhOrGirth: dbhOrGirthLabel(props),
    heightClass: props.height_class ?? null,
    confidence: numOrNull(props.confidence),
  };
}

function treePointsGeoJson(records, epsg) {
  return JSON.stringify({
    type: "FeatureCollection",
    crs_note:
      `Geometry is WGS84 longitude/latitude (EPSG:4326), per RFC 7946. The underlying survey ` +
      `was measured in EPSG:${epsg}; those coordinates are carried in each feature's properties ` +
      `as easting_m/northing_m.`,
    features: records.map((t) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [round(t.lon, 8), round(t.lat, 8)] },
      properties: {
        tree_id: t.treeId,
        latitude: round(t.lat, 7),
        longitude: round(t.lon, 7),
        easting_m: round(t.easting, 3),
        northing_m: round(t.northing, 3),
        elevation_m: t.elevation,
        height_m: t.height,
        crown_area_m2: t.crownArea,
        crown_diameter_m: t.crownDiameter,
        dbh_or_girth: t.dbhOrGirth,
        height_class: t.heightClass,
        confidence: t.confidence,
      },
    })),
  });
}

function treePointsKmlFeatures(records) {
  return records.map((t) => ({
    type: "Feature",
    properties: {
      name: `Tree ${t.treeId}`,
      description: popupHtml([
        ["Tree ID", t.treeId],
        ["Height", t.height === null ? null : `${t.height.toFixed(2)} m`],
        ["Elevation", t.elevation === null ? null : `${t.elevation.toFixed(2)} m`],
        ["Crown area", t.crownArea === null ? null : `${t.crownArea.toFixed(1)} m²`],
        ["Crown diameter", t.crownDiameter === null ? null : `${t.crownDiameter.toFixed(2)} m`],
        ["DBH / girth", t.dbhOrGirth],
        ["Height class", t.heightClass],
        ["Confidence", t.confidence === null ? null : t.confidence.toFixed(2)],
      ]),
    },
    geometry: { type: "Point", coordinates: [t.lon, t.lat] },
  }));
}

function treePointsShpZip(records, epsg) {
  const geometries = records.map((t) => ({ type: "Point", coordinates: [t.easting, t.northing] }));
  const { shp, shx } = writeShapefileGeometry("point", geometries);
  const dbf = writeDbf(
    records.map((t) => ({
      tree_id: t.treeId,
      latitude: round(t.lat, 7),
      longitude: round(t.lon, 7),
      elev_m: t.elevation,
      height_m: t.height,
      crown_area: t.crownArea,
      crown_diam: t.crownDiameter,
      dbh_girth: t.dbhOrGirth,
      height_cls: t.heightClass,
      confidence: t.confidence,
    })),
  );
  const prj = Buffer.from(writeShapefilePrj(epsg), "latin1");
  return writeZip([
    { name: "tree_points.shp", data: shp },
    { name: "tree_points.shx", data: shx },
    { name: "tree_points.dbf", data: dbf },
    { name: "tree_points.prj", data: prj },
  ]);
}

const CONTENT_TYPE = {
  shp: "application/zip",
  geojson: "application/geo+json",
  csv: "text/csv",
  kml: "application/vnd.google-earth.kml+xml",
  kmz: "application/vnd.google-earth.kmz",
};

/**
 * Export a tree point layer.
 *
 * @param {object[]} trees `crowns.geojson` `Feature`s (Polygon geometry), already
 *   scoped to whatever the client's current filter selected — never assumed to
 *   be the whole survey.
 * @param {("shp"|"geojson"|"csv"|"kml"|"kmz")} format
 * @param {{ epsg: number, zone: number, northern: boolean }} projection the
 *   survey's own UTM zone, e.g. `{ epsg: 32643, zone: 43, northern: true }`.
 * @returns {{ ext: string, contentType: string, filenameStem: string, data: Buffer }}
 */
export function treePointsExport(trees, format, projection) {
  assertFormat(format);
  if (!projection?.epsg || !projection?.zone) {
    throw new Error("treePointsExport: projection (epsg, zone, northern) is required");
  }
  const records = trees.map((f) => treeRecord(f, projection));

  if (format === "geojson") {
    return {
      ext: "geojson",
      contentType: CONTENT_TYPE.geojson,
      filenameStem: "tree-points",
      data: Buffer.from(treePointsGeoJson(records, projection.epsg), "utf8"),
    };
  }
  if (format === "csv") {
    return {
      ext: "csv",
      contentType: CONTENT_TYPE.csv,
      filenameStem: "tree-points",
      data: Buffer.from(treePointsToCsv(records, { epsg: projection.epsg }), "utf8"),
    };
  }
  if (format === "kml") {
    return {
      ext: "kml",
      contentType: CONTENT_TYPE.kml,
      filenameStem: "tree-points",
      data: Buffer.from(
        writeKml(treePointsKmlFeatures(records), { documentName: "Tree points" }),
        "utf8",
      ),
    };
  }
  if (format === "kmz") {
    return {
      ext: "kmz",
      contentType: CONTENT_TYPE.kmz,
      filenameStem: "tree-points",
      data: writeKmz(treePointsKmlFeatures(records), { documentName: "Tree points" }),
    };
  }
  // shp
  return {
    ext: "zip",
    contentType: CONTENT_TYPE.shp,
    filenameStem: "tree-points",
    data: treePointsShpZip(records, projection.epsg),
  };
}

// ---------------------------------------------------------------------------
// Crown polygons
// ---------------------------------------------------------------------------

function crownRecord(feature) {
  const props = feature.properties ?? {};
  return {
    treeId: String(props.tree_id ?? ""),
    height: numOrNull(props.height_m),
    crownArea: numOrNull(props.crown_area_m2),
    crownDiameter: numOrNull(props.crown_diameter_avg_m),
    heightClass: props.height_class ?? null,
    geometry: feature.geometry, // native survey UTM, untouched
  };
}

function crownPolygonsGeoJson(records, zone, epsg) {
  return JSON.stringify({
    type: "FeatureCollection",
    crs_note:
      `Geometry is WGS84 longitude/latitude (EPSG:4326), per RFC 7946. The crown shapes were ` +
      `measured in EPSG:${epsg}.`,
    features: records.map((c) => ({
      type: "Feature",
      geometry: reprojectGeometry(c.geometry, zone),
      properties: {
        tree_id: c.treeId,
        height_m: c.height,
        crown_area_m2: c.crownArea,
        crown_diameter_m: c.crownDiameter,
        height_class: c.heightClass,
      },
    })),
  });
}

function crownPolygonsKmlFeatures(records, zone) {
  return records.map((c) => ({
    type: "Feature",
    properties: {
      name: `Tree ${c.treeId} — crown`,
      description: popupHtml([
        ["Tree ID", c.treeId],
        ["Height", c.height === null ? null : `${c.height.toFixed(2)} m`],
        ["Crown area", c.crownArea === null ? null : `${c.crownArea.toFixed(1)} m²`],
        ["Crown diameter", c.crownDiameter === null ? null : `${c.crownDiameter.toFixed(2)} m`],
        ["Height class", c.heightClass],
      ]),
    },
    geometry: reprojectGeometry(c.geometry, zone),
  }));
}

function crownPolygonsShpZip(records, epsg) {
  const geometries = records.map((c) => c.geometry);
  const { shp, shx } = writeShapefileGeometry("polygon", geometries);
  const dbf = writeDbf(
    records.map((c) => ({
      tree_id: c.treeId,
      height_m: c.height,
      crown_area: c.crownArea,
      crown_diam: c.crownDiameter,
      height_cls: c.heightClass,
    })),
  );
  const prj = Buffer.from(writeShapefilePrj(epsg), "latin1");
  return writeZip([
    { name: "crowns.shp", data: shp },
    { name: "crowns.shx", data: shx },
    { name: "crowns.dbf", data: dbf },
    { name: "crowns.prj", data: prj },
  ]);
}

/**
 * Export a crown polygon layer.
 *
 * @param {object[]} trees `crowns.geojson` `Feature`s, already scoped to the
 *   client's current filter.
 * @param {("shp"|"geojson"|"csv"|"kml"|"kmz")} format
 * @param {{ epsg: number, zone: number, northern: boolean }} projection
 * @returns {{ ext: string, contentType: string, filenameStem: string, data: Buffer }}
 */
export function crownPolygonExport(trees, format, projection) {
  assertFormat(format);
  if (!projection?.epsg || !projection?.zone) {
    throw new Error("crownPolygonExport: projection (epsg, zone, northern) is required");
  }
  const records = trees.map(crownRecord);

  if (format === "geojson") {
    return {
      ext: "geojson",
      contentType: CONTENT_TYPE.geojson,
      filenameStem: "crowns",
      data: Buffer.from(crownPolygonsGeoJson(records, projection, projection.epsg), "utf8"),
    };
  }
  if (format === "csv") {
    return {
      ext: "csv",
      contentType: CONTENT_TYPE.csv,
      filenameStem: "crowns",
      data: Buffer.from(crownPolygonsToCsv(records, { epsg: projection.epsg }), "utf8"),
    };
  }
  if (format === "kml") {
    return {
      ext: "kml",
      contentType: CONTENT_TYPE.kml,
      filenameStem: "crowns",
      data: Buffer.from(
        writeKml(crownPolygonsKmlFeatures(records, projection), { documentName: "Crown polygons" }),
        "utf8",
      ),
    };
  }
  if (format === "kmz") {
    return {
      ext: "kmz",
      contentType: CONTENT_TYPE.kmz,
      filenameStem: "crowns",
      data: writeKmz(crownPolygonsKmlFeatures(records, projection), { documentName: "Crown polygons" }),
    };
  }
  // shp
  return {
    ext: "zip",
    contentType: CONTENT_TYPE.shp,
    filenameStem: "crowns",
    data: crownPolygonsShpZip(records, projection.epsg),
  };
}
