/**
 * The forest inventory's first write path — pure logic only, no database and
 * no import of `forest-source.ts`. See `docs/forest-tools-plan.md` §6.
 *
 * Two independent jobs live here, and the split matters:
 *
 *   1. **Re-basing** (§6.2) — reattach a client's stored edits to whichever
 *      tree in a *fresh* detection run is now the same physical tree.
 *   2. **Applying** (§6.1) — fold a site's edits onto a base tree list to
 *      produce the list actually served. The base inventory itself is never
 *      touched; the edits are a delta layered on read.
 *
 * Both are plain functions over plain arrays, exactly so they can be tested
 * with hand-built fixtures (`scripts/forest-edits-test.mjs`) without a
 * database or a real `trees.bin` on disk.
 *
 * ## The one thing the plan doesn't spell out: an edit must carry its own anchor
 *
 * §6.2 says the durable id is "a hash of the apex position quantised to
 * 0.25 m" and that a re-run "re-associates edits by nearest match". A SHA-256
 * hash is one-way: given only an old `treeId` string, there is no computing
 * back the (x, y) it was made from. So re-basing cannot start from the id
 * alone — it needs the position that produced it.
 *
 * The fix is to record that position on the edit itself the moment it is
 * created: every stored edit's payload carries `anchorX`/`anchorY`, the apex
 * (in the survey's projected CRS, EPSG:32643) of the tree the edit was made
 * against. That is what `rebaseEdits` below actually searches with. Without
 * this, re-basing this table would be impossible after the first run change,
 * silently, which is exactly the class of bug §6.2 exists to prevent.
 */

// --------------------------------------------------------------------------
// Shared types
// --------------------------------------------------------------------------

/** A tree in a production run's list, in the shape `forest-source.ts` will
 * eventually decode `trees.bin` into (see its header TODO). Only `id`, `x`
 * and `y` are read here; everything else rides along untouched so `add`,
 * `edit_attributes` and friends can carry whatever attribute set the engine
 * settles on without this file needing to know its shape. */
export interface ForestTree {
  id: string;
  x: number;
  y: number;
  [attribute: string]: unknown;
}

export const EDIT_OPERATIONS = [
  "add",
  "delete",
  "move",
  "split",
  "merge",
  "edit_attributes",
  "edit_crown",
  "recalculate",
] as const;

export type EditOperation = (typeof EDIT_OPERATIONS)[number];

export function isEditOperation(value: unknown): value is EditOperation {
  return typeof value === "string" && (EDIT_OPERATIONS as readonly string[]).includes(value);
}

/** One row of `forest_edits`, as read back from Postgres. */
export interface StoredForestEdit {
  id: string;
  siteId: string;
  treeId: string | null;
  operation: EditOperation;
  payload: Record<string, unknown>;
  authorId: string | null;
  createdAt: string | Date;
}

/** The site's analysis cell size, from that site's own `manifest.json`
 * (`ForestManifest.grid.cellSize`). 0.25 m is `forest-run.mjs`'s default, used
 * here only as a fallback for a caller that has not looked the real value up
 * yet — it must never silently stand in for a site's actual grid. */
export const DEFAULT_ANALYSIS_CELL_M = 0.25;

/**
 * How many analysis cells a re-run's apex is allowed to have drifted by and
 * still count as "the same tree".
 *
 * Named, not inlined, because the plan is explicit that a hash-exact miss by
 * one cell is the *expected* case for a re-run with different DeepForest
 * weights, a different rejection threshold, or a slightly different crown
 * segmentation — not a bug to chase. Two cells gives one cell of slack in
 * either axis independently (a diagonal shift of 1 cell in x and 1 in y is
 * already ~1.4 cells) while still being tight enough that two genuinely
 * different, closely spaced trees are not confused for one another at
 * Ektanagar 1's ~100 trees/ha density (typical nearest-neighbour spacing
 * there is well over a metre).
 */
export const REBASE_TOLERANCE_CELLS = 2;

