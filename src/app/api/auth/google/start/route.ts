import { NextResponse, type NextRequest } from "next/server";
import {
  authorizationUrl,
  createOauthState,
  googleConfigured,
  OAUTH_COOKIE,
  redirectUri,
} from "@/lib/portal/google";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

/** Sends the browser to Google, remembering state and nonce in a short lived cookie. */
export async function GET(request: NextRequest) {
  if (!googleConfigured()) {
    logPortalEvent("denied", { reason: "google_not_configured" });
    return NextResponse.redirect(new URL("/portal/login?error=google_unavailable", request.url));
  }

  const requested = request.nextUrl.searchParams.get("next");
  // Only internal portal paths, so this cannot be used as an open redirect.
  const next = requested && requested.startsWith("/portal") ? requested : "/portal";

  try {
    const { state, nonce, token } = await createOauthState(next);
    const url = authorizationUrl({
      redirectUri: redirectUri(request.url),
      state,
      nonce,
      loginHint: request.nextUrl.searchParams.get("email") ?? undefined,
    });

    const response = NextResponse.redirect(url);
    response.cookies.set(OAUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return response;
  } catch (err) {
    console.error("[portal] could not start Google sign in", err);
    return NextResponse.redirect(new URL("/portal/login?error=google_unavailable", request.url));
  }
}
