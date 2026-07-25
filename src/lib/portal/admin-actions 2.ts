"use server";

/**
 * Write actions for the owner console.
 *
 * Every action re-checks that the caller is an owner. Never trust that the UI
 * was only rendered for owners: a server action is a public endpoint.
 * Every action also writes an access_changes row, so "who gave them that" is
 * always answerable.
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "./auth";
import { getDb } from "./db/client";
import * as schema from "./db/schema";
import { logPortalEvent } from "./log";
import { isOwnerEmail } from "./users-db";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ownerAndDb() {
  const session = await requireOwner();
  const db = getDb();
  if (!db) throw new Error("The owner console needs DATABASE_URL to be configured.");
  // invited_by, granted_by and actor_id are foreign keys into users. A staff
  // password session has no row there, and an owner row can be deleted, so
  // resolve the reference and fall back to null rather than letting a perfectly
  // good invite fail on a constraint. The email is always kept in the audit row.
  const actorId = await resolveActor(db, session.userId);
  return { session, db, actorId };
}

async function resolveActor(
  db: NonNullable<ReturnType<typeof getDb>>,
  userId: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function record(
  db: NonNullable<ReturnType<typeof getDb>>,
  actor: { id: string | null; email: string },
  action: string,
  subject: string,
  detail?: Record<string, unknown>,
) {
  await db.insert(schema.accessChanges).values({
    actorId: actor.id,
    action,
    subject,
    detail: { ...detail, actorEmail: actor.email },
  });
  logPortalEvent("admin_change", { action, subject, actor: actor.email });
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function createClientAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const name = String(formData.get("name") ?? "").trim();
  const slug = slugify(String(formData.get("slug") ?? "") || name);

  if (!name) return { ok: false, message: "Give the client a name." };
  if (!SLUG_RE.test(slug)) return { ok: false, message: "Slug must be lowercase letters, numbers and hyphens." };

  const existing = await db.select().from(schema.clients).where(eq(schema.clients.slug, slug)).limit(1);
  if (existing[0]) return { ok: false, message: `A client with the slug "${slug}" already exists.` };

  const [created] = await db.insert(schema.clients).values({ name, slug }).returning();
  await record(db, { id: actorId, email: session.email }, "create_client", created.slug, { name });
  revalidatePath("/portal/admin");
  return { ok: true, message: `Created client "${name}".` };
}

export async function inviteUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const clientId = String(formData.get("clientId") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim() || null;

  if (!EMAIL_RE.test(email)) return { ok: false, message: "That does not look like an email address." };
  if (isOwnerEmail(email)) {
    return {
      ok: false,
      message: "That address is a Sudaan owner. Owners sign in without an invite.",
    };
  }

  const client = (await db.select().from(schema.clients).where(eq(schema.clients.id, clientId)).limit(1))[0];
  if (!client) return { ok: false, message: "Choose which client this person belongs to." };

  const existing = (
    await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
  )[0];

  if (existing) {
    await db
      .update(schema.users)
      .set({ clientId: client.id, isActive: true, fullName: fullName ?? existing.fullName })
      .where(eq(schema.users.id, existing.id));
    await record(db, { id: actorId, email: session.email }, "reassign_user", email, { client: client.slug });
    revalidatePath("/portal/admin");
    return { ok: true, message: `${email} now has access to ${client.name}.` };
  }

  await db
    .insert(schema.users)
    .values({ email, fullName, role: "client", clientId: client.id, invitedBy: actorId });
  await record(db, { id: actorId, email: session.email }, "invite_user", email, { client: client.slug });
  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: `Invited ${email}. They can now sign in with that Google account.`,
  };
}

export async function setUserActiveAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const userId = String(formData.get("userId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";

  const target = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!target) return { ok: false, message: "That person no longer exists." };
  if (target.id === session.userId) return { ok: false, message: "You cannot deactivate yourself." };

  await db.update(schema.users).set({ isActive: active }).where(eq(schema.users.id, userId));
  await record(db, { id: actorId, email: session.email }, active ? "reactivate_user" : "deactivate_user", target.email);
  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: active ? `${target.email} can sign in again.` : `${target.email} can no longer sign in.`,
  };
}

export async function createSiteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const clientId = String(formData.get("clientId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const slug = slugify(String(formData.get("slug") ?? "") || name);
  const location = String(formData.get("location") ?? "").trim() || null;
  const summary = String(formData.get("summary") ?? "").trim() || null;

  if (!name) return { ok: false, message: "Give the site a name." };
  if (!SLUG_RE.test(slug)) return { ok: false, message: "Slug must be lowercase letters, numbers and hyphens." };

  const client = (await db.select().from(schema.clients).where(eq(schema.clients.id, clientId)).limit(1))[0];
  if (!client) return { ok: false, message: "Choose which client this site belongs to." };

  const clash = (
    await db
      .select()
      .from(schema.sites)
      .where(and(eq(schema.sites.clientId, clientId), eq(schema.sites.slug, slug)))
      .limit(1)
  )[0];
  if (clash) return { ok: false, message: `${client.name} already has a site with the slug "${slug}".` };

  await db.insert(schema.sites).values({ clientId, slug, name, location, summary, isPublished: false });
  await record(db, { id: actorId, email: session.email }, "create_site", `${client.slug}/${slug}`);
  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: `Created "${name}". It stays hidden from the client until you publish it.`,
  };
}

export async function setSitePublishedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const siteId = String(formData.get("siteId") ?? "");
  const published = String(formData.get("published") ?? "") === "true";

  const site = (await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).limit(1))[0];
  if (!site) return { ok: false, message: "That site no longer exists." };

  await db.update(schema.sites).set({ isPublished: published }).where(eq(schema.sites.id, siteId));
  await record(db, { id: actorId, email: session.email }, published ? "publish_site" : "unpublish_site", site.slug);
  revalidatePath("/portal/admin");
  revalidatePath("/portal");
  return {
    ok: true,
    message: published ? `"${site.name}" is now visible to the client.` : `"${site.name}" is hidden again.`,
  };
}

/**
 * Adds or removes a per user site grant. Remember the rule: a user with NO
 * grants sees every published site of their client, and adding the first grant
 * narrows them to exactly what is ticked.
 */
export async function toggleGrantAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const userId = String(formData.get("userId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const grant = String(formData.get("grant") ?? "") === "true";

  const target = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  const site = (await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).limit(1))[0];
  if (!target || !site) return { ok: false, message: "That person or site no longer exists." };
  if (target.clientId !== site.clientId) {
    return { ok: false, message: "That site belongs to a different client." };
  }

  if (grant) {
    await db
      .insert(schema.userSiteGrants)
      .values({ userId, siteId, grantedBy: actorId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.userSiteGrants)
      .where(and(eq(schema.userSiteGrants.userId, userId), eq(schema.userSiteGrants.siteId, siteId)));
  }

  await record(db, { id: actorId, email: session.email }, grant ? "grant_site" : "revoke_site", `${target.email} -> ${site.slug}`);
  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: grant
      ? `${target.email} can now see "${site.name}".`
      : `Removed "${site.name}" from ${target.email}.`,
  };
}
