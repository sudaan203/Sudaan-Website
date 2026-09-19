---
name: production-issue
description: Playbook for a production incident in Sudaan — gathering evidence safely, distinguishing a real regression from a known operational quirk (Supabase free-tier idling, a stale env var), and documenting the outcome the way this repo already does. Invoke as /production-issue.
---

# Production issue

```
GATHER EVIDENCE → ASSESS IMPACT → REPRODUCE SAFELY → FIX → VERIFY → DOCUMENT
```

1. **Gather evidence** before acting. What's actually failing — the
   marketing site, the portal, one tool, one client's data? Check Vercel
   deploy status and, if the tile gateway is implicated, whether it was
   redeployed alongside the last portal change (the two deploy
   independently — see the `deployment` skill).
2. **Assess impact.** One client or all of them? Read-path or write-path?
   Is this a known operational pattern rather than a regression — most
   notably, **Supabase's free tier idles out and looks exactly like "the
   whole portal is broken."** Check that before assuming code changed.
3. **Reproduce safely.** Prefer reading logs/state over touching production
   data. Any write against Supabase or R2 (including `r2-prune.mjs`) needs
   explicit user authorization — this is not the place to experiment.
4. **Fix**, scoped to the incident.
5. **Verify** against production or the closest safe approximation
   (`portal-security-test.mjs` runs against a production build, for
   example). State plainly what you could and couldn't verify without
   touching live infrastructure.
6. **Document** the way this repo already does it — not a new incident-log
   file for its own sake, but a note at the decision point (a comment
   explaining *why*, a line in `docs/` if it's architectural) with enough
   detail that the next person doesn't rediscover it the hard way. The
   `.env.example` file and `context.md` are full of exactly this kind of
   note (the pooler-port outage, the manifest-namespace collision) — match
   that register: specific, dated where it matters, and honest about what
   was inferred vs. measured.
