import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import { CloudUnavailable, loadCloudManifest, readCloudNode } from "@/lib/portal/cloud-source";

export const runtime = "nodejs";

/**
 * A site's LiDAR point cloud, one quadtree node at a time.
 *
 *   GET .../cloud            -> the manifest: what exists, and where each node is
 *   GET .../cloud/2/1/3      -> that node's points, ten bytes each
 *
 * Authorisation is the same as every other portal route and happens before any
 * file is opened: prove a session, then ask the tenant scoped store for the
 * site, and answer 404 for both "no such site" and "belongs to another client".
 *
 * ## Why GET, and why it may be cached
 *
 * Every other analysis route is a POST, because it computes an answer to a
 * question about geometry the client just drew. This one returns bytes that were
 * written once by an offline pipeline and will not change until the survey is
 * reflown. That makes it a file, and a file should be requested the way files
 * are, so the browser's own cache does the work of not asking twice while a
 * client pans back and forth over the same ground.
 *
 * `private` on the cache header, never `public`. This is one client's survey,
 * and a shared cache holding it would be a way for the next person through a
 * proxy to read it.
 *
 * The general `/api/portal/:path*` rule in next.config.mjs sets `no-store` and
 * *overrides* whatever a handler sets, which is why a more specific rule for
 * this path exists there, placed after the general one so it wins. That trap has
 * now cost two features — the tiler re-rendered every tile on every pan before
 * it was found — so it is written down in both places.
 */

/** Client wording for the two ways a site can have no cloud. */
function unavailableMessage(reason: CloudUnavailable["reason"]): string {
  return reason === "missing"
    ? "No LiDAR point cloud has been published for this survey."
    : "This survey's point cloud could not be read.";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string; node?: string[] }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { siteSlug, node } = await params;
  const site = await queryDb("cloud site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "cloud" });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    if (!node || node.length === 0) {
      const manifest = await loadCloudManifest(siteSlug);
      return NextResponse.json(manifest, {
        headers: {
          // Shorter than a node's, because the manifest is what tells a client a
          // *new* cloud has been published. A stale one for a day would hide a
          // reflight behind a browser cache nobody can reach to clear.
          "Cache-Control": "private, max-age=300",
        },
      });
    }

    if (node.length !== 3) {
      return NextResponse.json(
        { error: "A node is addressed as <level>/<col>/<row>" },
        { status: 400 },
      );
    }

    const bytes = await readCloudNode(siteSlug, node.join("/"));
    if (!bytes) return NextResponse.json({ error: "No such node" }, { status: 404 });

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
        /*
         * A node is immutable: its contents are a function of the survey, and a
         * new survey gets a new manifest. A day is long enough that panning
         * around a site costs one fetch per node, and short enough that a
         * republished cloud is picked up the same working day.
         */
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  } catch (error) {
    if (error instanceof CloudUnavailable) {
      /*
       * The message on the error names the pipeline command and the file layout,
       * which is right for whoever operates this and wrong for a client, who
       * cannot act on it and should not be shown our directory structure. The
       * machine readable `reason` is what the client uses to choose its wording.
       */
      return NextResponse.json(
        { error: unavailableMessage(error.reason), reason: error.reason },
        { status: 409 },
      );
    }
    console.error("[portal cloud]", error);
    return NextResponse.json({ error: "The point cloud could not be served" }, { status: 500 });
  }
}
