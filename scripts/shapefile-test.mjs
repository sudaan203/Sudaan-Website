/**
 * The shapefile engine: SHP geometry, DBF attributes, PRJ projection, and the
 * ZIP container that bundles them.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/shapefile-test.mjs
 *
 * The point of this tool is verification: Malhar wants to draw or import a
 * shape and check our coordinates against another package he trusts. That
 * makes round-tripping the whole test — write a geometry, read it back,
 * require the same numbers — because a shapefile that writes plausibly and
 * reads back wrong is worse than no shapefile at all: it looks like it works
 * right up until someone compares the numbers, which is precisely what this
 * tool exists for someone to do.
 */

import {
  writeShapefileGeometry,
  readShapefileGeometry,
  writeDbf,
  readDbf,
  writeShapefilePrj,
  parseShapefilePrj,
} from "../src/lib/geo/shapefile.mjs";
import { writeZip, readZip } from "../src/lib/geo/zip.mjs";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const pointsNear = (a, b, tol = 1e-6) =>
  a.length === b.length && a.every(([x, y], i) => near(x, b[i][0], tol) && near(y, b[i][1], tol));

// ---------------------------------------------------------------------------
console.log("\nPoint: a single record round trips exactly");
{
  const geometries = [
    { type: "Point", coordinates: [361500.123, 2420900.456] },
    { type: "Point", coordinates: [361600.789, 2421000.012] },
  ];
  const { shp } = writeShapefileGeometry("point", geometries);
  const back = readShapefileGeometry(shp);

  check("the kind survives the round trip", back.kind === "point");
  check("the record count survives", back.geometries.length === 2, `${back.geometries.length}`);
  check(
    "coordinates survive to double precision",
    near(back.geometries[0].coordinates[0], geometries[0].coordinates[0]) &&
      near(back.geometries[0].coordinates[1], geometries[0].coordinates[1]) &&
      near(back.geometries[1].coordinates[0], geometries[1].coordinates[0]),
    JSON.stringify(back.geometries.map((g) => g.coordinates)),
  );
}

// ---------------------------------------------------------------------------
console.log("\nLineString: a drawn alignment round trips, in order");
{
  const line = { type: "LineString", coordinates: [[0, 0], [10, 5], [20, 5], [25, 0]] };
  const { shp } = writeShapefileGeometry("polyline", [line]);
  const back = readShapefileGeometry(shp);

  check("the kind is polyline", back.kind === "polyline");
  check("it reads back as a LineString, not a MultiLineString",
    back.geometries[0].type === "LineString", back.geometries[0].type);
  check("every vertex survives, in the order it was drawn",
    pointsNear(back.geometries[0].coordinates, line.coordinates),
    JSON.stringify(back.geometries[0].coordinates));
}

console.log("\nMultiLineString: more than one part in one record");
{
  const multi = {
    type: "MultiLineString",
    coordinates: [[[0, 0], [5, 5]], [[10, 10], [15, 5], [20, 10]]],
  };
  const { shp } = writeShapefileGeometry("polyline", [multi]);
  const back = readShapefileGeometry(shp);

  check("it reads back as a MultiLineString", back.geometries[0].type === "MultiLineString",
    back.geometries[0].type);
  check("both parts survive with the right point counts",
    back.geometries[0].coordinates.length === 2 &&
      back.geometries[0].coordinates[0].length === 2 &&
      back.geometries[0].coordinates[1].length === 3);
  check("and the coordinates in each part are unchanged",
    pointsNear(back.geometries[0].coordinates[0], multi.coordinates[0]) &&
      pointsNear(back.geometries[0].coordinates[1], multi.coordinates[1]));
}

