import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import {
  TILE_GRANT_COOKIE,
  TILE_GRANT_MINUTES,
  createTileGrant,
  tileGrantCookieOptions,
} from "@/lib/portal/tile-grant";

export const runtime = "nodejs";

/**
 * The single authorisation decision that covers a whole map session.
 *
 * The map tab calls this once. It proves a session exists and that this user's
 * client owns the site, in exactly the order and with exactly the same
 * `getSite` every other portal route uses, then sets a short lived cookie the
 * tile edge can verify without calling back here. See
 * `docs/portal-map-architecture.md` section 5 for why per object signing does
 * not work for tiles.
 *
 * The failure mode is deliberately identical to the rest of the portal: a site
 * that does not exist and a site belonging to someone else both answer 404, so
 * a slug is never confirmed by the response.
 *
 * This route hands out no bytes. The worst a bug here can do is issue a grant,
 * and the grant only unlocks one site's objects for half an hour.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { siteSlug } = await params;
  const site = await queryDb("tile grant site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "tile-grant" });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const token = await createTileGrant(siteSlug);
  const expiresAt = new Date(Date.now() + TILE_GRANT_MINUTES * 60 * 1000).toISOString();

  // Logged as a map view because that is what it is: the one authorisation
  // decision that opens a survey's tiles for this session. The individual tile
  // reads that follow happen at the edge and are never seen here, so this line
  // is the only record that a client opened the map.
  logPortalEvent("view_map", { userId: session.userId, site: siteSlug, file: "tile-grant" });

  const response = NextResponse.json(
    { site: siteSlug, expiresAt },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );

  // The cookie is scoped to the parent domain so it reaches the tile subdomain.
  // Unset in development, where everything is on localhost and a Domain
  // attribute would stop the cookie being stored at all.
  const domain = process.env.PORTAL_TILE_COOKIE_DOMAIN;
  response.cookies.set({
    name: TILE_GRANT_COOKIE,
    value: token,
    ...tileGrantCookieOptions,
    ...(domain ? { domain } : {}),
  });
  return response;
}
