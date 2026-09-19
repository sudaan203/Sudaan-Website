import { NextResponse, type NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { getDb, queryDb } from "@/lib/portal/db/client";
import * as schema from "@/lib/portal/db/schema";
import { logPortalEvent } from "@/lib/portal/log";
import {
  assertValidPayload,
  isEditOperation,
  PayloadError,
  type StoredForestEdit,
} from "@/lib/portal/forest-edits";

export const runtime = "nodejs";

/**
 * Tools 14: the forest inventory's first write path.
 *
 * ## Authorisation — the same as every read route, on purpose
 *
 * `docs/forest-tools-plan.md` §0.1 row 4 records Malhar's answer: both owner
 * and client roles may edit, gated only by "does this session's tenancy
 * resolve this site at all" — no new role tier. That is exactly what
 * `getSite(session, siteSlug)` already gives every read route: an owner
 * resolves any site, a client resolves only a published site of their own
 * client, and everyone else gets the row back as `null`. There is nothing to
 * add to session or auth code to make this true — `isOwnerRole` exists only
 * to gate *owner-only* actions (the admin console), and this is deliberately
 * not one of those. A wrong-tenant caller gets the identical 404 every
 * sibling route already gives, because it is the identical check.
 *
 * ## What this route does not do
 *
 * It does not compute the site's effective inventory (base run + edits
 * applied) — that needs the base tree list, and `forest-source.ts` does not
 * yet decode `trees.bin` (its own header TODO; the engine track owns that
 * byte layout and has not fixed it). GET here returns the edit log, which is
 * everything this route can honestly serve today. `applyEdits` in
 * `forest-edits.ts` is written and tested against a plain tree list already,
 * so wiring GET up to return the effective inventory is a one-function change
 * once that decoder exists — not a redesign.
 */

async function resolveSite(siteSlug: string) {
  const session = await getSession();
  if (!session) return { session: null, site: null, error: unauthenticated() };

  const site = await queryDb("forest edits site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "forest-edits" });
    return { session, site: null, error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { session, site, error: null };
}

function unauthenticated() {
  return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
}

function noDatabase() {
  return NextResponse.json(
    { error: "Forest editing needs DATABASE_URL to be configured on this deployment." },
    { status: 503 },
  );
}

function toStoredEdit(row: typeof schema.forestEdits.$inferSelect): StoredForestEdit {
  return {
    id: row.id,
    siteId: row.siteId,
    treeId: row.treeId,
    operation: row.operation,
    payload: (row.payload as Record<string, unknown>) ?? {},
    authorId: row.authorId,
    createdAt: row.createdAt,
  };
}

/** GET — a site's edit log, oldest first (the order `applyEdits` folds them in). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string }> },
) {
  const { siteSlug } = await params;
  const { session, site, error } = await resolveSite(siteSlug);
  if (error) return error;

  const db = getDb();
  if (!db) return noDatabase();

  const rows = await queryDb("forest edits list", () =>
    db
      .select()
      .from(schema.forestEdits)
      .where(eq(schema.forestEdits.siteId, site!.id))
      .orderBy(asc(schema.forestEdits.createdAt)),
  );

  logPortalEvent("forest_edit", { userId: session!.userId, site: siteSlug, op: "list", count: rows.length });

  return NextResponse.json(
    {
      site: siteSlug,
      edits: rows.map(toStoredEdit),
      note:
        "This is the edit log, not the effective inventory (base run with edits applied). " +
        "The effective inventory needs trees.bin decoded, which forest-source.ts does not " +
        "do yet (see its header TODO) — once it does, src/lib/portal/forest-edits.ts's " +
        "applyEdits() is already written and tested against a plain tree list.",
    },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** POST — record one edit. Body: `{ treeId, operation, payload }`. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string }> },
) {
  const { siteSlug } = await params;
  const { session, site, error } = await resolveSite(siteSlug);
  if (error) return error;

  const db = getDb();
  if (!db) return noDatabase();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const operation = body.operation;
  if (!isEditOperation(operation)) {
    return NextResponse.json(
      { error: `operation must be one of add, delete, move, split, merge, edit_attributes, edit_crown, recalculate` },
      { status: 400 },
    );
  }

  const treeId =
    body.treeId === null || body.treeId === undefined ? null : String(body.treeId);
  if (operation !== "add" && !treeId) {
    return NextResponse.json({ error: `${operation} requires a treeId` }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = assertValidPayload(operation, body.payload);
  } catch (err) {
    if (err instanceof PayloadError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // authorId is a foreign key into users; a session's userId is not
  // guaranteed to resolve to a row there (see admin-actions.ts's identical
  // resolveActor concern for a staff/legacy session), so it is looked up and
  // allowed to fall back to null rather than letting a perfectly good edit
  // fail on a constraint.
  const authorId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    session!.userId,
  )
    ? (
        await queryDb("forest edit author lookup", () =>
          db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, session!.userId)).limit(1),
        )
      )[0]?.id ?? null
    : null;

  const [created] = await queryDb("forest edit insert", () =>
    db
      .insert(schema.forestEdits)
      .values({ siteId: site!.id, treeId, operation, payload, authorId })
      .returning(),
  );

  logPortalEvent("forest_edit", {
    userId: session!.userId,
    site: siteSlug,
    op: operation,
    treeId,
    editId: created.id,
  });

  return NextResponse.json({ edit: toStoredEdit(created) }, { status: 201 });
}