// ---------------------------------------------------------------------------
console.log("\nPolygon: a simple boundary round trips");
{
  // Counter-clockwise, GeoJSON's own convention for an outer ring.
  const square = {
    type: "Polygon",
    coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
  };
  const { shp } = writeShapefileGeometry("polygon", [square]);
  const back = readShapefileGeometry(shp);

  check("it reads back as a Polygon", back.geometries[0].type === "Polygon",
    back.geometries[0].type);
  check("with exactly one ring, having no holes", back.geometries[0].coordinates.length === 1);
  check("and the same vertices in the same order",
    pointsNear(back.geometries[0].coordinates[0], square.coordinates[0]),
    JSON.stringify(back.geometries[0].coordinates[0]));

  /*
   * The check this tool exists for. A shapefile's outer ring is clockwise and
   * GeoJSON's is counter-clockwise — the opposite convention — and getting that
   * backwards is invisible in a viewer that does not care about winding and
   * fatal in one that does (a hole rendered as if it were the boundary, or
   * vice versa). Read the raw bytes directly, independent of this module's own
   * read path, so a bug shared between the writer and the reader cannot hide
   * from both directions at once.
   */
  const numParts = shp.readInt32LE(100 + 8 + 36);
  const partStart = 100 + 8 + 44;
  const pointsStart = partStart + numParts * 4;
  const rawFirst = [shp.readDoubleLE(pointsStart), shp.readDoubleLE(pointsStart + 8)];
  const rawSecond = [shp.readDoubleLE(pointsStart + 16), shp.readDoubleLE(pointsStart + 24)];
  // GeoJSON [0,0]->[10,0]->[10,10]->[0,10] is CCW; the shapefile bytes must be
  // reversed, so its second vertex should be [0,10], the GeoJSON ring's last
  // interior vertex, not [10,0].
  check("the raw bytes are actually reversed to clockwise, not merely read that way",
    near(rawFirst[0], 0) && near(rawFirst[1], 0) && near(rawSecond[0], 0) && near(rawSecond[1], 10),
    `first ${JSON.stringify(rawFirst)}, second ${JSON.stringify(rawSecond)}`);
}

console.log("\nPolygon with a hole: winding tells outer from inner");
{
  const withHole = {
    type: "Polygon",
    coordinates: [
      [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], // outer, CCW
      [[5, 5], [5, 15], [15, 15], [15, 5], [5, 5]], // hole, CW
    ],
  };
  const { shp } = writeShapefileGeometry("polygon", [withHole]);
  const back = readShapefileGeometry(shp);

  check("it reads back as a Polygon with two rings", back.geometries[0].coordinates.length === 2,
    `${back.geometries[0].coordinates.length} rings`);
  check("the outer ring survives", pointsNear(back.geometries[0].coordinates[0], withHole.coordinates[0]));
  check("the hole survives, correctly identified as a hole and not a second polygon",
    pointsNear(back.geometries[0].coordinates[1], withHole.coordinates[1]),
    JSON.stringify(back.geometries[0].coordinates[1]));

  // A hole's signed area must be negative in GeoJSON's convention (clockwise);
  // if grouping put it in the wrong place this would not hold, and neither
  // would the point count check above, so this is a second, independent read
  // of the same fact.
  const shoelace = (ring) => {
    let s = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return s / 2;
  };
  check("the outer ring is counter-clockwise, GeoJSON's convention",
    shoelace(back.geometries[0].coordinates[0]) > 0);
  check("and the hole is clockwise", shoelace(back.geometries[0].coordinates[1]) < 0);
}

