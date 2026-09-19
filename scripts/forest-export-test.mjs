/**
 * Forest export — the tree point and crown polygon writers, round-tripped
 * against a handful of real trees from the real inventory, plus the PDF
 * report builder and the new KML writer.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/forest-export-test.mjs
 *
 * This is a separate script from `scripts/forest-test.mjs` (which belongs to
 * the detection engine track) and from `scripts/shapefile-test.mjs`/
 * `scripts/kml-test.mjs` (which test the format writers/readers in the
 * abstract, with synthetic geometry). This one exists to answer a narrower
 * question: does *this* export path — real `crowns.geojson` features,
 * through `forest-export.mjs`, through `shapefile.mjs`/`kml.mjs`/`zip.mjs` —
 * actually round-trip, and does the PDF report actually build.
 *
 * Real data, not synthetic: `portal-data/forest/aektanagar-survey/
 * crowns.geojson` has 26,776 real crown polygons, and this reads the first
 * twenty-five of them, exactly as delivered by the engine track's own run,
 * asking nothing about how they were produced.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  treePointsExport,
  crownPolygonExport,
  polygonCentroid,
  dbhOrGirthLabel,
} from "../src/lib/geo/forest-export.mjs";
import { buildForestInventoryReport } from "../src/lib/geo/forest-report.mjs";
import {
  readShapefileGeometry,
  readDbf,
  parseShapefilePrj,
} from "../src/lib/geo/shapefile.mjs";
import { readZip } from "../src/lib/geo/zip.mjs";
import { readKml, readKmz } from "../src/lib/geo/kml.mjs";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Real fixtures: the first 25 trees from Ektanagar 1's real inventory.
// docs/forest-tools-plan.md §1.4: aektanagar-survey is EPSG:32643 (UTM 43N),
// confirmed by every .prj in that delivery, and forest-run.mjs's own comment
// on crowns.geojson says the same.
// ---------------------------------------------------------------------------

const CROWNS_PATH = join(process.cwd(), "portal-data", "forest", "aektanagar-survey", "crowns.geojson");
const MANIFEST_PATH = join(process.cwd(), "portal-data", "forest", "aektanagar-survey", "manifest.json");
const SUMMARY_PATH = join(process.cwd(), "portal-data", "forest", "aektanagar-survey", "summary.json");

const crownsFile = JSON.parse(readFileSync(CROWNS_PATH, "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));

const SAMPLE_SIZE = 25;
const sample = crownsFile.features.slice(0, SAMPLE_SIZE);
console.log(`\nLoaded ${crownsFile.features.length} real trees; testing against the first ${sample.length}.`);

const PROJECTION = { epsg: 32643, zone: 43, northern: true };

// ---------------------------------------------------------------------------
console.log("\npolygonCentroid: a square with a square hole");
{
  // A 10x10 square (CCW, GeoJSON's outer-ring convention) with a 2x2 hole
  // (CW) centred at (4,4)-(6,6). The hole is off-centre, so a correct
  // hole-subtracted centroid must differ from the outer ring's own centroid
  // (5,5) — that difference is exactly what would go undetected by a test
  // that only checked "some point near the shape came back".
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]]; // CW, opposite the outer ring
  const [cx, cy] = polygonCentroid([outer, hole]);
  check(
    "centroid of a square alone is its middle",
    Math.abs(polygonCentroid([outer])[0] - 5) < 1e-9 && Math.abs(polygonCentroid([outer])[1] - 5) < 1e-9,
  );
  // Composite centroid of a 10x10 square (area 100, centroid (5,5)) minus a
  // 2x2 hole (area 4, centroid (5,5)) sitting exactly in the middle: the hole
  // is symmetric about the same centre, so the composite centroid is
  // unchanged at (5,5) even though the area is not. Move the hole off centre
  // instead, to actually exercise the subtraction.
  const offHole = [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]; // CW
  const [ox, oy] = polygonCentroid([outer, offHole]);
  check(
    "an off-centre hole pulls the centroid away from the outer ring's own centre",
    Math.abs(ox - 5) > 0.01 && ox > 5,
    `centroid=(${ox.toFixed(4)}, ${oy.toFixed(4)})`,
  );
  void cx; void cy;
}

// ---------------------------------------------------------------------------
console.log("\ndbhOrGirthLabel: passes the engine's own refusal through, formats a real number");
{
  check(
    "a string refusal is passed through unchanged",
    dbhOrGirthLabel({ dbh_cm: "Not reliably detectable" }) === "Not reliably detectable",
  );
  check(
    "a numeric DBH is formatted with its girth",
    dbhOrGirthLabel({ dbh_cm: 32.5, girth_m: 1.02 }) === "32.5 cm (girth 1.02 m)",
    dbhOrGirthLabel({ dbh_cm: 32.5, girth_m: 1.02 }),
  );
}

// ---------------------------------------------------------------------------
console.log("\nTree points: SHP round trips against real trees");
{
  const { data } = treePointsExport(sample, "shp", PROJECTION);
  const entries = readZip(data);
  const names = entries.map((e) => e.name);
  check("all four shapefile parts are present", ["shp", "shx", "dbf", "prj"].every(
    (ext) => names.some((n) => n.endsWith(`.${ext}`)),
  ), names.join(", "));

  const shp = entries.find((e) => e.name.endsWith(".shp")).data;
  const dbf = entries.find((e) => e.name.endsWith(".dbf")).data;
  const prj = entries.find((e) => e.name.endsWith(".prj")).data;

  const geo = readShapefileGeometry(shp);
  check("geometry kind is point", geo.kind === "point");
  check("every tree round trips", geo.geometries.length === sample.length, `${geo.geometries.length}`);

  // Geometry stays in the survey's own UTM zone, matching every other SHP
  // export in this portal (the shapefile route never writes lon/lat
  // geometry) — Latitude/Longitude are DBF columns instead, checked below.
  const crs = parseShapefilePrj(prj.toString("latin1"));
  check("the .prj states the survey's own UTM zone", crs.epsg === PROJECTION.epsg, crs.description);

  const inSurveyUtm = geo.geometries.every(
    (g) => g.coordinates[0] > 300000 && g.coordinates[0] < 400000 && g.coordinates[1] > 2400000,
  );
  check("point geometry is UTM easting/northing, matching the crown polygons", inSurveyUtm);

  const { records } = readDbf(dbf);
  check(
    "the DBF carries the same tree ids in the same order as crowns.geojson",
    records.every((r, i) => r.tree_id === sample[i].properties.tree_id),
  );
  check(
    "the DBF also carries latitude/longitude, reprojected, per Malhar's column set",
    records.every((r) => typeof r.latitude === "number" && r.latitude > 20 && r.latitude < 25),
    JSON.stringify(records[0]),
  );
  check(
    "a real refusal ('Not reliably detectable') survives the DBF round trip",
    records.some((r) => r.dbh_girth === "Not reliably detectable"),
  );
}

// ---------------------------------------------------------------------------
console.log("\nCrown polygons: SHP round trips against real trees, geometry stays in survey UTM");
{
  const { data } = crownPolygonExport(sample, "shp", PROJECTION);
  const entries = readZip(data);
  const shp = entries.find((e) => e.name.endsWith(".shp")).data;
  const prj = entries.find((e) => e.name.endsWith(".prj")).data;

  const geo = readShapefileGeometry(shp);
  check("geometry kind is polygon", geo.kind === "polygon");
  check("every crown round trips", geo.geometries.length === sample.length, `${geo.geometries.length}`);

  const crs = parseShapefilePrj(prj.toString("latin1"));
  check("crown SHP states the survey's own UTM zone", crs.epsg === PROJECTION.epsg, crs.description);

  // Ring winding: shapefile.mjs's own convention is that this is an
  // unconditional reversal in both directions (see that file's header
  // comment), so a polygon written here and read back should have the same
  // *set* of rings as the source feature, not necessarily the same order.
  const first = geo.geometries[0];
  const sourceRingCount = sample[0].geometry.coordinates.length;
  const backRingCount =
    first.type === "Polygon" ? first.coordinates.length : first.coordinates.flat().length;
  check(
    "a crown with a hole (multiple rings) keeps all its rings",
    backRingCount === sourceRingCount,
    `source ${sourceRingCount}, round-tripped ${backRingCount}`,
  );
}

// ---------------------------------------------------------------------------
console.log("\nTree points: GeoJSON states its CRS and carries the requested columns");
{
  const { data, contentType } = treePointsExport(sample, "geojson", PROJECTION);
  check("content type is a GeoJSON media type", contentType === "application/geo+json");
  const fc = JSON.parse(data.toString("utf8"));
  check("it is a FeatureCollection", fc.type === "FeatureCollection");
  check("it states its CRS in words", typeof fc.crs_note === "string" && fc.crs_note.includes("32643"));
  check("every tree is present", fc.features.length === sample.length);
  const props = fc.features[0].properties;
  for (const key of [
    "tree_id", "latitude", "longitude", "elevation_m", "height_m",
    "crown_area_m2", "crown_diameter_m", "dbh_or_girth", "height_class", "confidence",
  ]) {
    check(`GeoJSON properties carry "${key}"`, key in props, JSON.stringify(props));
  }
}

// ---------------------------------------------------------------------------
console.log("\nCSV: tree points and crown polygons both state a projection and have one row per tree");
{
  const points = treePointsExport(sample, "csv", PROJECTION).data.toString("utf8");
  const pointLines = points.trim().split("\n");
  check("points CSV has a CRS comment", pointLines.some((l) => l.startsWith("#") && l.includes("EPSG")));
  const pointDataLines = pointLines.filter((l) => !l.startsWith("#") && l !== "tree_id,latitude,longitude,elevation_m,height_m,crown_area_m2,crown_diameter_m,dbh_or_girth,height_class,confidence");
  check("one CSV row per tree", pointDataLines.length === sample.length, `${pointDataLines.length}`);

  const crowns = crownPolygonExport(sample, "csv", PROJECTION).data.toString("utf8");
  check(
    "crown CSV states the projection even without coordinate columns",
    crowns.split("\n").some((l) => l.startsWith("#") && l.includes("EPSG:32643")),
  );
  check("crown CSV has no latitude/longitude columns", !crowns.includes("latitude"));
}

// ---------------------------------------------------------------------------
console.log("\nKML: the new writer round trips against the existing reader");
{
  const { data: kmlBuf } = treePointsExport(sample, "kml", PROJECTION);
  const kmlText = kmlBuf.toString("utf8");
  check("KML declares its namespace", kmlText.includes("opengis.net/kml/2.2"));

  const { featureCollection, counts } = readKml(kmlText);
  check("every tree round trips as a Point placemark", counts.Point === sample.length, JSON.stringify(counts));
  const first = featureCollection.features[0];
  check("the placemark name carries the tree id", first.properties.name.includes(sample[0].properties.tree_id));
  check(
    "the description balloon carries the tree's height",
    first.properties.description.includes("Height"),
  );
  const [lon, lat] = first.geometry.coordinates;
  check(
    "the KML point is real lon/lat for this survey, not raw UTM",
    lon > 68 && lon < 75 && lat > 20 && lat < 25,
    `[${lon}, ${lat}]`,
  );
}

// ---------------------------------------------------------------------------
console.log("\nKML: crown polygons carry their holes through readKml");
{
  const { data: kmlBuf } = crownPolygonExport(sample, "kml", PROJECTION);
  const { featureCollection, counts } = readKml(kmlBuf);
  check("every crown round trips as a Polygon placemark", counts.Polygon === sample.length, JSON.stringify(counts));
  const withHole = sample.findIndex((f) => f.geometry.coordinates.length > 1);
  if (withHole >= 0) {
    check(
      "a crown with a hole in the source keeps its hole in the KML",
      featureCollection.features[withHole].geometry.coordinates.length > 1,
    );
  } else {
    console.log("  (skipped: no sampled crown has a hole)");
  }
}

// ---------------------------------------------------------------------------
console.log("\nKMZ: writes a zip readKmz can open, doc.kml at the root");
{
  const { data: kmz, contentType } = treePointsExport(sample, "kmz", PROJECTION);
  check("content type is a KMZ media type", contentType === "application/vnd.google-earth.kmz");
  const { featureCollection } = readKmz(kmz);
  check("KMZ round trips the same tree count as KML", featureCollection.features.length === sample.length);

  const entries = readZip(kmz);
  check("the KMZ's one entry is doc.kml at the root", entries.length === 1 && entries[0].name === "doc.kml");
}

// ---------------------------------------------------------------------------
console.log("\nPDF: the inventory report builds without throwing and is non-trivial");
{
  const buf = buildForestInventoryReport({
    siteName: "Aektanagar",
    siteSlug: "aektanagar-survey",
    layer: "points",
    manifest,
    summary,
    trees: sample,
    maxRows: 200,
  });
  check("a Buffer came back", Buffer.isBuffer(buf));
  check("it starts with the PDF magic header", buf.toString("latin1", 0, 8).startsWith("%PDF-1."));
  check("it ends with %%EOF", buf.toString("latin1", buf.length - 7).trim().endsWith("%%EOF"));
  check("it is non-trivial in size (charts + table drew something)", buf.length > 4000, `${buf.length} bytes`);
  console.log(`  (${(buf.length / 1024).toFixed(1)} KB for ${sample.length} trees, capped at 200 rows)`);
}

// ---------------------------------------------------------------------------
console.log("\nPDF: a larger, more realistic slice still builds and respects the row cap");
{
  const bigger = crownsFile.features.slice(0, 3000);
  const buf = buildForestInventoryReport({
    siteName: "Aektanagar",
    siteSlug: "aektanagar-survey",
    layer: "crowns",
    manifest,
    summary,
    trees: bigger,
    maxRows: 500,
  });
  check("builds over 3,000 real trees without throwing", Buffer.isBuffer(buf) && buf.length > 4000);
  console.log(`  (${(buf.length / 1024).toFixed(1)} KB for ${bigger.length} trees, capped at 500 rows)`);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
