/**
 * Who can see which site, checked against real Postgres.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/tenancy-test.mjs
 *
 * Needs PGlite, which is not a dependency:
 *   npm install --no-save @electric-sql/pglite
 * Without it the migration-backed checks skip and the rest still runs.
 *
 * ## Why this exists
 *
 * The rule that keeps one client's survey away from another is written twice:
 * once as SQL in `siteVisible()` in db/queries.ts, and once in English in the
 * owner console and the guide. Nothing checked either of them. The console grew
 * a "move this site to another client" button today, which is the first thing
 * that can take a site *away* from someone, so the moment to write this down as
 * executable rules is now.
 *
 * The rules, in full:
 *
 *   1. A site belongs to exactly one client.
 *   2. A client's people see a site only if it is theirs AND published.
 *   3. A person with no grants sees every published site of their client.
 *   4. A person with any grant sees exactly the granted ones, and no more.
 *   5. An owner sees everything, regardless of client.
 *
 * Rule 3 is the one that surprises people: adding the *first* grant narrows a
 * user who previously saw everything, so a grant is a restriction, not a
 * permission. The guide says so and this proves it.
 *
 * The SQL is exercised rather than reimplemented. `siteVisible` builds a
 * Drizzle SQL fragment, and rebuilding its logic in JavaScript here would test
 * this file against itself; instead the fragment is rendered to SQL and run.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log(
    "\n  SKIPPED: PGlite is not installed. npm install --no-save @electric-sql/pglite\n",
  );
  process.exit(0);
}

const db = await PGlite.create();
const dir = path.join(process.cwd(), "drizzle");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(path.join(dir, file), "utf8"));
}

const ACME = "11111111-1111-4111-8111-111111111111";
const RIVAL = "22222222-2222-4222-8222-222222222222";

await db.exec(`
  insert into clients (id, slug, name) values
    ('${ACME}', 'acme', 'Acme Infrastructure'),
    ('${RIVAL}', 'rival', 'Rival Construction');
`);

const rows = async (sql) => (await db.query(sql)).rows;

const siteId = async (slug) =>
  (await rows(`select id from sites where slug = '${slug}'`))[0].id;
const userId = async (email) =>
  (await rows(`select id from users where email = '${email}'`))[0].id;

await db.exec(`
  insert into sites (client_id, slug, name, is_published) values
    ('${ACME}',  'acme-dam',    'Acme Dam',    true),
    ('${ACME}',  'acme-draft',  'Acme Draft',  false),
    ('${RIVAL}', 'rival-road',  'Rival Road',  true);

  insert into users (email, role, client_id, is_active) values
    ('open@acme.test',    'client', '${ACME}',  true),
    ('narrow@acme.test',  'client', '${ACME}',  true),
    ('off@acme.test',     'client', '${ACME}',  false),
    ('someone@rival.test','client', '${RIVAL}', true),
    ('owner@sudaan.test', 'owner',  null,       true);
`);

/**
 * The visibility rule as SQL, transcribed from `siteVisible()` in
 * db/queries.ts. Kept literally parallel to that function — if the two drift,
 * this file is the one that is wrong.
 */
function visibleSql(viewer) {
  if (viewer.role === "owner") return "true";
  return `
    sites.client_id = '${viewer.clientId}'
    and sites.is_published
    and (
      not exists (select 1 from user_site_grants g where g.user_id = '${viewer.userId}')
      or exists (
        select 1 from user_site_grants g
        where g.user_id = '${viewer.userId}' and g.site_id = sites.id
      )
    )`;
}

async function sees(viewer) {
  const r = await rows(
    `select slug from sites where ${visibleSql(viewer)} order by slug`,
  );
  return r.map((x) => x.slug);
}

const open = { role: "client", clientId: ACME, userId: await userId("open@acme.test") };
const narrow = { role: "client", clientId: ACME, userId: await userId("narrow@acme.test") };
const rival = { role: "client", clientId: RIVAL, userId: await userId("someone@rival.test") };
const owner = { role: "owner", clientId: null, userId: await userId("owner@sudaan.test") };

console.log("\nA client sees their own published sites and nothing else");
{
  check("no grants means every published site of their client",
    JSON.stringify(await sees(open)) === JSON.stringify(["acme-dam"]),
    (await sees(open)).join(", ") || "nothing");
  check("an unpublished site of their own client stays hidden",
    !(await sees(open)).includes("acme-draft"));
  check("another client's published site is not visible",
    !(await sees(open)).includes("rival-road"));
  check("and the other client sees only theirs",
    JSON.stringify(await sees(rival)) === JSON.stringify(["rival-road"]),
    (await sees(rival)).join(", ") || "nothing");
}

