/**
 * Server helpers for reading the portal session inside pages and route handlers.
 * Middleware already blocks unauthenticated requests, these are the second
 * check so a page is never renderable without a session (defence in depth).
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "./session";
import type { PortalSession } from "./types";

export async function getSession(): Promise<PortalSession | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function requireSession(returnTo?: string): Promise<PortalSession> {
  const session = await getSession();
  if (!session) {
    const next = returnTo ? `?next=${encodeURIComponent(returnTo)}` : "";
    redirect(`/portal/login${next}`);
  }
  return session;
}
