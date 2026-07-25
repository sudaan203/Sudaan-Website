# Client Data Portal, Implementation Plan

> Status: approved concept, not yet built. Written 25 Jul 2026.
> Read `context.md` first for the marketing site it plugs into.

## 1. Goal

Give every Sudaan Geo-Analytics client a private, password protected dashboard on
sudaangeo.in where they can browse and download the deliverables we produced for
their own sites: orthomosaic maps, DSM/DTM, contours, point clouds, drone video,
reports, engineering drawings, DGPS/UAV raw data and site photos.

Reference implementation we are modelling: the EnerComp "Monuments" dashboard
built for the Directorate of Archaeology and Museums, Pune Division (see the
walkthrough video `05. Dashboard_Overview_video.mp4`, kept locally, gitignored).
Its structure is a monument list, then per monument tabs for OrthoMaps,
Comparison, PointClouds, Video, Report Writing, UAV & DGPS Data, LiDAR Data,
Engineering Drawings, 3D Modelling, Coffeetable Data, Conservation Work,
Control Area and Walkthrough.

### Non goals for v1

- No client self signup. We create every login by hand.
- No billing, invoicing or ticketing.
- No editing of geodata in the browser.
- No public sharing links.
- **No downloads.** Decided 25 Jul 2026: clients view deliverables in the browser
  and there is no download link anywhere in the portal. See section 2b.

## 2. Access model (decided)

- A **client** is an organisation (Reliance, Adani, a government department).
- A **user** belongs to exactly one client and logs in with email plus password.
  Multiple users per client are allowed, so a client team does not share one
  password. This is the one change from the original idea of a single login per
  client, and it costs nothing to support.
- A **site** (survey project) belongs to exactly one client. A user only ever
  sees sites where `site.client_id` equals their own `client_id`.
- Sudaan staff get `role = 'admin'`, which sees every client and reaches the
  admin screens. Admin accounts are not tied to a client.
- Passwords: we generate a strong initial password, hand it over, and force a
  change on first login. Reset is admin driven for v1 (we set a new one), email
  based reset arrives with Phase 4.

## 2b. What v1 actually ships (built 25 Jul 2026)

Two owner decisions shaped the first build:

1. **View only, no downloads.** Assets are streamed with
   `Content-Disposition: inline`, the portal renders no download button, and PDFs
   open with the browser toolbar suppressed where the browser honours it. Be
   straight with clients about what this is: a deterrent and a clear policy
   signal, not DRM. Anyone who can view a file can screenshot it, and a technical
   user can pull the bytes out of the network tab. If a deliverable genuinely must
   not leave our control, do not publish it to the portal at all.
2. **Stay on the Vercel Hobby plan for the pilot**, with small sample data, and
   revisit paid plans once the portal has proved itself. That rules out paid
   services for now, so v1 uses **no database and no object storage**:

| Concern | v1 as built | Swap to when scaling up |
| --- | --- | --- |
| Catalogue (clients, sites, assets) | Typed seed in `src/lib/portal/seed.ts`, read through the async, tenant scoped API in `store.ts` | Drizzle plus Supabase Postgres, same `store.ts` signatures, schema in section 5 |
| Logins | `PORTAL_USERS` env var on Vercel, or gitignored `portal-data/users.json` locally, created by `scripts/portal-user.mjs` | `users` table plus an admin screen |
| Files | `portal-data/files/**`, outside `public/`, read by an authorised route handler and bundled into the function via `outputFileTracingIncludes` | Supabase Storage or R2 with short lived signed URLs, only `files.ts` changes |
| Access log | `console.log`, readable in Vercel logs | `access_log` table, only `log.ts` changes |
| Login throttling | In memory per instance, 5 failures per 15 minutes | Shared counter in Postgres or Redis |

Everything the client facing UI touches goes through `store.ts`, `files.ts` and
`log.ts`, so the Postgres migration is a change behind those three modules rather
than a rewrite. Keep it that way: pages must never read `seed.ts` directly.

**Consequences of the no database choice**, all deliberate:

- Publishing new client data means editing `seed.ts`, adding files under
  `portal-data/files/`, and deploying. There is no admin upload screen yet.
- A client cannot change their own password. We generate a new one with the
  script and hand it over.
