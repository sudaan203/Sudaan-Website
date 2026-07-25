/**
 * Session handling for the portal: a signed JWT in an httpOnly cookie.
 *
 * Uses jose only, so this module is safe to import from middleware (Edge
 * runtime). Password hashing lives in users.ts, which is Node only.
 */

// Subpath imports, not the "jose" barrel: the barrel pulls in the JWE decrypt
// path, which references CompressionStream and warns under the Edge runtime that
// middleware uses. We only sign and verify JWS.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";
import type { PortalSession } from "./types";

export const SESSION_COOKIE = "sga_portal_session";
const SESSION_HOURS = 8;

function secretKey() {
  const secret = process.env.PORTAL_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "PORTAL_AUTH_SECRET is missing or too short. Generate one with: openssl rand -base64 32",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(session: PortalSession) {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secretKey());
}

/** Returns the session, or null if the token is missing, invalid or expired. */
export async function verifySessionToken(
  token: string | undefined,
): Promise<PortalSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (
      typeof payload.userId !== "string" ||
      typeof payload.email !== "string" ||
      (payload.role !== "admin" && payload.role !== "owner" && payload.role !== "client")
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      email: payload.email,
      fullName: typeof payload.fullName === "string" ? payload.fullName : payload.email,
      role: payload.role,
      clientId: typeof payload.clientId === "string" ? payload.clientId : null,
      via: payload.via === "google" ? "google" : "password",
    };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_HOURS * 60 * 60,
};
