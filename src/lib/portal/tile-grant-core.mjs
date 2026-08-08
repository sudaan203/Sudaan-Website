/**
 * The tile grant rules, in one place, for three runtimes.
 *
 * This module is imported by the Next route handler (Node), by the Cloudflare
 * Worker that fronts the R2 bucket (workerd, bundled by wrangler), and by
 * `scripts/portal-tile-grant-test.mjs` (plain Node). One copy rather than three
 * is a security property, not tidiness: an authorisation rule that exists in two
 * files drifts, and the copy nobody remembered to update is the one on the edge
 * holding the private bucket open.
 *
 * Constraints that shape everything here:
 *
 * - **Plain JavaScript, no build step.** Wrangler bundles it as is.
 * - **Web Crypto only.** `crypto.subtle` is the one HMAC available in Node, the
 *   Edge runtime and workerd alike. No `node:crypto`, no `jose`.
 * - **No environment access.** Secrets arrive as arguments. Reading
 *   `process.env` at module scope would crash the Worker on import, and it would
 *   make the rules untestable without a fixture environment.
 *
 * The design is `docs/portal-map-architecture.md` section 5: one authorisation
 * decision per map session instead of a signature per tile, because a single pan
 * fires hundreds of tile requests.
 */

export const TILE_GRANT_COOKIE = "sga_tile_grant";

/** Long enough to browse a survey, short enough that a leaked token dies fast. */
export const TILE_GRANT_MINUTES = 30;

function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/**
 * Compare without leaking where two strings first differ.
 *
 * A plain `===` returns as soon as a byte mismatches, and how long that took is
 * a measurable hint about how much of a forged signature was correct. That is a
 * real attack against a token an attacker can retry freely, which is exactly
 * what a tile endpoint offers.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a grant for one site.
 *
 * Does no authorisation of its own and will sign any slug it is handed. Callers
 * must already have proved access through the tenant scoped store.
 *
 * The payload carries a site and an expiry and deliberately nothing else: no
 * user id, no email, no role, no client id. The tile edge runs outside our
 * infrastructure and must not be able to tell one client from another.
 *
 * The JSDoc types here are load bearing, not decoration: `tile-grant.ts` imports
 * this file under `allowJs`, and without them TypeScript infers the options bag
 * from the destructuring defaults alone and silently drops any property that has
 * no default, which makes a real argument look like a typo at the call site.
 *
 * @param {string} site
 * @param {string} secret
 * @param {{ minutes?: number }} [options]
 * @returns {Promise<string>}
 */
export async function createTileGrant(site, secret, { minutes = TILE_GRANT_MINUTES } = {}) {
  const payload = { site, exp: Math.floor(Date.now() / 1000) + minutes * 60 };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(secret, body));
  return `${body}.${signature}`;
}

/**
 * Verify a grant, and optionally that it covers a named site.
 *
 * `expectedSite` matters and is not decoration: a valid signature only proves we
 * issued the token, never that it authorises the object being requested. Skip
 * that check and a client holding a legitimate grant for their own site can read
 * another client's data by asking for a different key, defeating tenant
 * isolation at the one layer sitting outside our own infrastructure.
 *
 * @param {string|undefined} token
 * @param {string|undefined} secret
 * @param {{ expectedSite?: string, now?: number }} [options]
 * @returns {Promise<{ site: string, exp: number } | null>}
 */
export async function verifyTileGrant(token, secret, { expectedSite, now = Date.now() } = {}) {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let expected;
  try {
    expected = base64UrlEncode(await hmac(secret, body));
  } catch {
    return null;
  }
  if (!timingSafeEqual(signature, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
  if (typeof payload?.site !== "string" || typeof payload?.exp !== "number") return null;
  if (payload.exp * 1000 <= now) return null;
  if (expectedSite !== undefined && payload.site !== expectedSite) return null;

  return payload;
}

/**
 * Is this storage key inside the site the grant covers?
 *
 * Separate from signature checking because the two fail for different reasons
 * and both have to hold.
 *
 * The trailing slash in the prefix is the point of this function existing at
 * all. A naive `key.startsWith("sites/" + site)` lets a grant for `kotba` read
 * `sites/kotba-survey-2/...`, because one slug is a prefix of the other. Real
 * slugs in this portal look exactly like that.
 */
export function keyIsWithinSite(key, site) {
  if (!key || !site) return false;
  if (key.includes("..") || key.includes("\\") || key.startsWith("/")) return false;
  // Traversal can arrive percent encoded, since decoding happens at the edge.
  if (/%2e/i.test(key) || /%2f/i.test(key)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return false;
  return key.startsWith(`sites/${site}/`);
}

/**
 * Where a site's objects live in the bucket. One place, so it cannot drift.
 * @param {string} site
 * @returns {string}
 */
export function siteObjectPrefix(site) {
  return `sites/${site}/`;
}
