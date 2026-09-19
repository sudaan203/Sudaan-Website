---
name: deployment
description: Sudaan's actual deployment process — Vercel auto-deploy for the Next app, a separately-deployed Cloudflare Worker for the tile gateway, the environment-variable conventions (local dir vs. production URL pairs), and the one-command survey publish pipeline. Load before touching env vars, the Worker, or the publish scripts.
---

# Deployment

## Two independent deploys

1. **Next.js app → Vercel.** Auto-deploys on every push to `main`. No manual
   step for ordinary app changes.
2. **Cloudflare Worker (`workers/tile-gateway/`) → Cloudflare, manually.**
   `cd workers/tile-gateway && npx wrangler deploy`. This does **not**
   happen automatically and is **not** triggered by the Vercel deploy. A
   change to `src/lib/portal/tile-grant-core.mjs` (imported by both the
   portal and the Worker, by relative import, deliberately so the two can't
   drift) needs both sides redeployed together.

## Environment variables

Documented name-by-name, with the incident history, in `.env.example` — read
it before adding or changing one; it is not filler. The recurring pattern:
every large data class has a `PORTAL_<CLASS>_DIR` (local disk, gitignored,
never valid in production — Vercel's filesystem is read-only and has a
~250 MB bundle limit) and `PORTAL_<CLASS>_URL` (production, HTTP range reads
against the Worker). Unset both and the feature reports itself unavailable
rather than failing on first use; set both and the URL wins.

Two secrets, and they **must differ** — the app refuses to start if they
match:
- `PORTAL_AUTH_SECRET` — signs the portal session cookie, stays on our infra.
- `PORTAL_TILE_SECRET` — signs the short-lived tile grant, deployed to the
  Worker (`npx wrangler secret put PORTAL_TILE_SECRET`), so the edge can
  verify grants without holding the session-signing key.

`DATABASE_URL` must use the Supabase **transaction pooler, port 6543**,
identically in local dev, production, and test scripts — a past local/prod
port mismatch hid a production outage for days because nothing local could
reproduce it. `getDb()` warns if it sees port 5432.

Keep local and Vercel env values identical wherever the variable name
matches — this codebase has direct precedent for a single differing digit
causing a multi-day, hard-to-diagnose production-only outage.

## Publishing a survey (the actual pipeline)

```
node scripts/publish-site.mjs <prepared-folder> <slug> --publish
```

Builds, uploads every data class to R2, writes the catalogue, prints the
client's link — one command, replacing what used to be five manual steps
plus a Vercel environment edit. Upstream of that: `terrain-run.mjs`,
`hydro-run.mjs`, `forest-run.mjs`, `prepare-map-data.mjs`,
`prepare-point-cloud.mjs` produce the prepared layers first.

`scripts/r2-prune.mjs` removes orphaned R2 objects — treat as a destructive
production operation requiring explicit authorization, not routine cleanup;
it has previously found a site's point cloud stored twice.

## R2 / Worker specifics

- Bucket stays **private** — no public `r2.dev` URL, no public custom domain
  on the bucket. The Worker is the only door; this is a design decision, not
  a TODO.
- The Worker does **no listing, no writes (GET/HEAD/OPTIONS only), no
  cross-site reads, and carries no identity** — a valid grant signature
  proves *we* issued it, not that it covers the object being requested; both
  are checked. Compromising the edge yields tiles, not a user account.
- Route must be a subdomain of the portal's own domain (e.g.
  `tiles.sudaangeo.in` under `sudaangeo.in`) or the grant cookie — scoped via
  `PORTAL_TILE_COOKIE_DOMAIN` — won't be sent with tile requests. Leave that
  variable empty in local dev; a `Domain` attribute on localhost stops the
  cookie being stored at all.

## Build-specific gotchas

`outputFileTracingIncludes` patterns in `next.config.mjs` must stay narrow
and anchored (e.g. `portal-data/files/**`) — a broad glob walks the
gitignored, multi-hundred-MB survey data tree and hangs the build at trace
collection. `npm run build` needs outbound network access for Google Fonts.
