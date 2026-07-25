import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCodeForIdentity,
  OAUTH_COOKIE,
  readOauthState,
  redirectUri,
} from "@/lib/portal/google";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/portal/session";
import { signInWithEmail } from "@/lib/portal/users-db";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

function backToLogin(request: NextRequest, error: string) {
  const url = new URL(`/portal/login?error=${error}`, request.url);
  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
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

  // No saved state means the cookie expired or this callback was not started here.
  if (!code || !state || !saved || saved.state !== state) {
    logPortalEvent("login_failed", { via: "google", reason: "state_mismatch" });
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
  response.cookies.set(OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
