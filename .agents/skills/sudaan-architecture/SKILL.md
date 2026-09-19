---
name: sudaan-architecture
description: Quick-reference map of the Sudaan repository's architecture — where the marketing site, portal, GIS engine, database, and storage layers live and how they connect. Load before navigating unfamiliar parts of the codebase or deciding which agent/subsystem a task touches.
---

# Sudaan architecture, at a glance

Full detail lives in [`.agents/PROJECT_CONTEXT.md`](../../PROJECT_CONTEXT.md)
and, deeper still, [`context.md`](../../../context.md) at the repo root and
[`docs/`](../../../docs/). This skill is the fast lookup, not the source of
truth — when it's silent or stale, go to those.

## Two products, one repo

- **Marketing site**: `src/app/{page,services,projects,about,blog,contact,data-insights}` +
  `src/components/*` (top level) + `src/data/*`. Static/typed content,
  server components, no auth.
- **Client portal**: `src/app/portal/**` + `src/app/api/portal/**` +
  `src/components/portal/*` + `src/lib/portal/*`. Behind Google-only auth,
  tenant-isolated, its own GIS engine.

## Where a given concern lives

| Concern | Location |
|---|---|
| Auth / session | `src/lib/portal/{auth,session,google,users-db}.ts`, `src/middleware.ts` |
| Tenant visibility | `src/lib/portal/db/queries.ts` (the *only* place) |
| DB schema | `src/lib/portal/db/schema.ts`, migrations in `drizzle/*.sql` |
| Raster/geometry computation | `src/lib/geo/*.mjs` (pure, framework-free) |
| Storage-mode-aware readers | `src/lib/portal/*-source.ts` |
| Browser-side data access | `src/lib/portal/*-client.ts` |
| Portal tool panels | `src/components/portal/*Panel.tsx` |
| Tool status (built/not) | `src/lib/portal/tool-catalogue.ts` → `docs/tool-catalogue.md` |
| Private object storage door | `workers/tile-gateway/` (Cloudflare Worker, only path to R2) |
| Data-prep pipelines | `scripts/{terrain,hydro,forest,prepare-map-data,prepare-point-cloud}*.mjs` |
| Publish a survey | `scripts/publish-site.mjs` |
| Elevation colour (single owner) | `src/lib/geo/elevation-image.mjs` |

## Request flow, portal tool call

```
browser → src/app/api/portal/sites/[siteSlug]/<tool>/route.ts
        → session check (auth.ts) → tenant check (db/queries.ts)
        → *-source.ts reads a byte-range window of the raster
        → src/lib/geo/*.mjs computes
        → JSON/PNG/tile response
```

For tiles specifically, after the first grant the browser talks to the
Cloudflare Worker directly (`tiles.<domain>`), bypassing Next.

## Deploy topology

Two independent deploys: the Next app on **Vercel** (auto, on push to
`main`), and the tile-gateway **Cloudflare Worker** (`wrangler deploy`,
manual, from `workers/tile-gateway/`). A change to `tile-grant-core.mjs`
affects both and needs both redeployed.

## When in doubt about a tool's status

Never infer a numbered tool (Malhar's spec, #1–40, or forest F1–F16) is built
or not from the original spec document. Check `docs/tool-catalogue.md` —
it's generated from the same list the dashboard reads, so it cannot disagree
with the running app the way a static spec can.
