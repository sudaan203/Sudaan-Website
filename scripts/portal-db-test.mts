/**
 * Verifies the portal authorisation rules against a real Postgres, in process.
 *
 * Runs drizzle/0001_init.sql and the exact query functions the app uses against
 * PGlite (embedded Postgres), so the rules that decide "who can see what" are
 * tested without needing a hosted database.
 *
 * Needs two tools that are not project dependencies:
 *   npm install --no-save @electric-sql/pglite tsx
 *   npx tsx scripts/portal-db-test.mts
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "../src/lib/portal/db/schema";
import {
  findActiveUserByEmail,
  getVisibleAsset,
  getVisibleSite,
  listVisibleAssets,
  listVisibleSites,
  type Viewer,
} from "../src/lib/portal/db/queries";

let pass = 0;
let fail = 0;
function check(desc: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  PASS  ${desc} (${a})`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${desc} -> got ${a}, want ${e}`);
  }
}

const client = new PGlite();
const db = drizzle(client, { schema });

const ddl = readFileSync(path.join(process.cwd(), "drizzle", "0001_init.sql"), "utf8");
await client.exec(ddl);
console.log("migration applied to PGlite\n");

// ---- fixtures ----
const [acme] = await db
  .insert(schema.clients)
  .values({ slug: "acme", name: "Acme Infra" })
  .returning();
const [globex] = await db
  .insert(schema.clients)
  .values({ slug: "globex", name: "Globex" })
  .returning();

const [owner] = await db
  .insert(schema.users)
  .values({ email: "Malhar@Sudaangeo.in", fullName: "Malhar", role: "owner" })
  .returning();
const [acmeUser] = await db
  .insert(schema.users)
  .values({ email: "eng@acme.com", fullName: "Acme Engineer", role: "client", clientId: acme.id })
  .returning();
const [acmeContractor] = await db
  .insert(schema.users)
  .values({
    email: "contractor@acme.com",
    fullName: "Acme Contractor",
    role: "client",
    clientId: acme.id,
  })
  .returning();
const [globexUser] = await db
  .insert(schema.users)
  .values({ email: "gis@globex.com", role: "client", clientId: globex.id })
  .returning();
await db
  .insert(schema.users)
  .values({ email: "exstaff@acme.com", role: "client", clientId: acme.id, isActive: false });

const [sitePub] = await db
  .insert(schema.sites)
  .values({ clientId: acme.id, slug: "kotba", name: "Kotba", isPublished: true })
  .returning();
const [siteSecond] = await db
  .insert(schema.sites)
  .values({ clientId: acme.id, slug: "vadnagar", name: "Vadnagar", isPublished: true })
  .returning();
const [siteDraft] = await db
  .insert(schema.sites)
  .values({ clientId: acme.id, slug: "staging", name: "Staging Site", isPublished: false })
  .returning();
const [globexSite] = await db
  .insert(schema.sites)
  .values({ clientId: globex.id, slug: "globex-yard", name: "Globex Yard", isPublished: true })
  .returning();

// The contractor is narrowed to one site only.
await db
  .insert(schema.userSiteGrants)
  .values({ userId: acmeContractor.id, siteId: sitePub.id, grantedBy: owner.id });

const [assetPub] = await db
  .insert(schema.assets)
  .values({
    siteId: sitePub.id,
    category: "report",
    title: "Topo Report",
    fileName: "topo.pdf",
    storageKey: "acme/kotba/topo.pdf",
    mimeType: "application/pdf",
    isPublished: true,
  })
  .returning();
const [assetDraft] = await db
  .insert(schema.assets)
  .values({
    siteId: sitePub.id,
    category: "report",
    title: "Unreviewed Draft",
    fileName: "draft.pdf",
    storageKey: "acme/kotba/draft.pdf",
    mimeType: "application/pdf",
    isPublished: false,
  })
  .returning();
const [globexAsset] = await db
  .insert(schema.assets)
  .values({
    siteId: globexSite.id,
    category: "report",
    title: "Globex Report",
    fileName: "g.pdf",
    storageKey: "globex/yard/g.pdf",
    mimeType: "application/pdf",
    isPublished: true,
  })
  .returning();

const ownerV: Viewer = { userId: owner.id, role: "owner", clientId: null };
const acmeV: Viewer = { userId: acmeUser.id, role: "client", clientId: acme.id };
const contractorV: Viewer = { userId: acmeContractor.id, role: "client", clientId: acme.id };
const globexV: Viewer = { userId: globexUser.id, role: "client", clientId: globex.id };

console.log("== Client user with no grants: all published sites of own client");
check(
  "sees both published sites",
  (await listVisibleSites(db, acmeV)).map((s) => s.slug).sort(),
  ["kotba", "vadnagar"],
);
check("cannot see unpublished staging site", await getVisibleSite(db, acmeV, "staging"), undefined);
check("cannot see other client site", await getVisibleSite(db, acmeV, "globex-yard"), undefined);
check("can open own site", (await getVisibleSite(db, acmeV, "kotba"))?.slug, "kotba");

console.log("== Grants narrow a user down");
check(
  "contractor sees only the granted site",
  (await listVisibleSites(db, contractorV)).map((s) => s.slug),
  ["kotba"],
);
check(
  "contractor cannot open the ungranted sibling site",
  await getVisibleSite(db, contractorV, "vadnagar"),
  undefined,
);

console.log("== Publish flags on assets");
check(
  "client sees only published assets",
  (await listVisibleAssets(db, acmeV, sitePub.id)).map((a) => a.title),
  ["Topo Report"],
);
check(
  "client cannot fetch an unpublished asset by id",
  await getVisibleAsset(db, acmeV, assetDraft.id),
  undefined,
);
check(
  "client can fetch a published asset by id",
  (await getVisibleAsset(db, acmeV, assetPub.id))?.asset.title,
  "Topo Report",
);
check(
  "client cannot fetch another client's asset by id",
  await getVisibleAsset(db, acmeV, globexAsset.id),
  undefined,
);
check(
  "assets of an unpublished site are hidden",
  (await listVisibleAssets(db, acmeV, siteDraft.id)).length,
  0,
);

console.log("== Other client is isolated in the other direction too");
check(
  "globex sees only its own site",
  (await listVisibleSites(db, globexV)).map((s) => s.slug),
  ["globex-yard"],
);
check("globex cannot open kotba", await getVisibleSite(db, globexV, "kotba"), undefined);

console.log("== Owner sees everything, including staging");
check(
  "owner sees all four sites",
  (await listVisibleSites(db, ownerV)).map((s) => s.slug).sort(),
  ["globex-yard", "kotba", "staging", "vadnagar"],
);
check(
  "owner sees unpublished assets",
  (await listVisibleAssets(db, ownerV, sitePub.id)).map((a) => a.title).sort(),
  ["Topo Report", "Unreviewed Draft"],
);

console.log("== Google allowlist");
check("invited email resolves", (await findActiveUserByEmail(db, "eng@acme.com"))?.email, "eng@acme.com");
check(
  "email case is ignored (Google may return any case)",
  (await findActiveUserByEmail(db, "MALHAR@sudaangeo.IN"))?.role,
  "owner",
);
check("uninvited email is rejected", await findActiveUserByEmail(db, "random@gmail.com"), undefined);
check("deactivated user is rejected", await findActiveUserByEmail(db, "exstaff@acme.com"), undefined);

console.log("== Schema constraints hold");
let ownerWithClientRejected = false;
try {
  await db
    .insert(schema.users)
    .values({ email: "bad@x.com", role: "owner", clientId: acme.id });
} catch {
  ownerWithClientRejected = true;
}
check("an owner cannot be tied to a client", ownerWithClientRejected, true);

let dupEmailRejected = false;
try {
  await db.insert(schema.users).values({ email: "ENG@acme.com", role: "client", clientId: acme.id });
} catch {
  dupEmailRejected = true;
}
check("duplicate email in a different case is rejected", dupEmailRejected, true);

let dupSlugRejected = false;
try {
  await db.insert(schema.sites).values({ clientId: acme.id, slug: "kotba", name: "Dup" });
} catch {
  dupSlugRejected = true;
}
check("same slug twice for one client is rejected", dupSlugRejected, true);

const [reused] = await db
  .insert(schema.sites)
  .values({ clientId: globex.id, slug: "kotba", name: "Globex Kotba", isPublished: true })
  .returning();
check("two clients may reuse a slug", Boolean(reused), true);
check(
  "and slug lookup still returns the caller's own row",
  (await getVisibleSite(db, globexV, "kotba"))?.name,
  "Globex Kotba",
);
check(
  "while the other client keeps theirs",
  (await getVisibleSite(db, acmeV, "kotba"))?.name,
  "Kotba",
);

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