- Suitable for tens of sites and small documents. Do not put a 351 MB GeoTIFF in
  `portal-data/files`, the repo and the function bundle are the wrong home for it.
  That is what Phase 2 and R2 are for.

## 3. Where it lives

Same Next.js app, same repo, same Vercel project. The portal is a route group
under `/portal`, so we keep one deploy, one domain and the existing warm light
theme, fonts and components.

- `sudaangeo.in/portal/login` and `sudaangeo.in/portal/...` for the portal.
- The marketing pages stay public and unchanged.
- The portal gets its own shell (sidebar plus slim top bar), so it does **not**
  render the marketing `Navbar`, `Footer`, `ScrollProgress` or `BackgroundDecor`.
- A "Client Login" link goes in the marketing navbar and footer.
- If we later want `portal.sudaangeo.in`, it is a Vercel domain alias plus a
  rewrite. Not needed for v1 and not worth the extra cookie scoping work now.

## 4. Stack additions

| Concern | Choice | Why |
| --- | --- | --- |
| Database | Supabase Postgres | Free tier is enough for tens of clients, bundles private file storage, real Postgres so no lock in |
| Query layer | Drizzle ORM plus `postgres` driver | Light, fast cold starts on Vercel serverless, SQL first, easy to reason about tenant filters |
| Auth | Auth.js v5 (`next-auth@5`), Credentials provider, JWT session | Works with admin created users, integrates with Next middleware, no extra hosted service |
| Password hashing | `bcryptjs` | Pure JS, no native build problems on Vercel |
| Document and photo storage | Supabase Storage, private bucket, signed URLs | Same project as the DB, per object signing, simple |
| Map tile and point cloud storage | Cloudflare R2 | Zero egress fees, which matters because tile pyramids are thousands of requests |
| Map viewer | MapLibre GL JS | Open source, no API key, handles raster XYZ tiles and vector overlays |
| Point cloud viewer | Potree (static build) in an iframe | What the reference uses, proven at this data size |
| Video | Unlisted YouTube embeds | Free bandwidth and transcoding, same as the reference |
| Validation | Zod | Form and API input validation |

Everything above has a free or near free tier at our volume. See section 11 for cost.

## 5. Data model

```sql
-- Organisations we deliver to.
create table clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null unique,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Logins. role 'admin' = Sudaan staff (client_id null), 'client' = customer user.
create table users (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid references clients(id) on delete cascade,
  email              text not null unique,
  password_hash      text not null,
  full_name          text not null,
  role               text not null default 'client' check (role in ('admin','client')),
  must_change_password boolean not null default true,
  is_active          boolean not null default true,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  constraint client_users_have_a_client
    check ((role = 'admin' and client_id is null) or (role = 'client' and client_id is not null))
);

-- A surveyed project. Equivalent of a "Monument" in the reference portal.
create table sites (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  slug          text not null,
  name          text not null,
  location      text,
  district      text,
  state         text,
  area_label    text,                     -- e.g. "412 ha", free text like data/projects.ts
  industry      text,                     -- reuse the Industry union from data/projects.ts
  status        text not null default 'delivered'
                check (status in ('in_progress','delivered','archived')),
  summary       text,
  thumbnail_key text,                     -- storage key, not a /public path
  created_at    timestamptz not null default now(),
  unique (client_id, slug)
);

-- One flight or acquisition campaign. Enables the date selector and Comparison tab.
create table surveys (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  label       text not null,              -- "May 2024 flight"
  flown_on    date not null,
  notes       text,
  created_at  timestamptz not null default now()
);

-- Downloadable or viewable files (PDF, DWG, zip, tif, jpg).
create table assets (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  survey_id   uuid references surveys(id) on delete set null,
  category    text not null check (category in (
                'report','uav_dgps','lidar','drawing','photo',
                'conservation','control_area','three_d_model','misc')),
  file_name   text not null,
  storage_key text not null,              -- Supabase Storage object key
  mime_type   text,
  size_bytes  bigint,
  is_viewable boolean not null default false,  -- show a VIEW button (pdf, jpg) as well as DOWNLOAD
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

-- Raster layers for the map tab, one row per toggleable layer.
create table map_layers (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references sites(id) on delete cascade,
  survey_id    uuid references surveys(id) on delete cascade,
  kind         text not null check (kind in (
                 'ortho','dsm','dtm','contours','gcp','drainage','boundary','other')),
  title        text not null,
  tile_prefix  text not null,             -- R2 prefix, tiles at {z}/{x}/{y}.png under it
  min_zoom     int not null default 12,
  max_zoom     int not null default 22,
  bounds       jsonb not null,            -- [west, south, east, north] in EPSG:4326
  default_on   boolean not null default false,
  default_opacity real not null default 1,
  sort_order   int not null default 0
);

-- Potree octree or COPC file per site or survey.
create table point_clouds (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references sites(id) on delete cascade,
  survey_id    uuid references surveys(id) on delete cascade,
  title        text not null,
  potree_prefix text not null,            -- R2 prefix holding metadata.json plus octree data
  point_count  bigint
);

create table videos (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references sites(id) on delete cascade,
  title      text not null,
  youtube_id text not null,
  kind       text not null default 'other'
             check (kind in ('front_view','360_view','walkthrough','other')),
  sort_order int not null default 0
);

-- Who looked at or downloaded what. Clients ask for this, and it helps us debug.
create table access_log (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete set null,
  client_id  uuid references clients(id) on delete set null,
  action     text not null,               -- 'login','login_failed','view_site','download_asset','view_asset'
  target     text,                        -- asset id, site slug, or email for failed logins
  ip         inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index on sites (client_id);
create index on assets (site_id, category);
create index on map_layers (site_id, survey_id);
create index on access_log (created_at desc);
```

