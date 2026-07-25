#!/usr/bin/env node
/**
 * Runs a throwaway Postgres on localhost for development, using PGlite over the
 * Postgres wire protocol. Lets the portal be exercised against its SQL backend
 * without a hosted database or any credentials.
 *
 * Not a project dependency, install on demand:
 *   npm install --no-save @electric-sql/pglite @electric-sql/pglite-socket
 *   node scripts/dev-pglite-server.mjs &
 *   DATABASE_URL=postgres://postgres@localhost:5433/postgres node scripts/portal-db-migrate.mjs
 *   DATABASE_URL=postgres://postgres@localhost:5433/postgres node scripts/portal-db-seed.mjs
 *   DATABASE_URL=postgres://postgres@localhost:5433/postgres npm run dev
 *
 * Data lives in memory unless PGLITE_DIR is set, so restarting gives a clean slate.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.PGLITE_PORT ?? 5433);
const dataDir = process.env.PGLITE_DIR;

const db = await PGlite.create(dataDir ? { dataDir } : undefined);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });

await server.start();
console.log(
  `PGlite listening on postgres://postgres@localhost:${port}/postgres` +
    (dataDir ? ` (persisted in ${dataDir})` : " (in memory)"),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  });
}
