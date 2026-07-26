#!/usr/bin/env node
/**
 * Writes a generated catalogue.json into Postgres.
 *
 *   node scripts/portal-db-publish.mjs portal-data/files/<client>/<site>/catalogue.json
 *   node scripts/portal-db-publish.mjs <path> --dry-run
 *
 * The difference from portal-db-seed.mjs, which stays as the demo fixture seeder:
 * that file holds a hand written array of rows, and this reads rows that
 * publish-site.mjs derived from the delivered files. Nothing in here decides what
 * a site contains.
 *
 * Idempotent by construction. Ids are uuid v5 over client, site and file path, so
 * republishing a site updates its rows in place. Assets that no longer exist in
 * the catalogue are unpublished rather than deleted, because a client may have a
 * link to one and a 404 is a worse answer than "no longer available"; and because
 * deleting rows a human might have granted access to is not this script's call.
 */

import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const path = argv.find((a) => !a.startsWith("--"));

if (!path) {
  console.error("Usage: node scripts/portal-db-publish.mjs <catalogue.json> [--dry-run]");
  process.exit(1);
}
const file = resolve(path);
if (!existsSync(file)) {
  console.error(`no such catalogue: ${file}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url && !dryRun) {
  console.error("Neither DATABASE_URL nor POSTGRES_URL is set. Use --dry-run to inspect without a database.");
  process.exit(1);
}

const catalogue = JSON.parse(readFileSync(file, "utf8"));
const { client, site, survey, assets } = catalogue;

/* ---------------------------------------------------------------- checks --- */

// Fail before touching the database rather than half way through it.
const CATEGORIES = new Set(["report", "drawing", "photo", "uav_dgps", "lidar", "control_area", "misc"]);
const MIMES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
  "text/csv", "text/tab-separated-values",
]);

const errors = [];
if (!client?.id || !client?.slug) errors.push("the catalogue has no client");
if (!site?.id || !site?.slug) errors.push("the catalogue has no site");
if (!Array.isArray(assets) || assets.length === 0) errors.push("the catalogue has no assets");
for (const a of assets ?? []) {
  if (!CATEGORIES.has(a.category)) errors.push(`${a.title}: category "${a.category}" is not one the schema allows`);
  // The asset route refuses anything off its allowlist with a 415, which reaches
  // the client as "cannot be previewed". Catch it here instead.
  if (!MIMES.has(a.mime_type)) errors.push(`${a.title}: mime type "${a.mime_type}" is not one the asset route will serve`);
  if (!a.storage_key?.startsWith(`${client.slug}/`)) {
    errors.push(`${a.title}: storage key "${a.storage_key}" is outside this client's folder`);
  }
}
if (errors.length) {
  console.error(`\nrefusing to publish:`);
  for (const e of errors) console.error(`  ! ${e}`);
  process.exit(1);
}

console.log(`\n${site.name} (${site.slug})`);
console.log(`  client   ${client.slug}`);
console.log(`  area     ${site.area_label ?? "none"}`);
console.log(`  assets   ${assets.length}`);
for (const a of assets) console.log(`    ${a.category.padEnd(9)} ${a.title}`);

if (dryRun) {
  console.log(`\ndry run, nothing written\n`);
  process.exit(0);
}

/* ----------------------------------------------------------------- write --- */

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

/**
 * Identity comes from the natural key, not from the generated id.
 *
 * The generated uuid v5 is only used when a row has to be created. Existing rows
 * keep the id they already have, matched on what the schema says is unique:
 * `clients.slug`, `sites (client_id, slug)`, and for assets the storage key inside
 * a site.
 *
 * Doing it the other way round does not work, and would have broken on the first
 * real run. Kotba already exists with the id `33333333-...` from the demo seed,
 * while this script generates `567a0eaf-...` for the same slug, and `sites` has a
 * unique constraint on (client_id, slug). An id keyed upsert would have hit that
 * constraint and failed, or worse, in a table without the constraint, inserted a
 * duplicate site the client would see twice.
 */