Notes:

- `sites` deliberately mirrors the shape of `src/data/projects.ts` so a public
  case study and a private portal site can describe the same job without a
  second vocabulary.
- Every child table reaches the tenant through `site_id`, so one join proves
  ownership. There is no path where a file is reachable without a site.
- We are **not** using Supabase Row Level Security in v1, because all access goes
  through our own server code with the service key and we enforce tenancy in the
  query layer. RLS is a good Phase 4 hardening step, not a v1 blocker.

## 6. Routes

```
src/middleware.ts                     protects /portal/* except /portal/login

src/app/portal/
  layout.tsx                          portal shell (no marketing chrome)
  login/page.tsx                      email plus password form
  change-password/page.tsx            forced on must_change_password
  page.tsx                            dashboard: cards for this client's sites, filters
  [siteSlug]/
    layout.tsx                        left sidebar tabs plus survey date selector
    page.tsx                          site overview: metadata, thumbnail, what is available
    maps/page.tsx                     MapLibre viewer plus layer panel plus measure plus export
    compare/page.tsx                  CompareSlider between two surveys or two layers
    point-cloud/page.tsx              Potree iframe
    videos/page.tsx                   YouTube embeds
    reports/page.tsx                  category = report
    drawings/page.tsx                 category = drawing
    uav-dgps/page.tsx                 category = uav_dgps
    lidar/page.tsx                    category = lidar
    photos/page.tsx                   category = photo, gallery grid
    data/page.tsx                     everything else, one table
  admin/
    page.tsx                          admin home, recent activity from access_log
    clients/…                         create and edit clients
    users/…                           create user, set password, deactivate
    sites/…                           create site, surveys, register layers and videos
    uploads/…                         upload assets to a site, set category

src/app/api/portal/
  assets/[assetId]/route.ts           GET: authorise, log, 302 to a 60 second signed URL
  tiles/[...path]/route.ts            GET: authorised tile proxy (Phase 2, see 8.2)
  admin/…                             POST handlers for the admin screens
```

Component reuse from the existing site: `Reveal`, `SectionHeading`, `CompareSlider`,
`Logo`, `ServiceIcon`, and the `.surface`, `.btn-primary`, `.btn-secondary`,
`.heading-*` classes in `globals.css`. The portal should look like the same brand,
warm light theme, orange `accent-600` for actions. Do not import the reference
portal's teal and green palette.

## 7. Security rules (non negotiable)

1. **Nothing client owned goes in `/public`.** Anything under `/public` is served
   to anyone who guesses the URL, with no login. Client deliverables live only in
   Supabase Storage or R2.
2. **Every query is tenant filtered in SQL**, not in the UI. Fetch a site with
   `where sites.slug = $slug and sites.client_id = $sessionClientId`, never by
   slug alone. A missing match returns 404, not 403, so we do not leak that a
   site exists.
