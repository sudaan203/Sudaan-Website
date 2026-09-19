/**
 * KML and KMZ, read into GeoJSON.
 *
 * Malhar's item 3: the compare panel took a zipped shapefile and nothing else,
 * and KML is what arrives from Google Earth, from a client's phone, and from
 * every handheld GPS in the field. Refusing it meant a conversion step in QGIS
 * before a client could put their own boundary next to ours.
 *
 * ## Written by hand rather than pulled in
 *
 * There is no DOM in a Node route and no XML parser in the standard library, so
 * the options were a dependency or a reader for the subset KML actually uses
 * for geometry. This is the reader. It is deliberately narrow — placemarks,
 * their geometry, their name and description, and the folders they sit in — and
 * it ignores styling, overlays, network links, tours and time spans completely,
 * because none of them place a point on a map.
 *
 * ## The three things that make KML different from everything else here
 *
 * **1. Coordinates are lon,lat[,alt] — and the altitude is optional per point.**
 * Not per file. A single `<coordinates>` run may mix `12.3,45.6` and
 * `12.3,45.6,78.9`, and a reader that assumes three numbers per tuple will
 * silently read the next point's longitude as this point's altitude and shift
 * every coordinate after the first. This splits on whitespace *first* and then
 * on commas within each tuple, which is what the spec actually describes.
 *
 * **2. Longitude comes first.** KML is x,y like GeoJSON, unlike the lat,lon
 * order people type into search boxes and unlike GPX's `lat=` `lon=`
 * attributes. Getting this backwards puts a Gujarat survey in Somalia, which is
 * at least obvious; a site near the equator and the prime meridian would land
 * somewhere plausible, which is worse.
 *
 * **3. KML is always WGS84.** The spec fixes it — there is no projection tag
 * and no equivalent of a `.prj`. So unlike the shapefile path, which refuses a
 * file with no stated CRS, there is nothing here to read and nothing to guess:
 * the coordinates are already lon/lat and go onto the map unprojected.
 *
 * A KMZ is a zip with a `.kml` inside it, so that case unwraps and recurses.
 */

import { readZip, writeZip } from "./zip.mjs";

/**
 * Strip XML comments and CDATA-wrap markers, keeping the CDATA content.
 *
 * A comment containing a `<Placemark>` — which is exactly how people disable
 * one in Google Earth — would otherwise be read as a real placemark.
 */
function clean(xml) {
  return xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);
}

/** Every `<tag>…</tag>` block at any depth, with its inner text. */
function blocks(xml, tag) {
  const out = [];
  // Namespace-tolerant: Google Earth writes bare `<Placemark>`, some exporters
  // write `<kml:Placemark>`, and both are the same element.
  const open = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*?(/?)>`, "gi");
  let match;
  while ((match = open.exec(xml)) !== null) {
    if (match[1] === "/") continue; // self-closing, so no content
    const from = open.lastIndex;
    const close = new RegExp(`</(?:\\w+:)?${tag}\\s*>`, "gi");
    close.lastIndex = from;
    // Nesting has to be counted or the first `</Folder>` closes the outermost
    // folder, and every placemark after it is dropped.
    const nested = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*?(/?)>|</(?:\\w+:)?${tag}\\s*>`, "gi");
    nested.lastIndex = from;
    let depth = 1;
    let end = -1;
    let inner;
    while ((inner = nested.exec(xml)) !== null) {
      if (inner[0].startsWith("</")) {
        depth -= 1;
        if (depth === 0) { end = inner.index; break; }
      } else if (inner[1] !== "/") {
        depth += 1;
      }
    }
    if (end < 0) break;
    out.push(xml.slice(from, end));
    open.lastIndex = end;
  }
  return out;
}

/** The text of the first `<tag>` directly available in this fragment. */
function text(xml, tag) {
  const found = blocks(xml, tag)[0];
  return found === undefined ? null : decode(found.trim());
}

function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/**
 * One `<coordinates>` run to an array of [lon, lat].
 *
 * Altitude is read and discarded. Carrying it would mean deciding whether a
 * KML's own elevation or the survey's raster is authoritative at the same
 * point, and for a layer being uploaded *to compare against* the survey, the
 * answer has to be the survey. GeoJSON positions are therefore two-element.
 */
function coordinates(run) {
  const points = [];
  for (const tuple of run.trim().split(/\s+/)) {
    if (!tuple) continue;
    const parts = tuple.split(",");
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    points.push([lon, lat]);
  }
  return points;
}