export function rebaseToleranceMetres(cellSizeM: number = DEFAULT_ANALYSIS_CELL_M): number {
  return REBASE_TOLERANCE_CELLS * cellSizeM;
}

// --------------------------------------------------------------------------
// Payload shape per operation
//
// `payload` is jsonb (§6.1's schema), so nothing enforces its shape at the
// database. This is the one place that shape is written down and checked,
// so a malformed edit is refused at the API boundary rather than corrupting
// the served inventory silently.
// --------------------------------------------------------------------------

/** A tree's apex, in the survey's projected CRS — what a stored edit anchors
 * itself to, and what `rebaseEdits` searches with. Every operation except
 * `add` carries one. */
export interface Anchor {
  anchorX: number;
  anchorY: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasAnchor(payload: Record<string, unknown>): payload is Record<string, unknown> & Anchor {
  return isFiniteNumber(payload.anchorX) && isFiniteNumber(payload.anchorY);
}

/**
 * Validate a payload against the shape its operation requires. Throws
 * `PayloadError` naming exactly what is wrong, so a bad POST body gets a 400
 * that says why rather than a 500 from deep inside `applyEdits`.
 */
export class PayloadError extends Error {}

export function assertValidPayload(operation: EditOperation, payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new PayloadError("payload must be a JSON object");
  }
  const p = payload as Record<string, unknown>;

  switch (operation) {
    // A brand new tree the client is placing by hand. No anchor: it has no
    // production-run ancestor to be re-based against, ever.
    case "add":
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
        throw new PayloadError("add requires numeric x and y");
      }
      return p;

    // Everything below corrects an existing tree, so it must say which one,
    // by position, not only by the id that happened to be current when the
    // edit was written.
    case "delete":
      if (!hasAnchor(p)) throw new PayloadError("delete requires anchorX/anchorY");
      return p;

    case "move":
      if (!hasAnchor(p)) throw new PayloadError("move requires anchorX/anchorY");
      if (!isFiniteNumber(p.toX) || !isFiniteNumber(p.toY)) {
        throw new PayloadError("move requires numeric toX/toY (where the tree is corrected to)");
      }
      return p;

    case "edit_attributes":
    case "recalculate":
      if (!hasAnchor(p)) throw new PayloadError(`${operation} requires anchorX/anchorY`);
      if (typeof p.changes !== "object" || p.changes === null || Array.isArray(p.changes)) {
        throw new PayloadError(`${operation} requires a "changes" object`);
      }
      return p;

    case "edit_crown":
      if (!hasAnchor(p)) throw new PayloadError("edit_crown requires anchorX/anchorY");
      if (typeof p.crown !== "object" || p.crown === null) {
        throw new PayloadError("edit_crown requires a \"crown\" polygon geometry");
      }
      return p;

    // Split and merge are the hard geometry cases the plan explicitly stubs
    // (§6, item 3): the API accepts a client-supplied replacement geometry
    // rather than computing the split/merge itself. Both are recorded the
    // same shape — an array of sources being consumed, and the resulting
    // tree(s) replacing them — because a merge is a split with the arrows
    // reversed and re-basing treats every source anchor identically either
    // way.
    case "split": {
      if (!Array.isArray(p.sources) || p.sources.length !== 1) {
        throw new PayloadError("split requires exactly one entry in \"sources\" (the crown being divided)");
      }
      for (const s of p.sources) validateSource(s, "split");
      if (!Array.isArray(p.results) || p.results.length < 2) {
        throw new PayloadError("split requires at least two entries in \"results\" (the drawn replacement crowns)");
      }
      for (const r of p.results) validateResult(r, "split");
      return p;
    }
    case "merge": {
      if (!Array.isArray(p.sources) || p.sources.length < 2) {
        throw new PayloadError("merge requires at least two entries in \"sources\" (the crowns being combined)");
      }
      for (const s of p.sources) validateSource(s, "merge");
      if (!Array.isArray(p.results) || p.results.length !== 1) {
        throw new PayloadError("merge requires exactly one entry in \"results\" (the drawn combined crown)");
      }
      for (const r of p.results) validateResult(r, "merge");
      return p;
    }

