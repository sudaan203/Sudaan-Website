/**
 * Proves the portal survives a connection the pooler has thrown away.
 *
 * This is the failure that took the owner console down in production on
 * 26 Jul 2026: Vercel kept a warm function instance, the instance kept our
 * cached pool on globalThis, and Supabase's transaction pooler had long since
 * dropped the socket underneath it. The next render failed with "Connection
 * closed." and the page showed an error, or sat there until Vercel killed it at
 * 30 seconds.
 *
 * The test kills the live connection behind the application's back, then does
 * exactly what the owner console does, and expects real rows back.
 *
 * Run:
 *   npx tsx scripts/portal-reconnect-test.mts
 */

import { readFileSync } from "node:fs";

// The modules read process.env at call time, so load .env.local first.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const { getDb, queryDb } = await import("../src/lib/portal/db/client.ts");
const { listAdminClients, listAdminSites, listAdminUsers, listRecentAccessChanges } =
  await import("../src/lib/portal/admin-db.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const ownerConsoleReads = () =>
  queryDb("owner console", () =>
    Promise.all([listAdminClients(), listAdminUsers(), listAdminSites(), listRecentAccessChanges()]),
  );

console.log("\nconnecting");
if (!getDb()) {
  console.error("no DATABASE_URL, nothing to test");
  process.exit(1);
}

const first = await ownerConsoleReads();
check("owner console reads on a fresh connection", first[0].length > 0, `${first[0].length} clients`);

// Kill it the way the pooler does: end the socket without telling the app.
const globals = globalThis as unknown as { portalSql?: { end: (o?: unknown) => Promise<void> } };
const live = globals.portalSql;
check("pool handle is cached for reuse", Boolean(live));
await live!.end({ timeout: 1 });
console.log("\nconnection killed behind the application's back\n");

const started = Date.now();
const second = await ownerConsoleReads();
const elapsed = Date.now() - started;

check("owner console recovers on the dead connection", second[0].length === first[0].length,
  `${second[0].length} clients in ${elapsed}ms`);
check("recovery is fast, not a 30 second hang", elapsed < 15000, `${elapsed}ms`);
check("users still read back", second[1].length === first[1].length, `${second[1].length} people`);
check("sites still read back", second[2].length === first[2].length, `${second[2].length} sites`);

// A real query fault must surface immediately, not be retried into a longer
// wait. Watch the warnings to prove no reconnect was attempted.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));

let surfaced = "";
try {
  await queryDb("bad query", async () => {
    const db = getDb()!;
    const { sql } = await import("drizzle-orm");
    return db.execute(sql`select * from table_that_does_not_exist`);
  });
} catch (err) {
  surfaced = err instanceof Error ? err.message : String(err);
}
console.warn = realWarn;

check("a genuine SQL error surfaces", /table_that_does_not_exist/.test(surfaced));
check("and is not retried as a connection fault", warnings.length === 0,
  warnings.join(" ").slice(0, 80));

const third = await ownerConsoleReads();
check("still usable after that error", third[0].length === first[0].length);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
