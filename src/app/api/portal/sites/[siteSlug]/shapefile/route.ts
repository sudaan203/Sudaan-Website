import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import { readMapManifest } from "@/lib/portal/map-data";
import { lonLatToUtm, utmToLonLat } from "@/lib/geo/projection.mjs";
import {
  writeShapefileGeometry,
  readShapefileGeometry,
  writeDbf,
  readDbf,
  writeShapefilePrj,
  parseShapefilePrj,
} from "@/lib/geo/shapefile.mjs";
import { writeZip, readZip } from "@/lib/geo/zip.mjs";

export const runtime = "nodejs";

/**
 * Malhar's shapefile tool: draw or upload Point, Line and Polygon features,
 * download them as a real ESRI Shapefile, and compare them against whatever
 * other package he trusts.
 *
 *   POST .../shapefile   { op: "download", ... }  -> a .zip
 *   POST .../shapefile   { op: "upload" }           -> GeoJSON, as multipart form data
 *
 * Authorisation is the same as every other portal route: prove a session, then
 * ask the tenant scoped store for the site, and answer 404 for both "no such
 * site" and "belongs to another client" — before any geometry is touched.
 *
 * ## Why this needs a route at all
 *
 * `export-formats.mjs` writes CSV, DXF and LandXML entirely in the browser,
 * because it has zero imports and nothing it does needs Node. This cannot:
 * reading a zip a client uploads has to tolerate deflate compression, because
 * that is what QGIS, ArcGIS and Global Mapper write by default, and decoding
 * that needs `node:zlib`. A binary format reader that only accepts the one
 * compression method its own writer happens to use is not an interchange tool,
 * it is a private format wearing a public one's extension.
 *
 * ## Projection, both ways
 *
 * Download always writes in the survey's own UTM zone, never lon/lat — the
 * same rule every other export in this portal follows, because a shapefile of
 * plain longitude and latitude opened in a package that assumes metres is a
 * shapefile drawn in the wrong place with no error to say so.
 *
 * Upload reads whatever zone the uploaded `.prj` declares, which need not be
 * the survey's own zone: the whole point of this tool is comparing our data
 * against a file that came from somewhere else, and refusing a shapefile for
 * being honestly in a different projection would defeat that. A shapefile with
 * no recognisable CRS, or one not on WGS84, is refused rather than guessed at
 * — `parseShapefilePrj` already enforces that, and this route does not relax it.
 */

class BadRequest extends Error {}

const GEOMETRY_KIND = { point: "point", line: "polyline", polygon: "polygon" } as const;
type GeometryKind = keyof typeof GEOMETRY_KIND;

/** The site's own UTM zone, read from the map manifest rather than a raster.
 *  Lighter than opening a terrain GeoTIFF for a projection nothing else here
 *  needs, and available in production whether or not local terrain is. */
async function siteUtmZone(siteSlug: string): Promise<{ zone: number; northern: boolean; epsg: number }> {
  const manifest = await readMapManifest(siteSlug);
  const dem = manifest?.layers.find((l) => l.utmZone);
  if (!dem?.utmZone) {
    throw new BadRequest("This site has no recorded UTM zone to export in.");
  }
  const northern = dem.utmNorthern !== false;
  return {
    zone: dem.utmZone,
    northern,
    epsg: (northern ? 32600 : 32700) + dem.utmZone,
  };
}

function readLonLat(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length < 2) throw new BadRequest("a coordinate must be [lon, lat]");
  const [a, b] = value.map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new BadRequest("a coordinate is not numeric");
  return [a, b];
}
function readRing(value: unknown): [number, number][] {
  if (!Array.isArray(value) || value.length < 2) throw new BadRequest("a line needs at least 2 points");
  return value.map(readLonLat);
}

/**
 * A drawn feature, from the client, projected into the survey's own metres.
 *
 * Deliberately narrow: only the three plain geometries the draw tool can ever
 * produce. A client uploading something more exotic goes through `upload`
 * instead, which reads whatever a shapefile actually contains.
 */