console.log("\nMultiPolygon: two separate outer rings stay separate");
{
  const two = {
    type: "MultiPolygon",
    coordinates: [
      [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
      [[[10, 10], [15, 10], [15, 15], [10, 15], [10, 10]]],
    ],
  };
  const { shp } = writeShapefileGeometry("polygon", [two]);
  const back = readShapefileGeometry(shp);

  check("it reads back as a MultiPolygon", back.geometries[0].type === "MultiPolygon",
    back.geometries[0].type);
  check("with two separate polygons, not one four-ring polygon",
    back.geometries[0].coordinates.length === 2,
    `${back.geometries[0].coordinates.length} polygons`);
  check("each with exactly one ring", back.geometries[0].coordinates.every((p) => p.length === 1));
}

// ---------------------------------------------------------------------------
console.log("\n.shx carries a valid, checkable index");
{
  const { shp, shx } = writeShapefileGeometry("point", [
    { type: "Point", coordinates: [1, 1] },
    { type: "Point", coordinates: [2, 2] },
    { type: "Point", coordinates: [3, 3] },
  ]);
  check("shx has the same file code as shp", shx.readInt32BE(0) === 9994 && shp.readInt32BE(0) === 9994);
  check("shx has one 8 byte record per feature",
    shx.length === 100 + 3 * 8, `${shx.length} bytes`);

  // Each shx entry's offset, read and followed into the shp file, must land
  // exactly on that record's own header.
  let ok = true;
  for (let i = 0; i < 3; i += 1) {
    const offsetWords = shx.readInt32BE(100 + i * 8);
    const recordNumber = shp.readInt32BE(offsetWords * 2);
    if (recordNumber !== i + 1) ok = false;
  }
  check("every shx offset points at the matching shp record", ok);
}

// ---------------------------------------------------------------------------
console.log("\nDBF: attributes round trip, typed");
{
  const rows = [
    { id: 1, name: "checkpoint A", verified: true, note: "GCP" },
    { id: 2, name: "checkpoint B", verified: false, note: "" },
  ];
  const dbf = writeDbf(rows);
  const back = readDbf(dbf);

  check("both records survive", back.records.length === 2, `${back.records.length}`);
  check("numeric fields come back as numbers", back.records[0].id === 1, `${back.records[0].id}`);
  check("text fields come back trimmed", back.records[0].name === "checkpoint A",
    JSON.stringify(back.records[0].name));
  check("boolean fields round trip", back.records[0].verified === true && back.records[1].verified === false,
    `${back.records[0].verified}, ${back.records[1].verified}`);

  check("an empty record list still produces a valid dbf",
    readDbf(writeDbf([])).records.length === 1); // the id-only fallback row
}

// ---------------------------------------------------------------------------
console.log("\nPRJ: UTM zone 43N round trips, and refuses what it should");
{
  const wkt = writeShapefilePrj(32643);
  const back = parseShapefilePrj(wkt);
  check("the zone and hemisphere survive", back.epsg === 32643, `epsg ${back.epsg}`);

  const wgs = parseShapefilePrj(
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
  );
  check("a bare geographic WGS84 CRS is read as lon/lat", wgs.epsg === 4326, `epsg ${wgs.epsg}`);

  check(
    "a zone can be recovered from its parameters alone, without 'Zone_43N' in the name",
    parseShapefilePrj(
      'PROJCS["Custom",GEOGCS["WGS 84",DATUM["WGS_1984"]],PROJECTION["Transverse_Mercator"],' +
        'PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],' +
        'PARAMETER["Central_Meridian",75.0],PARAMETER["Scale_Factor",0.9996]]',
    ).epsg === 32643,
  );

  let refused = false;
  try {
    parseShapefilePrj('PROJCS["NAD_1983_UTM_Zone_15N",GEOGCS["NAD83"]]');
  } catch {
    refused = true;
  }
  check("a non-WGS84 datum is refused rather than assumed close enough", refused);

  let refusedEpsg = false;
  try {
    writeShapefilePrj(4326);
  } catch {
    refusedEpsg = true;
  }
  check("writing a non-UTM code is refused", refusedEpsg);
}

// ---------------------------------------------------------------------------
console.log("\nZIP: the four files round trip as one archive");
{
  const { shp, shx } = writeShapefileGeometry("point", [{ type: "Point", coordinates: [1, 2] }]);
  const dbf = writeDbf([{ id: 1 }]);
  const prj = Buffer.from(writeShapefilePrj(32643), "latin1");

  const zip = writeZip([
    { name: "layer.shp", data: shp },
    { name: "layer.shx", data: shx },
    { name: "layer.dbf", data: dbf },
    { name: "layer.prj", data: prj },
  ]);

  check("the archive starts with a local file header signature", zip.readUInt32LE(0) === 0x04034b50);

  const entries = readZip(zip);
  check("all four files come back", entries.length === 4, `${entries.length}`);
  check("named the way they were written",
    ["layer.shp", "layer.shx", "layer.dbf", "layer.prj"].every((n) =>
      entries.some((e) => e.name === n)),
    entries.map((e) => e.name).join(", "));

  const shpBack = entries.find((e) => e.name === "layer.shp").data;
  check("the shp bytes are byte-for-byte identical after the round trip",
    Buffer.compare(shp, shpBack) === 0, `${shp.length} vs ${shpBack.length} bytes`);

  const prjBack = entries.find((e) => e.name === "layer.prj").data.toString("latin1");
  check("the prj text survives too", prjBack === prj.toString("latin1"));
}

console.log("\nZIP: refuses what it cannot open, rather than guessing");
{
  let refused = false;
  try {
    readZip(Buffer.from("not a zip file at all"));
  } catch {
    refused = true;
  }
  check("a file with no end of central directory record is refused", refused);
}

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}\n`);
process.exit(fail ? 1 : 0);