try {
  await sql.begin(async (tx) => {
    const [existingClient] = await tx`select id from clients where slug = ${client.slug}`;
    const clientId = existingClient?.id ?? client.id;
    if (existingClient) {
      await tx`update clients set name = ${client.name ?? client.slug} where id = ${clientId}`;
      console.log(`  client   reusing existing ${client.slug}`);
    } else {
      await tx`insert into clients ${tx({ id: clientId, slug: client.slug, name: client.name ?? client.slug })}`;
      console.log(`  client   created ${client.slug}`);
    }

    const [existingSite] = await tx`
      select id from sites where client_id = ${clientId} and slug = ${site.slug}
    `;
    const siteId = existingSite?.id ?? site.id;
    const siteFields = {
      name: site.name, location: site.location, district: site.district,
      state: site.state, area_label: site.area_label, industry: site.industry,
      status: site.status, summary: site.summary, is_published: site.is_published,
    };
    if (existingSite) {
      await tx`update sites set ${tx(siteFields)} where id = ${siteId}`;
      console.log(`  site     updating existing ${site.slug} (${siteId})`);
    } else {
      await tx`insert into sites ${tx({ id: siteId, client_id: clientId, slug: site.slug, ...siteFields })}`;
      console.log(`  site     created ${site.slug} (${siteId})`);
    }

    let surveyId = null;
    if (survey) {
      const label = survey.label ?? "Baseline flight";
      const [existingSurvey] = await tx`
        select id from surveys where site_id = ${siteId} and label = ${label}
      `;
      surveyId = existingSurvey?.id ?? survey.id;
      const fields = {
        label,
        flown_on: survey.flown_on ?? new Date().toISOString().slice(0, 10),
        notes: survey.notes ?? null,
      };
      if (existingSurvey) await tx`update surveys set ${tx(fields)} where id = ${surveyId}`;
      else await tx`insert into surveys ${tx({ id: surveyId, site_id: siteId, ...fields })}`;
    }

    const existingAssets = await tx`select id, storage_key from assets where site_id = ${siteId}`;
    const byKey = new Map(existingAssets.map((r) => [r.storage_key, r.id]));

    const keep = [];
    for (const a of assets) {
      const id = byKey.get(a.storage_key) ?? a.id;
      keep.push(id);
      const fields = {
        survey_id: surveyId, category: a.category, title: a.title,
        file_name: a.file_name, storage_key: a.storage_key, mime_type: a.mime_type,
        description: a.description ?? null, size_bytes: a.size_bytes ?? null,
        is_published: a.is_published !== false, sort_order: a.sort_order ?? 0,
      };
      if (byKey.has(a.storage_key)) await tx`update assets set ${tx(fields)} where id = ${id}`;
      else await tx`insert into assets ${tx({ id, site_id: siteId, ...fields })}`;
    }

    // Anything this site had before and no longer produces is hidden, not deleted.
    // A client may hold a link to it, and "no longer available" is a better answer
    // than a 404; and removing a row someone was granted access to is not this
    // script's decision to make.
    const retired = await tx`
      update assets set is_published = false
      where site_id = ${siteId} and is_published and id not in ${tx(keep)}
      returning id
    `;
    if (retired.length) {
      console.log(`  assets   unpublished ${retired.length} no longer produced by this site`);
    }
    site.id = siteId;
  });

  const [{ n: assetCount }] = await sql`select count(*)::int n from assets where site_id = ${site.id} and is_published`;
  const [{ n: siteCount }] = await sql`select count(*)::int n from sites`;
  console.log(`\npublished. ${assetCount} live asset(s) on this site, ${siteCount} site(s) in total.\n`);
} catch (err) {
  console.error(`\ndatabase write failed, nothing was committed:`);
  console.error(`  ${err.message}`);
  process.exit(1);
} finally {
  await sql.end();
}
