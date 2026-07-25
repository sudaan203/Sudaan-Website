/**
 * Postgres backed implementation of the portal store.
 *
 * Every function here delegates the "may this person see it" decision to
 * db/queries.ts, so there is exactly one definition of visibility. This module
 * only maps database rows onto the UI facing types in types.ts.
 */

import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Db, Viewer } from "./db/queries";
import * as q from "./db/queries";
import * as schema from "./db/schema";
import type {
  AssetCategory,
  PortalAsset,
  PortalClient,
  PortalSession,
  PortalSite,
  PortalSurvey,
  PortalVideo,
} from "./types";

/**
 * Sessions still carry the Phase 1 role names. "admin" and "owner" mean the same
 * thing: Sudaan staff who see every client. This mapping is the only place that
 * needs to know, and it can go once Google sign in issues "owner" everywhere.
 */
export function viewerFor(session: PortalSession): Viewer {
  return {
    userId: session.userId,
    role: session.role === "client" ? "client" : "owner",
    clientId: session.clientId,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Guards the boundary between a session and SQL. Identifiers reach Postgres as
 * uuids, and a session carrying anything else (a stale cookie from the seed era,
 * a user removed from the database) must not become a 500 or, worse, a query
 * that accidentally matches more rows than it should.
 *
 * Fails closed: an unusable viewer sees nothing.
 */
function viewerIsQueryable(viewer: Viewer): boolean {
  if (!isUuid(viewer.userId)) return false;
  if (viewer.role === "client" && !isUuid(viewer.clientId)) return false;
  return true;
}

const warned = new Set<string>();
function denyUnqueryable(viewer: Viewer, where: string): true {
  if (!warned.has(viewer.userId)) {
    warned.add(viewer.userId);
    const reason = !isUuid(viewer.userId)
      ? `session id "${viewer.userId}" is not a database uuid`
      : "the session carries no client id";
    console.warn(
      `[portal] denying ${where}: ${reason}. Sign out and back in, or recreate the login.`,
    );
  }
  return true;
}

type SiteRow = typeof schema.sites.$inferSelect;
type AssetRow = typeof schema.assets.$inferSelect;

function toSite(row: SiteRow): PortalSite {
  return {
    id: row.id,
    clientId: row.clientId,
    slug: row.slug,
    name: row.name,
    location: row.location ?? "",
    district: row.district ?? undefined,
    state: row.state ?? undefined,
    areaLabel: row.areaLabel ?? undefined,
    industry: row.industry ?? undefined,
    status: row.status,
    summary: row.summary ?? "",
  };
}

function toAsset(row: AssetRow): PortalAsset {
  return {
    id: row.id,
    siteId: row.siteId,
    surveyId: row.surveyId ?? undefined,
    category: row.category as AssetCategory,
    title: row.title,
    fileName: row.fileName,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    description: row.description ?? undefined,
    sortOrder: row.sortOrder,
  };
}

export function createSqlStore(db: Db) {
  return {
    async getClient(clientId: string): Promise<PortalClient | null> {
      if (!isUuid(clientId)) return null;
      const rows = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);
      const row = rows[0];
      return row ? { id: row.id, slug: row.slug, name: row.name } : null;
    },

    async listSites(session: PortalSession): Promise<PortalSite[]> {
      const viewer = viewerFor(session);
      if (!viewerIsQueryable(viewer) && denyUnqueryable(viewer, "listSites")) return [];
      const rows = await q.listVisibleSites(db, viewer);
      return rows.map(toSite);
    },

    async getSite(session: PortalSession, slug: string): Promise<PortalSite | null> {
      const viewer = viewerFor(session);
      if (!viewerIsQueryable(viewer) && denyUnqueryable(viewer, "getSite")) return null;
      const row = await q.getVisibleSite(db, viewer, slug);
      return row ? toSite(row) : null;
    },

    async listSurveys(siteId: string): Promise<PortalSurvey[]> {
      if (!isUuid(siteId)) return [];
      const rows = await q.listSurveysForSite(db, siteId);
      return rows.map((row) => ({
        id: row.id,
        siteId: row.siteId,
        label: row.label,
        // date columns come back as YYYY-MM-DD strings, which is what we want.
        flownOn: String(row.flownOn),
        notes: row.notes ?? undefined,
      }));
    },

    async listAssets(
      session: PortalSession,
      siteId: string,
      category?: AssetCategory,
    ): Promise<PortalAsset[]> {
      const viewer = viewerFor(session);
      if (!viewerIsQueryable(viewer) && denyUnqueryable(viewer, "listAssets")) return [];
      if (!isUuid(siteId)) return [];
      const rows = await q.listVisibleAssets(db, viewer, siteId, category);
      return rows.map(toAsset);
    },

    async listAssetCounts(
      session: PortalSession,
      siteId: string,
    ): Promise<Record<AssetCategory, number>> {
      const viewer = viewerFor(session);
      if (!viewerIsQueryable(viewer) && denyUnqueryable(viewer, "listAssetCounts")) {
        return {} as Record<AssetCategory, number>;
      }
      if (!isUuid(siteId)) return {} as Record<AssetCategory, number>;
      const rows = await db
        .select({ category: schema.assets.category, n: count() })
        .from(schema.assets)
        .innerJoin(schema.sites, eq(schema.sites.id, schema.assets.siteId))
        .where(
          and(
            eq(schema.assets.siteId, siteId),
            viewer.role === "owner" ? sql`true` : eq(schema.assets.isPublished, true),
            // Reuse the site rule so counts can never advertise a hidden site.
            viewer.role === "owner"
              ? sql`true`
              : sql`${schema.sites.clientId} = ${viewer.clientId} and ${schema.sites.isPublished}`,
          ),
        )
        .groupBy(schema.assets.category);

      const counts = {} as Record<AssetCategory, number>;
      for (const row of rows) counts[row.category as AssetCategory] = Number(row.n);
      return counts;
    },

    async getAssetForSession(
      session: PortalSession,
      assetId: string,
    ): Promise<{ asset: PortalAsset; site: PortalSite } | null> {
      // A malformed id would make Postgres throw on the uuid cast, so treat
      // anything that is not a uuid as simply not found.
      const viewer = viewerFor(session);
      if (!viewerIsQueryable(viewer) && denyUnqueryable(viewer, "getAsset")) return null;
      if (!isUuid(assetId)) return null;
      const found = await q.getVisibleAsset(db, viewer, assetId);
      return found ? { asset: toAsset(found.asset), site: toSite(found.site) } : null;
    },

    async listVideos(session: PortalSession, siteId: string): Promise<PortalVideo[]> {
      const viewer = viewerFor(session);
      if (!viewerIsQueryable(viewer) && denyUnqueryable(viewer, "listVideos")) return [];
      if (!isUuid(siteId)) return [];
      const rows = await q.listVisibleVideos(db, viewer, siteId);
      return rows.map((row) => ({
        id: row.id,
        siteId: row.siteId,
        title: row.title,
        youtubeId: row.youtubeId,
        kind: row.kind,
        sortOrder: row.sortOrder,
      }));
    },
  };
}

export type SqlStore = ReturnType<typeof createSqlStore>;

/** Sorting helper shared with the seed store so both orders match. */
export const bySortOrder = asc;