function projectFeature(
  kind: GeometryKind,
  geometry: unknown,
  project: (lon: number, lat: number) => [number, number],
) {
  const g = geometry as { type?: string; coordinates?: unknown };
  if (kind === "point") {
    if (g.type !== "Point") throw new BadRequest(`expected a Point, got "${g.type}"`);
    const [lon, lat] = readLonLat(g.coordinates);
    return { type: "Point", coordinates: project(lon, lat) };
  }
  if (kind === "line") {
    if (g.type !== "LineString") throw new BadRequest(`expected a LineString, got "${g.type}"`);
    return {
      type: "LineString",
      coordinates: readRing(g.coordinates).map(([lon, lat]) => project(lon, lat)),
    };
  }
  if (g.type !== "Polygon") throw new BadRequest(`expected a Polygon, got "${g.type}"`);
  const rings = g.coordinates as unknown[];
  if (!Array.isArray(rings) || rings.length === 0) throw new BadRequest("a polygon needs a ring");
  return {
    type: "Polygon",
    coordinates: rings.map((ring) => readRing(ring).map(([lon, lat]) => project(lon, lat))),
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { siteSlug } = await params;
  const site = await queryDb("shapefile site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "shapefile" });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  try {
    // -------------------------------------------------------------- upload --
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new BadRequest("no file was uploaded");
      }
      if (!file.name.toLowerCase().endsWith(".zip")) {
        throw new BadRequest("upload a .zip containing .shp, .dbf and .prj");
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      const entries = readZip(bytes);

      // Matched by extension, case-insensitively, and by whichever base name
      // has a .shp: a zip may hold the three files under any shared stem, and
      // some tools zip a folder rather than flat files, which is why this
      // looks at the extension rather than an exact expected name.
      const byExt = (ext: string) =>
        entries.find((e) => e.name.toLowerCase().endsWith(`.${ext}`))?.data;
      const shp = byExt("shp");
      const prj = byExt("prj");
      if (!shp) {
        throw new BadRequest(
          "the zip has no .shp file. Upload a zip containing .shp, .shx, .dbf and .prj.",
        );
      }
      if (!prj) {
        throw new BadRequest(
          "the zip has no .prj file, so its coordinate system is unknown. A shapefile with " +
            "no stated projection cannot be placed on the map safely — export it with a .prj.",
        );
      }

      const geo = readShapefileGeometry(shp);
      const dbf = byExt("dbf");
      const attributes = dbf ? readDbf(dbf).records : [];
      const crs = parseShapefilePrj(prj.toString("latin1"));

      const toLonLat: (x: number, y: number) => [number, number] =
        crs.epsg === 4326
          ? (x, y) => [x, y]
          : (x, y) =>
              utmToLonLat(
                x,
                y,
                crs.epsg >= 32700 ? crs.epsg - 32700 : crs.epsg - 32600,
                crs.epsg < 32700,
              ) as [number, number];

      const reprojectRing = (ring: [number, number][]) => ring.map(([x, y]) => toLonLat(x, y));
      const reproject = (geometry: { type: string; coordinates: unknown }): unknown => {
        if (geometry.type === "Point") {
          const [x, y] = geometry.coordinates as [number, number];
          return { type: "Point", coordinates: toLonLat(x, y) };
        }
        if (geometry.type === "LineString") {
          return { type: "LineString", coordinates: reprojectRing(geometry.coordinates as [number, number][]) };
        }
        if (geometry.type === "MultiLineString") {
          return {
            type: "MultiLineString",
            coordinates: (geometry.coordinates as [number, number][][]).map(reprojectRing),
          };
        }
        if (geometry.type === "Polygon") {
          return {
            type: "Polygon",
            coordinates: (geometry.coordinates as [number, number][][]).map(reprojectRing),
          };
        }
        // MultiPolygon
        return {
          type: "MultiPolygon",
          coordinates: (geometry.coordinates as [number, number][][][]).map((poly) =>
            poly.map(reprojectRing),
          ),
        };
      };

      const featureCollection = {
        type: "FeatureCollection" as const,
        features: geo.geometries.map((geometry, i) => ({
          type: "Feature" as const,
          properties: attributes[i] ?? {},
          geometry: reproject(geometry as { type: string; coordinates: unknown }),
        })),
      };

      logPortalEvent("view_map", {
        userId: session.userId,
        site: siteSlug,
        file: `shapefile:upload:${geo.kind}`,
      });

      return NextResponse.json(
        {
          kind: geo.kind,
          count: geo.geometries.length,
          crs: { epsg: crs.epsg, description: crs.description },
          featureCollection,
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    // ------------------------------------------------------------ download --
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Body must be JSON, or a multipart upload" }, { status: 400 });
    }

    const op = String(body.op ?? "");
    if (op !== "download") {
      return NextResponse.json({ error: 'op must be "download", or send a multipart upload' }, {
        status: 400,
      });
    }

    const kind = String(body.geometryType ?? "") as GeometryKind;
    if (!GEOMETRY_KIND[kind]) {
      throw new BadRequest('geometryType must be "point", "line" or "polygon"');
    }
    const rawFeatures = body.features;
    if (!Array.isArray(rawFeatures) || rawFeatures.length === 0) {
      throw new BadRequest("features must be a non-empty array — draw at least one shape first");
    }

    const utm = await siteUtmZone(siteSlug);
    const project = (lon: number, lat: number): [number, number] =>
      lonLatToUtm(lon, lat, utm.zone, utm.northern) as [number, number];

    const geometries = rawFeatures.map((f) => {
      const feature = f as { geometry?: unknown; properties?: unknown };
      return projectFeature(kind, feature.geometry, project);
    });
    const properties = rawFeatures.map((f, i) => {
      const feature = f as { properties?: Record<string, unknown> };
      return { id: i + 1, ...(feature.properties ?? {}) };
    });

    const { shp, shx } = writeShapefileGeometry(GEOMETRY_KIND[kind], geometries as never);
    const dbf = writeDbf(properties);
    const prj = Buffer.from(writeShapefilePrj(utm.epsg), "latin1");

    const stem = String(body.name ?? `sudaan-${kind}s`).replace(/[^a-z0-9_-]+/gi, "_");
    const zip = writeZip([
      { name: `${stem}.shp`, data: shp },
      { name: `${stem}.shx`, data: shx },
      { name: `${stem}.dbf`, data: dbf },
      { name: `${stem}.prj`, data: prj },
    ]);

    logPortalEvent("view_map", {
      userId: session.userId,
      site: siteSlug,
      file: `shapefile:download:${kind}`,
    });

    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${stem}.zip"`,
        "Content-Length": String(zip.length),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    if (error instanceof BadRequest) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[portal shapefile]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The shapefile could not be processed" },
      { status: 400 },
    );
  }
}
