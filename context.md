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
  - **THE BUILD GOTCHA ON THIS MACHINE: iCloud evicts `node_modules`.** The repo lives in
    `~/Documents`, which iCloud Drive manages, and when the disk fills macOS turns files into
    dataless stubs. Measured 26 Jul 2026: **17,452 of 23,720 files in `node_modules` had zero
    blocks allocated.** Every `require()` of an evicted file blocks in `read()` while macOS
    fetches that one small file over the network, and ESLint loads thousands of rule modules.
    Symptom: the build prints "Creating an optimized production build" or "Linting and
    checking validity of types" and then sits there with **0% CPU** and a couple of seconds of
    CPU time after twenty minutes. It never errors and never times out. `next dev` fails the
    same way, never binding a port, which looks exactly like the node v26 problem above.
    Confirm with `stat -f %b <file>` returning 0, or `sample <pid>` showing every sample in
    `uv_fs_read` -> `read`. **Fix: `rm -rf node_modules && npm ci`**, which writes resident
    files and takes 15 seconds. Real fix: move the repo out of `~/Documents`, or turn off
    Optimise Mac Storage, because iCloud should never sync 23,000 dependency files.
  - **A full build takes about 20 seconds, not 7 minutes.** An earlier version of this note
    claimed 7 minutes and blamed a slow lint step, and a memory file claimed the opposite.
    Both were misreadings of the iCloud problem above. With `node_modules` resident:
    compiled in 8.1s, lint and typecheck clean, 27 static pages, 20s total. So there is no
    time argument for `--no-lint`: **always run the full build before pushing**, because
    Vercel runs lint and a lint error fails the deployment. One real example: an
    `eslint-disable` comment naming a rule this config does not load (`@typescript-eslint/*`,
    not part of `next/core-web-vitals`) is a hard error, not a warning.
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

> **SUPERSEDED in part, 26 Jul 2026. Read `docs/portal-map-architecture.md`
> first.** The measurements below are real and still worth reading. Two
> conclusions are not:
>
> - **Pre baked WebP pyramids committed to git are a dead end.** They cap site
>   size, and worse, they freeze the pixels: no restyling a DEM, no NDVI, no
>   comparing two dates, and publishing means committing about 1,700 binary
>   files. The replacement is PMTiles for imagery and vectors, COG behind a
>   dynamic tiler for elevation, COPC for point clouds.
> - **"Redirects to a short lived signed URL" is wrong for tiles.** One pan fires
>   hundreds of requests. Signed URLs are right for a single asset only.
>   `docs/client-portal-plan.md` 8.2 had this right before 8j got it wrong; tiles
>   are authorised once per session with an HMAC cookie checked by a Cloudflare
>   Worker in front of R2.

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

## 8k. The local workflow: one command per site

`scripts/prepare-site.mjs` is the tool Sudaan runs on the machine that holds the
survey. It takes a folder of deliverables and writes a portal ready bundle.

```bash
node scripts/prepare-site.mjs ~/surveys/reliance-jamnagar reliance-jamnagar
```

No paths in code, no per site editing. It looks at what is in the folder and
decides:

| Found | Treated as |
|---|---|
| Single band float GeoTIFF | Elevation model: colourised, tiled |
| Three band GeoTIFF, PNG, JPG | Orthomosaic imagery: tiled as is |
| `.shp` with `.dbf` and `.prj` | Lines: simplified GeoJSON, elevation kept |

Every raster needs georeferencing, a `.tfw` and `.prj` beside it or inside the
GeoTIFF. Without it the file is **skipped with a message**, not guessed at.

Options: `--out DIR`, `--quality N` (default 80), `--max-zoom N`.

### Why tiles and not "resize it smaller"

Resizing is the thing that costs quality. A single overlay has to fit in browser
memory, so it gets shrunk, and the detail the survey was flown to capture is
gone. Tiles keep **native resolution** and the browser fetches only the screenful
it is showing.

Measured end to end on the real Kotba survey, all three layers from one command:

```
Kotba_DEM.tif: elevation 2143x2423, 143.1 to 438.3 m
  55 tiles z13-19, 0.16 MB, 20 empty skipped
Ortho_test.tif: imagery 1200x770
  34 tiles z12-18, 0.10 MB
Kotba Contours.shp: 201 lines, 94,255 points thinned to 29,422, 645 KB
total 0.89 MB
```

Max zoom is chosen per layer from its own resolution, so a sharper source gets
more zoom levels rather than every layer being flattened to the same ceiling.

### The quality setting, measured

On the busiest photographic tile, against the q80 default:

| Quality | Size | Drift |
|---|---|---|
| q50 | 63% | 31.8 dB, visible |
| q70 | 84% | 35.2 dB |
| **q80 (default)** | **100%** | **40.1 dB** |
| q90 | 119% | 42.0 dB |
| q95 | 140% | 44.6 dB |

