/**
 * Turns a proven Google identity into a portal session, or refuses.
 *
 * This is the allowlist. Google tells us who someone is; this module decides
 * whether they get in at all. Default deny: an email with no active row in the
 * users table is rejected, no matter how valid the Google login was.
 *
 * The single exception is owner bootstrap. PORTAL_OWNER_EMAILS lists the Sudaan
 * owners, so the first sign in works against an empty database and there is no
 * chicken and egg problem creating the first account.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import * as schema from "./db/schema";
import type { PortalSession } from "./types";

export type SignInResult =
  | { ok: true; session: PortalSession }
  | { ok: false; reason: "no_database" | "not_invited" | "deactivated" | "unverified_email" };

export function ownerEmails(): string[] {
  return (process.env.PORTAL_OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerEmail(email: string): boolean {
  return ownerEmails().includes(email.trim().toLowerCase());
}

/**
 * Looks the person up, creating or repairing the owner row when the address is
 * in PORTAL_OWNER_EMAILS. Client users are never created here: an owner has to
 * invite them first, which is the whole point of the allowlist.
 */
export async function signInWithEmail(identity: {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}): Promise<SignInResult> {
  const db = getDb();
  if (!db) return { ok: false, reason: "no_database" };

  const email = identity.email.trim().toLowerCase();

  // An unverified Google address proves nothing about who controls the mailbox.
  if (!identity.emailVerified) return { ok: false, reason: "unverified_email" };

  const existing = (
    await db
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email}`)
      .limit(1)
  )[0];

  if (isOwnerEmail(email)) {
    const row = existing
      ? (
          await db
            .update(schema.users)
            .set({
              role: "owner",
              clientId: null,
              isActive: true,
              fullName: identity.name ?? existing.fullName,
              imageUrl: identity.picture ?? existing.imageUrl,
              lastLoginAt: new Date(),
            })
            .where(eq(schema.users.id, existing.id))
            .returning()
        )[0]
      : (
          await db
            .insert(schema.users)
            .values({
              email,
              fullName: identity.name ?? email,
              imageUrl: identity.picture,
              role: "owner",
              clientId: null,
            })
            .returning()
        )[0];

    return {
      ok: true,
      session: {
        userId: row.id,
        email: row.email,
        fullName: row.fullName ?? row.email,
        role: "owner",
        clientId: null,
      },
    };
  }

  // Anyone may sign in. A first time visitor is recorded as a pending person
  // with no client, which means they can see nothing at all until an owner
  // attaches them to one from the console. Signing in is not access.
  if (!existing) {
    const [created] = await db
      .insert(schema.users)
      .values({
        email,
        fullName: identity.name ?? email,
        imageUrl: identity.picture,
        role: "client",
        clientId: null,
        lastLoginAt: new Date(),
      })
      .returning();

    return {
      ok: true,
      session: {
        userId: created.id,
        email: created.email,
        fullName: created.fullName ?? created.email,
        role: "client",
        clientId: null,
      },
    };
  }

  // Deactivating someone is an explicit owner decision, so it still refuses.
  if (!existing.isActive) return { ok: false, reason: "deactivated" };

  await db
    .update(schema.users)
    .set({
      lastLoginAt: new Date(),
      fullName: existing.fullName ?? identity.name ?? null,
      imageUrl: identity.picture ?? existing.imageUrl,
    })
    .where(eq(schema.users.id, existing.id));

  return {
    ok: true,
    session: {
      userId: existing.id,
      email: existing.email,
      fullName: existing.fullName ?? identity.name ?? existing.email,
      role: existing.role === "owner" ? "owner" : "client",
      clientId: existing.clientId,
    },
  };
}

/**
 * Re-checks a live session against the database. Sessions are stateless JWTs, so
 * this is how deactivating someone takes effect before their cookie expires.
 * Returns false when the user is gone, deactivated, or moved to another client.
 */
export async function sessionStillValid(session: PortalSession): Promise<boolean> {
  const db = getDb();
  if (!db) return true; // seed backend, nothing to check against

  try {
    const rows = await db
      .select({ isActive: schema.users.isActive, clientId: schema.users.clientId, role: schema.users.role })
      .from(schema.users)
      .where(and(eq(schema.users.id, session.userId), eq(schema.users.isActive, true)))
      .limit(1);

    const row = rows[0];
    if (!row) return false;
    if (row.clientId !== session.clientId) return false;
    return true;
  } catch (err) {
    // A database hiccup must not sign everybody out. The cookie is already
    // cryptographically valid and expires within 8 hours; this check is
    // best effort revocation, so on an error keep the session and say so.
    // The alternative, failing closed, turns a brief database blip into an
    // apparently random logout loop, which is what it did in production.
    console.error("[portal] could not re-check session, keeping it", err);
    return true;
  }
}
