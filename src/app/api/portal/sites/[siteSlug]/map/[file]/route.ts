import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { readMapFile } from "@/lib/portal/map-data";
import { logPortalEvent } from "@/lib/portal/log";

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
  { params }: { params: Promise<{ siteSlug: string; file: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { siteSlug, file } = await params;

  const site = await getSite(session, siteSlug);
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const found = await readMapFile(siteSlug, file);
  if (!found) {
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
