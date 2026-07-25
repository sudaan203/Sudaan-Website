import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCodeForIdentity,
  OAUTH_COOKIE,
  OAUTH_RETRY_COOKIE,
  oauthCookieOptions,
  readOauthState,
  redirectUri,
} from "@/lib/portal/google";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/portal/session";
import { signInWithEmail } from "@/lib/portal/users-db";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

/**
 * Clears the handshake cookies. They must be cleared with the same domain they
 * were written with, otherwise the browser keeps the old ones and the next sign
 * in trips over stale state.
 */
function clearHandshake(response: NextResponse, requestUrl: string) {
  const expire = { ...oauthCookieOptions(requestUrl, 0), maxAge: 0 };
  response.cookies.set(OAUTH_COOKIE, "", expire);
  response.cookies.set(OAUTH_RETRY_COOKIE, "", expire);
  return response;
}

function backToLogin(request: NextRequest, error: string) {
  const url = new URL(`/portal/login?error=${error}`, request.url);
  return clearHandshake(NextResponse.redirect(url), request.url);
}

/**
 * Where Google returns the user. Verifies the round trip, then checks the email
 * against the invite allowlist. Proving a Google identity is not enough: an
 * address nobody invited is refused here.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // The user pressed cancel, or Google refused.
  const googleError = params.get("error");
  if (googleError) {
    logPortalEvent("login_failed", { via: "google", googleError });
    return backToLogin(request, googleError === "access_denied" ? "cancelled" : "google_error");
  }

  const code = params.get("code");
  const state = params.get("state");
  const saved = await readOauthState(request.cookies.get(OAUTH_COOKIE)?.value);

  // No saved state means the cookie expired, was overwritten by a second sign in
  // attempt in another tab, or this callback was not started here.
  if (!code || !state || !saved || saved.state !== state) {
    const alreadyRetried = request.cookies.get(OAUTH_RETRY_COOKIE)?.value === "1";
    logPortalEvent("login_failed", {
      via: "google",
      reason: "state_mismatch",
      alreadyRetried,
    });

    // Start one clean attempt automatically. Clicking sign in twice leaves a
    // stale state behind, and making the person click again to fix our own race
    // is poor. The cookie marker means this can happen at most once, so a genuine
    // problem still surfaces as an error rather than a redirect loop.
    if (!alreadyRetried) {
      const retry = NextResponse.redirect(new URL("/api/auth/google/start", request.url));
      retry.cookies.set(OAUTH_RETRY_COOKIE, "1", oauthCookieOptions(request.url, 120));
      return retry;
    }

    return backToLogin(request, "expired");
  }

  let identity;
  try {
    identity = await exchangeCodeForIdentity({
      code,
      redirectUri: redirectUri(request.url),
      nonce: saved.nonce,
    });
  } catch (err) {
    console.error("[portal] Google token exchange failed", err);
    logPortalEvent("login_failed", { via: "google", reason: "exchange_failed" });
    return backToLogin(request, "google_error");
  }

  const result = await signInWithEmail(identity);

  if (!result.ok) {
    logPortalEvent("login_failed", {
      via: "google",
      email: identity.email,
      reason: result.reason,
    });
    return backToLogin(request, result.reason);
  }

  const token = await createSessionToken({ ...result.session, via: "google" });

  logPortalEvent("login", {
    via: "google",
    userId: result.session.userId,
    email: result.session.email,
    role: result.session.role,
  });

  const response = NextResponse.redirect(new URL(saved.next, request.url));
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return clearHandshake(response, request.url);
}
