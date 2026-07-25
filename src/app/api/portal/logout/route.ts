import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/portal/session";
import { getSession } from "@/lib/portal/auth";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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
