---
name: security
description: Sudaan's actual security posture — auth/session model, tenant isolation, secret handling, CSP, rate limiting, R2/Worker boundary, and what was reviewed and fixed vs. what's known and accepted. Load before touching auth, the database, file/asset routes, or anything handling user input or secrets.
---

# Security

This reflects an actual security review already performed on this codebase
(`context.md` §8e, `scripts/portal-security-test.mjs`), not generic
guidance. Read it before assuming something here needs "hardening" — several
things that look minimal are deliberate, reviewed choices.

## Secrets

- Never in code, commits, Markdown, or agent output. `.env.example`
  documents variable **names** only, with real incident history explaining
  why each one matters — extend that pattern, never paste a real value into
  it.
- `PORTAL_AUTH_SECRET` and `PORTAL_TILE_SECRET` must differ; the app refuses
  to start otherwise. The auth secret never leaves our infrastructure; the
  tile secret is deployed to Cloudflare's edge.
- `.env.local` is gitignored and must stay that way. Don't read it into
  agent output even for debugging — describe what env var is missing or
  wrong, don't echo its value.

## Auth and sessions

- **Google OAuth only** (no password path — removed 18 Sep 2026). The known,
  accepted residual risk: a Google outage locks everyone out, owners
  included. Don't "fix" this by re-adding a fallback without the user
  explicitly asking — it was a deliberate trade for removing an entire class
  of credential-handling risk.
- OAuth verifies **state, nonce, the id_token signature against Google's
  JWKS, issuer, audience, and `email_verified`** — already sound, treat as a
  baseline not to weaken.
- Sessions are **JWTs, rechecked against the `users` table on every
  request** (not just at mint time), specifically because a session used to
  stay valid for hours after a user was deactivated. Don't reintroduce a
  purely-stateless check for the "is this user still allowed in" question.
- `PORTAL_OWNER_EMAILS` bootstraps the first owners against an empty
  database; everyone else is granted through the console.

## Tenant isolation

- Enforced in **one place**, `src/lib/portal/db/queries.ts`, in SQL. A new
  query touching `sites`/`assets`/`surveys` should go through it, not
  duplicate a filter inline.
- **A denied read answers 404, never 403** — confirming an id doesn't exist
  vs. exists-but-forbidden is itself information leakage, and this codebase
  treats that as worth avoiding consistently (owner console routes 404 a
  client too, rather than hinting the admin area exists).
- `requireOwner()` gates all six owner server actions.

## Network / headers

- CSP is set and strict except `script-src`, which needs `'unsafe-inline'`
  for Next's hydration bootstrap — a known, accepted gap, not an oversight.
  `frame-ancestors`, `base-uri`, `object-src`, `form-action` are the real
  protections in place.
- **Headers must be set in `next.config.mjs`, not a route handler** — a
  route-level CSP was previously silently discarded because the config-level
  header set overrode it. Anything per-response security-relevant needs to
  be in the config to actually take effect.
- Portal responses send `no-store` so a shared machine's back button can't
  reveal the previous session's data.

## File / asset serving

- The asset route serves through a **MIME-type allowlist**, not whatever the
  catalogue claims — an `image/svg+xml` or `text/html` served from our
  origin is same-origin script; this was fixed before uploads existed and
  should not regress once they do.
- File reads refuse anything resolving outside the files root.
- **View-only**: no download affordance for client deliverables, a
  deliberate product decision, not a gap to close.

## Rate limiting

- `/api/contact` and login are throttled — email+IP *and* a per-IP ceiling
  (email-only throttling permits spraying one guess across many addresses
  from one host).
- The limiter reads the **last** `x-forwarded-for` hop, not the first — the
  first is caller-supplied and spoofable.
- Known and accepted: rate limiting is per serverless instance, not global.

## R2 / Worker boundary

- Bucket is **private**, no public URL of any kind. The Worker
  (`workers/tile-gateway/`) is the *only* path to it: no listing, GET/HEAD
  only, and a grant's signature is checked *and* its scope against the
  requested key — a valid signature alone doesn't authorize an arbitrary
  object.
- Treat `workers/tile-gateway/src/index.js` as part of the security
  boundary when reviewing changes to it, not as plumbing — it's the last
  thing between a private bucket and the internet.

## Known and accepted (don't "fix" without asking)

- Rate limiting is per-instance, not global.
- Logs carry email addresses.
- `script-src` allows inline (Next's hydration requires it today; nonces are
  the documented upgrade path, not yet built).
- The RMSE/accuracy fallback (`PORTAL_SURVEY_RMSE_Z`) is a global constant by
  design — a per-site figure belongs in the database, not the environment.

## Destructive operations

Never perform a write against production data (Supabase, R2) — including
`r2-prune.mjs` — without explicit authorization from the user, even if the
operation looks routine (e.g. removing what appears to be an orphaned
object). Read-only inspection is always fine.