/** Close a ring the file left open. KML does not require the repeat; GeoJSON does. */
function closeRing(ring) {
  if (ring.length < 3) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, [fx, fy]];
}

/**
 * The geometry of one placemark.
 *
 * A placemark may hold a `<MultiGeometry>` of mixed types. GeoJSON has no
 * mixed-type geometry short of a GeometryCollection, and a collection is
 * awkward to style as a map layer, so a mixed placemark comes back as several
 * features sharing its properties — which is what a reader of the map expects
 * anyway: the shapes appear where the file says they are.
 */
function geometriesOf(fragment) {
  const out = [];

  for (const point of blocks(fragment, "Point")) {
    const pts = coordinates(text(point, "coordinates") ?? "");
    if (pts.length > 0) out.push({ type: "Point", coordinates: pts[0] });
  }

  for (const line of blocks(fragment, "LineString")) {
    const pts = coordinates(text(line, "coordinates") ?? "");
    if (pts.length >= 2) out.push({ type: "LineString", coordinates: pts });
  }

  // A LinearRing outside a Polygon is legal KML and is a closed line.
  for (const ring of blocks(fragment, "LinearRing")) {
    // Skip the ones that belong to a Polygon; those are handled below.
    if (/<(?:\w+:)?(?:outerBoundaryIs|innerBoundaryIs)/i.test(fragment)) break;
    const pts = coordinates(text(ring, "coordinates") ?? "");
    if (pts.length >= 3) out.push({ type: "LineString", coordinates: closeRing(pts) });
  }

  for (const polygon of blocks(fragment, "Polygon")) {
    const outer = blocks(polygon, "outerBoundaryIs")
      .flatMap((b) => blocks(b, "LinearRing"))
      .map((r) => closeRing(coordinates(text(r, "coordinates") ?? "")))
      .find((r) => r.length >= 4);
    if (!outer) continue;
    /*
     * Holes, which are what `innerBoundaryIs` is for. Dropping them would draw
     * a courtyard as built ground and an island in a lake as water — and the
     * area of the result would be wrong by the size of the hole, which is the
     * number a client is most likely to quote.
     */
    const holes = blocks(polygon, "innerBoundaryIs")
      .flatMap((b) => blocks(b, "LinearRing"))
      .map((r) => closeRing(coordinates(text(r, "coordinates") ?? "")))
      .filter((r) => r.length >= 4);
    out.push({ type: "Polygon", coordinates: [outer, ...holes] });
  }

  return out;
}

/**
 * Read a KML document into a GeoJSON FeatureCollection.
 *
 * @param {string|Buffer} source the KML text
 * @returns {{ featureCollection: GeoJSON.FeatureCollection, counts: Record<string, number> }}
 */
export function readKml(source) {
  const xml = clean(typeof source === "string" ? source : source.toString("utf8"));
  const features = [];

  for (const placemark of blocks(xml, "Placemark")) {
    const name = text(placemark, "name");
    const description = text(placemark, "description");
    const geometries = geometriesOf(placemark);
    for (const geometry of geometries) {
      features.push({
        type: "Feature",
        properties: {
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
        },
        geometry,
      });
    }
  }

  const counts = { Point: 0, LineString: 0, Polygon: 0 };
  for (const f of features) counts[f.geometry.type] = (counts[f.geometry.type] ?? 0) + 1;

  return {
    featureCollection: { type: "FeatureCollection", features },
    counts,
  };
}

/**
 * Read a KMZ: a zip whose payload is a KML.
 *
 * The spec says the document is the *first* `.kml` at the root, and real files
 * lean on that — a KMZ from Google Earth carries `doc.kml` beside an `images/`
 * folder, and picking a different `.kml` out of a subfolder would read a
 * fragment instead of the document.
 */
export function readKmz(bytes) {
  const entries = readZip(bytes);
  const root = entries.filter(
    (e) => e.name.toLowerCase().endsWith(".kml") && !e.name.includes("/"),
  );
  const chosen = root[0] ?? entries.find((e) => e.name.toLowerCase().endsWith(".kml"));
  if (!chosen) {
    throw new Error("that .kmz has no .kml inside it");
  }
  return readKml(chosen.data);
}

