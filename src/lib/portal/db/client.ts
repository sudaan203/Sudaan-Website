/**
 * Postgres connection for the portal. Node runtime only.
 *
 * Returns null when DATABASE_URL is not configured, which is how the portal keeps
 * working on the seed store until the database exists. Call sites use
 * `isDatabaseConfigured()` to choose, so there is never a half configured state
 * that throws at request time.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type PortalDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Cached on globalThis, not just in module scope.
 *
 * Next's dev server re-evaluates modules on every hot reload, and a plain module
 * level cache means a brand new connection pool each time. Those pools are never
 * closed, so within a few edits they exhaust the Supabase pooler and every query
 * starts queueing until it hits the statement timeout. Observed and fixed on
 * 26 Jul 2026, do not "simplify" this back to a local variable.
 */
const globalForDb = globalThis as unknown as { portalDb?: PortalDb | null };

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getDb(): PortalDb | null {
  if (globalForDb.portalDb !== undefined) return globalForDb.portalDb;

  const url = process.env.DATABASE_URL;
  if (!url) {
    globalForDb.portalDb = null;
    return null;
  }

  // prepare: false is required for Supabase's transaction mode pooler.
  // max keeps a serverless instance from opening a pool per invocation, and
  // idle_timeout hands connections back rather than holding them open.
  //
  // Which pooler port to point at (measured 26 Jul 2026):
  //   Vercel, short lived functions -> transaction pooler, port 6543.
  //   A long lived server such as `next dev` -> session pooler, port 5432.
  // A persistent client on 6543 wedges after a few requests: queries stop
  // returning at all and every later request hangs waiting for a connection.
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 15 });
  globalForDb.portalDb = drizzle(sql, { schema });
  return globalForDb.portalDb;
}

export { schema };