3. **Signed URLs are short lived** (60 seconds) and generated per request, after
   the ownership check. Never store a signed URL in the database or in HTML that
   gets cached.
4. **Middleware denies by default.** `/portal/:path*` requires a session except
   `/portal/login`. Admin paths additionally require `role = 'admin'`.
5. **Login is rate limited** (for example 5 failures per email per 15 minutes)
   and failures are logged to `access_log` with a generic "invalid email or
   password" response.
6. Session cookie is `httpOnly`, `secure`, `sameSite=lax`. Session lifetime 8
   hours with rolling refresh.
7. `SUPABASE_SERVICE_ROLE_KEY` and the R2 secret are server only. They must never
   appear in a `NEXT_PUBLIC_*` variable or in a client component.
8. Downloads and asset views are written to `access_log` before the redirect.

## 8. The two hard parts

### 8.1 Serving big rasters

`Kotba_Orthomosaic.tif` is 351 MB. A browser cannot open that, so we pre cut each
raster into an XYZ tile pyramid and serve tiles. There is **no GDAL on this
machine** (see `context.md` section 6), so tiling is a step in the production
pipeline on the workstation that has QGIS, not something the web app does.

Runbook per layer:

1. In QGIS, Processing Toolbox, "Generate XYZ Tiles (Directory)", zoom 12 to 22,
   PNG, output to `tiles/<site-slug>/<survey>/<kind>/`.
2. For DSM and DTM, first colourise (the existing `scripts/process-dem.mjs`
   already does colour plus hillshade for the web previews, reuse its ramp so the
   portal and the marketing site match).
3. Contours, GCP and drainage are vectors, export to GeoJSON, keep under a few MB,
   or tile them with tippecanoe later if they get heavy.
4. Upload with `rclone copy tiles/ r2:sudaan-portal/tiles/ --transfers 32`.
5. Register the layer in the admin screen: prefix, zoom range, bounds, opacity.

Expect roughly 0.5 to 2 GB of tiles per site at zoom 22. Keep the source
GeoTIFFs out of git, as they already are.

### 8.2 Authorising tiles

One map pan fires hundreds of tile requests, so per object signed URLs do not
work here, and proxying every tile through a Next route adds latency and Vercel
invocations. Decision, in two steps:

- **Phase 2 (ship this):** tiles live under an unguessable prefix, for example
  `tiles/9f3c1a7e-4b2d-4e0a-9c11-72d5b8a6e310/...`, in a bucket with no listing
  enabled, fronted by Cloudflare cache. The prefix only reaches a browser after a
  successful ownership check, so it is not linkable from outside, but it is
  bearer style protection: whoever holds the URL can fetch the tile until we
  rotate the prefix. Acceptable for imagery, and it is what most survey portals
  actually do. Document it to the client rather than overstate the protection.
- **Phase 4 (harden):** put a Cloudflare Worker in front of R2 that checks a
  short lived HMAC signed cookie which we set when the user opens the map tab.
  Then tiles are properly authorised without per tile signing.

Reports, drawings, raw data and photos never use the obscure prefix route. They
always go through `/api/portal/assets/[assetId]` with a real ownership check.

## 9. Phases

Each phase is independently shippable and useful.

### Phase 1: auth plus document portal, SHIPPED 25 Jul 2026

Built without a database, per section 2b: session cookie auth (`jose` signed JWT
plus `bcryptjs`), deny by default middleware over `/portal` and `/api/portal`,
login throttling, portal shell, dashboard site cards, site overview with
acquisitions, category tabs (Reports, Drawings and Maps, Imagery, UAV & DGPS,
LiDAR, Control Area, Other Data) driven by what each site actually has, in browser
PDF and image viewing through an authorised route, video tab ready for when
YouTube ids exist, access logging to stdout, `scripts/portal-user.mjs` for logins.

Not in Phase 1, deferred with the database: admin CRUD screens, self service
password change, uploads through the browser.

Verified: two seeded clients, each sees only its own site, cross client site slugs
and asset ids both return 404, unauthenticated requests are redirected or get 401,
and the marketing site renders unchanged.

### Phase 2: the map tab