// ---------------------------------------------------------------------------
// Writing — the forest export tools' entry point (docs/forest-tools-plan.md
// §7/§12). Nothing in this codebase wrote KML before this; everything above
// only ever read one.
//
// ## Mirrors the reader's own conventions, in reverse
//
// - **Longitude first.** `writeKml` takes plain GeoJSON-shaped geometry
//   (`{ type: "Point"|"Polygon", coordinates }`), which is already lon-then-lat,
//   so no reordering happens here — the caller is responsible for handing this
//   function coordinates already in lon/lat, exactly as `readKml` hands them
//   back. Passing UTM easting/northing here would silently write a file that
//   opens in Google Earth over the wrong continent, the write-side version of
//   the trap `readKml`'s header comment describes.
// - **Always WGS84.** Same reason `readKml` never looks for a `.prj`: KML has
//   no projection tag, so there is nothing to declare beyond stating it in
//   words, which the caller's description text does.
// - **Holes are `innerBoundaryIs`,** the same tag `readKml` already reads back,
//   so a polygon this writes and then re-reads with `readKml` round-trips.
// - **No ring-winding flip.** Unlike a shapefile, KML's recommended winding
//   (counterclockwise outer, clockwise holes as seen from above) already
//   matches GeoJSON's right-hand rule, so — unlike `shapefile.mjs`'s
//   `partsOf` — the rings pass through unreversed. Getting this backwards
//   would be a silent, easy-to-miss mistake precisely because most readers
//   render either winding the same way; it is called out here so nobody "fixes"
//   it into a bug later.
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** One ring, `lon,lat,0` tuples space separated — the exact shape `coordinates` reads. */
function coordinateRun(ring) {
  return ring.map(([lon, lat]) => `${lon},${lat},0`).join(" ");
}

function ringTag(tag, ring) {
  return `<${tag}><LinearRing><coordinates>${coordinateRun(ring)}</coordinates></LinearRing></${tag}>`;
}

/** One geometry object to its KML tag. Point, Polygon (with holes) and MultiPolygon. */
function geometryTag(geometry) {
  if (!geometry) return "";
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    return `<Point><coordinates>${lon},${lat},0</coordinates></Point>`;
  }
  if (geometry.type === "Polygon") {
    const [outer, ...holes] = geometry.coordinates;
    return (
      `<Polygon>${ringTag("outerBoundaryIs", outer)}` +
      `${holes.map((h) => ringTag("innerBoundaryIs", h)).join("")}</Polygon>`
    );
  }
  if (geometry.type === "MultiPolygon") {
    return (
      `<MultiGeometry>${geometry.coordinates
        .map((poly) => geometryTag({ type: "Polygon", coordinates: poly }))
        .join("")}</MultiGeometry>`
    );
  }
  throw new Error(`writeKml: unsupported geometry type "${geometry.type}"`);
}

function placemarkFor(feature) {
  const { properties = {}, geometry } = feature;
  const name = properties.name != null ? `<name>${escapeXml(String(properties.name))}</name>` : "";
  // The description is written as CDATA, unescaped, the same way `readKml`
  // decodes entities back out of it (see `decode` above) — so a caller handing
  // in an HTML popup balloon (a table of a tree's attributes, say) gets exactly
  // that balloon in Google Earth, not a wall of escaped `&lt;tr&gt;` text.
  const description =
    properties.description != null
      ? `<description><![CDATA[${properties.description}]]></description>`
      : "";
  return `<Placemark>${name}${description}${geometryTag(geometry)}</Placemark>`;
}

/**
 * Write a KML document from plain GeoJSON-shaped features.
 *
 * @param {{ properties?: { name?: string, description?: string }, geometry: object }[]} features
 * @param {{ documentName?: string }} [options]
 * @returns {string}
 */
export function writeKml(features, { documentName = "Export" } = {}) {
  const placemarks = features.map(placemarkFor).join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n` +
    `<name>${escapeXml(documentName)}</name>\n` +
    `${placemarks}\n` +
    `</Document></kml>\n`
  );
}

/**
 * The same document, wrapped as a KMZ — a zip whose one entry is `doc.kml`,
 * exactly the shape `readKmz` looks for at the root of the archive.
 *
 * @param {Parameters<typeof writeKml>[0]} features
 * @param {Parameters<typeof writeKml>[1]} [options]
 * @returns {Buffer}
 */
export function writeKmz(features, options = {}) {
  const kml = writeKml(features, options);
  return writeZip([{ name: "doc.kml", data: Buffer.from(kml, "utf8") }]);
}
