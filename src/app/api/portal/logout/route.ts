import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/portal/session";
import { getSession } from "@/lib/portal/auth";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // SameSite=Lax already keeps the session cookie off a cross site POST, so this
  // is defence in depth rather than the only thing standing between us and a
  // forced logout. It costs one comparison and does not depend on cookie
  // behaviour staying the way it is today.
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Cross origin request refused" }, { status: 403 });
  }

  const session = await getSession();
  if (session) {
    logPortalEvent("logout", { userId: session.userId, email: session.email });
  }

  const response = NextResponse.redirect(new URL("/portal/login", request.url), {
    status: 303,
  });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
