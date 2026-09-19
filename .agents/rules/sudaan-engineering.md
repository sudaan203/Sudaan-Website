---
name: sudaan-engineering
description: Baseline engineering rules for every Sudaan agent. Always on.
activation: always_on
---

# Sudaan engineering rules

These apply to every agent working in this repository, regardless of tier.
Read [`../PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md) alongside this file —
the rules here are the "how", that file is the "what's actually here".

1. **Understand before modifying.** Read the surrounding code and the
   relevant section of `PROJECT_CONTEXT.md` before changing it. If a
   `repo-explorer` pass would answer "where does this live and how does it
   work today," run it before writing code.
2. **Inspect before inventing.** Don't assume a library, pattern, or file
   exists — check. This codebase has already been burned by assumptions
   (GDAL is not installed; there is no `npm test`; Node 22 is pinned).
3. **Reuse before creating.** Search for an existing component, engine
   function, or script before writing a new one. `src/lib/geo/` and
   `src/lib/portal/` are large; a new raster/geometry primitive probably has
   a sibling already.
4. **Follow existing project conventions**, not generic best practice, where
   they conflict. See "Existing Patterns" in `PROJECT_CONTEXT.md`
   (`*-source.ts`/`*-client.ts` split, dual `_DIR`/`_URL` storage mode, thin
   route handlers, pure `.mjs` engines).
5. **Keep changes focused.** A bug fix does not need a surrounding refactor.
6. **Avoid unrelated refactors** in the same change as a feature or fix.
7. **Avoid unnecessary dependencies.** This repo runs with almost none —
   no ORM query builder beyond Drizzle, no UI kit, no 3D library for the
   point cloud, hand-rolled shapefile/world-file parsing because GDAL isn't
   available. Adding a dependency to avoid writing 20 lines is a net loss
   here more often than not.
8. **Never expose secrets.** No API keys, connection strings, or the
   contents of `.env.local` in code, commits, agent output, or Markdown.
   `.env.example` documents *names* only.
9. **Never commit credentials.**
10. **Never perform destructive production operations without explicit
    authorization** — this includes writes to the Supabase database, R2
    bucket deletions/pruning (`r2-prune.mjs`), and Vercel/Cloudflare config
    changes. Read-only inspection is fine; anything that mutates shared
    state is not, without asking first.
11. **Preserve existing API contracts.** Route handlers under `src/app/api/**`
    are consumed by the portal UI and, in the case of the tile gateway, by
    the Cloudflare Worker's expectations of the grant format — changing a
    response shape or the grant token format is a two-sided change.
12. **Prefer migrations for schema changes.** New SQL in `drizzle/000N_*.sql`,
    applied via `scripts/portal-db-migrate.mjs`. Never hand-edit a shipped
    migration; add a new one.
13. **Test meaningful changes.** Run the relevant `scripts/*-test.mjs`
    suite(s) — see the `testing` skill for which ones apply and which need a
    database or real survey data you may not have locally.
14. **Browser-test meaningful UI changes.** Source-code inspection is not
    verification for anything the client sees. Use the QA agent or run the
    app and look.
15. **Inspect `git diff` before finishing.** Confirm the change matches what
    was intended and nothing unrelated crept in.
16. **Never claim success without verification.** If a command could not be
    run, a browser could not be opened, or an assumption is unverified, say
    so explicitly rather than implying it was checked. See "No False
    Confidence" in the coordinator's own instructions.
17. **Document significant architectural decisions** the way this repo
    already does — in `docs/`, or as a comment explaining *why* at the
    decision point — not as a new top-level Markdown file for every change.
18. **Prefer maintainability over cleverness.**
19. **Prefer simple solutions over unnecessary abstraction.** This repo has a
    working example of the failure mode to avoid: five independent elevation
    colour ramps before `elevation-image.mjs` unified them. Don't recreate
    parallel implementations of something that should be one function.
20. **Treat existing application behavior as intentional unless evidence
    indicates otherwise.** Several things that look like bugs at a glance are
    documented decisions (view-only downloads, no basemap by default, the
    RMSE fallback being global not per-site) — check `context.md` and
    `docs/` before "fixing" one.

Existing project code is the primary source of truth for implementation
conventions unless the user explicitly requests a change.

## Git safety

- Run `git status` before any significant work, and again before finishing.
- Never reset, discard, or overwrite changes you didn't make.
- Never force-push, never delete a branch, never overwrite a file outside
  the scope of the current task.
- Inspect `git diff` before declaring a task complete.
- Do not commit unless the user explicitly asked for a commit.
