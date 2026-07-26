# Sudaan Geo-Analytics — Project Context

> Handoff doc for a fresh AI session. Read this first. It explains what the site
> is, how the code is organised, the conventions to follow, how it ships, and
> what's still pending.

## 1. What this is
A premium marketing website for **Sudaan Geo-Analytics**, a geospatial **data &
analytics** firm (Gandhinagar, Gujarat, India). It sells **processed
deliverables, analytics and intelligence** (orthomosaics, DSM/DTM, contours,
LiDAR, GIS) — **NOT** drones / hardware / training. Keep that positioning.

- **Live site:** https://sudaangeo.in (also www). Hosted on **Vercel**.
- **Repo:** https://github.com/sudaan203/Sudaan-Website (owner `sudaan203`).
- **Local folder:** /Users/ompatel/Documents/Sudan-Geo-Infomatics
  (folder name still says "Sudan-Geo-Infomatics" — that's fine, the brand is Sudaan Geo-Analytics).
- **GitHub auth on this machine:** `gh` is logged in as **patel-om**, a *Write
  collaborator* on the repo (cannot change repo settings / enable Pages; can push, PR, merge).

## 2. Tech stack
- **Next.js 15** (App Router) · **TypeScript** · **Tailwind CSS v3** · **Framer Motion 11**
- Node 20. Package manager: npm. `sharp` is available (used by scripts).
- Deploy: **Vercel** (project `sudaan-website`, Hobby plan), auto-deploys on every push to `main`.
- Domain: `sudaangeo.in` bought on **Hostinger**; DNS at Hostinger points to Vercel
  (A `@` → Vercel IP, CNAME `www` → Vercel). HTTPS auto by Vercel.

## 3. Visual theme (warm, light)
Defined in `tailwind.config.ts` + `src/app/globals.css`. **It's a light theme.**
- Backgrounds: `paper` #FAF7F2 (primary), `mist` #E8E8E8 (alt bands), `panel` #FFFFFF (cards).
- Text: `ink` #2E2E2E (body, use `text-ink`, `text-ink/70` etc.), `ink-900` #111111 (headings).
- Brand orange: `accent` ramp — DEFAULT `#E58E3A` (500), **`accent-600` #D97706 = CTA/buttons/links**, `accent-700` hover.
- Secondary warm tone: `signal` (#C2410C burnt orange) — used for checkmarks, "Outcome:" labels, gradient end.
- **Legacy tokens `abyss`/`navy` are remapped to light values** (paper/white) — don't assume they're dark.
- Reusable classes (globals.css): `.surface`, `.surface-hover`, `.btn-primary`, `.btn-secondary`, `.heading-xl/lg/md`, `.lead`, `.eyebrow`, `.container-px`, `.section-py`, `.grid-overlay`.
- The hero headline gradient (`from-accent-500 via-accent-600 to-signal bg-clip-text text-transparent`) is the signature "Actionable Intelligence" look — reused for the home "Trusted By" client names.

## 4. Site structure (`src/`)
```
app/
  layout.tsx          Root: fonts, metadata, JSON-LD (Organization), BackgroundDecor,
                      ScrollProgress, Navbar, BackToTop, Footer.
  page.tsx            HOME: Hero, Stats, "Trusted By" client strip, Ortho→DSM teaser
                      slider, Services preview, Workflow, Sectors, CTA.
  globals.css         Tailwind layers + design tokens + reduced-motion.
  sitemap.ts robots.ts manifest.ts opengraph-image.tsx icon.svg   (SEO; use siteConfig.url)
  not-found.tsx
  services/page.tsx       10 core ServiceCards + categorised catalogue (4 categories).
  data-insights/page.tsx  ⭐ flagship. Comparison sliders (REAL data), NDVI, application
                          examples, point cloud viewer, downloadable sample reports.
  projects/page.tsx       PageHeader + ProjectsExplorer.
  about/page.tsx          Who-we-are, Mission/Vision/Values, Stats, Leadership (real photos), Values-in-depth.
  blog/page.tsx + blog/[slug]/page.tsx   Blog index + article (PLACEHOLDER content).
  contact/page.tsx        Contact details + ContactForm.
  api/contact/route.ts    POST handler: validates, honeypot, emails via Resend if
                          RESEND_API_KEY set (else logs). from noreply@sudaangeo.in, to sudaan203@gmail.com.
components/
  Navbar, Footer, Logo (uses /logo-mark.png transparent emblem + wordmark),
  Hero + HeroSequence (animated drone-scan pipeline: Raw→Cloud→DSM→Contour→Intelligence),
  ScrollProgress (orange bar under navbar, fills on scroll), BackToTop (floating button),
  BackgroundDecor (subtle site-wide wavy contours + dots),
  StatsCounter, SectionHeading, PageHeader, CTASection, Reveal (+StaggerGroup/Item),
  ServiceCard, ServiceIcon (icon library), ProjectsExplorer (filterable, animated),
  CompareSlider (touch-friendly: drag anywhere, touch-action pan-y, handle is pointer-events-none),
  PointCloudViewer (canvas 3D, drag/zoom, pauses off-screen via IntersectionObserver),
  ContactForm (posts to /api/contact),
  visuals/scene.ts        deterministic procedural "site" data (fields, buildings, river).
  visuals/GeoLayers.tsx   SVG visuals still used: NDVI, ForestMap, SolarFarm,
                          TransmissionCorridor, RealTile (renders a real image + badge),
                          + helpers Label, NDVILegend, r2. (Dead procedural layers were pruned.)
  visuals/ProjectThumb.tsx generated warm map thumbnails (fallback when a project has no real image).
data/
  services.ts            10 core services.
  serviceCategories.ts   4 categories (Field Survey, Advanced Processing, Utility, Environmental) + items.
  projects.ts            16 REAL case studies; Industry union: Infrastructure, Hydrology,
                         Mining, Solar, Transmission, LiDAR, Forestry. Optional accuracy + image.
                         9 projects map to real screenshots in /public/projects (slug.webp).
  blog.ts                4 placeholder posts.
lib/
  site.ts                siteConfig (name, url https://sudaangeo.in, email sudaan203@gmail.com,
                         phones[2], address Gandhinagar, social, keywords), navLinks,
                         sectors[16], stats[4], clients[5: Reliance, Adani, Mahindra & Mahindra, Dalmia, Nirma].
  asset.ts               base-path helper (currently no-op; was for the abandoned GitHub Pages export).
```

## 5. Real client data on the site
- **Data Insights sliders** use the user's real processed layers of one field:
  `public/insights/{ortho1,dsm1,dtm1,contour1}.webp`. Sliders are Ortho→DSM (also the
  home teaser), DSM→DTM, Ortho→Contours. Sections renumbered 01–03, then 04 NDVI,
  05 Application Examples, 06 Point Cloud Viewer, 07 Deliverables.
- **Projects** (`data/projects.ts`) are 16 real jobs from the user's PDF (Ambaji, Reliance,
  Vadnagar, Gandhinagar, Navsari, Bavla, Lakhtar, Kutch dams, Dalmia, Nirma, Mahindra/Adani
  solar, Sabarmati transmission, Diu LiDAR, Dang forest, etc.).
- **Leadership photos:** `public/team/{prakhar,malhar}.webp` (Prakhar Pandey, Malhar Patel).
- **Logo:** `public/logo-mark.png` (white background keyed out to transparent circular emblem).

## 6. Scripts & local tooling
- `scripts/process-dem.mjs` — colourise+hillshade a float GeoTIFF DEM → webp (auto-reads `.tfw`).
- `scripts/process-logo.mjs` — key white bg → transparent, isolate circular emblem.
- `scripts/generate-reports.mjs` — generate the sample PDF deliverables in /public/reports.
- **Raw source is gitignored** (large/proprietary): `DSM/ DTM/ Contours/ Ortho1/ SS/ SS.zip
  *.ecw *.tif *.tiff *.zip`, plus `node_modules/ .next/ out/`. Processed web copies live in /public.
- Tooling notes: **only `sharp`** is available — **no GDAL, ImageMagick, or poppler**. ECW files are
  unreadable here (need a GeoTIFF/JPG/PNG export instead). `pypdf` (pip) can extract PDF text.

## 7. Conventions (IMPORTANT — follow these)
- **No em dashes (`—`) anywhere** in code or copy — the user dislikes the "AI tell". Use commas, colons, or "to".
- **Light warm theme** — never reintroduce the old dark blue/green palette or blue/green data-viz UI chrome.
- **Git/deploy flow:** make changes on the local folder → verify on localhost → branch →
  open PR with `gh pr create` → merge to `main` → Vercel auto-deploys. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and PR bodies with the Claude Code line.
  Note: `gh pr merge` may report "not mergeable" for a few seconds right after a push (GitHub is still
  computing mergeability) — poll `gh pr view --json mergeable` until `MERGEABLE`, then merge.
- **Verify visually** with the preview tools (launch.json server name `sgi-dev`, port 3000). Running a
  production `npm run build` while `next dev` is up clobbers `.next` and breaks the preview styling —
  if that happens, `rm -rf .next` and restart the preview.
- Keep procedural SVG/canvas visuals deterministic (rounded values) to avoid hydration mismatches.

## 8. Dev commands
- `npm run dev` (localhost:3000) · `npm run build` (static-checks) · `npm run lint`
- Regenerate sample PDFs: `node scripts/generate-reports.mjs`
- **Local toolchain gotchas found 25 Jul 2026 (this machine, not CI):**
  - Default Homebrew `node` is now v26, too new for Next 15.5 (`next dev` starts but never
    binds a port). Run the app with the Node 22 keg instead:
    `PATH="/opt/homebrew/opt/node@22/bin:$PATH" /opt/homebrew/opt/node@22/bin/node node_modules/next/dist/bin/next dev -p 3100`
  - **Lint works, it is just slow.** An earlier note here claimed ESLint hung; that was
    wrong. A full `next build` takes about 7 minutes locally, most of it the lint and
    typecheck step, and it passes. `next build --no-lint` is fine for a quick check but
    **always run the full build before pushing**, because Vercel runs lint and a lint error
    fails the deployment. One real example: an `eslint-disable` comment naming a rule this
    config does not load (`@typescript-eslint/*`, not part of `next/core-web-vitals`) is a
    hard error, not a warning.
  - A bare `eslint` CLI run still fails: ESLint 9 wants a flat `eslint.config.js` while the
    repo has `.eslintrc.json`. Next supplies its own config internally, which is why the
    build works. Migrating the config is unfinished work.
  - Typecheck on its own is fast and reliable: `npx tsc --noEmit`.
  - `outputFileTracingIncludes` patterns must stay narrow and anchored (e.g.
    `portal-data/files/**`). A broad glob walks the gitignored multi-hundred-MB survey data
    and hangs the build at trace collection.

## 8b. Client data portal (Phase 1 BUILT, 25 Jul 2026)
Private per-client dashboard at **`/portal`**: each client user logs in and sees only their
own sites and deliverables. **View only, no downloads** (owner decision). Runs with **no
database and no paid services** so it fits the Vercel Hobby plan.

- **Read `docs/client-portal-plan.md` before touching portal code.** Section 2b explains the
  v1 storage choices and what to swap when moving to Postgres; section 10 has the ops runbook.
- Code: `src/middleware.ts` (deny by default over `/portal` + `/api/portal`),
  `src/lib/portal/*` (session, users, store, seed, files, log, rate-limit),
  `src/app/portal/**`, `src/app/api/portal/**`, `src/components/portal/*`.
- Catalogue = `src/lib/portal/seed.ts` (typed seed). Sample files = `portal-data/files/**`
  (committed, ~700 KB, outside `public/` on purpose). Logins = `PORTAL_USERS` env var on
  Vercel or gitignored `portal-data/users.json` locally, both created by
  `node scripts/portal-user.mjs`. Needs `PORTAL_AUTH_SECRET` set in Vercel to work in prod.
- Pages never import `seed.ts` directly, always go through `src/lib/portal/store.ts`, which
  is async and tenant-scoped so the Postgres swap does not touch the UI.
- Marketing chrome is suppressed on `/portal` by `src/components/SiteChrome.tsx`, which
  receives the navbar/footer as props so those stay server components.

## 8c. Portal Phase 1b: Google sign in + owner-managed access (IN PROGRESS)
Owners (Malhar, Prakhar) will control which client sees which data from their own logins.
**Google-only sign in** (decided 25 Jul 2026). Needs a real database, which is why Postgres
moved ahead of schedule. Design + provisioning checklist: `docs/client-portal-plan.md` §12b.
- Already built and verified: `drizzle/0001_init.sql` (schema), `src/lib/portal/db/*`
  (drizzle schema, lazy client, and `queries.ts` = the single place that decides visibility),
  `scripts/portal-db-migrate.mjs` (applies SQL migrations, tracks them in
  `portal_schema_migrations`), `scripts/portal-db-test.mts` (25 authorisation checks on
  embedded Postgres: `npm install --no-save @electric-sql/pglite tsx` then
  `npx tsx scripts/portal-db-test.mts`).
- Visibility rule (owners bypass it): site belongs to your client AND is published AND
  (you have no per-user grants OR the site is one of your grants); assets additionally
  must be published.
- **Supabase is LIVE** (project ref `azyyimhspvatxesnbjzi`, region ap-southeast-2). Schema
  migrated and demo data seeded, 26 Jul 2026. Connect with the **transaction pooler**
  (`aws-0-ap-southeast-2.pooler.supabase.com:6543`, user `postgres.<ref>`), never the direct
  `db.<ref>.supabase.co` host, which is IPv6-only and unreachable from IPv4 networks.
  Percent-encode the password. `DATABASE_URL` lives in the gitignored `.env.local`.
  Note: a password reset takes up to a minute to propagate; a 28P01 straight after a reset
  usually just means retry.
- Verified end to end against Supabase on 26 Jul 2026: 33 HTTP checks green (isolation,
  view-only streaming, admin view, marketing routes untouched).
- **Google sign in + owner console BUILT 26 Jul 2026.** `src/lib/portal/google.ts` (OAuth code
  flow, hand-rolled on the existing session cookie, no Auth.js), `/api/auth/google/start` +
  `/api/auth/callback/google`, `users-db.ts` (the allowlist: Google proves identity, a users
  row grants access; `PORTAL_OWNER_EMAILS` bootstraps owners), `/portal/admin` owner console
  with `admin-actions.ts` (create client, invite, deactivate, create site, publish, grants).
- Password login still exists as a **staff fallback** behind a details toggle, so a Google
  problem cannot lock the owners out. Remove it by clearing `PORTAL_USERS` and deleting
  `portal-data/users.json`.
- **Use the transaction pooler (port 6543) everywhere** — production, local dev and the test
  scripts. This used to say that `next dev` needed the session pooler (5432) because a
  persistent client on 6543 "wedges after a few requests". That was a misdiagnosis. The real
  cause was the pool being capped at one connection: the transaction pooler serves one query
  at a time per connection, so concurrent queries pipelined down a single connection never
  return. With the pool sized properly a dev server is stable on 6543 across repeated loads
  and hot reloads (verified 26 Jul 2026).
- **The split itself was the expensive part.** Local on 5432 and production on 6543 meant no
  local test could reproduce the owner console outage; everything passed here while every
  production request failed. `.env.example` documents the port, `getDb()` warns when it sees
  5432, and `scripts/portal-pooler-test.mts` fails if the two drift apart again.
- Cache the db client on `globalThis` (done) or hot reload leaks a pool per edit and
  exhausts the pooler.
- Verified 26 Jul 2026 against real Supabase: 33 portal checks, 18 console checks, and a
  16 step owner workflow (create site, publish, grant, revoke, unpublish, deactivate) where
  the client's dashboard changed correctly at every step.
- **Still outstanding:** add `https://www.sudaangeo.in/api/auth/callback/google` in Google
  Cloud, publish the consent screen, set the env vars in Vercel, and have a human complete
  one real Google sign in (cannot be automated from here).

## 8d. Loading feedback and the review pass (26 Jul 2026)

Every click that waits on the server now says so, because a portal page rendered
against a database in Sydney can take a second or two and an unchanged screen
reads as a dead button.

- **`loading.tsx` per portal segment** is the main mechanism. Next renders the
  skeleton the instant a link is clicked, so the console's shape appears
  immediately instead of a blank page. Segments each need their own, otherwise a
  nested route falls back to an ancestor and redraws the whole shell, including
  the tab you just clicked.
- **`NavProgress`** is the top bar, for routes with no skeleton. It waits 140ms
  before appearing so fast navigations do not flash, creeps to 90%, and only
  completes on a real route change. The cases that strand this kind of component
  are a link to the current page and the back button; both are covered by
  `scripts/portal-ux-test.mjs`.
- **`useLinkStatus` / `useFormStatus`** drive the per control spinners
  (`src/components/Pending.tsx`). Reading pending state from the platform rather
  than a hand rolled `useState` means it cannot drift from the navigation.
- **Framer Motion ignored `prefers-reduced-motion`.** The CSS block in
  globals.css only reaches CSS transitions, and every animation here is
  JavaScript driven inline transforms. `MotionProvider` fixes it globally.
- **The dashboard tested `role === "admin"`**, which is the Phase 1 name. Google
  owners are `"owner"`, so owners saw a client's greeting and no client
  attribution on the cards. Use `isOwnerRole()` from types.ts, never a bare
  comparison.

## 8e. Security review (26 Jul 2026)

Reviewed as an account-holding app: auth, tenant isolation, the file route, the
public endpoints and the headers. `scripts/portal-security-test.mjs` runs the
whole thing against a production build.

What was already sound and should not be "simplified": Google OAuth verifies
state, nonce, the id_token signature against Google's JWKS, issuer, audience and
`email_verified`; `next=` is restricted to internal paths at both ends; tenant
filtering happens in SQL through one function in `db/queries.ts` and answers 404
rather than 403 so an id is never confirmed; all six server actions go through
`requireOwner()`; password checks run a dummy bcrypt compare so timing cannot
reveal which addresses exist; file reads refuse anything resolving outside the
files root.

Fixed:

- **No CSP at all.** Now set, strict except `script-src`, which still needs
  `'unsafe-inline'` for Next's hydration bootstrap. `frame-ancestors`,
  `base-uri`, `object-src` and `form-action` are the real wins today; nonces are
  the upgrade path.
- **A header set in `next.config.mjs` overrides one set in a route handler.** The
  asset route's own tighter CSP was being silently discarded. Anything
  per-response must be declared in the config. Found by reading the response,
  not the code.
- **The asset route served whatever MIME type the catalogue held.** An
  `image/svg+xml` or `text/html` file served from our origin is same origin
  script. Now an allowlist, which matters before uploads land.
- **Password sessions were never re-checked**, so removing someone from
  `PORTAL_USERS` left them signed in for up to eight hours. Rights are now
  re-read per request, so a demotion takes effect immediately.
- **Login throttling keyed on email+IP only**, which permits spraying one
  password across thousands of addresses from one host. There is now also a per
  IP ceiling.
- **`/api/contact` had no throttle**, no length caps, and is on its way to
  spending money through Resend.
- The rate limiter grew without bound, and read the *first* `x-forwarded-for`
  entry, which is the caller supplied end. It reads the last hop now.
- Portal responses now send `no-store`, so a shared machine's back button cannot
  reveal the previous person's data.

Known and accepted: rate limiting is per serverless instance, not global; logs
carry email addresses; `script-src` allows inline.

## 8f. The reference dashboard, from the walkthrough video

The portal is modelled on the **EnerComp "Monuments" dashboard** built for the
Directorate of Archaeology and Museums, Pune Division. The 11 minute walkthrough
is `05. Dashboard_Overview_video.mp4` in the repo root: 424 MB, gitignored, so it
is on this machine only.

Everything below was read off the actual frames on 26 Jul 2026, not remembered.
**Eight stills are committed in `docs/reference/dashboard/`** with their own
README, so you can look instead of reading prose. Extract more with:

```bash
ffmpeg -i "05. Dashboard_Overview_video.mp4" -vf "fps=1/20,scale=1280:-1" -q:v 4 out/f%03d.jpg
```

The committed stills have the account email redacted. They are another company's
product, captured for design reference, in a public repo: keep that in mind
before adding more.

**Chrome.** Teal top bar, hamburger, the client's crest, account email at top
right. A left icon rail that is the whole navigation. Footer credits EnerComp.
Their palette is teal and green: **do not copy it**, we are warm light (section 3).

**Landing: "Monuments".** Three cascading filters (Division `PUNE` → District
`KOLHAPUR` → monument name) with FILTER and RESET, plus ADD MONUMENT top right.
Below, a four column card grid. Each card: name, village/taluka/district address,
then District, Division, **Last Modified**, **Data Acquisition on**, **Created**,
and a row of small action buttons ending in a red delete.

**Left rail, per monument.** Monuments, OrthoMaps, Comparison, PointClouds,
Video, REPORT_WRITING, UAV & DGPS DATA, LIDARDATA, ENGINEERING_DRAWINGS,
3D_MODELLING, COFFEETABLE_DATA, CONSERVATION_WORK, CONTROL_AREA, WALKTHROUGH.

**OrthoMaps is the centre of the product**, and it is a real WebGIS, not an
image viewer:

- `SELECT DATE` picks the acquisition, so the same monument holds several surveys.
- A layer tree on the right, in groups: **Drawing**; **Layers**
  (Drainage_Pattern, Contours1, GCP1); **Drone Imagery** (Orthomosaic.tif, DTM,
  DSM); **Base layers** (OSM, Google Maps).
- Every layer has a checkbox, its own **opacity slider**, and a delete control.
  Toggling DTM/DSM swaps the green/yellow elevation raster over the ortho.
- Contours render **with elevation labels** (777 m, 782 m …) on top of the ortho.
- A draw and measure toolbar: select, point, line, polygon, rectangle, measure.
- Zoom buttons, live lat/long readout, and **Page size + Resolution + Export
  PDF**, plus Save.

**PointClouds** is **Potree**, unmistakably: a "SELECT A POINT CLOUD TO VIEW"
dropdown, then point budget, field of view, Eye-Dome-Lighting, splat quality,
measurement tools and clipping.

**Video and WALKTHROUGH** are YouTube embeds behind a SELECT VIDEO dropdown,
titled like `Kukdeshwar_Temple_FrontView`. The walkthrough is a flythrough of the
point cloud.

**REPORT_WRITING** opens a File Viewer: the browser PDF viewer with a page
thumbnail rail, on a 42 page report.

**The data tabs** (ENGINEERING_DRAWINGS, CONTROL_AREA, LIDARDATA, and the rest)
are all the same table: `No | File Name | Action`, with **DOWNLOAD** and **VIEW**
per row. A `.dwg` row gets DOWNLOAD only, because it cannot be previewed.

**Comparison was not captured** in the frames sampled, so its behaviour is the
one thing here that is inferred rather than seen. Intent is comparing two
acquisition dates. Check the video before building it.

### How ours differs, deliberately

- **View only.** Their every file row offers DOWNLOAD. Ours never does: the
  client asked for view only, and `AssetViewer` plus the inline-only asset route
  exist to hold that line.
- **Multi tenant.** Theirs serves one organisation. Ours isolates every client
  from every other, which is why visibility lives in SQL (`db/queries.ts`) and a
  miss answers 404.
- **Management is not in the client UI.** They put ADD MONUMENT, edit and delete
  next to the data. Ours lives in the owner console, so a client sees only their
  deliverables.

### What "working on the dashboard" means next

Built already: the monument list (our `/portal` site cards), per site tabs, the
file tables, the PDF and image viewer. What the reference has and we do not:

1. **The map viewer.** The biggest gap by far, and the thing that makes their
   portal feel like a product: tiled ortho/DSM/DTM, a layer tree with opacity,
   base maps, contour labels, measurement. Phase 2 in the plan.
2. **Survey date switching** on a site that has more than one acquisition. The
   `surveys` table already exists for this.
3. **Point cloud viewer**, Potree in an iframe. Phase 3.
4. **Comparison** between two dates. We already have `CompareSlider` on the
   marketing site, which is most of the interaction.
5. **Video tab**, unlisted YouTube embeds. `videos` table exists, page is a stub.

## 8g. The survey map (Phase 2a, BUILT 26 Jul 2026)

`/portal/<site>/map` draws the georeferenced deliverables over each other. This
is the feature that closes most of the gap with the reference dashboard in 8f.

**The pipeline.** `scripts/prepare-map-data.mjs` turns the raw Kotba survey into
web layers in `portal-data/map/<slug>/`, outside `public/` so every byte goes
through an authorised route. It does two things nothing else here does:
unprojects UTM 43N corners to WGS84 so a raster lands in the right field, and
parses the ESRI shapefile directly, because GDAL is not available on this
machine. Cross check that it is working: the DTM reports 337 to 424 m and the
contours, read from a completely separate file, report 338 to 424 m.

Three bugs it is worth not rediscovering:

- `sharp(...).raw()` silently returns 8 bit RGB for a float GeoTIFF. Without
  `depth: "float"` you get convincing nonsense, the first run had the DSM
  spanning -24 to 0 m. It also expands one band to three, so step by stride.
- The contour `.dbf` stores elevation as the text `"338 m"`, so `Number()` gives
  NaN and every line loses its height.
- Colour across the 2nd to 98th percentile. One outlier at 143 m flattened the
  entire survey to a single shade of orange.

**MapLibre under Next needs its worker served by hand.** MapLibre tiles vector
data in a web worker and finds it via `new URL(..., import.meta.url)`, which
Next does not emit. Both `maplibre-gl-worker.mjs` and its sibling
`maplibre-gl-shared.mjs` are copied to `public/vendor/` by a postinstall script
and pointed at with `setWorkerUrl`. Copying only the first is not enough; the
worker then requests the second and dies quietly.

The failure mode is nasty and cost most of a session: raster layers keep working
because images decode on the main thread, so the map looks fine while every
GeoJSON source sits at `isSourceLoaded: false` with zero features, no error in
the console and no failed request. If a vector layer ever silently vanishes
again, check the worker before anything else.

**Also worth knowing:** GeoJSON is fetched on the main thread and handed to the
source with `setData`, because MapLibre's worker fetch does not carry the
session cookie and our route answers 401. Contours are simplified to about a DEM
cell, which took 94,255 points down to 29,422 and the file from 2.2 MB to 660 KB.

**Deliberately different from the reference:** the basemap is off by default and
says why, because a tile request tells a third party where a client's site is.

## 8i. What the map pipeline does and does not handle

Audited 26 Jul 2026 against the data types Sudaan actually produces, rather than
the one survey that happened to be on disk. Four things were broken and none of
them failed loudly. `scripts/portal-map-test.mjs` now guards all of them.

**Fixed:**

- **`-9999` was treated as a real elevation.** It is the commonest nodata
  sentinel in DEMs, and the old test (`v < -1e4`) let it through by 1 metre. A
  nodata corner would have drawn as terrain. Now bounded by what an elevation
  can be, -500 to 9000 m, which catches -9999, -32767, -32768 and -3.4e38 in one
  rule.
- **Only `PolyLine` (type 3) contours were read.** Most survey packages export
  `PolyLineZ` (13) because each line carries its height, and those would have
  produced an empty layer with no error. Types 3, 13, 23 and the polygon
  equivalents are read now, and anything else is named in a warning.
- **An orthomosaic fed to the DEM path read colour channels as metres** and
  reported "120 to 120 m". It is refused with a message now.
- **The script was hardcoded to Kotba.** Sites are a config block; adding one is
  a data change.

**Still not handled, deliberately, and they throw rather than guess:**

| Input | What happens |
|---|---|
| Non UTM projection (geographic, Lambert, Web Mercator) | Throws on the `.prj` |
| Rotated world file | Throws |
| Orthomosaic imagery | Refused, no imagery path exists yet |
| ECW | Cannot be read at all without GDAL |
| Raster over 4,096 px | Downsampled, flagged in the manifest, see 8h |
| LAS/LAZ point clouds | Not handled, needs a desktop converter |
| Multiple surveys per site | Manifest has no date dimension yet |

**The ask for the field team stands:** GeoTIFF, or PNG/JPG with its `.tfw` and
`.prj`, in UTM. Anything else needs a conversion step before it reaches here.

## 8j. Full quality data on a light website: the architecture

The question this answers: how does the portal show a client their survey at full
resolution without the website carrying the weight of it. Worked out from
Sudaan's own portfolio, not from general advice.

### What the portfolio actually demands

At the accuracy the site advertises, plus or minus 3 to 4 cm, which means 2 to
5 cm ground sampling:

| Site | Area | Pixels at 5 cm | Raw RGB |
|---|---|---|---|
| Dang Forest | 450 km² | 180 Gpx | 540 GB |
| Kutch dams | 70 km² | 28 Gpx | 84 GB |
| Navsari | 64 km² | 25.6 Gpx | 77 GB |
| Bavla, Gandhinagar | 20 km² each | 8 Gpx | 24 GB |
| Kotba (the demo) | 0.13 km² | 51 Mpx | 154 MB |

Dang Forest at 2 cm is **3.4 TB**. No single image approach survives contact
with this, and the corridor jobs are worse in a different way: a 110 km
transmission corridor covers about 22 km² of ground inside a bounding box of
roughly 4,200 km², so **99% of one big image would be empty pixels**.

### The answer, and the measurement that proves it

Tile pyramids. The browser fetches only the 256 px squares covering the current
view, so cost is flat in the size of the deliverable.

Measured on the real Kotba DSM with `scripts/make-tiles.mjs`:

```
153 tiles, z14 to z20, 0.44 MB total, 2.9 KB average
53 empty tiles skipped
a 1440x900 screen pulls ~24 tiles = 70 to 78 KB, at every zoom
```

**70 KB per screenful whether the source is 150 MB or 3 TB.** Empty tiles are
never written, which is what makes the corridor jobs affordable.

Georeferencing was checked against an independently calculated slippy map tile
index rather than by looking at the picture.

### Where each piece runs, which is the actual design decision

**Do not process rasters on Vercel, and do not put them in git.** The split:

1. **Production, on the desktop Sudaan already uses.** Pix4D, Agisoft, Global
   Mapper and QGIS all already produce these deliverables. Add one export step:
   QGIS has "Generate XYZ Tiles" built into Processing, GDAL has `gdal2tiles`,
   and either produces exactly what the portal needs. No new vendor, no new
   cost, and it runs on the machine that already holds the data.
   `scripts/make-tiles.mjs` is the fallback for when that is not available; it
   is slower and reads fewer formats.
2. **Storage: Cloudflare R2.** 10 GB free, and **egress is free**, which is the
   number that matters when serving imagery. At $0.015/GB/month beyond that,
   100 GB of tiles is about $1.50 a month. Supabase Storage works too but bills
   egress after 5 GB.
3. **The portal stays a thin authorising layer.** It checks the caller can see
   the site, then redirects to a short lived signed URL. Bytes come from R2's
   edge, not from a serverless function.

### Why this keeps the site light, concretely

- **The repository does not grow.** Imagery never enters git or the Vercel
  bundle, so builds and deploys stay where they are today.
- **Function time stays near zero.** The portal answers with a redirect, not
  megabytes.
- **The client's browser holds one viewport**, about 70 KB, instead of a whole
  raster, and zooming fetches the next few tiles rather than a bigger image.

### Quality is not the thing being traded away

Tiles go to native resolution. Kotba's 15 cm data reaches z20; 2 cm data reaches
z22 or z23. A client can zoom to the limit of what was flown, which is more than
the current single overlay allows, since that is capped at 4,096 px and
downsamples anything larger.

### The order to build it

1. Portal support for `kind: "tiles"` layers: a manifest entry and a MapLibre
   raster source. Small, and there are real tiles on disk to test against.
2. An R2 bucket and the signed URL redirect in the layer route.
3. Move the desktop export into the delivery checklist, so tiles arrive with the
   deliverables rather than being generated after the fact.

Steps 1 and 2 are independent: tiles can be served from `portal-data` first and
moved to R2 when a real site outgrows the repository, which is the 50 MB trigger
in 8h.

## 9. Pending / TODO (next steps)
1. **Consultation email (highest priority):** the contact form works but only logs server-side until
   Resend is configured. Steps: create a Resend account → verify `sudaangeo.in` (add DNS at Hostinger)
   OR temporarily switch the route's `from` to `onboarding@resend.dev` for testing → add env vars in
   Vercel: `RESEND_API_KEY` (and optional `CONTACT_TO=sudaan203@gmail.com`) → redeploy. Then form
   submissions email sudaan203@gmail.com (reply-to = sender).
2. **Domain mailbox:** `info@sudaangeo.in` does NOT exist (domain-only plan, no email hosting). Site
   contact email is therefore `sudaan203@gmail.com`. Create a real mailbox later if desired.
3. **Stats are estimates:** `stats` in `lib/site.ts` (100+ projects, 650+ km², 7 sectors, 99%) — adjust
   to true figures when known.
4. **Suggested (not yet done):** hide Blog from nav until real posts exist; add a WhatsApp click-to-chat
   button (two numbers in siteConfig.phones); swap the procedural Point Cloud for a real cloud; add team
   credentials / certifications; enable Vercel Speed Insights; optional Vercel coding-agent plugin
   (`npx plugins add vercel/vercel-plugin` — user must run it, it's blocked from the agent sandbox).

## 10. History so far (high level)
Built full site → renamed Sudan Geo-Informatics → **Sudaan Geo-Analytics** → switched to warm light
theme → added animated drone-scan hero, categorised services, leadership, sectors → wired REAL Kotba/field
data into Data Insights + real projects + leadership photos → pushed to GitHub → (briefly tried GitHub
Pages static export, then **reverted** it — site runs as a full server app) → deployed to **Vercel** →
connected **sudaangeo.in** → mobile slider fix, real contact details, scroll-progress bar, back-to-top,
real stats, "Trusted By" client strip (black hero heading + gradient names), point-cloud perf + dead-code
prune. All merged to `main` and live.

> There are also persistent memory files at
> `~/.claude/projects/-Users-ompatel-Documents-Sudan-Geo-Infomatics/memory/` that mirror some of this.
