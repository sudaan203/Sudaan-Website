/**
 * The only place that decides what a signed in person may see.
 *
 * Rules, in one place so they can be reasoned about and tested:
 *   Owners (Malhar, Prakhar) see every client, including unpublished staging data.
 *   A client user sees a site when ALL of these hold:
 *     1. the site belongs to their client,
 *     2. the site is published,
 *     3. they have no per user grants at all, OR the site is one of their grants.
 *   A client user sees an asset when its site is visible and the asset is published.
 *
 * Rule 3 is what keeps the owner console simple: granting nothing means "all of my
 * client's sites", and ticking specific sites narrows that person down.
 */

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/** Structural type so the same functions run on postgres-js and on PGlite in tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema, any>;

export type Viewer = {
  userId: string;
  role: "owner" | "client";
  clientId: string | null;
};

/** Site level visibility, applied to every read. */
function siteVisible(viewer: Viewer): SQL {
  if (viewer.role === "owner") return sql`true`;

  return sql`
    ${schema.sites.clientId} = ${viewer.clientId}
    and ${schema.sites.isPublished}
    and (
      not exists (
        select 1 from user_site_grants g where g.user_id = ${viewer.userId}
      )
      or exists (
        select 1 from user_site_grants g
        where g.user_id = ${viewer.userId} and g.site_id = ${schema.sites.id}
      )
    )
  `;
}

export async function listVisibleSites(db: Db, viewer: Viewer) {
  return db
    .select()
    .from(schema.sites)
    .where(siteVisible(viewer))
    .orderBy(asc(schema.sites.name));
}

/**
 * One site by slug. Returns undefined when it does not exist or is not visible,
 * and callers answer 404 either way so a slug is never confirmed.
 */
export async function getVisibleSite(db: Db, viewer: Viewer, slug: string) {
  const rows = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.slug, slug), siteVisible(viewer)))
    .limit(1);
  return rows[0];
}

export async function listVisibleAssets(
  db: Db,
  viewer: Viewer,
  siteId: string,
  category?: string,
) {
  const conditions = [
    eq(schema.assets.siteId, siteId),
    siteVisible(viewer),
    ...(category ? [eq(schema.assets.category, category as "report")] : []),
    ...(viewer.role === "owner" ? [] : [eq(schema.assets.isPublished, true)]),
  ];

  const rows = await db
    .select({ asset: schema.assets })
    .from(schema.assets)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.assets.siteId))
    .where(and(...conditions))
    .orderBy(asc(schema.assets.sortOrder), asc(schema.assets.title));

  return rows.map((r) => r.asset);
}

/** An asset plus its site, only when the viewer may see both. */
export async function getVisibleAsset(db: Db, viewer: Viewer, assetId: string) {
  const conditions = [
    eq(schema.assets.id, assetId),
    siteVisible(viewer),
    ...(viewer.role === "owner" ? [] : [eq(schema.assets.isPublished, true)]),
  ];

  const rows = await db
    .select({ asset: schema.assets, site: schema.sites })
    .from(schema.assets)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.assets.siteId))
    .where(and(...conditions))
    .limit(1);

  return rows[0];
}

export async function listSurveysForSite(db: Db, siteId: string) {
  return db
    .select()
    .from(schema.surveys)
    .where(eq(schema.surveys.siteId, siteId))
    .orderBy(desc(schema.surveys.flownOn));
}

export async function listVisibleVideos(db: Db, viewer: Viewer, siteId: string) {
  const rows = await db
    .select({ video: schema.videos })
    .from(schema.videos)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.videos.siteId))
    .where(and(eq(schema.videos.siteId, siteId), siteVisible(viewer)))
    .orderBy(asc(schema.videos.sortOrder));
  return rows.map((r) => r.video);
}

/**
 * Looks up a person by the email Google returned. This is the allowlist: no row,
 * or an inactive row, means no access no matter how valid the Google identity is.
 */
export async function findActiveUserByEmail(db: Db, email: string) {
  const rows = await db
    .select()
    .from(schema.users)
    .where(and(sql`lower(${schema.users.email}) = ${email.trim().toLowerCase()}`, eq(schema.users.isActive, true)))
    .limit(1);
  return rows[0];
}
