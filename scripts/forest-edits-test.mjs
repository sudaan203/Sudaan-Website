/**
 * Tests for the forest inventory's write path (`docs/forest-tools-plan.md` §6).
 *
 * Two halves, in the style `forest-test.mjs` and `tenancy-test.mjs` each hold
 * one of on their own:
 *
 *   - **Re-basing and applying** (`src/lib/portal/forest-edits.ts`) are pure
 *     functions over plain arrays, so they are checked here against
 *     hand-built fixtures — no database, no `trees.bin` on disk — the same
 *     discipline `forest-test.mjs` holds the engine to.
 *   - **Tenancy** is checked against real Postgres DDL (every migration,
 *     0001 through the new 0005), the same way `tenancy-test.mjs` proves
 *     `siteVisible()`'s rule with PGlite rather than trusting a description
 *     of it. What is new here beyond what `tenancy-test.mjs` already proves
 *     is `forest_edits`' own cascade behaviour and that a tenancy-scoped join
 *     through it respects exactly the same visibility rule every other table
 *     already does.
 *
 * Run:
 *   node scripts/forest-edits-test.mjs
 */

import {
  rebaseEdits,
  applyEdits,
  assertValidPayload,
  isEditOperation,
  PayloadError,
  rebaseToleranceMetres,
  REBASE_TOLERANCE_CELLS,
} from "../src/lib/portal/forest-edits.ts";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

const CELL = 0.25;

function tree(id, x, y, extra = {}) {
  return { id, x, y, ...extra };
}

function edit({ treeId = null, operation, payload, id = `e-${Math.random().toString(16).slice(2)}`, createdAt = new Date().toISOString() }) {
  return { id, siteId: "site-1", treeId, operation, payload, authorId: null, createdAt };
}

// ---------------------------------------------------------------------- //
console.log("\n--- assertValidPayload ---");
{
  check("add requires numeric x/y", (() => {
    try { assertValidPayload("add", { x: 1 }); return false; } catch (e) { return e instanceof PayloadError; }
  })());
  check("add accepts x/y", (() => {
    const p = assertValidPayload("add", { x: 1, y: 2 });
    return p.x === 1 && p.y === 2;
  })());
  check("delete requires an anchor", (() => {
    try { assertValidPayload("delete", {}); return false; } catch (e) { return e instanceof PayloadError; }
  })());
  check("delete accepts an anchor", (() => {
    assertValidPayload("delete", { anchorX: 10, anchorY: 20 });
    return true;
  })());
  check("move requires toX/toY as well as an anchor", (() => {
    try { assertValidPayload("move", { anchorX: 1, anchorY: 2 }); return false; } catch (e) { return e instanceof PayloadError; }
  })());
  check("edit_attributes requires a changes object", (() => {
    try {
      assertValidPayload("edit_attributes", { anchorX: 1, anchorY: 2, changes: "nope" });
      return false;
    } catch (e) { return e instanceof PayloadError; }
  })());
  check("split requires exactly one source", (() => {
    try {
      assertValidPayload("split", {
        sources: [{ treeId: "a", anchorX: 0, anchorY: 0 }, { treeId: "b", anchorX: 0, anchorY: 0 }],
        results: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      });
      return false;
    } catch (e) { return e instanceof PayloadError; }
  })());
  check("split requires at least two results", (() => {
    try {
      assertValidPayload("split", {
        sources: [{ treeId: "a", anchorX: 0, anchorY: 0 }],
        results: [{ x: 0, y: 0 }],
      });
      return false;
    } catch (e) { return e instanceof PayloadError; }
  })());
  check("merge requires at least two sources", (() => {
    try {
      assertValidPayload("merge", {
        sources: [{ treeId: "a", anchorX: 0, anchorY: 0 }],
        results: [{ x: 0, y: 0 }],
      });
      return false;
    } catch (e) { return e instanceof PayloadError; }
  })());
  check("a well formed split validates", (() => {
    assertValidPayload("split", {
      sources: [{ treeId: "a", anchorX: 0, anchorY: 0 }],
      results: [{ x: -1, y: 0 }, { x: 1, y: 0 }],
    });
    return true;
  })());
  check("isEditOperation rejects nonsense", !isEditOperation("delete_all"));
  check("isEditOperation accepts every real operation", (() => {
    return ["add", "delete", "move", "split", "merge", "edit_attributes", "edit_crown", "recalculate"]
      .every(isEditOperation);
  })());
}

