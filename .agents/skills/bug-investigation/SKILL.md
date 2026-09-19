---
name: bug-investigation
description: Playbook for investigating and fixing a bug in Sudaan. Invoke as /bug-investigation. Covers reproducing before theorizing, checking the codebase's own history of silent-failure traps, and regression testing.
---

# Bug investigation

```
REPRODUCE → LOCATE LAYER → TRACE ROOT CAUSE → FIX → REGRESSION TEST → VERIFY
```

1. **Reproduce first.** Don't theorize from a description alone — run it.
   For a portal/GIS bug, check whether the report might actually be one of
   this codebase's known silent-failure modes before assuming new territory:
   - A MapLibre vector layer that's "just gone" with no console error →
     check the worker files in `public/vendor/` first (see `ui-guidelines`).
   - "Portal is completely broken" → check whether Supabase (free tier) has
     idled out before assuming a code regression.
   - An elevation/terrain value that looks wrong → check for a nodata
     sentinel (`-9999` etc.) or a `.dbf` numeric field being read as text
     before assuming the math is wrong (see `gis-development`).
   - A newly-uploaded data class making the map lose its layers → check
     whether it landed at `sites/<slug>/` root and collided with the map's
     `manifest.json` (see `gis-development`, `deployment`).
2. **Locate the layer.** UI, route handler, `*-source.ts`/`*-client.ts`,
   `src/lib/geo/*.mjs`, or the database/tenancy layer — use `repo-explorer`
   to trace it if the path isn't obvious.
3. **Trace root cause**, not just the symptom. This codebase has a track
   record of the visible symptom being one layer removed from the actual
   cause (a broken hillshade traced to an un-negated gradient; a lost map
   traced to a manifest-namespace collision two upload classes away).
4. **Fix** at the root cause, scoped to the bug — no incidental refactor.
5. **Regression test.** If an engine test exists for the affected module,
   confirm it would have caught this; if not, consider adding a check (this
   is exactly how `colour-consistency-test.mjs` and the nodata-range check
   came to exist — each guards a bug that already happened once).
6. **Verify** the actual fix, not just that the code compiles — browser
   check for anything user-visible (`qa-browser`), engine test for anything
   computational.