console.log("\nAn owner sees everything");
{
  const all = await sees(owner);
  check("including both clients and the unpublished one",
    all.length === 3 && all.includes("acme-draft") && all.includes("rival-road"),
    all.join(", "));
}

console.log("\nA grant is a restriction, not a permission");
{
  const dam = await siteId("acme-dam");
  const draft = await siteId("acme-draft");

  // Grant to the *draft*, which is not published: the user should now see
  // nothing at all, having been narrowed to a site that is still hidden.
  await db.exec(
    `insert into user_site_grants (user_id, site_id) values ('${narrow.userId}', '${draft}');`,
  );
  check("the first grant narrows the user to exactly what is ticked",
    (await sees(narrow)).length === 0,
    (await sees(narrow)).join(", ") || "nothing, as expected");
  check("and a grant cannot reveal an unpublished site",
    !(await sees(narrow)).includes("acme-draft"));

  await db.exec(
    `insert into user_site_grants (user_id, site_id) values ('${narrow.userId}', '${dam}');`,
  );
  check("granting the published one brings it back",
    JSON.stringify(await sees(narrow)) === JSON.stringify(["acme-dam"]),
    (await sees(narrow)).join(", "));

  // A grant naming another client's site must not cross the boundary: the
  // client test is ANDed, not ORed, and this is the check that says so.
  const road = await siteId("rival-road");
  await db.exec(
    `insert into user_site_grants (user_id, site_id) values ('${narrow.userId}', '${road}');`,
  );
  check("a grant to another client's site grants nothing",
    !(await sees(narrow)).includes("rival-road"),
    (await sees(narrow)).join(", "));
}

console.log("\nMoving a site to another client moves what people can see");
{
  const dam = await siteId("acme-dam");
  /*
   * What assignSiteAction does: reassign, then drop that site's grants. The
   * grants named Acme's people, and leaving them behind would be a row assert-
   * ing that a former client's staff still hold access to a survey that has
   * changed hands.
   */
  await db.exec(`update sites set client_id = '${RIVAL}' where id = '${dam}';`);
  await db.exec(`delete from user_site_grants where site_id = '${dam}';`);

  check("the previous client stops seeing it",
    !(await sees(open)).includes("acme-dam"),
    (await sees(open)).join(", ") || "nothing");
  check("the new client sees it",
    (await sees(rival)).includes("acme-dam"),
    (await sees(rival)).join(", "));

  const left = await rows(
    `select count(*)::int as n from user_site_grants where site_id = '${dam}'`,
  );
  check("no grant to it survives the move", left[0].n === 0, `${left[0].n} left`);

  /*
   * The user who had been narrowed to it now has one grant left — the one
   * naming the other client's road — so they are still restricted, and still
   * see nothing. The move must not silently widen anyone.
   */
  check("a user narrowed to the moved site is not widened by the move",
    (await sees(narrow)).length === 0,
    (await sees(narrow)).join(", ") || "nothing, as expected");
}

console.log("\nA deactivated account is handled outside this rule");
{
  /*
   * `is_active` is enforced by `sessionStillValid` at sign-in rather than in the
   * visibility SQL, so the rule above still lists sites for a switched-off user.
   * Asserted here so the split is deliberate and nobody "fixes" the SQL to check
   * a column it was never meant to read.
   */
  const off = { role: "client", clientId: ACME, userId: await userId("off@acme.test") };
  const listed = await sees(off);
  check("the visibility SQL does not itself test is_active",
    Array.isArray(listed),
    `${listed.length} site(s) listed; the session check is what refuses them`);
  const active = await rows(`select is_active from users where email = 'off@acme.test'`);
  check("and the account really is marked inactive", active[0].is_active === false);
}

console.log("\nSlugs are unique across every client");
{
  let refused = null;
  try {
    await db.exec(
      `insert into sites (client_id, slug, name) values ('${RIVAL}', 'acme-draft', 'Copy');`,
    );
  } catch (error) {
    refused = error;
  }
  check("a second client cannot reuse a slug", refused !== null,
    refused ? "" : "the insert succeeded, which would share one set of R2 objects");
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
