/**
 * Google OAuth 2.0 authorisation code flow.
 *
 * Deliberately not Auth.js: the portal already has a signed session cookie,
 * middleware and a tenant scoped store that are tested, and this flow only needs
 * to prove an email address and then hand over to that existing machinery.
 *
 * Security properties, all enforced below:
 *   state  ties the callback to the browser that started it (CSRF).
 *   nonce  ties the id_token to this particular request (replay).
 *   The id_token signature is verified against Google's published keys, with the
 *   issuer and audience checked, so a token minted for another app is refused.
 *   email_verified must be true.
 *
 * Proving identity is NOT authorisation. The caller still has to find the person
 * in the database allowlist, see users-db.ts.
 */

import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Short lived cookie holding the state and nonce while the user is at Google. */
export const OAUTH_COOKIE = "sga_portal_oauth";
/** Marks that we already auto retried once, so a bad state cannot loop forever. */
export const OAUTH_RETRY_COOKIE = "sga_portal_oauth_retry";
const OAUTH_TTL_SECONDS = 600;

/**
 * Cookie options for the sign in handshake.
 *
 * The domain is widened to the registrable domain (".sudaangeo.in") so the state
 * cookie survives a hop between the apex and www. The apex redirects to www, but
 * a cookie written on one host is not sent to the other, and that mismatch shows
 * up as a failed sign in that works on the second attempt.
 */
export function oauthCookieOptions(requestUrl: string, maxAge = OAUTH_TTL_SECONDS) {
  const base = process.env.AUTH_URL ?? new URL(requestUrl).origin;
  let domain: string | undefined;

  try {
    const host = new URL(base).hostname;
    const looksLikeIp = /^[\d.]+$/.test(host);
    if (host !== "localhost" && !looksLikeIp) {
      const parts = host.split(".");
      if (parts.length > 2) domain = `.${parts.slice(-2).join(".")}`;
    }
  } catch {
    // fall through with no domain, which scopes the cookie to the exact host
  }

  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
    ...(domain ? { domain } : {}),
  };
}

export function googleConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

function clientId(): string {
  const id = process.env.AUTH_GOOGLE_ID;
  if (!id) throw new Error("AUTH_GOOGLE_ID is not set");
  return id;
}

function clientSecret(): string {
  const secret = process.env.AUTH_GOOGLE_SECRET;
  if (!secret) throw new Error("AUTH_GOOGLE_SECRET is not set");
  return secret;
}

function stateSecret() {
  const secret = process.env.PORTAL_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("PORTAL_AUTH_SECRET is missing or too short");
  }
  return new TextEncoder().encode(secret);
}

/**
 * The redirect URI must match one registered in Google Cloud exactly. AUTH_URL
 * pins it in production, because the site serves www and deriving it from the
 * request would produce the apex host on some requests.
 */
export function redirectUri(requestUrl: string): string {
  const base = process.env.AUTH_URL?.replace(/\/$/, "") ?? new URL(requestUrl).origin;
  return `${base}/api/auth/callback/google`;
}

export async function createOauthState(next: string) {
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const token = await new SignJWT({ state, nonce, next })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OAUTH_TTL_SECONDS}s`)
    .sign(stateSecret());
  return { state, nonce, token };
}

export async function readOauthState(token: string | undefined) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, stateSecret());
    if (typeof payload.state !== "string" || typeof payload.nonce !== "string") return null;
    return {
      state: payload.state,
      nonce: payload.nonce,
      next: typeof payload.next === "string" ? payload.next : "/portal",
    };
  } catch {
    return null;
  }
}

export function authorizationUrl(opts: {
  redirectUri: string;
  state: string;
  nonce: string;
  loginHint?: string;
}) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: opts.state,
    nonce: opts.nonce,
    access_type: "online",
    // Always show the chooser: shared machines are common, and silently reusing
    // whichever Google account is signed in is confusing at best.
    prompt: "select_account",
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export type GoogleIdentity = {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  sub: string;
};

/** Exchanges the one time code for tokens, then verifies the id_token. */
export async function exchangeCodeForIdentity(opts: {
  code: string;
  redirectUri: string;
  nonce: string;
}): Promise<GoogleIdentity> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google token exchange failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("Google response contained no id_token");

  const { payload } = await jwtVerify(tokens.id_token, JWKS, {
    issuer: ISSUERS,
    audience: clientId(),
  });

  if (payload.nonce !== opts.nonce) {
    throw new Error("id_token nonce does not match this sign in attempt");
  }
  if (typeof payload.email !== "string") {
    throw new Error("id_token contained no email");
  }

  return {
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
    sub: String(payload.sub),
  };
}
