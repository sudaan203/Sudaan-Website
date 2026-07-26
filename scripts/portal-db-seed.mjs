#!/usr/bin/env node
/**
 * Seeds the demo catalogue into Postgres: the same two clients, two sites and ten
 * files that src/lib/portal/seed.ts holds, so the database backed portal shows
 * something real immediately.
 *
 * Idempotent: fixed ids and upserts, so running it twice changes nothing. Safe to
 * run against a fresh Supabase project after portal-db-migrate.mjs.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/portal-db-seed.mjs
 *   DATABASE_URL=postgres://... node scripts/portal-db-seed.mjs --only aektanagar-survey
 *   DATABASE_URL=postgres://... node scripts/portal-db-seed.mjs --only aektanagar-survey --dry-run
 *
 * --only <site-slug> restricts every write to one site, its survey and its
 * assets. It exists because "idempotent" is not the same as "harmless" once a
 * database is real: the upserts reset name, summary and is_published to the
 * values in this file, so a plain re-run to add one new site would quietly undo
 * anything the owners had changed on the others through the console.
 *
 * --dry-run prints what would be written and touches nothing.
 */

import postgres from "postgres";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : null;
if (onlyIndex >= 0 && !only) {
  console.error("--only needs a site slug, for example --only aektanagar-survey");
  process.exit(1);
}

// POSTGRES_URL is what the Supabase integration for Vercel creates.
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error("Neither DATABASE_URL nor POSTGRES_URL is set.");
  process.exit(1);
}

const CLIENT_DEMO = "11111111-1111-4111-8111-111111111111";
const CLIENT_SECOND = "22222222-2222-4222-8222-222222222222";
const SITE_KOTBA = "33333333-3333-4333-8333-333333333333";
const SITE_AEKTANAGAR = "33333333-3333-4333-8333-777777777777";
const SITE_AMBAJI = "44444444-4444-4444-8444-444444444444";
const SURVEY_KOTBA = "55555555-5555-4555-8555-555555555555";
const SURVEY_AEKTANAGAR = "55555555-5555-4555-8555-777777777777";
const SURVEY_AMBAJI = "66666666-6666-4666-8666-666666666666";
const asset = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const clients = [
  { id: CLIENT_DEMO, slug: "demo-client", name: "Demo Client" },
  { id: CLIENT_SECOND, slug: "second-client", name: "Second Client" },
];

const sites = [
  {
    id: SITE_KOTBA,
    client_id: CLIENT_DEMO,
    slug: "kotba-survey",
    name: "Kotba Site Survey",
    location: "Kotba, Gujarat",
    district: "Gandhinagar",
    state: "Gujarat",
    area_label: "42 ha",
    industry: "Infrastructure",
    status: "delivered",
    summary:
      "UAV survey of the Kotba site with GCP controlled processing. Deliverables include a 3 cm orthomosaic, DSM, DTM and 0.5 m contours.",
    is_published: true,
  },
  {
    id: SITE_AEKTANAGAR,
    client_id: CLIENT_DEMO,
    slug: "aektanagar-survey",
    name: "Aektanagar Site Survey",
    location: "Aektanagar, Gujarat",
    district: "Narmada",
    state: "Gujarat",
    area_label: "35 ha",
    industry: "Infrastructure",
    status: "delivered",
    summary:
      "High-precision UAV and LiDAR survey of the Aektanagar site with GCP controlled processing. Deliverables include a 1.8 cm orthomosaic, DSM, DTM, 0.5 m contours, 3D LiDAR point cloud, and elevation grid.",
    is_published: true,
  },
  {
    id: SITE_AMBAJI,
    client_id: CLIENT_SECOND,
    slug: "ambaji-corridor",
    name: "Ambaji Corridor Survey",
    location: "Ambaji, Gujarat",
    district: "Banaskantha",
    state: "Gujarat",
    area_label: "18 ha",
    industry: "Infrastructure",
    status: "delivered",
    summary:
      "Corridor mapping for alignment studies. Present so we can prove that one client cannot reach another client's data.",
    is_published: true,
  },
];

