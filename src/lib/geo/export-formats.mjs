/**
 * Tool 10 and 37: point and profile exports in the formats a CAD desk expects.
 *
 * CSV, TXT, DXF and LandXML. GeoTIFF lives in `raster.mjs` because it is a
 * raster concern; Malhar added it to the export list after the first review and
 * it is the most useful of the lot, because it lets a client open the exact grid
 * we computed against and check our numbers in their own software.
 *
 * One rule across all of them: **the coordinate reference system is always
 * stated.** A file of X, Y, Z with no projection is not merely unhelpful, it is
 * dangerous: 345308, 2355499 is a valid position in all sixty UTM zones and in
 * none of them by accident. Every writer here either embeds the CRS or emits a
 * `.prj` sidecar, and the caller cannot opt out.
 *
 * Coordinates go out as easting and northing in the survey's own UTM zone, not
 * lon/lat, because that is what goes into a total station and a Civil 3D
 * drawing. GeoJSON is the exception and is handled in `vectorise.mjs`, where RFC
 * 7946 forces WGS84.
 */

const ESCAPE = /[",\n\r]/;

function csvCell(value) {
  const s = String(value);
  return ESCAPE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Points as CSV, with the CRS in a comment header.
 *
 * The header is commented with `#` so a spreadsheet or a parser that skips
 * comments still sees a clean table, and a human opening the file still learns
 * what projection the numbers are in.
 */
/**
 * @param {{easting:number, northing:number, elevation:number}[]} points
 * @param {{ epsg: number, decimals?: number, label?: string }} options
 */
export function pointsToCsv(points, { epsg, decimals = 3, label = "Spot levels" } = /** @type {any} */ ({})) {
  if (!epsg) throw new Error("pointsToCsv: epsg is required, an unprojected CSV is unusable");
  const lines = [
    `# ${label}`,
    `# CRS: EPSG:${epsg}`,
    `# Coordinates are easting and northing in metres, not longitude and latitude.`,
    `# Generated ${new Date().toISOString()}`,
    "point,easting,northing,elevation",
  ];
  points.forEach((p, i) => {
    lines.push(
      [
        csvCell(p.name ?? i + 1),
        p.easting.toFixed(decimals),
        p.northing.toFixed(decimals),
        p.elevation === null ? "" : p.elevation.toFixed(decimals),
      ].join(","),
    );
  });
  return lines.join("\n") + "\n";
}

/**
 * Forest inventory CSV — tree points, `docs/forest-tools-plan.md` §12.
 *
 * A separate function from `pointsToCsv` rather than an extension of it: a
 * tree's columns (height class, DBH-or-refusal, confidence) have nothing to
 * do with a spot level's, and bending one function to both shapes would mean
 * an `options` bag that silently changes which columns appear. One function
 * per format-and-shape is this file's own convention already — `pointsToCsv`
 * and `profileToCsv` are both CSV and both stay separate for the same reason.
 *
 * `records` are plain objects (`{ treeId, lat, lon, elevation, height,
 * crownArea, crownDiameter, dbhOrGirth, heightClass, confidence }`), built by
 * `forest-export.mjs` from a `crowns.geojson` feature — this function only
 * formats what it is handed, so it stays usable from a script or a route
 * without depending on the shape of the raw feature file.
 */
export function treePointsToCsv(records, { epsg, decimals = 3 } = {}) {
  if (!epsg) throw new Error("treePointsToCsv: epsg is required, an unprojected CSV is unusable");
  const lines = [
    `# Forest inventory — tree points`,
    `# Latitude/longitude are WGS84 (EPSG:4326). The survey itself was surveyed in EPSG:${epsg}.`,
    `# Generated ${new Date().toISOString()}`,
    "tree_id,latitude,longitude,elevation_m,height_m,crown_area_m2,crown_diameter_m,dbh_or_girth,height_class,confidence",
  ];
  for (const t of records) {
    lines.push(
      [
        csvCell(t.treeId),
        t.lat.toFixed(7),
        t.lon.toFixed(7),
        t.elevation === null ? "" : t.elevation.toFixed(decimals),
        t.height === null ? "" : t.height.toFixed(decimals),
        t.crownArea === null ? "" : t.crownArea.toFixed(decimals),
        t.crownDiameter === null ? "" : t.crownDiameter.toFixed(decimals),
        csvCell(t.dbhOrGirth),
        csvCell(t.heightClass ?? ""),
        t.confidence === null ? "" : t.confidence.toFixed(4),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Forest inventory CSV — crown polygons, `docs/forest-tools-plan.md` §12.
 *
 * No coordinate columns at all: Malhar's own column set for the crown layer
 * (Tree ID, Crown Area, Crown Diameter, Height, Height Class) carries no
 * position, because the polygon geometry itself *is* the position, and a CSV
 * cannot hold a polygon. Stating the projection is still the rule every writer
 * here follows, so the header says which CRS the shape was measured in even
 * though this file does not carry the shape.
 */
export function crownPolygonsToCsv(records, { epsg, decimals = 3 } = {}) {
  if (!epsg) throw new Error("crownPolygonsToCsv: epsg is required");
  const lines = [
    `# Forest inventory — crown polygons`,
    `# This CSV has no coordinates (a polygon shape does not fit a row); the crown geometry ` +
      `itself was measured in EPSG:${epsg}. Use the SHP, GeoJSON or KML export for the shapes.`,
    `# Generated ${new Date().toISOString()}`,
    "tree_id,height_m,crown_area_m2,crown_diameter_m,height_class",
  ];
  for (const t of records) {
    lines.push(
      [
        csvCell(t.treeId),
        t.height === null ? "" : t.height.toFixed(decimals),
        t.crownArea === null ? "" : t.crownArea.toFixed(decimals),
        t.crownDiameter === null ? "" : t.crownDiameter.toFixed(decimals),
        csvCell(t.heightClass ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/** A profile as CSV: chainage first, which is how a section is read. */
export function profileToCsv(profileResult, { epsg, decimals = 3 } = {}) {
  if (!epsg) throw new Error("profileToCsv: epsg is required");
  const lines = [
    `# Cross section`,
    `# CRS: EPSG:${epsg}`,
    `# Length ${profileResult.length.toFixed(decimals)} m, ` +
      `sampled every ${profileResult.sampleSpacing} m`,
    "chainage,easting,northing,elevation,slope_percent",
  ];
  for (const p of profileResult.points) {
    lines.push(
      [
        p.chainage.toFixed(decimals),
        p.easting.toFixed(decimals),
        p.northing.toFixed(decimals),
        p.elevation === null ? "" : p.elevation.toFixed(decimals),
        p.slopePercent === null || p.slopePercent === undefined ? "" : p.slopePercent.toFixed(4),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Plain text points, the format most total stations and older packages read.
 *
 * Space delimited `id easting northing elevation` with no header at all, because
 * a header is what breaks these importers. The CRS therefore cannot live in the
 * file, which is exactly why `writePrj` exists and why the CLI writes one
 * alongside every TXT.
 */
/**
 * @param {{easting:number, northing:number, elevation:number}[]} points
 * @param {{ decimals?: number, delimiter?: string }} [options]
 */
export function pointsToTxt(points, { decimals = 3, delimiter = " " } = {}) {
  return (
    points
      .map((p, i) =>
        [
          p.name ?? i + 1,
          p.easting.toFixed(decimals),
          p.northing.toFixed(decimals),
          p.elevation === null ? "" : p.elevation.toFixed(decimals),
        ].join(delimiter),
      )
      .join("\n") + "\n"
  );
}

/**
 * Minimal ASCII DXF (R12) carrying POINT entities, optionally labelled.
 *
 * R12 rather than a modern release because every CAD package on earth reads it
 * and it needs no class or object tables. The entities go on a named layer so
 * they arrive as something a drafter can switch off, not loose geometry in layer
 * zero.
 *
 * DXF has no CRS of its own, which is the trap: the numbers are just numbers.
 * A `.prj` sidecar travels with it.
 */
/**
 * @param {{easting:number, northing:number, elevation:number}[]} points
 * @param {{ layer?: string, labels?: boolean, textHeight?: number }} [options]
 */
export function pointsToDxf(points, { layer = "SPOT_LEVELS", labels = true, textHeight = 0.5 } = {}) {
  const out = [];
  const pair = (code, value) => { out.push(String(code)); out.push(String(value)); };

  pair(0, "SECTION");
  pair(2, "ENTITIES");
  for (const [i, p] of points.entries()) {
    if (p.elevation === null) continue;
    pair(0, "POINT");
    pair(8, layer);
    pair(10, p.easting.toFixed(4));
    pair(20, p.northing.toFixed(4));
    pair(30, p.elevation.toFixed(4));
    if (labels) {
      pair(0, "TEXT");
      pair(8, `${layer}_TEXT`);
      pair(10, (p.easting + textHeight * 0.4).toFixed(4));
      pair(20, p.northing.toFixed(4));
      pair(30, p.elevation.toFixed(4));
      pair(40, textHeight);
      pair(1, p.elevation.toFixed(2));
    }
    void i;
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return out.join("\n") + "\n";
}

/** A polyline, for a cross section alignment or a drawn boundary. */
export function lineToDxf(coords, { layer = "ALIGNMENT", closed = false } = {}) {
  const out = [];
  const pair = (code, value) => { out.push(String(code)); out.push(String(value)); };
  pair(0, "SECTION");
  pair(2, "ENTITIES");
  pair(0, "POLYLINE");
  pair(8, layer);
  pair(66, 1);
  pair(70, closed ? 1 : 0);
  for (const c of coords) {
    pair(0, "VERTEX");
    pair(8, layer);
    pair(10, c[0].toFixed(4));
    pair(20, c[1].toFixed(4));
    pair(30, (c[2] ?? 0).toFixed(4));
  }
  pair(0, "SEQEND");
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return out.join("\n") + "\n";
}

/**
 * LandXML CgPoints.
 *
 * The trap here is real and silent: a LandXML `<CgPoint>` holds its coordinates
 * in the order **northing, easting, elevation**, not easting first. Writing them
 * the other way round produces a perfectly valid file that lands the survey at
 * the transpose of where it belongs, and nothing in the pipeline complains. It
 * is the same class of error as computing area in degrees, so it gets a test.
 */
/**
 * @param {{easting:number, northing:number, elevation:number}[]} points
 * @param {{ epsg: number, decimals?: number, name?: string }} options
 */
export function pointsToLandXml(points, { epsg, decimals = 4, name = "Spot levels" } = /** @type {any} */ ({})) {
  if (!epsg) throw new Error("pointsToLandXml: epsg is required");
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const rows = points
    .filter((p) => p.elevation !== null)
    .map((p, i) =>
      `   <CgPoint name="${esc(p.name ?? i + 1)}">` +
      // northing, easting, elevation. Not the other way round.
      `${p.northing.toFixed(decimals)} ${p.easting.toFixed(decimals)} ` +
      `${p.elevation.toFixed(decimals)}</CgPoint>`,
    );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"`,
    `         date="${new Date().toISOString().slice(0, 10)}"`,
    `         time="${new Date().toISOString().slice(11, 19)}">`,
    ` <Units>`,
    `  <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter"`,
    `          temperatureUnit="celsius" pressureUnit="milliBars"/>`,
    ` </Units>`,
    ` <CoordinateSystem epsgCode="${epsg}" horizontalDatum="WGS 84"/>`,
    ` <CgPoints name="${esc(name)}">`,
    ...rows,
    ` </CgPoints>`,
    `</LandXML>`,
  ].join("\n") + "\n";
}

/**
 * A `.prj` sidecar in the WKT the ESRI world expects.
 *
 * Only UTM on WGS84, since that is the one projection this pipeline handles and
 * the one every deliverable arrives in. An unsupported code throws rather than
 * emitting a plausible looking file for the wrong datum.
 */
export function writePrj(epsg) {
  const north = epsg >= 32601 && epsg <= 32660;
  const south = epsg >= 32701 && epsg <= 32760;
  if (!north && !south) {
    throw new Error(`writePrj: EPSG ${epsg} is not a WGS84 UTM zone, refusing to guess a datum`);
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
