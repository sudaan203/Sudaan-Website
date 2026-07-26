/**
 * Server helpers for reading the portal session inside pages and route handlers.
 * Middleware already blocks unauthenticated requests, these are the second
 * check so a page is never renderable without a session (defence in depth).
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "./session";
import { sessionStillValid } from "./users-db";
import { findUserById } from "./users";
import type { PortalSession } from "./types";

/**
 * Deduplicated per request with React cache().
 *
 * A single page render calls this from the portal layout, from the page itself
 * and from the header, and each call used to make its own database round trip to
 * re-check the account. On the owner console that was about six trips to a
 * database in another continent, which is slow and gives six chances to fail.
 * cache() collapses them into one lookup per request.
 */
export const getSession = cache(async (): Promise<PortalSession | null> => {
  const store = await cookies();
  const session = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;

  // Sessions are stateless JWTs, so revoking one means checking the source of
  // truth on every request. Which source depends on where the session came from.
  if (session.via === "google") {
    if (!(await sessionStillValid(session))) return null;
    return session;
  }

  // Password sessions were previously not checked at all, so removing someone
  // from PORTAL_USERS left them signed in for up to eight more hours, including
  // any staff account with owner rights. Their list is the source of truth, so
  // consult it.
  const staff = findUserById(session.userId);
  if (!staff) return null;
  // Rights are re-read from the list rather than trusted from the cookie: an
  // account demoted from admin to client must lose the console immediately, not
  // when the token happens to expire.
  return { ...session, role: staff.role, clientId: staff.clientId };
});

/** Owners only. Client users get a 404 rather than a hint that this exists. */
export async function requireOwner(): Promise<PortalSession> {
  const session = await requireSession("/portal/admin");
  if (session.role === "client") notFound();
  return session;
}

export async function requireSession(returnTo?: string): Promise<PortalSession> {
  const session = await getSession();
  if (!session) {
    const next = returnTo ? `?next=${encodeURIComponent(returnTo)}` : "";
    redirect(`/portal/login${next}`);
  }
  return session;
}
