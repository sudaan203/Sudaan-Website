import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import { ForestUnavailable, loadForest } from "@/lib/portal/forest-source";
import { openTerrain } from "@/lib/portal/terrain-source";
import { treePointsExport, crownPolygonExport } from "@/lib/geo/forest-export.mjs";
import { buildForestInventoryReport } from "@/lib/geo/forest-report.mjs";

export const runtime = "nodejs";

/**
 * Forest exports — tree points and crown polygons, in SHP, GeoJSON, CSV,
 * KML, KMZ and a PDF inventory report. `docs/forest-tools-plan.md` §7 / §12.
 *
 *   GET .../forest/export?layer=points|crowns&format=shp|geojson|csv|kml|kmz|pdf
 *       [&minHeight=][&maxHeight=][&minCrownArea=][&maxCrownArea=]
 *       [&minCrownDiameter=][&maxCrownDiameter=][&minElevation=][&maxElevation=]
 *       [&minConfidence=][&maxConfidence=][&heightClass=a,b][&treeIds=id1,id2]
 *
 * One route, not five or six, because "which format" and "which layer" are
 * both just parameters of the same job: read this survey's crown features,
 * narrow them to whatever the caller's filter describes, hand the result to
 * one writer. Splitting that into a route per format would triple the amount
 * of code that has to agree on what a "tree" is.
 *
 * ## Authorisation, identical to every sibling route
 *
 * Prove a session, then ask the tenant-scoped store for the site, and answer
 * 404 for both "no such site" and "belongs to another client" — before any
 * forest file is opened. Same order, same status codes, as `.../hydrology`
 * and `.../shapefile`.
 *
 * ## Filtering happens here, not client-side-then-trust
 *
 * The whole point of scoping an export to "only trees passing the client's
 * current filter" is that a request for 40 tall trees should not carry
 * 26,776 of them over the wire and back. So this route re-applies the same
 * filter server-side from query parameters, rather than trusting a list of
 * ids the client already filtered — which also means a shared export link
 * (not currently offered, but cheap to add later) keeps meaning the same
 * thing without the browser having replayed anything.
 */

class BadRequest extends Error {}

const LAYERS = new Set(["points", "crowns"]);
const VECTOR_FORMATS = new Set(["shp", "geojson", "csv", "kml", "kmz"]);
const FORMATS = new Set([...VECTOR_FORMATS, "pdf"]);

const EXT: Record<string, string> = { shp: "zip", geojson: "geojson", csv: "csv", kml: "kml", kmz: "kmz", pdf: "pdf" };
const CONTENT_TYPE: Record<string, string> = {
  shp: "application/zip",
  geojson: "application/geo+json",
  csv: "text/csv",
  kml: "application/vnd.google-earth.kml+xml",
  kmz: "application/vnd.google-earth.kmz",
  pdf: "application/pdf",
};