Tile pipeline runbook proven on Kotba, R2 bucket and rclone upload, `map_layers`
admin registration, MapLibre viewer, layer tree with checkboxes and opacity
sliders, base layer switch (OSM and satellite), cursor coordinate readout,
measure distance and area, print or export to PDF at A4 with a chosen DPI.

Done when: a client can toggle ortho, DSM, DTM, contours and GCP over a base map
for Kotba, measure a distance, and export a PDF.

### Phase 3: point clouds, comparison, video

PotreeConverter output to R2, Potree viewer page with measurement and clipping,
Comparison tab reusing `CompareSlider` for two surveys or two layers, video tab
with unlisted YouTube embeds, 3D model tab if we have web ready meshes.

Done when: the Kotba cloud loads, spins smoothly, and a distance measured in
Potree matches the map tab to within tolerance.

### Phase 1b: Google sign in and owner managed access, NEXT UP

Requested 25 Jul 2026, specified in section 12b. Brings the database forward from
Phase 4 because owner controlled permissions need writes. Blocked until the owners
create a Google OAuth client and a Supabase project (section 12b checklist).

### Phase 4: hardening and polish

Cloudflare Worker tile auth, Postgres RLS as defence in depth, email password
reset and invite (depends on the Resend setup that is already pending in
`context.md` section 9), 2FA for admins, per client branding on the login page,
Excel or CSV export of an asset inventory, bulk zip download, notification email
when new data is published to a client.

## 10. Environment variables

### Needed now (v1)

```
PORTAL_AUTH_SECRET=   # required, session signing key: openssl rand -base64 32
PORTAL_USERS=         # required on Vercel, the JSON array printed by scripts/portal-user.mjs
                      # locally you can use portal-data/users.json instead (gitignored)
```

Without `PORTAL_AUTH_SECRET` the login endpoint returns "Sign in is temporarily
unavailable" and logs the reason, it does not fail open.

### Operations runbook (v1)

- **Add a login:** `node scripts/portal-user.mjs "Full Name" email@company.com <client-slug|admin>`
  then copy the printed password to the client over a channel they already trust,
  and paste the printed `PORTAL_USERS` line into Vercel before deploying.
- **Rotate a password:** run the same command again for that email, it replaces the
  entry and keeps the user id.
- **Revoke access:** delete the user's entry from `PORTAL_USERS` and redeploy.
  Their existing session cookie stays valid for up to 8 hours, so rotate
  `PORTAL_AUTH_SECRET` too if the revocation is urgent, which signs everyone out.
- **Publish new data:** add files under `portal-data/files/<client>/<site>/<category>/`,
  add the matching rows to `src/lib/portal/seed.ts`, commit and deploy.

### Needed later (Phase 2 onwards)

```
DATABASE_URL=                 # Supabase Postgres pooled connection string
AUTH_SECRET=                  # openssl rand -base64 32
AUTH_URL=https://sudaangeo.in
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=sudaan-portal-files
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=sudaan-portal
R2_PUBLIC_BASE=https://tiles.sudaangeo.in    # R2 custom domain for tiles
```

`.gitignore` already covers `.env` and `.env*.local`, so no change needed there.

## 11. Cost and plan changes

- **Vercel:** staying on **Hobby** for the pilot, by owner decision on 25 Jul 2026,
  with sample sized data only. Two things to know when this stops being a pilot:
  Vercel's Hobby plan is licensed for non commercial use, and Hobby bandwidth will
  not survive real tile serving. Budget **Pro, about 20 USD per month**, before the
  portal is handed to a paying client or Phase 2 tiles go live.
- **Supabase:** free tier covers 500 MB database and 1 GB storage, which is
  plenty for documents at first. Pro is 25 USD per month when we outgrow it.
- **Cloudflare R2:** 0.015 USD per GB per month of storage, **zero egress**. Twenty
  sites at 2 GB of tiles is roughly 0.60 USD per month. This is the reason tiles
  live in R2 rather than Supabase or Vercel.
- **YouTube, MapLibre, Potree:** free.

Realistic run rate for v1: about 20 to 25 USD per month, dominated by Vercel Pro.

## 12. Open questions for Sudaan

