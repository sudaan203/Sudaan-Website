# MCP strategy

Principle: **least privilege, and only where it materially beats what's
already available.** This repo already has `gh` (authenticated, write
collaborator), `wrangler` (Cloudflare), and Antigravity's own native browser
tool available to agents via the shell/IDE — an MCP server is worth adding
only when it does something those can't, or does it meaningfully more
safely (e.g. a scoped read-only DB role vs. a raw connection string in an
agent's hands).

**Current state: no project-level MCP servers configured.** This is a
deliberate outcome of the evaluation below, not an oversight — see
"Avoid overengineering" in the top-level task brief. If that changes, add
entries to `.agents/mcp_config.json` (workspace-scoped; see format at the
bottom of this file) rather than the global `~/.gemini/config/mcp_config.json`,
so the configuration travels with the repo.

## Evaluated

| Integration | Verdict | Why |
|---|---|---|
| **GitHub** | Not installed | `gh` CLI is already authenticated (`patel-om`, write collaborator) and covers PR/issue creation, review, and CI status via Bash. An MCP server would duplicate this with no capability gain, and would be another place a token could leak. Revisit only if an agent needs to *read* GitHub state (issues, PR comments) as structured data rather than parsed CLI output at high volume. |
| **Database (Postgres/Supabase)** | Not installed | The production `DATABASE_URL` is a live, tenant-data-holding, write-capable connection string. Handing it to an MCP server (and therefore to any agent with MCP access) is a bigger blast radius than the scripted, reviewed access patterns already in place (`scripts/portal-db-*.mjs`, `db/queries.ts`). If read-only DB inspection becomes a recurring need, the prerequisite is a **read-only Postgres role** scoped to non-sensitive tables — build that first, then reconsider a read-only MCP server against it. Until then, use `scripts/portal-db-seed.mjs`/migration scripts and PGlite-backed tests, which don't touch production. |
| **Browser** | Not installed as MCP — use Antigravity's native browser tool | Antigravity's IDE agent already drives a real browser natively (navigate, screenshot, inspect console/network) — this is the mechanism `qa-browser` and `ui-engineer` are written against. A separate browser MCP (e.g. Chrome DevTools MCP) would be redundant for the verification this project needs. Reconsider only for deep performance profiling (Core Web Vitals traces) beyond what's needed today. |
| **Deployment (Vercel)** | Not installed | Deploys are automatic on push to `main`; there's no recurring need for an agent to query deploy status programmatically today. The Vercel dashboard/CLI is sufficient for the rare manual check. Revisit if deploy-status checks become a routine part of the loop (e.g. verifying a deploy landed before running `qa-browser` against it). |
| **Monitoring / error tracking** | Not applicable | No Sentry, Datadog, or equivalent exists in this codebase. Nothing to integrate. |
| **Figma / design source** | Not applicable | No Figma or other design-source file found in the repo; design tokens live in `tailwind.config.ts` and `globals.css` directly. |
| **GIS/data sources** | Not applicable | No external GIS data API is consumed — all spatial data is the client's own survey deliverables, processed locally/in R2. |
| **Documentation** | Not installed | `docs/`, `context.md`, and this `.agents/` tree already cover project documentation; there's no external doc system (Confluence/Notion) to integrate. |
| **Cloud storage (R2)** | Not installed | `wrangler` and the existing scripts (`upload-site.mjs`, `r2-prune.mjs`, `publish-site.mjs`) already cover R2 access via the shell, with the review/authorization discipline in `SECURITY.md` attached to the destructive ones. An R2 MCP server would mostly duplicate `wrangler r2 object` commands; reconsider only if agents need frequent, fine-grained object listing that scripting the CLI makes awkward. |

## If a server is added later

- **Read-only by default.** Only grant write scope where a specific,
  named task requires it, and prefer a scoped credential over a full-access
  one (e.g. a read-only DB role, a fine-grained GitHub token) over reusing
  an existing full-access credential.
- **No secrets committed.** Reference credentials with `${VAR_NAME}`
  environment substitution in `.agents/mcp_config.json`, never a literal
  value.
- **State the security risk explicitly** in this file when adding an entry:
  purpose, permissions, read-only vs. read/write, and what happens if the
  credential leaks.

### Format (workspace-scoped, `.agents/mcp_config.json`)

```jsonc
{
  "mcpServers": {
    "example-read-only": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "API_KEY": "${SOME_API_KEY}" }
    }
    // Remote (SSE/HTTP) servers use "serverUrl", not "url" or "httpUrl" —
    // those legacy field names are not supported by current Antigravity.
  }
}
```
