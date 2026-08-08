/**
 * Portal side of the tile grant: the environment and cookie concerns.
 *
 * The rules themselves live in `tile-grant-core.mjs`, shared verbatim with the
 * Cloudflare Worker in `workers/tile-gateway`. This file adds only the two
 * things a Worker must not have: where the secret comes from, and how the cookie
 * is set.
 *
 * See `docs/portal-map-architecture.md` section 5 for why tiles get one
 * authorisation decision per session rather than a signature per object.
 */

import {
  TILE_GRANT_COOKIE,
  TILE_GRANT_MINUTES,
  createTileGrant as mint,
  verifyTileGrant as check,
  keyIsWithinSite,
  siteObjectPrefix,
} from "./tile-grant-core.mjs";

export { TILE_GRANT_COOKIE, TILE_GRANT_MINUTES, keyIsWithinSite, siteObjectPrefix };

export type TileGrant = {
  /** The one site this token authorises. */
  site: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
};

/**
 * The signing secret.
 *
 * Separate from `PORTAL_AUTH_SECRET` on purpose, and the check below refuses to
 * let them be the same value. This secret is deployed to Cloudflare so the edge
 * can verify grants; the session secret mints portal logins and must never leave
 * our own infrastructure. Sharing them would turn a compromise of the tile edge
 * into a compromise of every account.
 */
function tileSecret(): string {
  const secret = process.env.PORTAL_TILE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "PORTAL_TILE_SECRET is missing or too short. Generate one with: openssl rand -base64 32",
    );
  }
  if (secret === process.env.PORTAL_AUTH_SECRET) {
    throw new Error(
      "PORTAL_TILE_SECRET must not equal PORTAL_AUTH_SECRET. The tile secret is deployed to " +
        "the Cloudflare Worker; the session secret must never leave our own infrastructure.",
    );
  }
  return secret;
}

export function createTileGrant(site: string, options?: { minutes?: number }): Promise<string> {
  return mint(site, tileSecret(), options);
}

export function verifyTileGrant(
  token: string | undefined,
  expectedSite?: string,
): Promise<TileGrant | null> {
  return check(token, tileSecret(), { expectedSite });
}

/**
 * Cookie attributes for the grant.
 *
 * A function rather than a constant because `process.env` must not be read when
 * the module is imported: the same file is reachable from the Edge runtime, and
 * a top level environment read is how a shared module stops being shareable.
 */
export function tileGrantCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax, not None. The tile host is a subdomain of the portal, so it is the
    // same site under cookie rules and Lax is still sent on those subresource
    // requests. None would additionally expose the cookie to genuinely cross
    // site requests, which nothing here needs.
    sameSite: "lax" as const,
    path: "/",
    maxAge: TILE_GRANT_MINUTES * 60,
  };
}