    default: {
      const exhaustive: never = operation;
      throw new PayloadError(`Unknown operation "${exhaustive as string}"`);
    }
  }
}

function validateSource(value: unknown, op: string): asserts value is { treeId: string } & Anchor {
  if (typeof value !== "object" || value === null) {
    throw new PayloadError(`${op}: every entry in "sources" must be an object`);
  }
  const s = value as Record<string, unknown>;
  if (typeof s.treeId !== "string" || !s.treeId) {
    throw new PayloadError(`${op}: every source needs a treeId`);
  }
  if (!hasAnchor(s)) {
    throw new PayloadError(`${op}: every source needs anchorX/anchorY`);
  }
}

/**
 * A split/merge result is a client-drawn replacement tree: it needs a
 * position like any other tree in the inventory (so it can be plotted and,
 * eventually, re-based against a future run), even though its crown geometry
 * is drawn by a human rather than computed here.
 */
function validateResult(value: unknown, op: string): asserts value is { x: number; y: number } {
  if (typeof value !== "object" || value === null) {
    throw new PayloadError(`${op}: every entry in "results" must be an object`);
  }
  const r = value as Record<string, unknown>;
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y)) {
    throw new PayloadError(`${op}: every result needs numeric x/y (the new tree's apex)`);
  }
}

// --------------------------------------------------------------------------
// Re-basing (§6.2)
// --------------------------------------------------------------------------

export interface UnassociatedEdit {
  edit: StoredForestEdit;
  reason: string;
}

export interface RebaseResult {
  /** Edits whose anchor(s) matched a tree in the new run, with `treeId` (and,
   * for split/merge, each source's `treeId`) rewritten to the new run's id,
   * and the anchor advanced to that tree's new apex so the next re-run starts
   * its search from the latest known-good position rather than compounding
   * drift back to the original run. */
  rebased: StoredForestEdit[];
  /** Edits that found no tree within tolerance. Never dropped — the caller
   * (an admin UI, out of scope here) is expected to surface these so a client
   * knows a correction may have been lost, rather than have it vanish with no
   * trace. */
  unassociated: UnassociatedEdit[];
}

/** Nearest tree to `anchor` in `trees`, or null if `trees` is empty.
 *
 * A linear scan. Fine at the scale this ships for — Ektanagar 1 is ~2.5k
 * trees, and even Ektanagar 2's ~39k is well under a millisecond-budget
 * problem for a maintenance operation that runs once per re-run, not once per
 * request. A survey at Kiru's scale would need a spatial index the same way
 * §2.4 gives crown segmentation a tile halo instead of a whole-grid scan —
 * out of scope here, same as it is everywhere else Kiru is mentioned.
 */
function nearestTree(
  anchor: { anchorX: number; anchorY: number },
  trees: readonly ForestTree[],
): { tree: ForestTree; distance: number } | null {
  let best: ForestTree | null = null;
  let bestDistance = Infinity;
  for (const tree of trees) {
    const d = Math.hypot(tree.x - anchor.anchorX, tree.y - anchor.anchorY);
    if (d < bestDistance) {
      bestDistance = d;
      best = tree;
    }
  }
  return best ? { tree: best, distance: bestDistance } : null;
}

/**
 * Re-associate a site's edits (keyed to some earlier run's tree ids) against
 * a fresh run's tree list.
 *
 * Pure: no I/O, no database. `oldEditsForSite` is whatever the caller already
 * loaded (in any order), `newTreeList` is the freshly produced inventory for
 * the same site. Nothing here knows or cares where either came from.
 */
