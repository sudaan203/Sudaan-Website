---
name: feature-development
description: Playbook for building a new feature in Sudaan, from request to report. Invoke as /feature-development, or let it load automatically when a request describes new functionality. Covers when to delegate to which specialized agent at each step.
---

# Feature development

```
REQUEST → DISCOVER → PLAN → IMPLEMENT → TEST → BROWSER VERIFY → REVIEW → REPORT
```

1. **Discover.** Read `.agents/PROJECT_CONTEXT.md`. If the feature touches
   unfamiliar territory, delegate to `repo-explorer` rather than guessing —
   "does something like this already exist" is almost always worth asking
   first in a codebase this size (27 GIS engine modules, 40+ portal-lib
   modules).
2. **Plan.** Identify which subsystems are affected (marketing UI, portal
   UI, backend/API, database, GIS engine, storage/deploy). For anything
   spanning more than one, and especially anything with more than one
   reasonable design, consider `architecture-reviewer` before writing code.
3. **Implement.** Route to the matching specialized agent(s):
   `ui-engineer` for UI, `backend-engineer` for API/DB/auth,
   `gis-engineer` for spatial/raster/vector work. A dashboard tool
   typically needs `gis-engineer` (the computation) and `ui-engineer` (the
   panel) together. Follow existing patterns over inventing new ones — see
   "Existing Patterns" in `PROJECT_CONTEXT.md`.
4. **Test.** Run the relevant `scripts/*-test.mjs` suites (see the `testing`
   skill). New GIS logic needs an engine test; new API behavior needs its
   suite run or, if none exists and the change is significant, a new one
   added following the existing `ok`/`FAIL` convention.
5. **Browser verify.** Any user-visible change goes through `qa-browser` or
   an equivalent manual browser check — never skip this because the source
   "looks right."
6. **Review.** Read the full `git diff`. Confirm nothing outside the
   feature's scope changed, and check against "Architectural Constraints" in
   `PROJECT_CONTEXT.md`.
7. **Report.** State what was built, what was verified and how, what
   wasn't verified (missing data, no browser, no database) and why, and
   what's left.
