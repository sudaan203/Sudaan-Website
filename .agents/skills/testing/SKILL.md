---
name: testing
description: How testing actually works in Sudaan — there is no test framework dependency and no `npm test`; tests are plain Node scripts under scripts/*-test.mjs. Covers what CI runs vs. what needs manual verification, and the local-machine toolchain gotchas that look like test/build failures but aren't. Load before running or writing a test, or before claiming a change was verified.
---

# Testing

Verified against `.github/workflows/ci.yml` and `package.json` — there is
**no Jest/Vitest/Playwright** and **no `npm test` script**. Every suite is a
standalone script under `scripts/`, `node scripts/<name>-test.mjs` (or
`.mts` via `npx tsx`), printing `ok`/`FAIL` per check and exiting non-zero on
any failure.

## What CI runs (needs nothing but the checkout)

Typecheck (`npx tsc --noEmit`), then, in one step so all failures show
rather than stopping at the first:

```
terrain-test  engineering-test  hydro-test  flood-test  merge-tree-test
analysis-core-test  render-test  colour-consistency-test  shapefile-test
lzw-test  db-timeout-test  geo-differential-test  accuracy-test
coarsen-test  tenancy-test  portal-map-test  portal-assets-test
portal-tile-grant-test
```

Then `node scripts/bench-geo.mjs --size=small` (a smoke run, not a
benchmark — numbers from a shared CI runner mean nothing; it exists to catch
a renamed export or changed signature). Then `npm run build` in a separate
job (parallel to the above), which also needs outbound network access for
Google Fonts (`next/font/google`).

These are synthetic/closed-form where possible; several (lzw, geo-
differential, accuracy, merge-tree, coarsen) compare against a real survey
raster (usually Kotba) **when present** and skip that half cleanly when it
isn't — the synthetic half still runs and still proves something. `tenancy-test`
spins up embedded Postgres via PGlite and applies `drizzle/`; it skips
cleanly without PGlite installed.

## What does not run in CI, and why

- **`scripts/*-api-test.mjs`** (alignment, analysis, cloud, hydrology,
  render, shapefile, surface) — drive real HTTP routes, need `next dev`
  live, a real Supabase database with the portal schema seeded, and the
  actual survey rasters. Run these manually before a release.
- **`scripts/portal-*-browser-test.mjs`** — same, plus a real browser.
- **`scripts/raster-window-test.mjs`** — every check compares a windowed
  read against a whole-file read of a real `portal-data/terrain/<site>/dtm.tif`
  (one BigTIFF-tiled survey, one stripped — the reader has a separate path
  for each). A synthetic fixture wouldn't prove what this exists to prove:
  that the reader is correct against the exact file layouts the portal
  actually serves.

Run the manual suites before a release, not before every merge — they need
real infrastructure CI doesn't have (a database, survey data, a browser).

## Local toolchain gotchas (this machine — not CI, but easy to misdiagnose as a code bug)

- **Node must be 22, exactly.** Default Homebrew `node` on this machine has
  drifted newer, and a too-new Node makes `next dev`/`next build` start and
  then hang without binding a port or erroring — indistinguishable at a
  glance from a real bug. Use the Node 22 keg explicitly if `node -v`
  disagrees.
- **iCloud can evict `node_modules`.** This repo lives under `~/Documents`,
  which iCloud Drive manages; when disk fills, macOS turns files into
  dataless stubs, and every `require()` of one blocks in `read()` waiting on
  a network fetch. Symptom: a build or dev server prints its first message,
  then sits at ~0% CPU for many minutes with no error and no timeout — looks
  exactly like the Node-version problem above. Confirm with
  `stat -f %b <file>` returning 0 on files under `node_modules`. Fix:
  `rm -rf node_modules && npm ci`.
- **A clean build is ~20 seconds**, not minutes — if it's taking much longer,
  suspect the iCloud issue above before assuming something is actually slow.
- **Typecheck alone (`npx tsc --noEmit`) is fast and a good first signal** —
  run it before `npm run build`, since `next build` only typechecks what's
  reachable from a route and can miss a broken unreferenced module.
- **`npm run build` also lints**, and a Vercel deploy fails on a lint error —
  always run the full build before pushing, not just typecheck. A bare
  `eslint` CLI invocation will fail on its own (ESLint 9 wants a flat config
  this repo doesn't have); Next's internal lint step is what actually works.
- **Portal database tests** prefer embedded PGlite over live Supabase so
  they're not gated on the free-tier instance being awake.

## Reporting what you verified

State exactly which suites you ran and which you couldn't (missing
database, missing survey data, no browser available) — see the "No false
confidence" rule in `../../rules/sudaan-engineering.md`. "I couldn't run the
API/browser suites, only the synthetic engine suites" is a complete and
useful answer.