export function rebaseEdits(
  oldEditsForSite: readonly StoredForestEdit[],
  newTreeList: readonly ForestTree[],
  cellSizeM: number = DEFAULT_ANALYSIS_CELL_M,
): RebaseResult {
  const tolerance = rebaseToleranceMetres(cellSizeM);
  const rebased: StoredForestEdit[] = [];
  const unassociated: UnassociatedEdit[] = [];

  for (const edit of oldEditsForSite) {
    // `add` has no ancestor to re-associate — it is not a correction to a
    // detected tree, it is a tree the client placed themselves, so it simply
    // survives every re-run unchanged.
    if (edit.operation === "add") {
      rebased.push(edit);
      continue;
    }

    if (edit.operation === "split" || edit.operation === "merge") {
      const sources = (edit.payload.sources as Array<Record<string, unknown>>) ?? [];
      const newSources: Array<Record<string, unknown>> = [];
      let failed: string | null = null;
      for (const source of sources) {
        if (!isFiniteNumber(source.anchorX) || !isFiniteNumber(source.anchorY)) {
          failed = `a source in this ${edit.operation} has no anchor to search with`;
          break;
        }
        const match = nearestTree(
          { anchorX: source.anchorX as number, anchorY: source.anchorY as number },
          newTreeList,
        );
        if (!match || match.distance > tolerance) {
          failed = match
            ? `nearest tree to a source is ${match.distance.toFixed(2)} m away, beyond the ${tolerance.toFixed(2)} m tolerance`
            : "the new run has no trees at all";
          break;
        }
        newSources.push({
          ...source,
          treeId: match.tree.id,
          anchorX: match.tree.x,
          anchorY: match.tree.y,
        });
      }
      if (failed) {
        unassociated.push({ edit, reason: failed });
      } else {
        rebased.push({
          ...edit,
          payload: { ...edit.payload, sources: newSources },
        });
      }
      continue;
    }

    // delete, move, edit_attributes, edit_crown, recalculate: a single anchor.
    if (!hasAnchor(edit.payload)) {
      unassociated.push({ edit, reason: `${edit.operation} edit has no anchor stored on it` });
      continue;
    }
    const match = nearestTree(
      { anchorX: edit.payload.anchorX, anchorY: edit.payload.anchorY },
      newTreeList,
    );
    if (!match) {
      unassociated.push({ edit, reason: "the new run has no trees at all" });
      continue;
    }
    if (match.distance > tolerance) {
      unassociated.push({
        edit,
        reason:
          `nearest tree in the new run is ${match.distance.toFixed(2)} m away, beyond the ` +
          `${tolerance.toFixed(2)} m tolerance (${REBASE_TOLERANCE_CELLS} analysis cells at ${cellSizeM} m)`,
      });
      continue;
    }
    rebased.push({
      ...edit,
      treeId: match.tree.id,
      payload: { ...edit.payload, anchorX: match.tree.x, anchorY: match.tree.y },
    });
  }

  return { rebased, unassociated };
}

// --------------------------------------------------------------------------
// Applying edits (§6.1): base inventory + edits -> what is actually served
// --------------------------------------------------------------------------

export interface SkippedEdit {
  edit: StoredForestEdit;
  reason: string;
}

export interface EffectiveInventory {
  trees: ForestTree[];
  /** Edits that could not be applied against *this* base list — e.g. a
   * `delete` whose `treeId` has already been re-based to something not in
   * `baseTrees`, which would mean re-basing has not yet run for this site
   * since its last production run. Never silently absorbed into the count. */
  skipped: SkippedEdit[];
}

/**
 * Fold a site's edits onto its base tree list.
 *
 * This assumes `edits`' `treeId` values already refer to ids present in
 * `baseTrees` — i.e. `rebaseEdits` has already been run against this exact
 * `baseTrees` if the production run changed since the edits were written.
 * Applying and re-basing are deliberately two different functions: this one
 * has no tolerance search in it at all, on purpose, so a bug in matching
 * cannot silently hide inside "just apply the edits".
 *
 * Edits are applied in `createdAt` order — later edits win over earlier ones
 * for the same tree — regardless of the order the caller passed them in.
 */