Around 40 dB is the usual line for visually lossless, which is where q80 sits, so
the default gives the smallest bundle that a client cannot tell apart. Use
`--quality 90` for a client doing close visual inspection and accept 19% more.

A colourised DEM barely moves across this whole range, because it is smooth, so
the setting only really matters for imagery.

### Where the output goes

Today: copy the folder to `portal-data/map/<slug>/` in the repo. That is fine
while a site is small.

Once a site exceeds the 50 MB trigger in 8h, it goes to a bucket instead and the
layer route redirects to a signed URL. The bundle layout does not change, which
is the point of writing it as a self contained folder.

### Wired up (26 Jul 2026)

The portal reads `kind: "tiles"` now, and the live Kotba map is served from a
pyramid: 110 tiles, 1.1 MB, committed to the repo. `prepare-site.mjs` is the
only script needed to publish a site.

Three things worth knowing about that wiring:

- **The layer route is a catch-all**, `map/[...path]`, because tiles are nested
  as `tiles/<layer>/{z}/{x}/{y}.webp`. It does not trust the path: a request is
  served only if it is one file the manifest names, or a tile whose layer key
  matches a declared `kind: "tiles"` layer with integer z, x and y.
- **Missing tiles answer 204, not 404.** A survey footprint is a rotated
  quadrilateral, MapLibre asks for every tile in the rectangle around it, and
  the corners were never written. 204 keeps the browser console clean.
- **Raster tiles load on the main thread**, so unlike GeoJSON they carry the
  session cookie without help. That asymmetry is the same one described in 8g.

Both older scripts share `scripts/lib/geo.mjs`, so there is one implementation
of the projection and shapefile code rather than a copy per script.

## 8l. Publishing Aektanagar, and the two ways it had silently half worked

The second real site went up on 26 Jul 2026: `aektanagar-survey`, Demo Client,
1,714 files and 22 MB in `portal-data/map/aektanagar-survey/`.

```
Surface model (DSM)   262 tiles z14-20   0.38 MB
Terrain model (DTM)   262 tiles z14-20   0.16 MB
Orthomosaic          1188 tiles z15-21  15.96 MB
Contours              108 lines, 1,015,587 points thinned to 44,292, 952 KB
```

The usual cross check passes: the DTM reports 29.48 to 98.18 m from the GeoTIFF
and the contours, read from a separate `.dbf`, report 30 to 97 m.

**A killed run leaves a bundle that looks finished.** The first attempt died
partway through the orthomosaic. `prepare-site.mjs` writes `manifest.json` last,
so the folder kept a *stale* manifest from an earlier `prepare-map-data.mjs`
run, which declared `kind: "raster"` single image overlays. The result was a map
that rendered perfectly and was wrong in two ways at once: DSM and DTM served as
4,096 px overlays while complete pyramids sat unused beside them, and 3,002
orthomosaic tiles, 46 MB, committed to git and unreachable, because the layer
route only serves tiles whose key a `kind: "tiles"` layer declares. Nothing
errored. If a bundle ever looks odd, compare the manifest's mtime against
`tiles/`.

**Why it was killed: one decoded raster is four bytes a pixel.** The ortho is
27,521 x 27,199, so 749 Mpx, so 3 GB held at once, on a machine with 8.6 GB.
There is now a `--max-pixels` working limit, default 120 Mpx:

- **Imagery over the limit is resized on the way in**, which libvips streams, so
  it costs about two seconds and bounds the peak. The full run is 57 seconds at
  857 MB peak with no swapping. The source size is recorded as
  `downsampledFrom` in the manifest so a reduced copy is visible rather than
  inferred from how blurry it looks.
- **Elevation models over the limit are refused, not resized.** Resampling
  across a nodata sentinel averages -9999 into real ground and invents terrain,
  which is the failure 8i exists to prevent.

**Resizing a georeferenced raster means changing the origin too.** A world file
names the centre of the top left pixel, so `scaleWorld` holds the outer edges
fixed and moves both the pixel size and the origin. Scaling only the pixel size
leaves the layer half a pixel out, which is invisible on screen and wrong in
every measurement taken off it. Verified at 0.0000 mm corner drift against the
untouched full resolution world file.

**What this costs, and how to get it back.** The portal's ortho is 4.57 cm
rather than the 1.83 cm that was flown. That is the fallback script running out
of machine, not a design choice, and 8j already names the fix: `gdal2tiles` or
QGIS "Generate XYZ Tiles" on the desktop that holds the data, which streams and
reaches native z22. The output drops into the same bundle layout. Do that before
telling a client they can zoom to the limit of the survey.

