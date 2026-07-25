/**
 * Reads for the owner console. Owners see everything, so unlike store.ts these
 * are not tenant scoped. Callers must gate on requireOwner() first.
 */

import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import * as schema from "./db/schema";

export type AdminClient = {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  siteCount: number;
  userCount: number;
};

export type AdminUser = {
  id: string;
  email: string;
  fullName: string | null;
  role: "owner" | "client";
  clientId: string | null;
  clientName: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  grantedSiteIds: string[];
};

export type AdminSite = {
  id: string;
  clientId: string;
  clientName: string;
  slug: string;
  name: string;
  location: string | null;
  isPublished: boolean;
  assetCount: number;
};

export async function listAdminClients(): Promise<AdminClient[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: schema.clients.id,
      slug: schema.clients.slug,
      name: schema.clients.name,
      isActive: schema.clients.isActive,
      siteCount: sql<number>`(select count(*) from sites s where s.client_id = ${schema.clients.id})`,
      userCount: sql<number>`(select count(*) from users u where u.client_id = ${schema.clients.id})`,
    })
    .from(schema.clients)
    .orderBy(asc(schema.clients.name));
  return rows.map((r) => ({ ...r, siteCount: Number(r.siteCount), userCount: Number(r.userCount) }));
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      fullName: schema.users.fullName,
      role: schema.users.role,
      clientId: schema.users.clientId,
      clientName: schema.clients.name,
      isActive: schema.users.isActive,
      lastLoginAt: schema.users.lastLoginAt,
    })
    .from(schema.users)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.users.clientId))
    .orderBy(asc(schema.users.email));

  const grants = await db.select().from(schema.userSiteGrants);

  return rows.map((row) => ({
    ...row,
    role: row.role as "owner" | "client",
    grantedSiteIds: grants.filter((g) => g.userId === row.id).map((g) => g.siteId),
  }));
}

export async function listAdminSites(): Promise<AdminSite[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: schema.sites.id,
      clientId: schema.sites.clientId,
      clientName: schema.clients.name,
      slug: schema.sites.slug,
      name: schema.sites.name,
      location: schema.sites.location,
      isPublished: schema.sites.isPublished,
      assetCount: sql<number>`(select count(*) from assets a where a.site_id = ${schema.sites.id})`,
    })
    .from(schema.sites)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.sites.clientId))
    .orderBy(asc(schema.clients.name), asc(schema.sites.name));
  return rows.map((r) => ({ ...r, assetCount: Number(r.assetCount) }));
}

export type ActivityRow = {
  id: number;
  action: string;
  subject: string;
  actorEmail: string | null;
  createdAt: Date;
};

export async function listRecentAccessChanges(limit = 15): Promise<ActivityRow[]> {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: schema.accessChanges.id,
      action: schema.accessChanges.action,
      subject: schema.accessChanges.subject,
      actorEmail: schema.users.email,
      createdAt: schema.accessChanges.createdAt,
    })
    .from(schema.accessChanges)
    .leftJoin(schema.users, eq(schema.users.id, schema.accessChanges.actorId))
    .orderBy(sql`${schema.accessChanges.createdAt} desc`)
    .limit(limit);
}
