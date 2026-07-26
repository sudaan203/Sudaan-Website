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
const globalForDb = globalThis as unknown as {
  portalDb?: PortalDb | null;
  portalSql?: ReturnType<typeof postgres>;
};

/** How long any one attempt gets before we give up on it. */
const QUERY_TIMEOUT_MS = 7000;

/** Connections in the pool. See the comment on `max` below before changing it. */
const POOL_MAX = 8;

/**
 * Like Promise.all over map, but never more than the pool can serve at once.
 *
 * A page that fans out per row (the dashboard does three reads per site) grows
 * its concurrency with the data. Past the pool size those queries queue behind
 * the transaction pooler and the page stalls, so the limit is a correctness
 * requirement rather than politeness.
 */
export async function mapPooled<In, Out>(
  items: readonly In[],
  fn: (item: In) => Promise<Out>,
  limit = Math.max(1, POOL_MAX - 2),
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

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

  // Which pooler port to point at:
  //   Vercel, short lived functions -> transaction pooler, port 6543.
  //   A long lived server such as `next dev` -> session pooler, port 5432.
  //
  // The two behave differently under concurrency, and that difference cost days.
  // A page whose queries ran fine on 5432 hung on 6543, so nothing reproduced
  // locally while production kept failing. If you are testing pooling behaviour,
  // test on 6543: `npx tsx scripts/portal-pooler-test.mts` forces that port
  // whatever .env.local says.
  const sql = postgres(url, {
    // Required by Supabase's transaction mode pooler: it cannot keep prepared
    // statements across pooled connections.
    prepare: false,
    // The one that actually caused 300 second timeouts in production. On its
    // first query postgres.js interrogates pg_catalog for custom type OIDs. Under
    // the transaction pooler that round trip can hang, and because Vercel reuses
    // a warm function instance, the wedged pool is reused for every later request
    // on that instance, so the whole page just times out. Skipping type discovery
    // removes the hang. Custom types are not used by this schema.
    fetch_types: false,
    // The pool must be at least as large as the most concurrent queries any one
    // page issues, and this is not a tuning knob. Supabase's transaction pooler
    // serves one query at a time per connection, so when postgres.js pipelines
    // several concurrent queries down a single connection they simply never come
    // back. Measured against the live transaction pooler on 26 Jul 2026, running
    // the owner console's four reads together:
    //   max 1 -> hangs indefinitely
    //   max 2 -> hangs, survives only because queryDb retries, 9.1s
    //   max 4 -> 325ms
    //   max 8 -> 325ms
    // That hang was the owner console failing in production. The session pooler
    // on 5432 does not behave this way, which is why it never reproduced locally.
    // Connections are handed back after idle_timeout, so 8 is a ceiling under
    // load rather than 8 connections held open.
    max: POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    // Recycle a connection well before the pooler decides to drop it. Supabase
    // closes pooled connections on its own schedule, and a socket that the
    // pooler has already discarded looks fine to us until the next query fails
    // with "Connection closed". Retiring them ourselves keeps that rare.
    max_lifetime: 60 * 5,
    // Server side ceiling on any single query. Without it a query that never
    // returns holds the request until Vercel kills the function minutes later,
    // which is what the production logs showed. Failing fast gives the page a
    // chance to show an error instead of a gateway timeout.
    connection: { statement_timeout: QUERY_TIMEOUT_MS - 1000 },
  });
  globalForDb.portalSql = sql;
  globalForDb.portalDb = drizzle(sql, { schema });
  return globalForDb.portalDb;
}

/**
 * Throws away the cached pool so the next getDb() dials a fresh connection.
 * Ending the old one is best effort: it is already broken, and waiting on a
 * broken socket is the very thing we are escaping.
 */
async function resetDb(): Promise<void> {
  const sql = globalForDb.portalSql;
  globalForDb.portalDb = undefined;
  globalForDb.portalSql = undefined;
  if (!sql) return;
  try {
    await sql.end({ timeout: 1 });
  } catch {
    // Nothing useful to do; the handle is being discarded either way.
  }
}

/**
 * A pooled socket that the other end has closed, or a hung connect. These are
 * transport failures rather than anything wrong with the query, so they are
 * worth one clean retry. Anything else (bad SQL, constraint violation) is a real
 * bug and must surface instead of being retried into a longer wait.
 */
function isConnectionFault(err: unknown): boolean {
  // Walk the cause chain. Drizzle wraps every failure in a DrizzleQueryError
  // whose own message is just the SQL, so the postgres.js code that identifies a
  // dead socket is one or more levels down. Reading only the top level error
  // silently misses the case this whole mechanism exists for.
  for (let cursor = err, depth = 0; cursor && depth < 5; depth += 1) {
    const code = (cursor as { code?: string }).code ?? "";
    const message = cursor instanceof Error ? cursor.message : String(cursor);
    if (
      /^(CONNECTION_|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|ECONNREFUSED)/.test(code) ||
      /connection closed|connection ended|connection destroyed|socket hang up|timed out after/i.test(
        message,
      )
    ) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

function withDeadline<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${QUERY_TIMEOUT_MS}ms`)),
      QUERY_TIMEOUT_MS,
    );
  });
  // Clearing the timer matters on a serverless function: a pending timer keeps
  // the instance awake after the response has already been sent.
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Runs portal reads with a deadline and one retry on a dead connection.
 *
 * Vercel keeps a function instance warm and we cache the pool on globalThis, so
 * an instance can come back to life holding a socket the Supabase pooler threw
 * away minutes ago. The first query on that socket fails, and without this the
 * page rendered a bare "Application error" or sat there until Vercel killed it
 * at 30 seconds. Observed in production on 26 Jul 2026.
 *
 * Wrap a whole page's reads in one call rather than each query separately, so
 * there is a single place that reconnects and no chance of parallel queries
 * resetting the pool underneath each other. Safe to wrap reads that fall back to
 * the seed catalogue: without a database there is simply nothing to reconnect.
 */
export async function queryDb<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await withDeadline(label, run());
  } catch (err) {
    if (!isConnectionFault(err)) throw err;

    // First line only: Drizzle's message is the entire failed statement, which
    // buries the actual cause in the Vercel log.
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 120);
    console.warn(`[portal] ${label}: ${why} — reconnecting and retrying once`);
    await resetDb();
    return withDeadline(`${label} (retry)`, run());
  }
}

export { schema };
