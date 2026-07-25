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
- **Pooler ports matter:** Vercel uses the transaction pooler (6543); a long-lived `next dev`
  must use the session pooler (5432). A persistent client on 6543 wedges after a few requests
  and every later query hangs. Also cache the db client on `globalThis` (done) or hot reload
  leaks a pool per edit and exhausts the pooler.
- Verified 26 Jul 2026 against real Supabase: 33 portal checks, 18 console checks, and a
  16 step owner workflow (create site, publish, grant, revoke, unpublish, deactivate) where
  the client's dashboard changed correctly at every step.
- **Still outstanding:** add `https://www.sudaangeo.in/api/auth/callback/google` in Google
  Cloud, publish the consent screen, set the env vars in Vercel, and have a human complete
  one real Google sign in (cannot be automated from here).

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