1. ~~Download or view only?~~ **Answered 25 Jul 2026: view only, no downloads.**
2. ~~Hobby or Pro?~~ **Answered 25 Jul 2026: Hobby for the pilot, sample data only.**
3. Do we **watermark** viewed PDFs and imagery with the client name and date? This
   is the natural next step for a view only policy, and it is the only measure here
   that survives a screenshot.
4. Is `sudaangeo.in/portal` fine long term, or do we move to `portal.sudaangeo.in`
   for a cleaner client facing story?
5. How long do we retain data for a finished project, and does an archived client
   keep read access?
6. Who inside Sudaan gets admin logins? One admin account exists in local
   development only, nothing is provisioned in production yet.

## 12b. Owner managed access with Google sign in (requested 25 Jul 2026)

New requirement from the owners: **clients sign in with Google**, and **Malhar and
Prakhar decide from their own logins which client sees which data**, without a
developer editing files and redeploying.

This is the right end state, and it changes one earlier decision: it **requires a
database**. Owners changing permissions at runtime means writes, and Vercel's
filesystem is read only, so the v1 seed file cannot express it. The good news is
that the database is free at our size (Supabase or Neon free tier), so this does
not conflict with staying off paid plans. Vercel Hobby's non commercial licensing
is still the thing to fix before a real client relies on this.

### Auth design

- **Google OAuth via Auth.js v5**, with a strict allowlist: signing in with Google
  proves who someone is, it does not grant access. The `signIn` callback looks the
  email up in `portal_users` and **rejects any address an owner has not invited**.
  Default deny, exactly as now.
- **Owners are bootstrapped from an env var** (`PORTAL_OWNER_EMAILS`, the two owner
  Google addresses) so the first sign in works on an empty database. After that
  owners are rows like anyone else.
- **Not every client can use Google.** Large clients often run Microsoft 365, and
  those addresses cannot complete a Google sign in. Plan for both: keep Google as
  the primary path and add **email magic links** (Auth.js Resend provider, which
  reuses the Resend setup already pending in `context.md`) as the fallback. Do not
  make Google the only door, or an Adani or Reliance user will be locked out.
- Password logins from v1 are then retired. Fewer secrets to manage and no reset
  flow to build.

### Permission model

Three levels, in increasing specificity. Owners work mostly at level 1.

1. **User belongs to a client.** By default a client user sees every published
   site of that client. This covers the common case.
2. **Per user site grants (optional).** When a client wants a contractor limited
   to one site, owners tick specific sites for that user. Empty grant list means
   "all sites of my client", which keeps level 1 simple.
3. **Publish flags.** Every site and every asset has `is_published`. Owners stage
   data privately and flip it visible when the deliverable is signed off. Nothing
   is visible to a client until it is published, so a half uploaded site cannot
   leak.

```sql
-- Replaces the users table in section 5. No password column: identity comes from
-- the OAuth provider or a magic link.
create table portal_users (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null unique,
  full_name   text,
  role        text not null default 'client'
              check (role in ('owner','client')),
  client_id   uuid references clients(id) on delete cascade,
  invited_by  uuid references portal_users(id),
  is_active   boolean not null default true,
  last_login_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint owners_have_no_client
    check ((role = 'owner' and client_id is null) or (role = 'client' and client_id is not null))
);

-- Level 2. No rows for a user means "every published site of their client".
create table user_site_grants (
  user_id uuid not null references portal_users(id) on delete cascade,
  site_id uuid not null references sites(id) on delete cascade,
  granted_by uuid references portal_users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, site_id)
);

-- Level 3, added to the section 5 tables.
alter table sites  add column is_published boolean not null default false;
alter table assets add column is_published boolean not null default true;

-- Auth.js needs its own tables (accounts, sessions, verification_token) when
-- using the Drizzle adapter. Take them from the Auth.js schema as is.

-- Every owner action on access is recorded, so "who gave them that" is answerable.
create table access_changes (
  id         bigserial primary key,
  actor_id   uuid references portal_users(id),
  action     text not null,   -- invite_user, deactivate_user, grant_site, revoke_site, publish_site, unpublish_asset
  subject    text not null,   -- email, site slug or asset id
  detail     jsonb,
  created_at timestamptz not null default now()
);
```

The single authorisation question every read must answer stays the same shape as
today's `store.ts`, just sourced from SQL:

```
visible_sites(user) =
  sites where client_id = user.client_id
    and is_published
    and (user has no grants  or  site in user's grants)
```