const surveys = [
  {
    id: SURVEY_KOTBA,
    site_id: SITE_KOTBA,
    label: "Baseline flight",
    flown_on: "2024-05-03",
    notes: "DJI survey, 12 GCPs, RTK corrected.",
  },
  {
    id: SURVEY_AEKTANAGAR,
    site_id: SITE_AEKTANAGAR,
    label: "Baseline flight",
    flown_on: "2024-07-20",
    notes: "UAV LiDAR and high-resolution RGB camera survey, 10 GCPs, RTK & PPK corrected.",
  },
  {
    id: SURVEY_AMBAJI,
    site_id: SITE_AMBAJI,
    label: "Baseline flight",
    flown_on: "2024-06-19",
    notes: null,
  },
];

const assets = [
  [1, SITE_KOTBA, SURVEY_KOTBA, "report", "Topographic Survey Report", "topographic-survey.pdf",
    "demo-client/kotba/reports/topographic-survey.pdf", "application/pdf",
    "Methodology, control network, accuracy statement and outputs.", 1],
  [2, SITE_KOTBA, SURVEY_KOTBA, "report", "Volume Analysis Report", "volume-analysis.pdf",
    "demo-client/kotba/reports/volume-analysis.pdf", "application/pdf",
    "Cut and fill computation against the delivered DTM.", 2],
  [3, SITE_KOTBA, SURVEY_KOTBA, "drawing", "Contour Map, 0.5 m interval", "contour-map.pdf",
    "demo-client/kotba/drawings/contour-map.pdf", "application/pdf", null, 1],
  [4, SITE_KOTBA, SURVEY_KOTBA, "drawing", "Orthomosaic Sheet, A1", "orthomosaic-sheet.pdf",
    "demo-client/kotba/drawings/orthomosaic-sheet.pdf", "application/pdf", null, 2],
  [5, SITE_KOTBA, SURVEY_KOTBA, "photo", "Orthomosaic preview", "ortho.webp",
    "demo-client/kotba/imagery/ortho.webp", "image/webp", "True colour orthomosaic, 3 cm GSD.", 1],
  [6, SITE_KOTBA, SURVEY_KOTBA, "photo", "DSM preview", "dsm.webp",
    "demo-client/kotba/imagery/dsm.webp", "image/webp",
    "Digital surface model, colourised with hillshade.", 2],
  [7, SITE_KOTBA, SURVEY_KOTBA, "photo", "DTM preview", "dtm.webp",
    "demo-client/kotba/imagery/dtm.webp", "image/webp", "Bare earth terrain model.", 3],
  [8, SITE_KOTBA, SURVEY_KOTBA, "photo", "Contours over orthomosaic", "contours.webp",
    "demo-client/kotba/imagery/contours.webp", "image/webp", null, 4],
  [11, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "report", "Topographic Survey Report", "topographic-survey-report.pdf",
    "demo-client/aektanagar/reports/topographic-survey-report.pdf", "application/pdf",
    "Methodology, control network, accuracy statement and LiDAR deliverables summary.", 1],
  [12, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "drawing", "Contour Map, 0.5 m interval", "contour-map.pdf",
    "demo-client/aektanagar/drawings/contour-map.pdf", "application/pdf", null, 1],
  [13, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "drawing", "Survey Elevation Grid (5m x 5m)", "Grid.csv",
    "demo-client/aektanagar/drawings/Grid.csv", "text/csv", "5m grid elevation point dataset exported in UTM 43N / WGS84.", 2],
  [14, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "photo", "Orthomosaic preview", "ortho.webp",
    "demo-client/aektanagar/imagery/ortho.webp", "image/webp", "True colour high-resolution orthomosaic (1.8 cm GSD).", 1],
  [15, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "photo", "DSM preview", "dsm.webp",
    "demo-client/aektanagar/imagery/dsm.webp", "image/webp", "Digital surface model, colourised with elevation gradient.", 2],
  [16, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "photo", "DTM preview", "dtm.webp",
    "demo-client/aektanagar/imagery/dtm.webp", "image/webp", "Bare earth digital terrain model.", 3],
  [17, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "photo", "Contours over orthomosaic", "contours.webp",
    "demo-client/aektanagar/imagery/contours.webp", "image/webp", null, 4],
  [18, SITE_AEKTANAGAR, SURVEY_AEKTANAGAR, "lidar", "LiDAR Point Cloud (LAS)", "Aektanagar Lidar Point Cloud.las",
    "demo-client/aektanagar/uav/Aektanagar Lidar Point Cloud.las", "application/octet-stream", "3D Classified LiDAR point cloud file (1.7 GB).", 1],
  [9, SITE_AMBAJI, SURVEY_AMBAJI, "report", "Topographic Survey Report", "topographic-survey.pdf",
    "second-client/ambaji/reports/topographic-survey.pdf", "application/pdf", null, 1],
  [10, SITE_AMBAJI, SURVEY_AMBAJI, "photo", "Orthomosaic preview", "ortho.webp",
    "second-client/ambaji/imagery/ortho.webp", "image/webp", null, 1],
];

