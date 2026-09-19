---
name: refactoring
description: Playbook for refactoring in Sudaan — understanding why the current design is the way it is before changing it, since several "obviously wrong" patterns here are documented, deliberate decisions. Invoke as /refactoring.
---

# Refactoring

```
UNDERSTAND CURRENT DESIGN → IDENTIFY PROBLEM → DEFINE CONSTRAINTS → REVIEW OPTIONS → IMPLEMENT IN SMALL STEPS → TEST → REVIEW DIFF
```

1. **Understand current design first.** Check `PROJECT_CONTEXT.md`'s
   "Architectural Constraints" and "Existing Patterns", and `context.md`/`docs/`
   for the decision history. This codebase has real precedent for something
   that looks like an obvious refactor target actually being deliberate:
   the dual `PORTAL_<CLASS>_DIR`/`_URL` pattern repeated five times looks
   like it wants a single config object, but each pair also carries its own
   documented incident history in `.env.example` — collapsing them without
   preserving that context would be a regression in institutional memory,
   not just code.
2. **Identify the actual problem**, not just "this could be cleaner." This
   repo's own best refactor (unifying five elevation-colour implementations
   into `elevation-image.mjs`) happened because divergence had already
   caused a real, shipped bug (an inverted hillshade), not because five
   copies looked untidy in the abstract.
3. **Define constraints** before picking an approach — what must keep
   working (API contracts, the Worker/portal grant-format agreement, tenant
   isolation), what's actually free to change.
4. **Review options.** For anything spanning multiple subsystems or with
   real migration risk, use `architecture-reviewer` rather than picking the
   first approach.
5. **Implement in small steps.** Prefer a sequence of reviewable changes
   over one large diff, especially across `src/lib/geo/` (many call sites)
   or the database schema (migration risk).
6. **Test** after each step, not just at the end — `node scripts/<engine>-test.mjs`
   for anything in `src/lib/geo/`, the relevant portal suite for anything
   touching auth/db/storage.
7. **Review the diff** against the original problem: does it solve what was
   identified in step 2, and nothing else? Unrelated cleanup in the same
   change is exactly what the shared engineering rules ask you not to do.
