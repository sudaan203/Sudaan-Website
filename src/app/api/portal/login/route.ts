import { NextResponse, type NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/portal/session";
import { verifyCredentials } from "@/lib/portal/users";
import { isRateLimited, recordFailure, clearFailures } from "@/lib/portal/rate-limit";
import { logPortalEvent } from "@/lib/portal/log";

export const runtime = "nodejs";

/** Same message for every failure, so we never reveal which emails exist. */
const GENERIC_ERROR = "Invalid email or password.";

function clientIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function POST(request: NextRequest) {
  let email = "";
  let password = "";

  try {
    const body = await request.json();
    email = typeof body.email === "string" ? body.email : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }

  const ip = clientIp(request);
  const key = `${email.trim().toLowerCase()}|${ip}`;

  if (isRateLimited(key)) {
    logPortalEvent("login_rate_limited", { email, ip });
    return NextResponse.json(
      { error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 },
    );
  }

  let user;
  try {
    user = await verifyCredentials(email, password);
  } catch (err) {
    console.error("[portal] credential check failed", err);
    return NextResponse.json(
      { error: "Sign in is temporarily unavailable." },
      { status: 500 },
    );
  }

  if (!user) {
    recordFailure(key);
    logPortalEvent("login_failed", { email, ip });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  let token: string;
  try {
    token = await createSessionToken({
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      clientId: user.clientId,
    });
  } catch (err) {
    console.error("[portal] session signing failed", err);
    return NextResponse.json(
      { error: "Sign in is temporarily unavailable." },
      { status: 500 },
    );
  }

  clearFailures(key);
  logPortalEvent("login", { userId: user.id, email: user.email, role: user.role, ip });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return response;
}
