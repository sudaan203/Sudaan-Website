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

let cached: PortalDb | null | undefined;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getDb(): PortalDb | null {
  if (cached !== undefined) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) {
    cached = null;
    return cached;
  }

  // prepare: false is required for Supabase's transaction mode pooler.
  // max: 1 keeps a serverless function from opening a pool per invocation.
  const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 20 });
  cached = drizzle(sql, { schema });
  return cached;
}

export { schema };
