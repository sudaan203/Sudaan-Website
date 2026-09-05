/**
 * Tenant scoped data access for the portal, and the only module pages may import
 * for portal data. Pages must never touch seed.ts or the database directly.
 *
 * Two backends sit behind this interface:
 *   Postgres  when DATABASE_URL is set (store-sql.ts, visibility in db/queries.ts)
 *   seed file otherwise                (store-seed.ts, Phase 1 with no database)
 *
 * Both enforce the same rule: a caller only ever reaches their own client's data,
 * and a miss returns null so the page can answer 404 rather than confirm that a
 * slug or id exists.
 */

import { getDb, type PortalDb } from "./db/client";
import { createSqlStore, type SqlStore } from "./store-sql";
import * as seedStore from "./store-seed";
import type {
  AssetCategory,
  PortalAsset,
  PortalClient,
  PortalSession,
  PortalSite,
  PortalSurvey,
  PortalVideo,
} from "./types";

let sqlStore: SqlStore | null | undefined;

/**
 * The handle `sqlStore` was built over, so a reconnect can be noticed.
 *
 * `createSqlStore` captures its `db` in a closure, once. `queryDb`'s retry works
 * by throwing the dead pool away so the next `getDb()` dials a fresh one — but
 * a store cached on `sqlStore === undefined` alone is never rebuilt, so the
 * retry re-ran against *the same dead pool* and failed with the identical error.
 * Every portal route reads through this module, so the entire reconnect
 * mechanism in db/client.ts was a no-op for all of them.
 *
 * Observed on 5 Sep 2026 while running the analysis suite against the live
 * pooler: 20 `write CONNECTION_ENDED` drops, four of which reached the client as
 * a 500, each one preceded by "reconnecting and retrying once" in the log and
 * followed by the same failure a few milliseconds later.
 *
 * Comparing the handle rather than exporting a reset keeps the dependency
 * pointing one way — db/client.ts still knows nothing about the store — and
 * costs a map lookup, since `getDb()` returns the cached handle unless it has
 * been discarded. `users-db.ts` avoids the same trap by re-reading `getDb()`
 * inside its retried closure; this is the equivalent for the store.
 */
let sqlStoreDb: PortalDb | null | undefined;

function backend() {
  const db = getDb();
  if (sqlStore === undefined || sqlStoreDb !== db) {
    sqlStoreDb = db;
    sqlStore = db ? createSqlStore(db) : null;
  }
  return sqlStore ?? seedStore;
}

/** Which backend is live. Useful in logs and on the owner console. */
export function storeBackend(): "postgres" | "seed" {
  return backend() === seedStore ? "seed" : "postgres";
}

export function getClient(clientId: string): Promise<PortalClient | null> {
  return backend().getClient(clientId);
}

export function listSites(session: PortalSession): Promise<PortalSite[]> {
  return backend().listSites(session);
}

export function getSite(session: PortalSession, slug: string): Promise<PortalSite | null> {
  return backend().getSite(session, slug);
}

export function listSurveys(siteId: string): Promise<PortalSurvey[]> {
  return backend().listSurveys(siteId);
}

export function listAssets(
  session: PortalSession,
  siteId: string,
  category?: AssetCategory,
): Promise<PortalAsset[]> {
  return backend().listAssets(session, siteId, category);
}

export function listAssetCounts(
  session: PortalSession,
  siteId: string,
): Promise<Record<AssetCategory, number>> {
  return backend().listAssetCounts(session, siteId);
}

export function getAssetForSession(
  session: PortalSession,
  assetId: string,
): Promise<{ asset: PortalAsset; site: PortalSite } | null> {
  return backend().getAssetForSession(session, assetId);
}

export function listVideos(
  session: PortalSession,
  siteId: string,
): Promise<PortalVideo[]> {
  return backend().listVideos(session, siteId);
}