// ---------------------------------------------------------------------- //
console.log("\n--- rebaseEdits: the tolerance, both sides of it ---");
{
  // A tree at (100.00, 200.00) in the old run. The new run's DeepForest
  // weights shift its apex by exactly one analysis cell (0.25 m) — the plan's
  // own stated "expected, not a bug" case.
  const oldTreeId = "old-hash-aaaa";
  const shifted = tree("new-hash-bbbb", 100.25, 200.00);
  const farAway = tree("new-hash-cccc", 140.0, 240.0);

  check("tolerance is 2 cells", rebaseToleranceMetres(CELL) === 2 * CELL, `${rebaseToleranceMetres(CELL)}`);
  check("REBASE_TOLERANCE_CELLS is the named constant, not a magic number", REBASE_TOLERANCE_CELLS === 2);

  const del = edit({
    treeId: oldTreeId,
    operation: "delete",
    payload: { anchorX: 100.0, anchorY: 200.0 },
  });

  const { rebased, unassociated } = rebaseEdits([del], [shifted, farAway], CELL);
  check("a one-cell shift re-associates", rebased.length === 1 && unassociated.length === 0,
    `rebased=${rebased.length} unassociated=${unassociated.length}`);
  check("the rebased edit points at the NEW tree's id", rebased[0]?.treeId === shifted.id, rebased[0]?.treeId);
  check("the anchor advances to the new tree's position", rebased[0]?.payload.anchorX === shifted.x);

  // Now push the same edit's anchor out past tolerance (a shift of 3 cells,
  // 0.75 m, on a survey where tolerance is 2 cells / 0.5 m).
  const tooFar = edit({
    treeId: oldTreeId,
    operation: "delete",
    payload: { anchorX: 100.0, anchorY: 200.0 },
  });
  const onlyDistantMatch = tree("new-hash-dddd", 100.75, 200.0); // 0.75 m away
  const result2 = rebaseEdits([tooFar], [onlyDistantMatch], CELL);
  check("beyond tolerance is collected, not silently dropped",
    result2.rebased.length === 0 && result2.unassociated.length === 1,
    `rebased=${result2.rebased.length} unassociated=${result2.unassociated.length}`);
  check("the unassociated entry names why", /tolerance/i.test(result2.unassociated[0]?.reason ?? ""),
    result2.unassociated[0]?.reason);
  check("the original edit is preserved verbatim in the unassociated entry",
    result2.unassociated[0]?.edit === tooFar);
}

console.log("\n--- rebaseEdits: add edits are never re-based ---");
{
  const added = edit({ treeId: null, operation: "add", payload: { x: 5, y: 5 } });
  const { rebased, unassociated } = rebaseEdits([added], [tree("whatever", 999, 999)], CELL);
  check("an add edit passes through untouched", rebased.length === 1 && rebased[0] === added && unassociated.length === 0);
}

console.log("\n--- rebaseEdits: split/merge re-base every source ---");
{
  const merge = edit({
    operation: "merge",
    payload: {
      sources: [
        { treeId: "old-a", anchorX: 10, anchorY: 10 },
        { treeId: "old-b", anchorX: 10.1, anchorY: 10 },
      ],
      results: [{ x: 10.05, y: 10 }],
    },
  });
  const newTrees = [tree("new-a", 10.05, 10.05), tree("new-b", 10.1, 10.0)];
  const { rebased, unassociated } = rebaseEdits([merge], newTrees, CELL);
  check("both sources of a merge re-associate within tolerance",
    rebased.length === 1 && unassociated.length === 0, `rebased=${rebased.length} unassociated=${unassociated.length}`);
  const gotIds = rebased[0]?.payload.sources.map((s) => s.treeId).sort();
  check("each source now points at its own nearest new tree",
    JSON.stringify(gotIds) === JSON.stringify(["new-a", "new-b"]), JSON.stringify(gotIds));

  // One source with no match at all fails the whole edit, not silently half-applies.
  const badMerge = edit({
    operation: "merge",
    payload: {
      sources: [
        { treeId: "old-a", anchorX: 10, anchorY: 10 },
        { treeId: "old-far", anchorX: 500, anchorY: 500 },
      ],
      results: [{ x: 10, y: 10 }],
    },
  });
  const r2 = rebaseEdits([badMerge], newTrees, CELL);
  check("a merge with one unmatchable source is entirely unassociated",
    r2.rebased.length === 0 && r2.unassociated.length === 1);
}

