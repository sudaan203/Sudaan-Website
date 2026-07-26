import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { isDeclaredTilePath, readMapFile } from "@/lib/portal/map-data";
import { logPortalEvent } from "@/lib/portal/log";
import { queryDb } from "@/lib/portal/db/client";

export const runtime = "nodejs";

/**
 * Serves one georeferenced map layer.
 *
 * The authorisation is the same as everywhere else in the portal and is done in
 * the same order: prove there is a session, then ask the tenant scoped store for
 * the site. getSite returns null both for "no such site" and "belongs to another
 * client", and this answers 404 for both, so a slug is never confirmed.
 *
 * Worth stating plainly: without the getSite call this route would happily read
 * any client's terrain model to anyone signed in, because the files sit in a
 * folder named only by slug.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string; path: string[] }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // A catch-all, because tiles are nested as tiles/<layer>/{z}/{x}/{y}.webp.
  // readMapFile decides what is allowed; this only reassembles the path.
  const { siteSlug, path: segments } = await params;
  const file = (segments ?? []).join("/");

  // Same reconnect protection the pages get. A map pulls dozens of tiles, so a
  // route with no retry turns one dropped connection into a screen of holes.
  const site = await queryDb("map site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const found = await readMapFile(siteSlug, file);
  if (!found) {
    // A tile inside the bounding box but outside the survey footprint was never
    // generated. 204 tells MapLibre "nothing here" without filling the console
    // with 404s on every pan.
    if (await isDeclaredTilePath(siteSlug, file)) {
      return new NextResponse(null, {
        status: 204,
        headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
      });
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(found.body), {
    status: 200,
    headers: {
      "Content-Type": found.contentType,
      "Content-Length": String(found.body.byteLength),
      // View only, same as every other deliverable.
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
