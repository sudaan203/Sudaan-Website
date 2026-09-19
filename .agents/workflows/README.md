# Why this directory is (almost) empty

The task that produced `.agents/` asked for reusable development workflows
(Feature Development, Bug Investigation, Production Issue, Refactoring),
"where supported by the current Antigravity version."

Checked against Antigravity's own docs (`antigravity.google/docs/ide/workflows/`,
`antigravity.google/docs/migration/workflows-to-skills/`) as of 19 Sep 2026:
legacy Workflows (`.agents/workflows/*.md`, triggered by a `/` command) are
supported but **scheduled to stop being indexed and executable after 1 Nov
2026**. Their replacement is a Skill placed in `.agents/skills/<name>/SKILL.md`,
which is invokable the same way — `/<name>` — and doesn't expire.

So, per this system's own rule (adapt to the actually-supported mechanism,
document the adaptation, don't build on something about to be removed), the
four requested playbooks live as skills instead:

- [`../skills/feature-development/`](../skills/feature-development/SKILL.md)
- [`../skills/bug-investigation/`](../skills/bug-investigation/SKILL.md)
- [`../skills/production-issue/`](../skills/production-issue/SKILL.md)
- [`../skills/refactoring/`](../skills/refactoring/SKILL.md)

Each is invoked the same way a workflow would be: `/feature-development`,
`/bug-investigation`, `/production-issue`, `/refactoring`.

If a future Antigravity version reintroduces workflows as something
materially different from skills, re-evaluate; as of this writing they're
the same mechanism with skills being the one that keeps working.
