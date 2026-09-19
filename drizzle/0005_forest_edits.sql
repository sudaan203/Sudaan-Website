-- The forest inventory's first write path (`docs/forest-tools-plan.md` §6).
--
-- Every portal route before this one only ever read. This table is the entire
-- design decision in §6.1: the inventory `forest-run.mjs` writes is immutable
-- and is never patched in place. An edit is a row here, and the served
-- inventory is the precomputed artefact with these rows applied on read
-- (src/lib/portal/forest-edits.ts). Re-running detection therefore cannot
-- destroy a client's corrections — it produces a new tree list, and the
-- existing edits are re-associated to it (§6.2), not discarded.
--
-- tree_id is deliberately NOT a foreign key into anything. There is no trees
-- table — the inventory lives in flat files in R2/portal-data, never in
-- Postgres — and the id itself is a hash of a quantised apex position
-- (scripts/forest-run.mjs), which is stable only up to a tolerance, not
-- byte-for-byte across runs. A foreign key would have to point at a row that
-- may not exist yet (a newly added tree) or may no longer resolve after a
-- re-run (§6.2's re-basing is exactly the operation that reattaches an edit
-- whose old tree_id no longer matches anything). It stays a plain text
-- column, matched against the current run's tree list in application code.
--
-- operation and payload follow the same split access_changes uses for
-- `action`/`detail`: a short, indexable label plus an open jsonb bag, because
-- the seven operations (add, delete, move, split, merge, edit_attributes,
-- edit_crown, recalculate) each need a different shape of data and a rigid
-- column set would grow a new nullable column per operation forever.

create table if not exists forest_edits (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  -- The durable spatial hash from scripts/forest-run.mjs, or null for a tree
  -- this edit itself adds (an "add" has nothing to reference yet).
  tree_id     text,
  operation   text not null check (operation in (
                'add', 'delete', 'move', 'split', 'merge',
                'edit_attributes', 'edit_crown', 'recalculate')),
  payload     jsonb not null default '{}',
  author_id   uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Every read of "this site's effective inventory" loads its whole edit log in
-- creation order (later edits apply on top of earlier ones, same rule
-- access_changes' created_at ordering already gives an audit trail), so the
-- site is the index that matters.
create index if not exists forest_edits_site_idx on forest_edits (site_id, created_at);

-- Re-basing (§6.2) looks up "every existing edit for this tree_id" per site,
-- so the pair is worth its own index rather than a scan of the site's rows.
create index if not exists forest_edits_site_tree_idx on forest_edits (site_id, tree_id);
