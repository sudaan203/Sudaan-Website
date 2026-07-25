import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getAssetForSession } from "@/lib/portal/store";
import { readPortalFile } from "@/lib/portal/files";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

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
  const found = await getAssetForSession(session, assetId);

  // 404 (not 403) when the asset belongs to another client, so we never confirm
  // that an id exists outside the caller's own data.
  if (!found) {
    logPortalEvent("denied", { userId: session.userId, assetId });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { asset, site } = found;

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
      "Content-Disposition": `inline; filename="${asset.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