Owners bypass the client filter and see unpublished data, which is what makes the
staging workflow work.

### Owner console (`/portal/admin`, owners only)

- **Clients:** create, rename, deactivate.
- **People:** invite by email (choose client, optionally tick specific sites),
  deactivate, see last sign in. Inviting only writes a row, the person then signs
  in with Google or a magic link on their own.
- **Sites:** create a site for a client, publish or unpublish it.
- **Data:** upload files to a site, set category, publish or unpublish individual
  assets, reorder. Uploads need object storage, so this arrives with Supabase
  Storage (free tier, 1 GB, replaces the committed `portal-data/files` samples).
- **Activity:** recent sign ins and access changes from `access_log` and
  `access_changes`.

### What the owners have to provision first

Both are free and take about 15 minutes total. Nothing can be wired up until
these exist, because the credentials are the inputs.

1. **Google OAuth client:** Google Cloud Console, create a project, configure the
   OAuth consent screen (External, app name "Sudaan Geo-Analytics Client Portal",
   support email), then Credentials, Create OAuth client ID, Web application.
   Yields `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`. Created 25 Jul 2026 as
   client "Sudaan-Geo".

   Two things that bite here, both verified on 25 Jul 2026:

   - **The live site serves `www`, not the apex.** `https://sudaangeo.in` returns a
     308 to `https://www.sudaangeo.in/`, so the callback Google receives is on the
     `www` host. The authorised redirect URIs must therefore include
     `https://www.sudaangeo.in/api/auth/callback/google`, and `AUTH_URL` must be
     `https://www.sudaangeo.in`. Keeping the apex URI as well is harmless and
     covers a future switch of canonical host. Missing the `www` entry produces
     `redirect_uri_mismatch` on the first sign in. Keep
     `http://localhost:3000/api/auth/callback/google` for development.
   - **Publish the consent screen to "In production".** While it sits in Testing,
     only accounts listed as test users can sign in, so every new client contact
     would need adding by hand, which is exactly the manual work the owners want
     to stop doing. We request only `openid`, `email` and `profile`, which are non
     sensitive, so publishing needs no Google verification review. This is safe
     because Google only proves identity here: access is still gated by the
     invite allowlist in our own database.

   Preview deployments on `*.vercel.app` get random hostnames and so cannot
   complete Google sign in. Use localhost for development and the real domain for
   production, and do not expect the portal login to work on preview URLs.
2. **Postgres:** create a free Supabase project (also gives Storage for uploads),
   copy the pooled connection string as `DATABASE_URL`.

New environment variables: `DATABASE_URL`, `AUTH_SECRET`,
`AUTH_URL=https://www.sudaangeo.in` (the `www` host, see above),
`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `PORTAL_OWNER_EMAILS`, plus
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` when uploads land. The v1
`PORTAL_AUTH_SECRET` and `PORTAL_USERS` are then removed.

Unrelated nit spotted while checking the domain: `siteConfig.url` is the apex
`https://sudaangeo.in`, which 308s to `www`. Canonical tags, the sitemap and OG
URLs therefore all point at a redirect. Harmless but untidy for SEO, worth
switching to the `www` host (or making the apex canonical at Vercel) some time.

### Decision: Google only (25 Jul 2026)

The owners chose Google as the single sign in method for now, on the basis that
every client contact will have some Google identity. The magic link fallback stays
designed but unbuilt. Two consequences to keep in mind rather than rediscover:

- If a client's IT restricts third party Google OAuth, or the person only has a
  Microsoft work address, their way in is a personal Gmail. That works, but it
  means business deliverables reach a personal account, so invite the address the
  client actually asks for and keep the invite list tidy.
- Adding the magic link provider later is a small change (one Auth.js provider
  plus a verification token table). Nothing here paints us into a corner.

### Build order

1. Postgres schema plus Drizzle, and port `store.ts` to SQL behind its existing
   async interface. The UI should not change at all in this step, which is the
   proof that the interface was worth keeping.
   **Done ahead of provisioning (25 Jul 2026):** `drizzle/0001_init.sql`,
   `src/lib/portal/db/{schema,client,queries}.ts`,
   `scripts/portal-db-migrate.mjs`, and `scripts/portal-db-test.mts`, which proves
   the visibility rules on embedded Postgres (25 checks). The store port itself
   waits for a real `DATABASE_URL` so it can be verified end to end.
