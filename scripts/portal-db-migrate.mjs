#!/usr/bin/env node
/**
 * Applies the portal SQL migrations in drizzle/ in filename order, once each.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/portal-db-migrate.mjs
 *   node scripts/portal-db-migrate.mjs --dry-run     (list pending, connect only)
 *
 * Deliberately plain SQL and a tiny ledger table rather than drizzle-kit: the
 * migrations run identically on Supabase, local Postgres and PGlite, and there is
 * no generated state to get out of sync with the checked in DDL.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");
const dryRun = process.argv.includes("--dry-run");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy the pooled connection string from Supabase.");
  process.exit(1);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error(`No .sql files found in ${MIGRATIONS_DIR}`);
  process.exit(1);
}

// prepare: false is required for Supabase's transaction mode pooler (port 6543).
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  await sql`
    create table if not exists portal_schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set(
    (await sql`select filename from portal_schema_migrations`).map((r) => r.filename),
  );

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`Up to date, ${applied.size} migration(s) already applied.`);
  } else if (dryRun) {
    console.log("Pending migrations:");
    pending.forEach((f) => console.log(`  ${f}`));
  } else {
    for (const file of pending) {
      const ddl = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`applying ${file} ... `);
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`insert into portal_schema_migrations (filename) values (${file})`;
      });
      console.log("done");
    }
    console.log(`Applied ${pending.length} migration(s).`);
  }
} catch (err) {
  console.error("\nMigration failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
