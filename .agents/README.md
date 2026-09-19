# Sudaan — Antigravity multi-agent engineering system

A practical, Antigravity-native agent setup for this repository: one
coordinator, specialized subagents, shared rules and skills, and a
documented (mostly empty, deliberately) MCP strategy. Not a documentation
exercise — every agent file here is meant to be actually selected and run.

## Architecture

```
                         USER
                          |
                          v
                 SUDAAN COORDINATOR  (pro, mainAgent)
                          |
         task classification: what does this touch?
                          |
   +-----------+----------+----------+-----------+----------------+
   |           |          |          |           |                |
   v           v          v          v           v                v
repo-explorer ui-engineer backend-  gis-engineer qa-browser  architecture-
  (flash)      (pro)     engineer     (pro)       (flash)      reviewer
                          (pro)                                  (pro)
   |           |          |          |           |                |
   +-----------+----------+----------+-----------+----------------+
                          |
                 COORDINATOR: integrate, verify, review diff
                          |
                        REPORT
```

Repo-explorer and QA are `flash` (cheap, fast, narrow) because their job is
search and independent verification, not judgment. UI/backend/GIS/
architecture work is `pro` because it requires real reasoning about a
codebase with a lot of non-obvious, hard-won constraints (see
`PROJECT_CONTEXT.md`'s "Architectural Constraints"). The coordinator is
`pro` because integration and review is where a wrong call costs the most.

Model tiers are `inherit` / `flash` / `pro`, per Antigravity's documented
tier mechanism — never a hard-coded model name. A developer can always
override via Antigravity's own model selector for a specific run; the
repository configuration stays tier-based so it doesn't go stale as the
underlying models change.

## Agents (`agents/`)

| Agent | Model | Role | Permissions | Use when |
|---|---|---|---|---|
| [`sudaan-coordinator`](agents/sudaan-coordinator.md) | pro | Orchestrator | Full — reads/writes/delegates | Any non-trivial request; the default entry point |
| [`repo-explorer`](agents/repo-explorer.md) | flash | Investigation | Read-only | "Where is X," "how does Y work," "does this exist already" |
| [`ui-engineer`](agents/ui-engineer.md) | pro | Frontend | Full, browser-verifies its own work | Substantial UI/UX, marketing or portal |
| [`backend-engineer`](agents/backend-engineer.md) | pro | API/DB/auth | Full | API, schema, auth, data processing |
| [`gis-engineer`](agents/gis-engineer.md) | pro | Spatial/GIS | Full | Raster/vector, map, coordinate systems, numbered dashboard tools |
| [`qa-browser`](agents/qa-browser.md) | flash | Independent QA | Sandboxed, browser + read | After any user-facing change |
| [`architecture-reviewer`](agents/architecture-reviewer.md) | pro | Analysis | Sandboxed, recommends only | Multi-subsystem or high-risk decisions |

## Delegation strategy

The coordinator handles anything it can resolve directly (single-file edits,
config, copy). It delegates when the task genuinely benefits from a
narrower, cheaper agent (broad search → `repo-explorer`) or from
specialized judgment (`ui-engineer`/`backend-engineer`/`gis-engineer`), and
it always routes user-facing changes through `qa-browser` before calling
them done. `architecture-reviewer` is reserved for genuine forks in the
road — see its own file for the specific triggers. Trivial work is never
delegated merely to exercise the machinery; see `rules/sudaan-engineering.md`
rule 5 and the coordinator's own "When to delegate" section.

## Skills (`skills/`)

Loaded automatically by relevance, or invoked directly as `/<name>`:

- `sudaan-architecture` — fast lookup map of the codebase
- `ui-guidelines` — design tokens, component conventions, frontend traps
- `gis-development` — the GIS engine, formats, storage/tiling, known bugs
- `testing` — what CI runs, what's manual, local toolchain gotchas
- `deployment` — Vercel + Worker deploy topology, env var conventions
- `security` — auth/tenancy/secrets, what's reviewed vs. known-and-accepted
- `feature-development`, `bug-investigation`, `production-issue`,
  `refactoring` — the four requested workflow playbooks, implemented as
  skills rather than legacy Workflows (see `workflows/README.md` for why)

## Rules (`rules/`)

`sudaan-engineering.md` — always-on baseline for every agent: understand
before modifying, reuse before creating, no unrelated refactors, no secrets,
migrations for schema changes, browser-verify UI changes, verify before
claiming success, git safety.

## MCP strategy

See [`MCP_SETUP.md`](MCP_SETUP.md). Short version: nothing is installed by
default. `gh`, `wrangler`, and Antigravity's native browser tool already
cover GitHub, Cloudflare/R2, and browser verification without adding a new
credential surface; a database MCP specifically is withheld until a
read-only Postgres role exists to scope it to. Least privilege, and only
where it beats what's already available.

## Workflows

Legacy Antigravity Workflows are being retired (stop working 1 Nov 2026).
The four requested playbooks are implemented as skills instead — see
[`workflows/README.md`](workflows/README.md).

## How a developer should interact with this system

Ask the coordinator directly — it decides what to delegate. To force a
specific agent, name it, or use Antigravity's agent picker. To force a
specific playbook, invoke its skill directly (`/feature-development`, etc.).
To override the model tier for a specific run (e.g. force `pro` on a search
that turned out to be subtle), use Antigravity's own model selector — don't
edit an agent's `model:` field for a one-off need.

## Security principles

No secrets in any file under `.agents/`. Least-privilege MCP access.
Destructive/production operations need explicit user authorization. Full
detail: [`SECURITY.md`](SECURITY.md) and the `security` skill.

## Validating this system

Before trusting it: open `PROJECT_CONTEXT.md` and check it still matches
`git log`/`docs/tool-catalogue.md` (this repo's architecture moves — 28 of
Malhar's 40 tools were live as of the last audit, and status changes
regularly). Confirm agent frontmatter parses (`model` is one of
`inherit`/`flash`/`pro`; `mainAgent`/`subagent` are booleans). If Antigravity's
supported agent/skill schema changes, update the frontmatter here rather
than the architecture — the intent (coordinator → specialized agents →
independent QA → review) should outlive any one version's exact YAML shape.

## What this system does not change

No application source code was modified to build this. `PROJECT_CONTEXT.md`,
the rules, skills, and agent files describe the repository as found; they
don't prescribe a different architecture than the one already running in
production.
