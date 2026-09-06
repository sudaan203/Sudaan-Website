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

  /*
   * Checked across every client, not just this one. The slug is the site's name
   * in R2 (`sites/<slug>/...`) and in the tile Worker's grant, and neither
   * carries a client, so a slug reused under a second client would point at the
   * first one's rasters. See drizzle/0004_site_slug_global.sql.
   */
  const clash = (
    await db.select().from(schema.sites).where(eq(schema.sites.slug, slug)).limit(1)
  )[0];
  if (clash) {
    const owner = (
      await db.select().from(schema.clients).where(eq(schema.clients.id, clash.clientId)).limit(1)
    )[0];
    return {
      ok: false,
      message:
        `The slug "${slug}" is already used by "${clash.name}"` +
        `${owner ? ` under ${owner.name}` : ""}. Slugs are shared across all clients ` +
        `because they name the survey's files, so pick another.`,
    };
  }

  await db.insert(schema.sites).values({ clientId, slug, name, location, summary, isPublished: false });
  await record(db, { id: actorId, email: session.email }, "create_site", `${client.slug}/${slug}`);
  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: `Created "${name}". It stays hidden from the client until you publish it.`,
  };
}

/**
 * Move an existing site to a different client.
 *
 * The gap this fills: "Add a site" only ever created *new* sites. Every survey
 * that matters was already in the table, so adding a client and then giving
 * them one of those surveys was not expressible in the console at all — the
 * only route was an UPDATE by hand against production.
 *
 * Reassigning is the moment a site changes hands, so it also drops that site's
 * per-user grants. A grant names a user and a site; the users belong to the
 * *old* client, and leaving the rows behind would mean the previous client's
 * staff still hold an explicit grant to a survey that is no longer theirs. The
 * visibility rule would keep them out today, because it tests the client first,
 * but it would be a row that says otherwise sitting in the table waiting for
 * someone to write a query that trusts it.
 */
export async function assignSiteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const siteId = String(formData.get("siteId") ?? "");
  const clientId = String(formData.get("clientId") ?? "");

  const site = (await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).limit(1))[0];
  if (!site) return { ok: false, message: "That site no longer exists." };

  const client = (
    await db.select().from(schema.clients).where(eq(schema.clients.id, clientId)).limit(1)
  )[0];
  if (!client) return { ok: false, message: "Choose which client this site should belong to." };

  if (site.clientId === clientId) {
    return { ok: false, message: `"${site.name}" already belongs to ${client.name}.` };
  }

  const previous = (
    await db.select().from(schema.clients).where(eq(schema.clients.id, site.clientId)).limit(1)
  )[0];

  await db.update(schema.sites).set({ clientId }).where(eq(schema.sites.id, siteId));
  const dropped = await db
    .delete(schema.userSiteGrants)
    .where(eq(schema.userSiteGrants.siteId, siteId))
    .returning({ id: schema.userSiteGrants.userId });

  await record(db, { id: actorId, email: session.email }, "assign_site", site.slug, {
    from: previous?.slug ?? site.clientId,
    to: client.slug,
    grantsRemoved: dropped.length,
  });
  revalidatePath("/portal/admin");
  revalidatePath("/portal");
  return {
    ok: true,
    message:
      `"${site.name}" now belongs to ${client.name}` +
      `${previous ? `, moved from ${previous.name}` : ""}.` +
      `${dropped.length ? ` ${dropped.length} per-user grant(s) from the previous client were removed.` : ""}` +
      `${site.isPublished ? "" : " It is still hidden until you publish it."}`,
  };
}

/**
 * Rename a client, which is the label everyone reads.
 *
 * `slug` and `name` are different jobs and the seeded rows conflated them: the
 * first client is called "demo-client" in both, so the console offers "Choose a
 * client: demo-client" and a real company sees a developer's fixture name. The
 * slug is an identifier and stays put; this is the title.
 */
export async function renameClientAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const clientId = String(formData.get("clientId") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (!name) return { ok: false, message: "Give the client a name." };

  const client = (
    await db.select().from(schema.clients).where(eq(schema.clients.id, clientId)).limit(1)
  )[0];
  if (!client) return { ok: false, message: "That client no longer exists." };

  await db.update(schema.clients).set({ name }).where(eq(schema.clients.id, clientId));
  await record(db, { id: actorId, email: session.email }, "rename_client", client.slug, {
    from: client.name,
    to: name,
  });
  revalidatePath("/portal/admin");
  revalidatePath("/portal");
  return { ok: true, message: `"${client.name}" is now called "${name}".` };
}

/**
 * Rename a site. The title only — the slug is left alone deliberately.
 *
 * Changing a slug would rename the survey's files in R2 as well, and nothing
 * here can do that, so a console that offered it would produce a site whose
 * rasters had gone missing. Titles are free to change; identifiers are not.
 */
export async function renameSiteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { session, db, actorId } = await ownerAndDb();
  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (!name) return { ok: false, message: "Give the site a name." };

  const site = (await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).limit(1))[0];
  if (!site) return { ok: false, message: "That site no longer exists." };

  await db.update(schema.sites).set({ name }).where(eq(schema.sites.id, siteId));
  await record(db, { id: actorId, email: session.email }, "rename_site", site.slug, {
    from: site.name,
    to: name,
  });
  revalidatePath("/portal/admin");
  revalidatePath("/portal");
  return {
    ok: true,
    message: `"${site.name}" is now called "${name}". Its address is still /${site.slug}.`,
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
