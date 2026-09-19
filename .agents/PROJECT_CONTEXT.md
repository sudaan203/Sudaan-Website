# Sudaan — Project Context

This is the foundational context every agent in `.agents/` should read before
doing non-trivial work. It describes the repository as it actually exists,
verified by reading the code, not assumed from the stack's reputation.

This file is deliberately shorter than [`context.md`](../context.md) at the
repo root, which is the long-form human handoff doc and the deeper source of
truth when this file and reality disagree. Where the portal's GIS/dashboard
work is concerned, [`docs/tools.md`](../docs/tools.md) and
[`docs/tool-catalogue.md`](../docs/tool-catalogue.md) are more current than
either — they are generated from the same list the dashboard reads, so read
those before telling anyone a tool is or isn't built.

## Project Purpose

Sudaan Geo-Analytics is a geospatial data-processing and survey firm
(Gandhinagar, Gujarat). This repository holds **two products**:

1. **A public marketing site** — services, projects, data-insights, blog,
   contact. Sells processed deliverables and analytics, explicitly *not*
   drones, hardware, or training. Positioning matters; don't drift from it.
2. **A private client portal** (`/portal`, behind Google sign-in) — each
   client sees only their own sites and deliverables: a survey map, a
   hydrology/flood/alignment/engineering toolset computed from source
   GeoTIFFs, a dynamic raster tiler, a LiDAR point-cloud viewer, a forest
   inventory tool, and shapefile import/export. This half has its own
   geometry/raster engine under `src/lib/geo/` with real test suites.

## Technology Stack

Verified from `package.json`, `tsconfig.json`, `.eslintrc.json`, and the CI
workflow — nothing here is assumed:

- **Next.js 15** (App Router), **React 19**, **TypeScript 5** (`strict: true`)
- **Tailwind CSS 3** for styling, **Framer Motion 11** for animation
- **Drizzle ORM** over **Postgres** (`postgres` driver), hosted on **Supabase**
  (free tier — it idles out; a "whole portal broken" report is often just that)
- **MapLibre GL** for the map, a hand-rolled canvas renderer for the point
  cloud (no Three.js / deck.gl)
- **jose** for JWT signing (portal sessions and tile grants)
- Package manager: **npm**, lockfile-pinned (`npm ci` in CI)
- **Node 22 exactly** — newer Node breaks `next dev` (a `semver` interop
  failure) and this is pinned in CI and should be pinned locally too
- No test framework dependency (no Jest/Vitest/Playwright). Tests are plain
  Node scripts under `scripts/*-test.mjs` / `.mts`, each printing `ok`/`FAIL`
  per check and exiting non-zero on failure. See the `testing` skill.
- A small **Rust → WASM** module (`native/lzw/`) for LZW decoding, compiled to
  `native/lzw/lzw.wasm` and loaded by `src/lib/geo/lzw-wasm.mjs`.

## Architecture

**Frontend.** Next.js App Router, server components by default. Marketing
pages under `src/app/*`; portal pages under `src/app/portal/**`. Marketing
chrome (navbar/footer) is suppressed on portal routes by
`src/components/SiteChrome.tsx`.

**Backend / API.** Route handlers under `src/app/api/**`, thin — they call
into `src/lib/portal/*` and `src/lib/geo/*` rather than holding logic
themselves. No separate backend service; API routes *are* the backend,
running as Vercel serverless/edge functions.

