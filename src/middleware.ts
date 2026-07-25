/**
 * Portal gate. Deny by default: everything under /portal and /api/portal needs a
 * valid session, except the login endpoints themselves.
 *
 * The matcher below is scoped to those two prefixes ONLY, so no marketing route
 * runs through this middleware.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/portal/session";

// /api/portal/health is deliberately public: it reports whether the database is
// reachable and carries no credentials, and it has to work when sign in does not.
const PUBLIC_PATHS = ["/portal/login", "/api/portal/login", "/api/portal/health"];

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.includes(pathname)) {
    return NextResponse.next();
  }

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  if (session) {
    // Only admins reach the admin area.
    if (pathname.startsWith("/portal/admin") && session.role === "client") {
      return NextResponse.rewrite(new URL("/portal/not-found", request.url), {
        status: 404,
      });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const loginUrl = new URL("/portal/login", request.url);
  if (pathname !== "/portal") {
    loginUrl.searchParams.set("next", pathname + search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/portal", "/portal/:path*", "/api/portal/:path*"],
};
