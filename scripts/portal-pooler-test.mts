/**
 * Guards the bug that took the owner console down: concurrent queries on
 * Supabase's TRANSACTION pooler.
 *
 * The pooler serves one query at a time per connection. When postgres.js
 * pipelines several concurrent queries down a single connection they never come
 * back, and the page hangs until the platform kills it. Measured 26 Jul 2026
 * with the owner console's four reads: pool of 1 hangs indefinitely, pool of 2
 * takes 9.1s, pool of 4 takes 325ms.
 *
 * This runs against port 6543 whatever .env.local says, because .env.local
 * points at the session pooler on 5432, which does not have this behaviour. That
 * single digit is why the fault never reproduced locally for days.
 *
 * Run:
 *   npx tsx scripts/portal-pooler-test.mts
 */

import { readFileSync } from "node:fs";

const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const read = (k: string) =>
  ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

const configured = read("DATABASE_URL");
if (!configured) {
  console.error("no DATABASE_URL in .env.local");
  process.exit(1);
}

// Force the production port regardless of what is configured locally.
process.env.DATABASE_URL = configured.replace(/:(5432|6543)\//, ":6543/");
console.log("\ntransaction pooler, port 6543\n");

const { getDb, queryDb, mapPooled } = await import("../src/lib/portal/db/client.ts");
const { listAdminClients, listAdminSites, listAdminUsers, listRecentAccessChanges } =
  await import("../src/lib/portal/admin-db.ts");

if (!getDb()) {
  console.error("could not build a connection");
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const ownerConsoleReads = () =>
  queryDb("owner console", () =>
    Promise.all([listAdminClients(), listAdminUsers(), listAdminSites(), listRecentAccessChanges()]),
  );

// The render itself. This is what hung.
{
  const started = Date.now();
  const [clients, users, sites] = await ownerConsoleReads();
  const ms = Date.now() - started;
  check("owner console reads four tables concurrently", clients.length > 0, `${clients.length} clients`);
  check("and returns quickly rather than hanging", ms < 5000, `${ms}ms`);
  check("people load", users.length > 0, `${users.length}`);
  check("sites load", sites.length > 0, `${sites.length}`);
}

// A warm instance serves many requests on the same pool; a wedge shows up here.
{
  const started = Date.now();
  for (let i = 0; i < 3; i += 1) await ownerConsoleReads();
  const ms = Date.now() - started;
  check("three further renders on the warm pool stay fast", ms < 6000, `${ms} for 3`);
}

// Heavier fan out than any page does today, to prove the limit holds as the
// customer's data grows.
{
  const started = Date.now();
  const out = await mapPooled(Array.from({ length: 24 }, (_, i) => i), async () => {
    const rows = await listAdminSites();
    return rows.length;
  });
  const ms = Date.now() - started;
  check("24 fanned out reads complete", out.length === 24, `${ms}ms`);
  check("fan out does not stall the pool", ms < 15000, `${ms}ms`);
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
