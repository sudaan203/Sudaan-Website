import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getAssetForSession } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { readPortalFile } from "@/lib/portal/files";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

/**
 * What we are willing to put a Content-Type on and serve from our own origin.
 *
 * This is the important line in the file. A file served from sudaangeo.in as
 * text/html or image/svg+xml is same origin script: open one directly and it can
 * read the portal's pages, call its endpoints as you, and walk your data out.
 * nosniff does not help, because nothing is being sniffed; we would be declaring
 * the dangerous type ourselves.
 *
 * Today the catalogue is filled in by a developer, so this guards a mistake
 * rather than an attacker. When uploads land in a later phase it is the boundary
 * between a client's file and our origin, so it belongs here now, before anything
 * depends on the looser behaviour.
 */
const VIEWABLE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  /**
   * Delimited text, for point grids and observation tables.
   *
   * Safe for the reason the types above this line are and text/html is not: a
   * browser never executes text/csv, so serving it from our origin creates no
   * script context. It is also sent with `Content-Disposition: inline` and
   * `X-Content-Type-Options: nosniff`, so it cannot be re-interpreted as
   * something executable.
   *
   * Added because the Aektanagar elevation grid, 5,449 real surveyed points, was
   * being refused here with a 415 and reported to the client as "this file type
   * cannot be previewed". CsvViewer parses and profiles it instead.
   */
  "text/csv",
  "text/tab-separated-values",
]);

/**
 * Header values cannot contain control characters, and a filename arriving with
 * a newline in it would let someone append headers of their own. Quotes are
 * stripped because the value is quoted, and the result is ASCII only so no
 * encoding question arises.
 */
function safeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
  return cleaned.slice(0, 120) || "file";
}

/**
 * Streams an asset for in browser viewing.
 *
 * View only by design: Content-Disposition is always "inline" and the portal
 * never renders a download link. This is a deterrent, not DRM. A determined
 * viewer can still screenshot or use browser tooling, which is worth saying out
 * loud to clients rather than implying the file cannot leave the browser.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { assetId } = await params;
  // Through queryDb: pages recover from a pooled connection the database
  // dropped between requests, and without this the routes did not. A dead
  // socket turned into a 500 here while /portal beside it reconnected and
  // carried on, which is a confusing thing to debug from the outside.
  const found = await queryDb("asset lookup", () => getAssetForSession(session, assetId));

  // 404 (not 403) when the asset belongs to another client, so we never confirm
  // that an id exists outside the caller's own data.
  if (!found) {
    logPortalEvent("denied", { userId: session.userId, assetId });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { asset, site } = found;

  // Refuse rather than serve a type we have not vetted. The viewer already has
  // a "cannot be previewed in the browser" state for exactly this.
  if (!VIEWABLE_TYPES.has(asset.mimeType)) {
    console.warn(
      `[portal] refusing to serve asset ${asset.id} with unsupported type ${asset.mimeType}`,
    );
    return NextResponse.json({ error: "Not viewable" }, { status: 415 });
  }

  let body: Buffer;
  try {
    body = await readPortalFile(asset.storageKey);
  } catch (err) {
    console.error("[portal] asset read failed", asset.storageKey, err);
    return NextResponse.json({ error: "Asset unavailable" }, { status: 404 });
  }

  logPortalEvent("view_asset", {
    userId: session.userId,
    clientId: session.clientId,
    site: site.slug,
    assetId: asset.id,
  });

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `inline; filename="${safeFilename(asset.fileName)}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      // The tight Content-Security-Policy for this response is set in
      // next.config.mjs, not here: a header from the config wins over one set by
      // the handler, so setting it here achieved nothing at all.
    },
  });
}
