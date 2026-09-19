/**
 * The KML reader, against the things that make KML different.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/kml-test.mjs
 *
 * Written as a hand parser rather than a dependency, so the cases that would
 * normally be somebody else's problem are this file's problem instead. Each
 * check below is a way a naive reader goes wrong *silently* -- placing geometry
 * somewhere plausible and wrong rather than failing:
 *
 *  - altitude is optional **per coordinate**, not per file, so splitting a
 *    run into fixed triples reads the next point's longitude as this point's
 *    height and shifts everything after the first
 *  - longitude comes first, unlike the lat,lon people type and unlike GPX
 *  - a commented-out placemark is how Google Earth disables one
 *  - folders nest, so the first `</Folder>` does not close the outermost
 *  - a polygon's inner boundaries are holes, and dropping them overstates the
 *    area by the size of the hole -- the number a client is most likely to quote
 *  - a MultiGeometry may mix types, which GeoJSON has no single geometry for
 */

import { readKml, readKmz } from "../src/lib/geo/kml.mjs";
import { writeZip } from "../src/lib/geo/zip.mjs";
let bad=0; const ok=(l,c,d="")=>{ if(!c)bad++; console.log(`${c?"ok  ":"FAIL"} ${l}${d?` — ${d}`:""}`); };

const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<!-- <Placemark><name>disabled</name><Point><coordinates>0,0</coordinates></Point></Placemark> -->
<Folder><name>Outer</name>
  <Folder><name>Inner</name>
    <Placemark><name>Nested pt</name><Point><coordinates>72.5,23.1,140</coordinates></Point></Placemark>
  </Folder>
  <Placemark><name>After inner folder</name><Point><coordinates>72.6,23.2</coordinates></Point></Placemark>
</Folder>
<Placemark><name><![CDATA[Hotel & Spa]]></name><description>&lt;b&gt;bold&lt;/b&gt;</description>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>
    72.0,23.0 72.1,23.0 72.1,23.1 72.0,23.1
  </coordinates></LinearRing></outerBoundaryIs>
  <innerBoundaryIs><LinearRing><coordinates>
    72.04,23.04 72.06,23.04 72.06,23.06 72.04,23.06 72.04,23.04
  </coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
<Placemark><name>Mixed altitudes</name><LineString><coordinates>
  72.2,23.2,10 72.3,23.3 72.4,23.4,25
</coordinates></LineString></Placemark>
<Placemark><name>Multi</name><MultiGeometry>
  <Point><coordinates>73.0,24.0</coordinates></Point>
  <LineString><coordinates>73.1,24.1 73.2,24.2</coordinates></LineString>
</MultiGeometry></Placemark>
</Document></kml>`;

const { featureCollection: fc, counts } = readKml(kml);
console.log("counts:", JSON.stringify(counts));
const names = fc.features.map(f=>f.properties.name);
ok("the commented-out placemark is ignored", !names.includes("disabled"));
ok("a placemark nested two folders deep is found", names.includes("Nested pt"));
ok("a sibling after a nested folder is not swallowed", names.includes("After inner folder"), "nesting counted");
ok("CDATA name is unwrapped", names.includes("Hotel & Spa"));
const poly = fc.features.find(f=>f.geometry.type==="Polygon");
ok("polygon has an outer ring and a hole", poly.geometry.coordinates.length===2);
ok("the outer ring is closed", JSON.stringify(poly.geometry.coordinates[0][0])===JSON.stringify(poly.geometry.coordinates[0].at(-1)));
const line = fc.features.find(f=>f.properties.name==="Mixed altitudes");
ok("mixed 2D/3D tuples do not shift coordinates", JSON.stringify(line.geometry.coordinates)==='[[72.2,23.2],[72.3,23.3],[72.4,23.4]]',
   JSON.stringify(line.geometry.coordinates));
ok("lon comes first", line.geometry.coordinates[0][0]===72.2 && line.geometry.coordinates[0][1]===23.2);
ok("MultiGeometry splits into features sharing properties",
   fc.features.filter(f=>f.properties.name==="Multi").length===2);
ok("html-escaped description is decoded", fc.features.find(f=>f.properties.description)?.properties.description==="<b>bold</b>");

// ---- KMZ: a zip whose payload is a KML ------------------------------------
{
  const doc = `<?xml version="1.0"?><kml><Document><Placemark><name>Zipped</name>
    <Point><coordinates>70.1,22.2</coordinates></Point></Placemark></Document></kml>`;
  const kmz = writeZip([
    { name: "images/overlay.png", data: Buffer.from([0x89, 0x50]) },
    { name: "doc.kml", data: Buffer.from(doc, "utf8") },
  ]);
  const { featureCollection } = readKmz(kmz);
  ok(
    "a KMZ reads the .kml at its root, not the first entry",
    featureCollection.features[0]?.properties.name === "Zipped",
  );
}

console.log(bad === 0 ? "\nall KML checks passed" : `\n${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