// ---------------------------------------------------------------------- //
console.log("\n--- applyEdits: delete + re-run cycle removes the right tree and no other ---");
{
  const base = [tree("t1", 0, 0), tree("t2", 10, 10), tree("t3", 20, 20)];
  const del = edit({ treeId: "t2", operation: "delete", payload: { anchorX: 10, anchorY: 10 } });
  const { trees, skipped } = applyEdits(base, [del]);
  const ids = trees.map((t) => t.id).sort();
  check("exactly the deleted tree is gone", JSON.stringify(ids) === JSON.stringify(["t1", "t3"]), ids.join(","));
  check("no edit is skipped when the tree exists", skipped.length === 0);

  // Simulate a re-run: t2 is gone from the base entirely (as if it never
  // existed in this run), and a delete edit still pointing at "t2" (as it
  // would if re-basing had not yet run) must not be silently absorbed.
  const rerunBase = [tree("t1", 0, 0), tree("t3", 20, 20)];
  const stale = applyEdits(rerunBase, [del]);
  check("a delete whose tree is absent from the base is reported, not swallowed",
    stale.skipped.length === 1 && /needs re-basing/.test(stale.skipped[0].reason));
  check("the rest of the inventory is untouched by the stale edit",
    stale.trees.length === 2);
}

console.log("\n--- applyEdits: the other operations ---");
{
  const base = [tree("t1", 0, 0, { height: 5 })];

  const moved = applyEdits(base, [edit({ treeId: "t1", operation: "move", payload: { anchorX: 0, anchorY: 0, toX: 3, toY: 4 } })]);
  check("move updates position", moved.trees[0].x === 3 && moved.trees[0].y === 4);

  const attrs = applyEdits(base, [
    edit({ treeId: "t1", operation: "edit_attributes", payload: { anchorX: 0, anchorY: 0, changes: { height: 9.5, species: "sal" } } }),
  ]);
  check("edit_attributes merges changes without losing other fields",
    attrs.trees[0].height === 9.5 && attrs.trees[0].species === "sal" && attrs.trees[0].x === 0);

  const added = applyEdits(base, [edit({ operation: "add", payload: { x: 50, y: 50, attributes: { height: 2 } } })]);
  check("add appends a synthetic tree alongside the base", added.trees.length === 2);
  check("the added tree gets a client/manual id distinct from any hash id",
    added.trees.some((t) => t.id.startsWith("manual-")));

  const split = applyEdits(base, [
    edit({
      operation: "split",
      payload: {
        sources: [{ treeId: "t1", anchorX: 0, anchorY: 0 }],
        results: [{ x: -1, y: 0 }, { x: 1, y: 0 }],
      },
    }),
  ]);
  check("split removes the source and appends both results", split.trees.length === 2 && !split.trees.some((t) => t.id === "t1"));

  const merged = applyEdits([tree("a", 0, 0), tree("b", 1, 1)], [
    edit({
      operation: "merge",
      payload: {
        sources: [{ treeId: "a", anchorX: 0, anchorY: 0 }, { treeId: "b", anchorX: 1, anchorY: 1 }],
        results: [{ x: 0.5, y: 0.5 }],
      },
    }),
  ]);
  check("merge removes both sources and appends one result", merged.trees.length === 1 && merged.trees[0].mergedFrom.length === 2);

  // Order matters: a later edit wins over an earlier one on the same tree.
  const t0 = new Date(2026, 0, 1).toISOString();
  const t1 = new Date(2026, 0, 2).toISOString();
  const reordered = applyEdits(base, [
    edit({ treeId: "t1", operation: "move", payload: { anchorX: 0, anchorY: 0, toX: 9, toY: 9 }, createdAt: t1 }),
    edit({ treeId: "t1", operation: "move", payload: { anchorX: 0, anchorY: 0, toX: 1, toY: 1 }, createdAt: t0 }),
  ]);
  check("edits are applied in createdAt order regardless of array order",
    reordered.trees[0].x === 9 && reordered.trees[0].y === 9);
}

