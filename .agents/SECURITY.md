# Security

This is the top-level pointer every agent should know exists. The detailed,
regularly-loaded version is the [`security` skill](skills/security/SKILL.md)
— read that for the actual mechanisms, the security review history, and
what's known-and-accepted vs. needs fixing. This file exists so the policy
is discoverable without an agent having to guess the skill's name.

## Secret management

- Real secrets live only in `.env.local` (gitignored) locally and in
  Vercel's/Cloudflare's own secret stores in production — never in code,
  Markdown, agent output, or `.agents/` files.
- `.env.example` documents variable **names** with context, never values.
  It's already thorough; extend it in the same style rather than duplicating
  its content elsewhere.
- `PORTAL_AUTH_SECRET` and `PORTAL_TILE_SECRET` must differ (enforced at
  startup) — one is a session-signing key that never leaves our
  infrastructure, the other is deployed to Cloudflare's edge.
- No agent should read `.env.local` and echo its contents, even for
  debugging. Describe the *symptom* (e.g. "DATABASE_URL appears unset or
  points at the wrong pooler port"), not the value.

## Environment variables

Each large data class (terrain/map/hydrology/forest/cloud) has a
`PORTAL_<CLASS>_DIR`/`PORTAL_<CLASS>_URL` pair — see the `deployment` skill.
Keep local and production values identical for shared variables; a
divergence here previously hid a production outage for days.

## Authentication / authorization

Google OAuth only, JWT sessions rechecked against the `users` table on every
request, tenant visibility decided in exactly one SQL-backed function
(`db/queries.ts`), denied reads answer 404. See the `security` skill for the
full mechanism and what's been reviewed.

## Database access

- Read-only inspection of the schema/data is fine for investigation.
- Any write, delete, or migration against the **production** database needs
  explicit user authorization — this includes anything run against the live
  Supabase instance, not just obviously destructive commands.
- Prefer PGlite-backed test scripts over touching live Supabase when
  verifying database logic.

## API keys

- Google OAuth credentials, R2 API tokens, and the Resend key (if
  configured) are the external API keys in this project. Same rule as all
  secrets: names only in `.env.example`, real values only in `.env.local`
  and the hosting platforms' own secret stores.

## Production safety

- No destructive production operation (database writes/deletes, R2 pruning,
  Cloudflare Worker deploys that change security-relevant behavior) without
  explicit authorization.
- The tile-gateway Worker (`workers/tile-gateway/`) is part of the security
  boundary — review changes to it with the same weight as changes to auth
  code, not as routine infrastructure plumbing.

## File upload / asset security

The asset route serves through a MIME-type allowlist (not the catalogue's
claimed type) and refuses paths resolving outside the files root — both
fixed after review, both must hold for any new upload/serving path.

## User data

Client data (survey deliverables, contact-form submissions, account emails)
is tenant-isolated and view-only by design. Logs currently carry email
addresses — known and accepted, not something to silently change.

## GIS data

Survey rasters, point clouds, and derived layers are proprietary client
deliverables, served only through the tenant-checked, grant-authorized path
(Next route → tile grant → Worker → private R2). Never introduce a path that
serves this data without going through that chain, including for debugging.

## Logging

Don't log secrets, full session tokens, or raw database connection strings.
Existing logs including email addresses is a known, accepted tradeoff, not
license to log more sensitive material by default.

## Sensitive information in agent output

Treat anything from `.env.local`, database contents, or R2 object contents
as data to describe, not to paste verbatim into a report, commit message, or
PR description.
