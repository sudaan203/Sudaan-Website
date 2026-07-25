/**
 * Verifies the Postgres backed store that the portal pages actually call.
 *
 * Runs drizzle/0001_init.sql on embedded Postgres (PGlite), seeds two clients,
 * then drives createSqlStore() with real sessions. This is the same code path as
 * a page render, minus HTTP, so it covers row mapping as well as authorisation.
 *
 * Needs two tools that are not project dependencies:
 *   npm install --no-save @electric-sql/pglite tsx
 *   npx tsx scripts/portal-store-test.mts
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "../src/lib/portal/db/schema";
import { createSqlStore } from "../src/lib/portal/store-sql";
import type { PortalSession } from "../src/lib/portal/types";

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
await client.exec(readFileSync(path.join(process.cwd(), "drizzle", "0001_init.sql"), "utf8"));

const store = createSqlStore(db);

// ---- fixtures ----
const [acme] = await db.insert(schema.clients).values({ slug: "acme", name: "Acme" }).returning();
const [globex] = await db.insert(schema.clients).values({ slug: "globex", name: "Globex" }).returning();

const [acmeSite] = await db
  .insert(schema.sites)
  .values({
    clientId: acme.id,
    slug: "kotba",
    name: "Kotba Survey",
    location: "Kotba, Gujarat",
    district: "Gandhinagar",
    areaLabel: "42 ha",
    summary: "GCP controlled processing.",
    isPublished: true,
  })
  .returning();
const [acmeDraft] = await db
  .insert(schema.sites)
  .values({ clientId: acme.id, slug: "draft", name: "Draft Site", isPublished: false })
  .returning();
const [globexSite] = await db
  .insert(schema.sites)
  .values({ clientId: globex.id, slug: "yard", name: "Globex Yard", isPublished: true })
  .returning();

await db.insert(schema.surveys).values({
  siteId: acmeSite.id,
  label: "Baseline flight",
  flownOn: "2024-05-03",
  notes: "12 GCPs",
});

const [report] = await db
  .insert(schema.assets)
  .values({
    siteId: acmeSite.id,
    category: "report",
    title: "Topographic Survey Report",
    fileName: "topo.pdf",
    storageKey: "acme/kotba/topo.pdf",
    mimeType: "application/pdf",
    description: "Methodology and accuracy.",
    sortOrder: 1,
  })
  .returning();
await db.insert(schema.assets).values({
  siteId: acmeSite.id,
  category: "photo",
  title: "Ortho preview",
  fileName: "ortho.webp",
  storageKey: "acme/kotba/ortho.webp",
  mimeType: "image/webp",
  sortOrder: 1,
});
const [hidden] = await db
  .insert(schema.assets)
  .values({
    siteId: acmeSite.id,
    category: "report",
    title: "Unreviewed draft",
    fileName: "draft.pdf",
    storageKey: "acme/kotba/draft.pdf",
    mimeType: "application/pdf",
    isPublished: false,
    sortOrder: 2,
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
  })
  .returning();
await db.insert(schema.videos).values({
  siteId: acmeSite.id,
  title: "Flyover",
  youtubeId: "abc123",
  kind: "front_view",
});

const [acmeUser] = await db
  .insert(schema.users)
  .values({ email: "eng@acme.com", role: "client", clientId: acme.id })
  .returning();
const [globexUser] = await db
  .insert(schema.users)
  .values({ email: "gis@globex.com", role: "client", clientId: globex.id })
  .returning();
const [ownerUser] = await db
  .insert(schema.users)
  .values({ email: "malhar@sudaangeo.in", role: "owner" })
  .returning();

const session = (id: string, role: "admin" | "client", clientId: string | null): PortalSession => ({
  userId: id,
  email: "x@example.com",
  fullName: "Test",
  role,
  clientId,
});

const acmeS = session(acmeUser.id, "client", acme.id);
const globexS = session(globexUser.id, "client", globex.id);
const ownerS = session(ownerUser.id, "admin", null);

console.log("== Rows map onto the UI types correctly");
const sites = await store.listSites(acmeS);
check("client sees one published site", sites.map((s) => s.slug), ["kotba"]);
check("name maps", sites[0]?.name, "Kotba Survey");
check("nullable columns become undefined, not null", sites[0]?.state, undefined);
check("location maps", sites[0]?.location, "Kotba, Gujarat");
const surveys = await store.listSurveys(acmeSite.id);
check("survey date is a plain ISO date string", surveys[0]?.flownOn, "2024-05-03");

console.log("== Reads are scoped to the caller's client");
check("own site by slug", (await store.getSite(acmeS, "kotba"))?.name, "Kotba Survey");
check("unpublished site is invisible", await store.getSite(acmeS, "draft"), null);
check("other client's slug", await store.getSite(acmeS, "yard"), null);
check("other client's site list", (await store.listSites(globexS)).map((s) => s.slug), ["yard"]);

console.log("== Assets respect publish flags and ownership");
check(
  "published assets only",
  (await store.listAssets(acmeS, acmeSite.id, "report")).map((a) => a.title),
  ["Topographic Survey Report"],
);
const sortedCounts = (c: Record<string, number>) => Object.entries(c).sort();
check(
  "counts exclude unpublished",
  sortedCounts(await store.listAssetCounts(acmeS, acmeSite.id)),
  [["photo", 1], ["report", 1]],
);
check(
  "owner counts include unpublished",
  sortedCounts(await store.listAssetCounts(ownerS, acmeSite.id)),
  [["photo", 1], ["report", 2]],
);
check("fetch own asset", (await store.getAssetForSession(acmeS, report.id))?.asset.title, "Topographic Survey Report");
check("storage key survives mapping", (await store.getAssetForSession(acmeS, report.id))?.asset.storageKey, "acme/kotba/topo.pdf");
check("cannot fetch unpublished asset", await store.getAssetForSession(acmeS, hidden.id), null);
check("cannot fetch other client's asset", await store.getAssetForSession(acmeS, globexAsset.id), null);
check("other client cannot fetch ours", await store.getAssetForSession(globexS, report.id), null);
check("owner can fetch unpublished", (await store.getAssetForSession(ownerS, hidden.id))?.asset.title, "Unreviewed draft");

console.log("== Videos follow the same rule");
check("own site videos", (await store.listVideos(acmeS, acmeSite.id)).map((v) => v.title), ["Flyover"]);
check("other client sees none", (await store.listVideos(globexS, acmeSite.id)).length, 0);

console.log("== Bad input fails closed instead of throwing");
check("malformed asset id", await store.getAssetForSession(acmeS, "not-a-uuid"), null);
check("malformed site id in listAssets", (await store.listAssets(acmeS, "'; drop table sites; --")).length, 0);
check("malformed site id in counts", await store.listAssetCounts(acmeS, "abc"), {});
check("quote in slug does not break the query", await store.getSite(acmeS, "kotba' or '1'='1"), null);
const stale = session("usr_legacy_id", "client", acme.id);
check("session id that is not a uuid sees nothing", (await store.listSites(stale)).length, 0);
check("and cannot open a site", await store.getSite(stale, "kotba"), null);
const noClient = session(acmeUser.id, "client", null);
check("client session with no client id sees nothing", (await store.listSites(noClient)).length, 0);

console.log("== Owner view");
check("owner sees every site", (await store.listSites(ownerS)).map((s) => s.slug).sort(), ["draft", "kotba", "yard"]);
check("owner resolves a client name", (await store.getClient(acme.id))?.name, "Acme");
check("getClient rejects a non uuid", await store.getClient("cl_demo"), null);

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