Worth knowing: the DSM and the ortho do **not** share a footprint. They are 5.93
m apart east and 12.44 m north in the source world files, up to 21 m at a
corner. That is the deliverables, not a registration bug, so do not "fix" it.

### The code seed is not the database

Aektanagar was in `src/lib/portal/seed.ts` and in `scripts/portal-db-seed.mjs`
and still did not appear, because `store.ts` uses Postgres whenever
`DATABASE_URL` is set and the row had never been inserted. **Adding a site to
the seed file does nothing to production.**

`portal-db-seed.mjs` now takes `--only <site-slug>` and `--dry-run`. Use them:
the plain re-run upserts every site, so adding one new site would reset the
name, summary and `is_published` of the others back to this file and quietly
undo anything the owners had changed in the console. Idempotent is not the same
as harmless once a database is real.

Also fixed: the LiDAR asset used `category: "uav"`, which is not in
`AssetCategory` (`uav_dgps` and `lidar` are) and violates the check constraint in
`0001_init.sql`. It was wrong in both the seed file and the seed script, failed
`tsc` and would have failed the insert. It is `lidar` now.

### Two things about this site that are still placeholders

- The LiDAR `.las` in `portal-data/files/` is a 159 byte text description, not
  the 1.7 GB point cloud. It cannot go in git and there is no viewer for it
  until Potree lands in Phase 3.
- The Aektanagar report and contour map PDFs are about 1.5 KB each, generated,
  not the real deliverables.

### Mapbox, and where R2 stands

There is **no Mapbox in this project and that is deliberate.** The map is
MapLibre, a Mapbox token was added to `.env.example` at one point and referenced
by nothing, and Mapbox GL JS bills per map load. Basemaps are also off by
default on purpose (8g), so the thing a token would buy is the thing we chose
not to do.

The four `CF_*` variables are documented in `.env.example` and **nothing reads
them yet.** Tiles still come from `portal-data`. When the redirect is built it
is an authorisation check followed by a short lived signed URL, per 8j, never a
public bucket URL: a public URL would defeat view only and tenant isolation in
one step. Aektanagar at 22 MB is under the 50 MB trigger in 8h, so the move is
not forced yet, though a native resolution ortho would force it immediately.

## 8m. One command per site, and why the old flow produced wrong numbers

Publishing a site is now a single command. Everything in 8k and 8l is still true
about the individual steps, but nobody should run them one at a time.

```bash
node scripts/publish-site.mjs ~/surveys/reliance reliance-jamnagar \
  --client reliance --name "Reliance Jamnagar" \
  --location "Jamnagar, Gujarat" --flown-on 2025-03-14 --db
```

It looks at the folder, decides what each file is, and runs the whole pipeline:
tiles and contours, Terrain-RGB for measurement, imagery previews, the PDF
deliverables, the catalogue, the database, then the guards. `--dry-run` prints the
plan. `--skip-tiles` reuses a pyramid already on disk.

### The old flow was six steps and three of them were editing code

That is where every wrong figure came from, and it is worth being specific,
because none of it was carelessness at a keyboard:

| What the client saw | What the data said |
|---|---|
| Contour Map, 0.5 m interval | the shapefile stores `56.000000000000000`, so 1 m |
| 45,210,480 LiDAR points | the LAS header says 50,183,644 |
| Ground, Vegetation, Structures, High Noise | only Ground and Unclassified exist |
| Area 35 ha | the footprint measures about 26 ha |
| Kotba: 42 ha, 0.5 m contours | 12.8 ha, 201 lines at 1 m |
| Aektanagar's DSM, DTM and contour previews | byte identical to Kotba's |

The pipeline measured all of those correctly and then asked a person to retype
them into `seed.ts` and `portal-db-seed.mjs`. So the rule now is that a catalogue
row is **discovered, not declared**: `scripts/lib/catalogue.mjs` walks the site's
folder, recognises each file, and describes it from the file itself. A fact that
cannot be read is left blank rather than guessed.

### Three pieces worth knowing

- **`scripts/lib/manifest.mjs`** is the only thing that writes a manifest.
  `make-terrain-tiles.mjs` used to print a JSON block for a human to paste in,
  which is literally how Aektanagar's terrain layer was added. It now registers
  its own layer and then calls `verify()`, which walks what the manifest claims
  against the tiles on disk, including the "tiles newer than the manifest" case
  that left Aektanagar serving 4,096 px overlays with a complete pyramid beside
  them.
- **Identity comes from the natural key, not from a generated id.**
  `portal-db-publish.mjs` matches `clients.slug`, `sites (client_id, slug)` and an
  asset's storage key, and only uses its uuid v5 when creating something new.
  Doing it the other way round breaks on the first real run: Kotba already exists
  as `33333333-...` from the demo seed while the generator produces
  `567a0eaf-...` for the same slug, and `sites` has a unique constraint on
  (client_id, slug).