// ------------------------------------------------------------------ tenancy ---
console.log("\n--- tenancy, against real Postgres DDL ---");
{
  let PGlite = null;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    console.log("  SKIPPED: PGlite is not installed. npm install --no-save @electric-sql/pglite");
    console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${fail} of ${pass + fail} checks FAILED`}\n`);
    process.exit(fail ? 1 : 0);
  }

  const { readdirSync, readFileSync } = await import("node:fs");
  const path = await import("node:path");

  const db = await PGlite.create();
  const dir = path.join(process.cwd(), "drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(dir, file), "utf8"));
  }

  const rows = async (sql) => (await db.query(sql)).rows;

  const ACME = "11111111-1111-4111-8111-111111111111";
  const RIVAL = "22222222-2222-4222-8222-222222222222";
  await db.exec(`
    insert into clients (id, slug, name) values
      ('${ACME}', 'acme', 'Acme Infrastructure'),
      ('${RIVAL}', 'rival', 'Rival Construction');
    insert into sites (client_id, slug, name, is_published) values
      ('${ACME}',  'acme-forest', 'Acme Forest', true),
      ('${RIVAL}', 'rival-road',  'Rival Road',  true);
  `);
  const siteId = async (slug) => (await rows(`select id from sites where slug = '${slug}'`))[0].id;
  const acmeForest = await siteId("acme-forest");

  await db.exec(`
    insert into forest_edits (site_id, tree_id, operation, payload) values
      ('${acmeForest}', 'abcd1234', 'delete', '{"anchorX": 1, "anchorY": 2}');
  `);

  /**
   * The identical visibility rule `tenancy-test.mjs` proves against `sites`,
   * joined through to `forest_edits`. This is what `GET .../forest/edits`
   * effectively runs once it has resolved the site (`getSite` first, this
   * join second) — not a new rule, the existing one applied to a new table.
   */
  function visibleSql(viewer) {
    if (viewer.role === "owner") return "true";
    return `
      sites.client_id = '${viewer.clientId}'
      and sites.is_published`;
  }
  async function editsVisibleTo(viewer) {
    const r = await rows(`
      select forest_edits.tree_id from forest_edits
      join sites on sites.id = forest_edits.site_id
      where ${visibleSql(viewer)}
    `);
    return r.map((x) => x.tree_id);
  }

  const acmeViewer = { role: "client", clientId: ACME };
  const rivalViewer = { role: "client", clientId: RIVAL };
  const owner = { role: "owner", clientId: null };

  check("the owning client's viewer sees the edit",
    (await editsVisibleTo(acmeViewer)).includes("abcd1234"));
  check("a different client's viewer does not see it",
    !(await editsVisibleTo(rivalViewer)).includes("abcd1234"),
    (await editsVisibleTo(rivalViewer)).join(", ") || "nothing, as expected");
  check("an owner sees it regardless of client",
    (await editsVisibleTo(owner)).includes("abcd1234"));

  console.log("\ncascade: deleting a site takes its edits with it");
  {
    const before = (await rows(`select count(*)::int as n from forest_edits where site_id = '${acmeForest}'`))[0].n;
    check("the edit exists before the site is deleted", before === 1, `${before}`);
    await db.exec(`delete from sites where id = '${acmeForest}';`);
    const after = (await rows(`select count(*)::int as n from forest_edits where site_id = '${acmeForest}'`))[0].n;
    check("on delete cascade removes it, no orphan row is left behind", after === 0, `${after}`);
  }

  console.log("\nthe operation check constraint refuses nonsense");
  {
    const otherSite = await siteId("rival-road");
    let refused = null;
    try {
      await db.exec(
        `insert into forest_edits (site_id, operation, payload) values ('${otherSite}', 'levitate', '{}');`,
      );
    } catch (error) {
      refused = error;
    }
    check("an unknown operation is rejected at the database", refused !== null,
      refused ? "" : "the insert succeeded, which would let a typo become a stored operation");
  }
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${fail} of ${pass + fail} checks FAILED`}\n`);
process.exit(fail ? 1 : 0);