**Database.** Postgres (Supabase), schema in `src/lib/portal/db/schema.ts`,
migrations as plain SQL in `drizzle/*.sql` applied by
`scripts/portal-db-migrate.mjs` (tracked in `portal_schema_migrations`, not
Drizzle Kit's own migrator). Tables: `clients`, `users`, `sites`, `surveys`,
`assets`, `videos`, `userSiteGrants`, `accessLog`, `accessChanges`,
`forestEdits`. Tenant isolation is enforced in SQL, in one place
(`db/queries.ts`), and a denied read answers 404 rather than 403 so an id is
never confirmed to exist.

**Authentication.** Google OAuth only (`src/lib/portal/google.ts`, hand-rolled
code flow, no Auth.js/NextAuth). Password login was removed 18 Sep 2026.
Sessions are signed JWTs in a cookie (`src/lib/portal/session.ts`), rechecked
against the `users` table on every request (`auth.ts` → `sessionStillValid`)
so deactivating a user takes effect immediately rather than at cookie expiry.
`PORTAL_OWNER_EMAILS` bootstraps the first owners against an empty database.

**Authorization.** Two roles: `owner` and `client`. `requireOwner()` 404s a
client rather than 403ing, so the existence of `/portal/admin` isn't
confirmed to someone without access. Visibility rule for a client: site
belongs to their client AND is published AND (no per-user grants exist OR
this site is one of their grants); assets must additionally be published.
Owners bypass this. `src/middleware.ts` is the first gate (deny-by-default
over `/portal` and `/api/portal`); page/route-level checks are the second, on
purpose (defence in depth, not redundancy to remove).

**GIS / geospatial stack.** This is the deepest and most distinctive part of
the codebase — see the `gis-development` skill for the full picture. In
short: source rasters (DTM/DSM GeoTIFF, UTM-projected) are read in windows
(byte-range, not whole-file) by `src/lib/portal/*-source.ts` modules, fed
through pure computational engines in `src/lib/geo/*.mjs` (hydrology, flood,
terrain analysis, engineering volumes, forest, shapefile, LAS point clouds),
and rendered either as pre-baked tile pyramids or by an on-demand tiler.
Elevation colour (ramp, clip percentiles, hillshade) is centralised in one
module, `src/lib/geo/elevation-image.mjs` — CI actively fails
(`colour-consistency-test.mjs`) if another file defines its own ramp.

**File / object storage.** Every large data class (terrain, map tiles,
hydrology, forest, point cloud) has a `PORTAL_<CLASS>_DIR` (local disk) /
`PORTAL_<CLASS>_URL` (production) pair — see `.env.example`, which documents
each one in detail including past incidents. Locally these read from
`portal-data/<class>/<slug>/` (gitignored, large). In production they're
served from a **private Cloudflare R2 bucket** through
`workers/tile-gateway/` — the *only* door to that bucket — using a short-lived,
site-scoped HMAC "tile grant" cookie minted by the portal and verified by the
Worker (`src/lib/portal/tile-grant-core.mjs`, imported by both sides so the
rules can't drift apart). No listing, no writes, no cross-site reads, no
public bucket URL.

**Deployment.** Next.js app on **Vercel** (auto-deploys on push to `main`).
The Cloudflare Worker deploys separately via `wrangler deploy` from
`workers/tile-gateway/` and is **not** part of the Vercel deploy — a change
to `tile-grant-core.mjs` or the worker source needs its own deploy step.

## Repository Structure

```
src/app/            Next.js routes. app/api/** = backend; app/portal/** = private UI
src/components/      Marketing components (top level) + src/components/portal/** (portal UI)
src/lib/geo/         Pure GIS/raster computation engines (.mjs, framework-free)
src/lib/portal/      Portal glue: auth, session, db, storage config, per-tool *-source.ts/*-client.ts
src/lib/portal/db/   Drizzle schema + queries.ts (the one place tenant visibility is decided)
src/data/            Static marketing content (services, projects, blog)
drizzle/             Numbered SQL migrations, applied by scripts/portal-db-migrate.mjs
scripts/             Everything: engine tests, API tests, browser tests, data pipelines, publishing
workers/tile-gateway/ Cloudflare Worker, the only door to the private R2 bucket
native/lzw/           Rust/WASM LZW decoder
surveys/              Raw survey folders (disposable once archived and published)
portal-data/          Local-only prepared site data (gitignored, large; empty on a fresh checkout)
docs/                 Architecture, plans, and status docs — read before touching portal/GIS code
reference/            Malhar's tool specs, screenshots, and other source material (not code)
```

## Data Flow

**Marketing site:** static/typed data in `src/data/*` → server components →
static or lightly dynamic pages. `api/contact/route.ts` validates, honeypots,
and emails via Resend if configured.

**Portal, publishing a survey:** raw survey folder → `scripts/prepare-site.mjs`
/ `terrain-run.mjs` / `hydro-run.mjs` / `forest-run.mjs` /
`prepare-point-cloud.mjs` produce prepared layers in `portal-data/<class>/` →
`scripts/publish-site.mjs <folder> <slug> --publish` uploads every data class
to R2, writes the catalogue, and prints the client's link — this is the one
command that replaced five manual steps plus a Vercel env edit.

**Portal, a client viewing a tool:** browser → Next.js route under
`api/portal/sites/[siteSlug]/**` → session check → tenant visibility check
(SQL) → tile grant issued if needed → `*-source.ts` reads the exact byte
window of the raster covering the requested polygon/tile (never the whole
file) → `src/lib/geo/*.mjs` computes → JSON/PNG/tile response. For tiles
themselves, once a grant cookie is set the browser talks to
`tiles.<domain>` (the Worker) directly, bypassing Next entirely.

## GIS Architecture

See the `gis-development` skill for the full detail. Highlights an agent must
not relearn the hard way:

- **CRS:** source rasters are UTM-projected GeoTIFFs; the map re-projects
  corners to WGS84 for MapLibre. Non-UTM projections, rotated world files,
  and ECW are deliberately unsupported and throw rather than guess.
- **Geometry formats:** GeoTIFF (DTM/DSM), ESRI Shapefile (`.shp`/`.dbf`/`.prj`,
  parsed by hand — no GDAL on this machine), GeoJSON (contours, exports), LAS
  point clouds (LAZ is *not* supported — it needs `laszip` first).
  Orthomosaic imagery has no path through the elevation pipeline; feeding one
  in is refused with a message, not silently misread.
- **Processing pipeline:** windowed raster reads → pure `.mjs` engines →
  either baked tiles (`make-tiles.mjs`, `make-terrain-tiles.mjs`) or the
  dynamic tiler (on-demand, no container — a tile is just a window).
- **Persistence:** derived products live in `portal-data/<class>/<slug>/`
  locally and `sites/<slug>/<class>/` in R2 (note: map pyramid data owns
  `sites/<slug>/manifest.json`, so hydrology/forest/cloud each need their own
  sub-segment or they silently overwrite the map's manifest — this has
  actually happened).
- **Visualization:** MapLibre GL, worker files manually copied to
  `public/vendor/` by `postinstall` (MapLibre's own worker-URL resolution
  doesn't survive Next's bundler). Elevation colour is one module,
  see above. Basemaps are off by default (a tile request to a third party
  reveals a client's site location — deliberate, not an oversight).
- **No PostGIS.** Spatial computation happens in the `.mjs` engines against
  raster/vector files, not in SQL. Postgres holds only tenancy/catalogue
  metadata.

## Development Commands

Verified against `package.json` and `.github/workflows/ci.yml`:

- `npm run dev` — start Next dev server (localhost:3000)
- `npm run build` — production build (this is what actually typechecks +
  lints in practice; see the `testing` skill for the local-machine caveats)
- `npm run start` — run a production build
- `npm run lint` — `next lint`
- `npx tsc --noEmit` — typecheck only, fast, run before build
- Engine test suites: `node scripts/<name>-test.mjs` (or `.mts` via `npx tsx`)
  — there is no single `npm test`; see the `testing` skill for the full list
  and which suites need a database/dev-server/real rasters vs. which run on
  the checkout alone.
- `node scripts/bench-geo.mjs --size=small` — benchmark harness smoke run (CI)
- `node scripts/publish-site.mjs <folder> <slug> --publish` — the one-command
  survey publish pipeline

Do not document a command here without having seen it run (in this repo's CI
file or scripts) — several commands in `context.md`'s history turned out to
be stale.

## Architectural Constraints

Things agents should **not** casually change:

- **Tenant visibility logic** lives in exactly one place,
  `src/lib/portal/db/queries.ts`. Don't duplicate a visibility check
  elsewhere "for convenience."
- **`PORTAL_TILE_SECRET` must never equal `PORTAL_AUTH_SECRET`** — the code
  refuses to run if they match, and this is intentional: one secret signs
  portal logins (stays on our infra), the other is deployed to Cloudflare's
  edge.
- **The transaction pooler, port 6543, everywhere** — local dev, production,
  and test scripts. Port 5432 (session pooler) previously caused a local/prod
  divergence that hid a production outage for days.
- **Elevation colour** has exactly one owner, `src/lib/geo/elevation-image.mjs`.
  A new file defining its own ramp/clip/hillshade is a regression, and
  `colour-consistency-test.mjs` in CI is designed to catch it.
- **The `sites/<slug>/manifest.json` namespace** belongs to the map pyramid.
  Anything uploading hydrology/forest/cloud data must land it a level below
  (`hydrology/`, `forest/`, `cloud/`), never at the site root.
- **View-only in the portal.** No download affordance for client deliverables
  — this was an explicit owner decision, not a missing feature.
- **`R2_BUCKET` / the Cloudflare Worker bucket stays private.** No public
  `r2.dev` URL, no public custom domain on the bucket itself — the Worker is
  the only door, by design.
- **`PORTAL_SURVEY_RMSE_Z` is a fallback constant, never a per-survey value.**
  A real survey's accuracy belongs in `sites.vertical_rmse_z_m`; wanting to
  change the fallback for one site is a sign that site needs a database row,
  not a different deployment.
- **No em dashes** in code or copy (the owner's explicit style preference,
  noted in `context.md`).
- **No GDAL / ImageMagick / poppler on this machine.** Shapefile, world-file,
  and contour parsing are hand-rolled for this exact reason — don't introduce
  a dependency on a tool that isn't here.

## Existing Patterns

- **Dual storage mode**, `PORTAL_<CLASS>_DIR` (local disk) vs.
  `PORTAL_<CLASS>_URL` (HTTP range reads, production) — repeated identically
  for terrain, map, hydrology, forest, and cloud. A new large data class
  should follow the same pair, implemented via `storage-config.ts`'s
  `checkStorageDir` helper, not a bespoke env var.
- **`*-source.ts` / `*-client.ts` split** in `src/lib/portal/`: `-source.ts`
  reads raw data (server-side, storage-mode-aware), `-client.ts` is what the
  browser/React side consumes. Don't blur that line.
- **Route handlers are thin.** Look at any file under `src/app/api/portal/**`
  — validation and delegation only, logic lives in `src/lib/portal/*` or
  `src/lib/geo/*`.
- **`.mjs` engines under `src/lib/geo/` are framework-free and pure** —
  no Next.js imports, no React, testable by running the file directly with
  Node. Keep new geo primitives that way.
- **`cache()` from React** is used to deduplicate per-request work (see
  `getSession()` in `auth.ts`) rather than a hand-rolled memo.
- **Numeric coercion goes through `src/lib/portal/numbers.ts`**, after a bug
  where a bare `Number()` on a value like `"338 m"` silently produced `NaN`.
- **Tests are self-contained Node scripts**, not a framework: each prints
  `ok`/`FAIL` per check, many skip gracefully when the real raster/database
  they'd compare against isn't present locally, and CI only runs the ones
  that need nothing but the checkout.
- **Docs that are read, not just written.** `docs/tools.md`,
  `docs/tool-catalogue.md`, and the heavily-annotated `.env.example` exist
  because past incidents (a broken hillshade, an overwritten manifest, a port
  mismatch that hid a production outage) were each expensive enough that the
  fix was writing down *why*, not just fixing the bug. Extend that pattern
  rather than replacing it with a fresh doc that repeats the story.

Existing project code is the primary source of truth for implementation
conventions unless the user explicitly requests a change.