- **Assets that disappear are unpublished, not deleted.** A client may hold a
  link, and "no longer available" beats a 404. Republishing Kotba retired its
  three sample PDFs that way.

### The guard that catches the whole class

`scripts/portal-assets-test.mjs`, run automatically at the end of a publish:

- no deliverable may appear under two sites (hashes every file; this is what found
  Aektanagar serving Kotba's previews, and Ambaji serving Kotba's ortho and report)
- none may be a stub, and every file must match the format its extension claims
  (which catches the fake `.las`)
- no PDF may contain the marketing sample's text (`Gezira`, `demonstration
  purposes`), and every survey PDF must name its UTM zone. The exemption is
  earned, not configured: a document is excused only if it says in its own text
  that it is not a survey deliverable, which is how the isolation fixture passes.

### Two things this does not do yet

- **`src/lib/portal/seed.ts` is still hand written.** It is only the no database
  fallback now, so it can drift from what a publish produces. Either generate it
  from a catalogue or delete it once Postgres is the only backend.
- **The area label is a bounding box**, computed from the union of every layer's
  declared bounds. A survey footprint is an irregular quadrilateral, so the label
  overstates slightly: Aektanagar reads 26.1 ha against a 25.3 ha DTM rectangle.
  Fine for a card, wrong for a quantity, and it should say "bounding box" or be
  computed from the real footprint.

## 8n. The OpenStreetMap basemap was blocked by our own CSP

Reported by Malhar, and it had never worked in any environment.

`MapViewer` requests `https://tile.openstreetmap.org`. The CSP listed
`https://*.tile.openstreetmap.org`. **A CSP wildcard matches subdomains and not
the bare domain**, so every basemap tile was refused by policy.

Nothing looked broken from inside the app: a CSP violation is not a failed
request MapLibre can report, so the toggle turned on and simply nothing drew.
Both forms are listed now, `img-src` and `connect-src`, because the bare host is
canonical today and the a/b/c subdomains remain for older clients. Verified in a
real browser on both sites: 20 tiles on Kotba, 12 on Aektanagar, all 200, zero CSP
violations.

Worth remembering the general shape of this: **the map cannot tell you when the
browser refuses on its behalf.** If a layer silently does not draw, check the CSP
before the map code, alongside the MapLibre worker problem in 8g, which fails the
same silent way.

## 8o. The white slab around a survey, and a manifest that ate itself

Two bugs found by looking at the map with the basemap turned on.

### An orthomosaic footprint is not a rectangle, but its file is

Aektanagar's ortho is a JPEG, which carries no alpha, and **25.8% of it is pure
white filler** around the survey footprint. `ensureAlpha()` marked all of that
opaque, so the portal drew a white slab over the basemap around every survey.

`scripts/lib/nodata.mjs` clears it, and the interesting part is what it refuses to
do. Blanket "white becomes transparent" would punch holes through concrete, roofs
and road markings. So two conditions have to hold:

- **Contiguous with the border.** Filler touches the edge; a white roof in the
  middle does not. A scanline flood fill inward separates them with no per site
  threshold to tune.
- **The colour must look like a sentinel**, every channel at 250 or above, or 5 and
  below. Agreeing corners alone are not enough: a synthetic all green raster had
  agreeing corners and got 100% of itself cleared, which the test caught. Dense
  forest or open water would have done the same thing to a real survey.

Result on Aektanagar: 26.2% cleared, and 284 tiles that were pure white slabs are
now empty and never written. Detected as `rgb(255,255,255)` and recorded in the
manifest as `backgroundCleared`, so it is visible rather than magic. `--no-mask`
turns it off, `--mask-tolerance` widens it.

### prepare-site.mjs replaced the manifest instead of updating it

Found while re-tiling one raster. Running it on a subfolder took Aektanagar from
five declared layers to one, **while all four pyramids sat on disk untouched**, so
the portal would have shown a single layer with no error anywhere. The same silent
shape as the stale manifest in 8l, reached from the opposite direction: there the
manifest was too old, here it was too new and too empty.

It reads the existing manifest now, upserts by key through
`scripts/lib/manifest.mjs`, reports which layers it left alone, and calls
`verify()` before finishing. Re-running for one file is safe, and
`portal-map-test.mjs` covers it: a partial run keeps the other layers, updates
rather than duplicates the one it produced, and `verify()` catches both a layer
with no tiles and a zoom range that disagrees with disk.

The general rule worth keeping: **anything that writes the manifest must merge,
never replace.** It is the one file that describes everything else, it is written
last, and every failure around it has been silent.

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
