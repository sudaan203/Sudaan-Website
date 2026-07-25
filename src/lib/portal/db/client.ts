/**
 * Postgres connection for the portal. Node runtime only.
 *
 * Returns null when no connection string is configured, which is how the portal
 * keeps working on the seed store until the database exists. Call sites use
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

/**
 * Prisma and the Vercel integration add flags to the URL that Postgres itself
 * does not understand. postgres.js forwards unknown query parameters as server
 * startup options, and the pooler rejects them, so strip them.
 */
const NON_POSTGRES_PARAMS = [
  "pgbouncer",
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "schema",
  "supa",
];

/**
 * Accepts either name, so the Supabase integration for Vercel works with no
 * extra configuration:
 *   DATABASE_URL   set by hand, wins when present
 *   POSTGRES_URL   created automatically by the Supabase Vercel integration
 * Deliberately NOT POSTGRES_URL_NON_POOLING: that is the direct host, which is
 * IPv6 only on new projects and unreachable from many networks.
 */
export function connectionString(): string | null {
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
  if (!raw) return null;

  try {
    const url = new URL(raw);
    for (const param of NON_POSTGRES_PARAMS) url.searchParams.delete(param);
    return url.toString();
  } catch {
    return raw;
  }
}

export function isDatabaseConfigured(): boolean {
  return connectionString() !== null;
}

export function getDb(): PortalDb | null {
  if (globalForDb.portalDb !== undefined) return globalForDb.portalDb;

  const url = connectionString();
  if (!url) {
    globalForDb.portalDb = null;
    return null;
  }

  // A direct host cannot be reached from IPv4 only networks, so say so loudly
  // rather than letting every request fail with a DNS error.
  if (/db\.[a-z0-9]+\.supabase\.co/.test(url)) {
    console.warn(
      "[portal] the connection string points at the direct Supabase host, which is IPv6 only. " +
        "Use the pooler host (aws-N-region.pooler.supabase.com) instead.",
    );
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