/* ----------------------------------------------------- narrow to one site --- */

let targetSites = sites;
let targetClients = clients;
let targetSurveys = surveys;
let targetAssets = assets;

if (only) {
  targetSites = sites.filter((s) => s.slug === only);
  if (targetSites.length === 0) {
    console.error(
      `no site with slug "${only}" in this file. Known: ${sites.map((s) => s.slug).join(", ")}`,
    );
    process.exit(1);
  }
  const siteIds = new Set(targetSites.map((s) => s.id));
  targetClients = clients.filter((c) => targetSites.some((s) => s.client_id === c.id));
  targetSurveys = surveys.filter((s) => siteIds.has(s.site_id));
  targetAssets = assets.filter((a) => siteIds.has(a[1]));
}

console.log(
  only
    ? `seeding only "${only}": ${targetClients.length} client, ${targetSites.length} site, ` +
        `${targetSurveys.length} survey, ${targetAssets.length} assets`
    : `seeding everything: ${targetClients.length} clients, ${targetSites.length} sites, ` +
        `${targetSurveys.length} surveys, ${targetAssets.length} assets`,
);

if (dryRun) {
  for (const c of targetClients) console.log(`  client  ${c.slug}  ${c.name}`);
  for (const s of targetSites) console.log(`  site    ${s.slug}  ${s.name}  published=${s.is_published}`);
  for (const s of targetSurveys) console.log(`  survey  ${s.label}  flown ${s.flown_on}`);
  for (const a of targetAssets) console.log(`  asset   ${String(a[3]).padEnd(13)} ${a[4]}`);
  console.log("\ndry run, nothing written");
  process.exit(0);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  for (const c of targetClients) {
    await sql`
      insert into clients ${sql(c)}
      on conflict (id) do update set slug = excluded.slug, name = excluded.name
    `;
  }

  for (const s of targetSites) {
    await sql`
      insert into sites ${sql(s)}
      on conflict (id) do update set
        name = excluded.name, location = excluded.location, district = excluded.district,
        state = excluded.state, area_label = excluded.area_label, industry = excluded.industry,
        status = excluded.status, summary = excluded.summary, is_published = excluded.is_published
    `;
  }

  for (const s of targetSurveys) {
    await sql`
      insert into surveys ${sql(s)}
      on conflict (id) do update set
        label = excluded.label, flown_on = excluded.flown_on, notes = excluded.notes
    `;
  }

  for (const [n, siteId, surveyId, category, title, fileName, storageKey, mime, description, order] of targetAssets) {
    const row = {
      id: asset(n),
      site_id: siteId,
      survey_id: surveyId,
      category,
      title,
      file_name: fileName,
      storage_key: storageKey,
      mime_type: mime,
      description,
      is_published: true,
      sort_order: order,
    };
    await sql`
      insert into assets ${sql(row)}
      on conflict (id) do update set
        title = excluded.title, file_name = excluded.file_name,
        storage_key = excluded.storage_key, mime_type = excluded.mime_type,
        description = excluded.description, is_published = excluded.is_published,
        sort_order = excluded.sort_order
    `;
  }

  const [{ count: siteCount }] = await sql`select count(*)::int as count from sites`;
  const [{ count: assetCount }] = await sql`select count(*)::int as count from assets`;
  console.log(`Seeded. Now ${siteCount} site(s) and ${assetCount} asset(s).`);
  console.log(`  Demo Client   id ${CLIENT_DEMO}`);
  console.log(`  Second Client id ${CLIENT_SECOND}`);
  console.log("\nPoint a portal login at one of those client ids to see the data.");
} catch (err) {
  console.error("Seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
