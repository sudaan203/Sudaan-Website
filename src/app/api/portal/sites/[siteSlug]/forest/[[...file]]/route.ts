import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { logPortalEvent } from "@/lib/portal/log";
import { ForestUnavailable, loadForest } from "@/lib/portal/forest-source";
import { DEFAULT_HEIGHT_CLASSES } from "@/lib/geo/forest.mjs";

export const runtime = "nodejs";

/**
 * A site's forest inventory, the parts a browser needs, one file at a time.
 *
 *   GET .../forest                  -> manifest + summary + the default height
 *                                      classes, as JSON
 *   GET .../forest/trees.bin        -> the columnar attribute pack, raw bytes
 *   GET .../forest/crowns.geojson   -> the crown polygons and full per-tree
 *                                      attributes, raw JSON
 *
 * Modelled directly on `.../cloud/[[...node]]/route.ts`: a manifest-shaped GET
 * with no further path, and a GET with one more segment for the heavier file,
 * both behind the same session-then-tenant check every portal route uses
 * before it opens anything.
 *
 * ## Why the height classes are served, not imported
 *
 * `forest-client.ts` (a `"use client"` module, decoding `trees.bin` in the
 * browser) needs Malhar's ten default bands — `docs/forest-tools-plan.md` §5.4
 * is explicit that the client must read them from `forest.mjs`'s own export
 * rather than hardcode a second copy that can drift from it. But `forest.mjs`
 * imports `raster.mjs`, which imports `node:fs` for the pipeline's own file
 * reads, and pulling that transitively into a browser bundle does not merely
 * bloat it, it fails to build at all ("Module not found: Can't resolve 'fs'").
 * This route runs in the Node runtime already, so it is the one place both
 * constraints are satisfied at once: it imports the real export, unmodified,
 * and hands the *values* to the browser over the wire. The client still gets
 * Malhar's actual bands, sourced from the one place they are defined, without
 * either process needing to import code the other cannot run.
 *
 * ## Why crowns.geojson is passed through rather than reprojected here
 *
 * `forest-run.mjs`'s own comment on that file says it is deliberately left in
 * EPSG:32643 because it is "analysis geometry read back by the render/filter
 * routes in the survey's own CRS, not a client-facing export". This route is
 * exactly that kind of reader — it hands the bytes to `forest-client.ts`,
 * which reprojects to WGS84 the same way `hydrology-source.ts`'s callers do,
 * through `projection.mjs`'s own `utmToLonLat`, not a second implementation of
 * it. Reprojecting here instead would mean writing that logic a third time
 * (the render route and the hydrology route each already have their own
 * client-facing equivalent) for no benefit: the bytes are the same size either
 * way, and the browser needs the *un*projected easting/northing anyway to
 * match `trees.bin`'s own coordinates one-for-one by id.
 */

const FILES = new Set(["trees.bin", "crowns.geojson"]);

function unavailableMessage(reason: ForestUnavailable["reason"]): string {
  return reason === "missing"
    ? "No forest inventory has been computed for this survey."
    : "This survey's forest inventory could not be read.";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ siteSlug: string; file?: string[] }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { siteSlug, file } = await params;
  const site = await queryDb("forest site lookup", () => getSite(session, siteSlug));
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug, file: "forest" });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const forest = await loadForest(siteSlug);

    if (!file || file.length === 0) {
      const summary = await forest.summary();
      return NextResponse.json(
        {
          manifest: forest.manifest,
          summary,
          /*
           * `max: Infinity` on the last band (">15 m") is what `forest.mjs`
           * actually exports, and `JSON.stringify` silently turns `Infinity`
           * into `null` — not an error, just a wrong number arriving at the
           * client with nothing marking that it happened. Made explicit here
           * as `null` on purpose, so `forest-client.ts` decodes it back to
           * `Infinity` deliberately rather than receiving it by accident.
           */
          defaultHeightClasses: DEFAULT_HEIGHT_CLASSES.map((c) => ({
            label: c.label,
            min: c.min,
            max: Number.isFinite(c.max) ? c.max : null,
          })),
        },
        {
          headers: {
            // Overridden to a longer, immutable life by next.config.mjs for
            // this exact path once it reaches the client; see that file's
            // comment for why the override has to live there rather than here.
            "Cache-Control": "private, max-age=300",
          },
        },
      );
    }

    if (file.length !== 1 || !FILES.has(file[0])) {
      return NextResponse.json(
        { error: `Unknown forest file "${file.join("/")}". One of: ${[...FILES].join(", ")}.` },
        { status: 400 },
      );
    }

    if (file[0] === "trees.bin") {
      const bytes = await forest.treesBinBytes();
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, max-age=86400, immutable",
        },
      });
    }

    // crowns.geojson: read as text and passed straight through, exactly as
    // written by forest-run.mjs — no reprojection, no attribute filtering, per
    // the header comment above.
    const crowns = await forest.crowns();
    return NextResponse.json(crowns, {
      headers: { "Cache-Control": "private, max-age=86400, immutable" },
    });
  } catch (error) {
    if (error instanceof ForestUnavailable) {
      return NextResponse.json(
        { error: unavailableMessage(error.reason), reason: error.reason },
        { status: 409 },
      );
    }
    console.error("[portal forest]", error);
    return NextResponse.json({ error: "The forest inventory could not be served" }, { status: 500 });
  }
}