function num(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The seven filter axes `docs/forest-tools-plan.md` §9 lists for
 * `TreeFilterPanel`, applied here against the raw `crowns.geojson` properties
 * so a export never carries more trees than the caller asked to see.
 */
function filterTrees(features: GeoJsonFeature[], search: URLSearchParams): GeoJsonFeature[] {
  const minHeight = num(search.get("minHeight"));
  const maxHeight = num(search.get("maxHeight"));
  const minCrownArea = num(search.get("minCrownArea"));
  const maxCrownArea = num(search.get("maxCrownArea"));
  const minCrownDiameter = num(search.get("minCrownDiameter"));
  const maxCrownDiameter = num(search.get("maxCrownDiameter"));
  const minElevation = num(search.get("minElevation"));
  const maxElevation = num(search.get("maxElevation"));
  const minConfidence = num(search.get("minConfidence"));
  const maxConfidence = num(search.get("maxConfidence"));
  const heightClasses = search.get("heightClass")?.split(",").map((s) => s.trim()).filter(Boolean);
  const treeIds = search.get("treeIds")?.split(",").map((s) => s.trim()).filter(Boolean);
  const idSet = treeIds && treeIds.length ? new Set(treeIds) : null;
  const classSet = heightClasses && heightClasses.length ? new Set(heightClasses) : null;

  return features.filter((f) => {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (idSet && !idSet.has(String(p.tree_id))) return false;
    if (classSet && !classSet.has(String(p.height_class))) return false;
    const height = typeof p.height_m === "number" ? p.height_m : null;
    if (minHeight !== null && (height === null || height < minHeight)) return false;
    if (maxHeight !== null && (height === null || height > maxHeight)) return false;
    const area = typeof p.crown_area_m2 === "number" ? p.crown_area_m2 : null;
    if (minCrownArea !== null && (area === null || area < minCrownArea)) return false;
    if (maxCrownArea !== null && (area === null || area > maxCrownArea)) return false;
    const diam = typeof p.crown_diameter_avg_m === "number" ? p.crown_diameter_avg_m : null;
    if (minCrownDiameter !== null && (diam === null || diam < minCrownDiameter)) return false;
    if (maxCrownDiameter !== null && (diam === null || diam > maxCrownDiameter)) return false;
    const elevation = typeof p.ground_elevation_m === "number" ? p.ground_elevation_m : null;
    if (minElevation !== null && (elevation === null || elevation < minElevation)) return false;
    if (maxElevation !== null && (elevation === null || elevation > maxElevation)) return false;
    const confidence = typeof p.confidence === "number" ? p.confidence : null;
    if (minConfidence !== null && (confidence === null || confidence < minConfidence)) return false;
    if (maxConfidence !== null && (confidence === null || confidence > maxConfidence)) return false;
    return true;
  });
}

type GeoJsonFeature = { type: "Feature"; properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };

/**
 * The survey's own UTM zone, read from the forest CHM raster first (it shares
 * the DSM/DTM's grid and CRS by construction — CHM = DSM − DTM) and, failing
 * that, the DTM directly — the same fallback the shapefile route uses, for a
 * survey whose forest run has produced crowns but not (yet, or ever) a CHM
 * this route can open.
 */
async function forestZone(
  siteSlug: string,
  forest: Awaited<ReturnType<typeof loadForest>>,
): Promise<{ zone: number; northern: boolean; epsg: number }> {
  try {
    const chm = await forest.chm();
    const utm = chm.utmZone;
    if (utm && chm.epsg) return { zone: utm.zone, northern: utm.northern, epsg: chm.epsg };
  } catch {
    // fall through to the DTM
  }
  const raster = await openTerrain(siteSlug, "dtm");
  if (raster.utmZone && raster.epsg) {
    return { zone: raster.utmZone.zone, northern: raster.utmZone.northern, epsg: raster.epsg };
  }
  throw new BadRequest(
    "This survey has no recorded UTM zone to export in — neither its forest CHM nor its DTM " +
      "carries one.",
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { siteSlug } = await params;
  const site = await queryDb("forest export site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "forest:export" });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const search = request.nextUrl.searchParams;
  const layer = String(search.get("layer") ?? "");
  const format = String(search.get("format") ?? "");

  try {
    if (!LAYERS.has(layer)) {
      throw new BadRequest(`layer must be "points" or "crowns", not "${layer}"`);
    }
    if (!FORMATS.has(format)) {
      throw new BadRequest(
        `format must be one of ${[...FORMATS].join(", ")}, not "${format}"`,
      );
    }

    const forest = await loadForest(siteSlug);
    const crowns = (await forest.crowns()) as { features: GeoJsonFeature[] };
    const features = filterTrees(crowns.features ?? [], search);
    if (features.length === 0) {
      throw new BadRequest("No trees match that filter — nothing to export.");
    }

    const projection = await forestZone(siteSlug, forest);
    const stem = `${siteSlug}-forest-${layer}`;

    logPortalEvent("view_map", {
      userId: session.userId,
      site: siteSlug,
      file: `forest:export:${layer}:${format}`,
    });

    if (format === "pdf") {
      const summary = await forest.summary();
      const pdf = buildForestInventoryReport({
        siteName: site.name,
        siteSlug,
        layer: layer as "points" | "crowns",
        manifest: forest.manifest,
        summary,
        trees: features,
      });
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": CONTENT_TYPE.pdf,
          "Content-Disposition": `attachment; filename="${stem}-report.pdf"`,
          "Content-Length": String(pdf.length),
          "Cache-Control": "private, no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }

    const build = layer === "points" ? treePointsExport : crownPolygonExport;
    const result = build(features, format as "shp" | "geojson" | "csv" | "kml" | "kmz", projection);

    return new NextResponse(new Uint8Array(result.data), {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${stem}.${EXT[format]}"`,
        "Content-Length": String(result.data.length),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    if (error instanceof BadRequest) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ForestUnavailable) {
      return NextResponse.json({ error: error.message, reason: error.reason }, { status: 409 });
    }
    console.error("[portal forest export]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The forest export could not be built" },
      { status: 500 },
    );
  }
}