export function applyEdits(
  baseTrees: readonly ForestTree[],
  edits: readonly StoredForestEdit[],
): EffectiveInventory {
  const ordered = [...edits].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const byId = new Map<string, ForestTree>();
  for (const tree of baseTrees) byId.set(tree.id, { ...tree });

  const skipped: SkippedEdit[] = [];

  for (const edit of ordered) {
    switch (edit.operation) {
      case "add": {
        // No production run ever assigns this id, so it cannot collide with
        // a hash id (those are 16 hex characters; this is not).
        const id = typeof edit.payload.id === "string" && edit.payload.id ? edit.payload.id : `manual-${edit.id}`;
        byId.set(id, {
          ...(edit.payload.attributes as Record<string, unknown> | undefined),
          id,
          x: edit.payload.x as number,
          y: edit.payload.y as number,
          source: "added",
        });
        break;
      }

      case "delete": {
        if (!edit.treeId || !byId.has(edit.treeId)) {
          skipped.push({ edit, reason: "tree not found in the base inventory (needs re-basing?)" });
          break;
        }
        byId.delete(edit.treeId);
        break;
      }

      case "move": {
        const tree = edit.treeId ? byId.get(edit.treeId) : undefined;
        if (!tree) {
          skipped.push({ edit, reason: "tree not found in the base inventory (needs re-basing?)" });
          break;
        }
        byId.set(edit.treeId as string, { ...tree, x: edit.payload.toX as number, y: edit.payload.toY as number });
        break;
      }

      case "edit_attributes":
      case "recalculate": {
        const tree = edit.treeId ? byId.get(edit.treeId) : undefined;
        if (!tree) {
          skipped.push({ edit, reason: "tree not found in the base inventory (needs re-basing?)" });
          break;
        }
        byId.set(edit.treeId as string, {
          ...tree,
          ...(edit.payload.changes as Record<string, unknown>),
        });
        break;
      }

      case "edit_crown": {
        const tree = edit.treeId ? byId.get(edit.treeId) : undefined;
        if (!tree) {
          skipped.push({ edit, reason: "tree not found in the base inventory (needs re-basing?)" });
          break;
        }
        byId.set(edit.treeId as string, { ...tree, crown: edit.payload.crown });
        break;
      }

      // Structural stubs (§6, item 3): the geometry of "how a crown splits or
      // merges" is drawn by a human and supplied as-is. What this function
      // owns is bookkeeping — which tree(s) disappear and which appear — not
      // computing a polygon.
      case "split": {
        const sources = (edit.payload.sources as Array<{ treeId: string }>) ?? [];
        const missing = sources.filter((s) => !byId.has(s.treeId));
        if (missing.length) {
          skipped.push({ edit, reason: "a source tree for this split is not in the base inventory (needs re-basing?)" });
          break;
        }
        for (const s of sources) byId.delete(s.treeId);
        // Results are validated (assertValidPayload) to carry numeric x/y before
        // ever reaching here; applyEdits trusts that and only adds bookkeeping.
        const results = (edit.payload.results as Array<Record<string, unknown> & { x: number; y: number }>) ?? [];
        results.forEach((result, i) => {
          const id = typeof result.id === "string" && result.id ? result.id : `split-${edit.id}-${i}`;
          byId.set(id, {
            ...result,
            id,
            source: "split",
            splitFrom: sources.map((s) => s.treeId),
          } as ForestTree);
        });
        break;
      }

      case "merge": {
        const sources = (edit.payload.sources as Array<{ treeId: string }>) ?? [];
        const missing = sources.filter((s) => !byId.has(s.treeId));
        if (missing.length) {
          skipped.push({ edit, reason: "a source tree for this merge is not in the base inventory (needs re-basing?)" });
          break;
        }
        for (const s of sources) byId.delete(s.treeId);
        const result = (edit.payload.results as Array<Record<string, unknown> & { x: number; y: number }>)?.[0];
        const id = typeof result?.id === "string" && result.id ? result.id : `merge-${edit.id}`;
        byId.set(id, {
          ...result,
          id,
          source: "merged",
          mergedFrom: sources.map((s) => s.treeId),
        } as ForestTree);
        break;
      }

      default: {
        const exhaustive: never = edit.operation;
        skipped.push({ edit, reason: `Unknown operation "${exhaustive as string}"` });
      }
    }
  }

  return { trees: [...byId.values()], skipped };
}