2. Auth.js with Google, the allowlist `signIn` callback, and owner bootstrap.
   Retire the password login and `scripts/portal-user.mjs`.
3. Owner console: clients, people, invites, grants, publish toggles.
4. Uploads to Supabase Storage, and move the sample files out of the repo.
5. Magic link fallback for clients who cannot use Google.

## 12c. Vercel deployment checklist

Do these in order. Setting the variables first means the deploy triggered by the
merge already has them, so there is only one deployment.

### 1. Finish the Google setup first

Sign in will fail without both of these:

- Add `https://www.sudaangeo.in/api/auth/callback/google` to the OAuth client's
  authorised redirect URIs. The live site serves `www`, the apex 308s to it.
- Publish the OAuth consent screen ("In production"). While it is in Testing,
  only listed test users can sign in.

### 2. Environment variables

Vercel dashboard, project `sudaan-website`, Settings, Environment Variables. Tick
**Production** for each. Preview is optional and Google sign in cannot work on
preview URLs anyway, because their hostnames are random.

| Key | Value |
| --- | --- |
| `DATABASE_URL` | **skip this if the Supabase integration for Vercel is installed**, it already provides `POSTGRES_URL` and the code reads either. Otherwise the Supabase **transaction pooler** string, port **6543**, password percent encoded |
| `PORTAL_AUTH_SECRET` | generate with `openssl rand -base64 32`, never reuse the local one |
| `AUTH_GOOGLE_ID` | the OAuth client id ending `.apps.googleusercontent.com` |
| `AUTH_GOOGLE_SECRET` | the `GOCSPX-...` secret |
| `AUTH_URL` | `https://www.sudaangeo.in` (the `www` host, not the apex) |
| `PORTAL_OWNER_EMAILS` | the owners' real Google addresses, comma separated |

Leave `PORTAL_USERS` unset. That is what makes production Google only: with no
password users configured the staff form does not render.

**If the Supabase integration for Vercel is installed** it creates `POSTGRES_URL`,
`POSTGRES_URL_NON_POOLING`, `SUPABASE_*` and `NEXT_PUBLIC_SUPABASE_*` for you.
The portal reads `DATABASE_URL` first and falls back to `POSTGRES_URL`, so there
is nothing to add for the database, and rotating the password in Supabase updates
the integration variable automatically. Check once that `POSTGRES_URL` points at
`...pooler.supabase.com` rather than `db.<ref>.supabase.co`: the direct host is
IPv6 only and unreachable from many networks. Prisma style flags in that URL
(`pgbouncer`, `connection_limit`) are stripped before connecting, because
postgres.js would otherwise forward them to the server as startup options.
The `SUPABASE_*` keys are unused today and will matter for Storage uploads later.

### 3. Merge and deploy

Merge the portal PR. Vercel deploys automatically and picks up the variables.

### 4. Check it

1. Open `https://www.sudaangeo.in/portal`. Expect the login page with
   "Continue with Google" and no staff password form.
2. Sign in with an owner address. Expect the dashboard plus an "Owner console"
   link in the header.
3. In the console, create a client, invite a colleague's Google address, and have
   them sign in. They should see that client's published sites and nothing else.
4. Try signing in with an uninvited Google account. Expect a clear refusal.

### If the portal hangs in production

Symptom: pages load slowly then time out, and it gets worse rather than better.
That is pooler starvation. Switch `DATABASE_URL` to the **session pooler** (port
`5432`, same host) and redeploy. Transaction mode suits short lived functions and
is the right default, but session mode is the safe fallback.

## 13. Reference material

- Walkthrough video of the portal we are modelling: `05. Dashboard_Overview_video.mp4`
  in the repo root, gitignored, 424 MB, 11 minutes. Frames can be pulled with
  `ffmpeg -i "05. Dashboard_Overview_video.mp4" -vf fps=1/5 out/f%03d.jpg`
  (ffmpeg was installed via Homebrew on 25 Jul 2026).
- Existing real data we can use to build Phase 1 and 2 against: `Kotba_Orthomosaic.tif`,
  `DSM/`, `DTM/`, `Contours/` in the repo root, all gitignored.
