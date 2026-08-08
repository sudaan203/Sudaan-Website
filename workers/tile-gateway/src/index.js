/**
 * Cloudflare Worker: the only door to the private R2 bucket holding survey data.
 *
 * Phase 3a of `docs/portal-map-architecture.md`. The portal makes one
 * authorisation decision when a client opens a map, using the tenant scoped
 * store, and sets a short lived cookie. This Worker checks that cookie and
 * streams bytes straight out of R2, so no tile request touches a Vercel function
 * and one decision covers hundreds of tiles.
 *
 * Treat this file as part of the security boundary, not as plumbing. It sits
 * outside our own infrastructure and it is the last thing standing between a
 * private bucket and the internet. `docs/portal-map-architecture.md` section 11
 * lists it as new attack surface for exactly this reason.
 *
 * What it will not do, each of which was a decision rather than an omission:
 *
 * - **No listing.** There is no path that enumerates the bucket. A client who
 *   knows their own site learns nothing about which other sites exist.
 * - **No writes.** GET and HEAD only. The binding should also be read only.
 * - **No cross site reads.** A valid signature proves we issued the token; it
 *   does not prove the token covers the object being asked for. Both are checked.
 * - **No identity.** The token carries a site and an expiry. This Worker cannot
 *   tell one client from another, and that is the point: compromising the edge
 *   yields tiles, not a user.
 *
 * Deploy:
 *   cd workers/tile-gateway
 *   npx wrangler secret put PORTAL_TILE_SECRET
 *   npx wrangler deploy
 */

// One source of truth, shared verbatim with the portal. Wrangler bundles this
// relative import, so the authorisation rules on the edge cannot drift away from
// the rules that mint the tokens. Duplicating them here was the first draft and
// it was a bad idea: the copy nobody remembers to update is the one holding a
// private bucket open.
import {
  TILE_GRANT_COOKIE,
  verifyTileGrant,
  keyIsWithinSite,
} from "../../../src/lib/portal/tile-grant-core.mjs";

/** Range requests are the whole point: COG and PMTiles are read by byte range. */
const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Everything that is not a successful read answers the same way: 404, no body,
 * no detail. A 403 would confirm the object exists, which tells an attacker
 * which sites are real, and that is the same reasoning the portal already uses
 * for pages.
 */
function notFound() {
  return new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const CONTENT_TYPES = {
  pmtiles: "application/octet-stream",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  json: "application/json",
  geojson: "application/geo+json",
  laz: "application/octet-stream",
  copc: "application/octet-stream",
};

export default {
  async fetch(request, env) {
    if (!ALLOWED_METHODS.has(request.method)) return notFound();
    if (request.method === "OPTIONS") {
      // No CORS allowances. The map is served from our own origin, so a
      // cross origin preflight has no legitimate reason to succeed here.
      return new Response(null, { status: 405 });
    }
    if (!env.PORTAL_TILE_SECRET || !env.SURVEY_BUCKET) return notFound();

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    const grant = await verifyTileGrant(
      readCookie(request.headers.get("Cookie"), TILE_GRANT_COOKIE),
      env.PORTAL_TILE_SECRET,
    );
    if (!grant) return notFound();
    if (!keyIsWithinSite(key, grant.site)) return notFound();

    // Range is forwarded rather than swallowed: a COG or PMTiles archive is read
    // by byte range, and serving the whole file instead would turn a 4 KB tile
    // read into a multi gigabyte transfer.
    const range = request.headers.get("Range");
    const object = await env.SURVEY_BUCKET.get(key, range ? { range: request.headers } : undefined);
    if (!object) return notFound();

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    // View only, same rule as every other deliverable in the portal.
    headers.set("Content-Disposition", "inline");
    // Private, so a shared proxy never holds one client's terrain for another.
    // The grant already bounds how long a URL is useful for.
    headers.set("Cache-Control", "private, max-age=300");

    const extension = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    if (CONTENT_TYPES[extension]) headers.set("Content-Type", CONTENT_TYPES[extension]);

    if (request.method === "HEAD") {
      headers.set("Content-Length", String(object.size));
      return new Response(null, { status: 200, headers });
    }

    // R2 reports a range only when it actually served one.
    if (object.range && range) {
      const start = object.range.offset ?? 0;
      const length = object.range.length ?? object.size - start;
      headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { status: 200, headers });
  },
};
