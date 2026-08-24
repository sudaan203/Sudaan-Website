"use client";

/**
 * Typed client for Malhar's shapefile tool.
 *
 * Two operations, and they are asymmetric on purpose. Download sends JSON —
 * a handful of drawn coordinates is nothing to a request body — and gets a
 * `.zip` back as bytes. Upload sends the file itself as multipart form data,
 * because a shapefile a client picks up from disk can be a few megabytes and
 * base64 in a JSON body would inflate that by a third for no reason; it gets
 * GeoJSON back, already reprojected to the map's own longitude and latitude.
 */

export type GeometryKind = "point" | "line" | "polygon";

export class ShapefileError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ShapefileError";
    this.status = status;
  }
}

export type UploadedShapefile = {
  kind: GeometryKind | "polyline";
  count: number;
  crs: { epsg: number; description: string };
  featureCollection: GeoJSON.FeatureCollection;
};

/** A feature as the draw tool produces it: lon/lat geometry, no attributes yet. */
export type DrawnFeature = { geometry: GeoJSON.Geometry; properties?: Record<string, unknown> };

export class ShapefileClient {
  constructor(private readonly siteSlug: string) {}

  private get endpoint(): string {
    return `/api/portal/sites/${encodeURIComponent(this.siteSlug)}/shapefile`;
  }

  /** Download drawn features as a real ESRI Shapefile, zipped. Returns the Blob to save. */
  async download(
    geometryType: GeometryKind,
    features: DrawnFeature[],
    name?: string,
  ): Promise<{ blob: Blob; filename: string }> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ op: "download", geometryType, features, name }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as { error?: string });
      throw new ShapefileError(body.error ?? "The shapefile could not be built.", response.status);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `${geometryType}s.zip`;
    return { blob: await response.blob(), filename };
  }

  /** Upload a shapefile `.zip` and get back GeoJSON, already in longitude and latitude. */
  async upload(file: File): Promise<UploadedShapefile> {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(this.endpoint, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const body = await response.json().catch(() => ({}) as Record<string, unknown>);
    if (!response.ok) {
      throw new ShapefileError(
        typeof body.error === "string" ? body.error : "The shapefile could not be read.",
        response.status,
      );
    }
    return body as UploadedShapefile;
  }
}

/** A browser download for the zip `download()` returns, with no server round trip involved. */
export function saveShapefileZip(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}
