/**
 * The precomputed forest inventory for a site, ready to answer questions about.
 *
 * ## Why this mirrors hydrology-source.ts rather than terrain-source.ts
 *
 * Like hydrology, forest is a **batch product**: `scripts/forest-run.mjs` runs
 * once per survey, offline, and writes a directory of artefacts nothing here
 * computes on demand. A click on a tree or a drag on the height filter has to
 * answer in milliseconds, and detection, crown segmentation and the six
 * non-tree discriminators (`docs/forest-tools-plan.md` §3.5) are not
 * millisecond operations even on Ektanagar 1's 4 million analysis cells. So the
 * shape here is the same as `hydrology-source.ts`: a loader that reads what the
 * run already wrote, not a pipeline that runs one.
 *
 * The one artefact that *is* read the way terrain is — windowed, at its own
 * resolution, never loaded whole — is `chm.tif`. It is the one part of the
 * forest bundle that is a raster rather than a precomputed table, and the
 * render route tiles it exactly like a DTM or DSM: `openRaster` plus
 * `windowFor`/`readWindow`, reused rather than reinvented. See `chm()` below.
 *
 * ## Why `/forest` is not decoration
 *
 * This is the same fact `hydrology-source.ts` documents for `/hydrology`, and
 * it applies here for the identical reason. Remotely, everything for a site
 * shares one R2 prefix (`sites/<slug>/...`), because that is the prefix the
 * tile Worker's grant check enforces — a grant for one site must not reach
 * another's, and it does that by checking the prefix, not by knowing which
 * subtree is which. The published map pyramid already owns
 * `sites/<slug>/manifest.json`. `forest-run.mjs` writes a file of that same
 * name. Upload forest's `manifest.json` to the root of the site prefix and it
 * silently replaces the map's own manifest — the symptom is the map losing its
 * layers, and nothing in that symptom mentions forest. So forest nests under
 * `sites/<slug>/forest/`, the same way hydrology nests under
 * `sites/<slug>/hydrology/`, and for the same reason: the site root is already
 * spoken for.
 *
 * Locally the two never collide in the first place — `portal-data/hydrology/`
 * and `portal-data/forest/` are separate trees beside `portal-data/map/` — so
 * only the remote layout needs the extra segment. That asymmetry is
 * deliberate, not an inconsistency: it is exactly what `hydrology-source.ts`
 * does, restated here because forest needs the identical answer.
 *
 * ## "Never run" versus "ran but incomplete"
 *
 * `ForestUnavailable` carries the same two reasons `HydrologyUnavailable`
 * does, because they are different problems for an operator and conflating
 * them sends the fix to the wrong place:
 *
 * - `"missing"` — nothing has been computed for this site at all. The message
 *   names the exact `forest-run.mjs` invocation that would produce it, mirroring
 *   the way `hydrology-source.ts` names `hydro-run.mjs`.
 * - `"incomplete"` — a run happened, but a specific file is absent, unreadable,
 *   or missing a field this loader depends on. That is a corrupt or partial
 *   output, not an unstarted pipeline, and the message says which file.
 *
 * ## `trees.bin`'s byte layout is not fixed here
 *
 * `docs/forest-tools-plan.md` §2.5 specifies the *columns* — id, easting,
 * northing (int32), height, crown area, crown diameter, ground elevation,
 * confidence (float32/uint16) — but not yet the exact byte offsets, and the
 * engine that writes the file (`scripts/forest-run.mjs`, a separate, parallel
 * track from this one) owns that decision. Rather than guess a layout and risk
 * it disagreeing with what actually gets written, `treesBinBytes()` hands back
 * the raw bytes and nothing decodes them yet.
 *
 * TODO(forest): once `forest-run.mjs` documents its actual byte layout in its
 * own header comment, add a `trees()` decoder here that reads that layout into
 * typed arrays, the way this file already turns `manifest.json` into
 * `ForestManifest`. Until then, `forest-client.ts` (a later wave, per the plan
 * §5.1) has nothing to decode against and should not be started.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkStorageDir } from "./storage-config";
import { cached, fileSource, httpSource } from "@/lib/geo/raster-source.mjs";
import { openRaster } from "@/lib/geo/raster-window.mjs";
import { createTileGrant, TILE_GRANT_COOKIE } from "@/lib/portal/tile-grant";

export class ForestUnavailable extends Error {
  readonly reason: "missing" | "incomplete";
  constructor(reason: "missing" | "incomplete", message: string) {
    super(message);
    this.reason = reason;
    this.name = "ForestUnavailable";
  }
}

/**
 * `manifest.json`, as `forest-run.mjs` is contracted to write it.
 *
 * Shaped after `HydrologyManifest`: the fields this loader actually depends on
 * are named and typed, and an index signature keeps the rest open, because the
 * exact parameter set (§3.2's window-function `a`/`b`, §2.3's cell size
 * override, and whatever else the engine records) is the engine track's
 * decision, not this one's, and re-typing this file every time a new parameter
 * is added would be exactly the kind of coupling the two tracks were split to
 * avoid.
 */
export type ForestManifest = {
  generator: string;
  generatedAt: string;
  parameters: Record<string, unknown>;
  grid: {
    cellSize: number;
    width: number;
    height: number;
  };
  counts: {
    candidates: number;
    /** Segments dropped as non-trees, by which discriminator caught them (§3.5). */
    rejected: Record<string, number>;
    accepted: number;
  };
  /**
   * Stated plainly in every manifest, per `docs/forest-tools-plan.md` §0.1 row 2
   * and §8: no field measurement exists for any survey this pipeline runs on, so
   * nothing downstream may present a tree count or height as validated against
   * the ground. This field exists so that fact travels with the data rather than
   * living only in a plan document nobody reads at report time.
   */
  groundTruthNote: string;
  [key: string]: unknown;
};

/**
 * `summary.json` — every §10 statistic and chart series, precomputed once by
 * `forest-run.mjs` rather than computed per request, for the same reason
 * `trees.bin` is a flat pack: a summary card round-tripping to the server on
 * every page view would be paying network latency for arithmetic that does not
 * change between runs.
 *
 * The eleven summary figures and five chart series are named loosely, as
 * `Record<string, unknown>`, for the same reason `ForestManifest.parameters`
 * is: the engine track owns the exact keys, and this type exists so a caller
 * gets *something* typed back rather than `unknown`, not so this file can
 * enforce a shape it does not produce.
 */
export type ForestSummary = {
  count: number;
  treesPerHectare: number;
  height: { avg: number; max: number; min: number };
  crownArea: { avg: number; totalCovered: number };
  crownDiameter: { avg: number; max: number };
  canopyCoveragePct: number;
  /** The five §10 chart series: by height class, density/ha, crown-area and tree-height distributions, elevation vs height. */
  charts: Record<string, unknown>;
  [key: string]: unknown;
};

const FILES = {
  manifest: "manifest.json",
  summary: "summary.json",
  trees: "trees.bin",
  crowns: "crowns.geojson",
  chm: "chm.tif",
} as const;

/**
 * Same two-mode arrangement as hydrology, and for the same reason: the derived
 * artefacts are gitignored and a serverless deployment has no disk to keep them
 * on. `PORTAL_FOREST_URL` wins when set.
 */
function forestLocation(siteSlug: string) {
  const url = process.env.PORTAL_FOREST_URL;
  if (url) {
    return { remote: true as const, base: `${url.replace(/\/+$/, "")}/${siteSlug}/forest` };
  }
  const configured = process.env.PORTAL_FOREST_DIR;
  const dir = configured ?? join(process.cwd(), "portal-data", "forest");
  checkStorageDir("PORTAL_FOREST_DIR", "PORTAL_FOREST_URL", dir, Boolean(configured));
  return { remote: false as const, base: join(dir, siteSlug) };
}

async function fetchText(remote: boolean, siteSlug: string, ref: string): Promise<string | null> {
  if (!remote) return existsSync(ref) ? readFile(ref, "utf8") : null;
  const response = await fetch(ref, {
    headers: { Cookie: `${TILE_GRANT_COOKIE}=${await createTileGrant(siteSlug)}` },
  });
  if (!response.ok) return null;
  return response.text();
}

/** The same fetch as `fetchText`, but for a binary file (`trees.bin`). */
async function fetchBytes(remote: boolean, siteSlug: string, ref: string): Promise<Buffer | null> {
  if (!remote) return existsSync(ref) ? readFile(ref) : null;
  const response = await fetch(ref, {
    headers: { Cookie: `${TILE_GRANT_COOKIE}=${await createTileGrant(siteSlug)}` },
  });
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

type OpenRaster = Awaited<ReturnType<typeof openRaster>>;

type Loaded = {
  manifest: ForestManifest;
  summary: () => Promise<ForestSummary>;
  /**
   * The raw bytes of `trees.bin`. Not decoded here — see the header TODO.
   * Cached after the first call, the same as every other artefact below.
   */
  treesBinBytes: () => Promise<Buffer>;
  crowns: () => Promise<unknown>;
  /**
   * The analysis CHM, opened for windowed reading, exactly like
   * `openTerrain(siteSlug, "dtm")`. Not read whole: at 0.25 m Ektanagar 1 alone
   * is 4 million cells, and the render route only ever wants the window one
   * tile covers.
   */
  chm: () => Promise<OpenRaster>;
  cellSize: number;
};

const cache = new Map<string, Promise<Loaded>>();

/**
 * Load a site's forest inventory, or explain precisely why there is none.
 *
 * Mirrors `loadHydrology`'s shape: a cheap manifest read up front, so callers
 * that only need `counts` or `grid` (a summary card, a "this site has N trees"
 * line) never pay for the heavier artefacts, and a `siteSlug` validated once
 * here rather than trusted from a caller that might be less careful.
 */
export async function loadForest(siteSlug: string): Promise<Loaded> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteSlug)) {
    throw new ForestUnavailable("missing", `"${siteSlug}" is not a valid site slug`);
  }
  const hit = cache.get(siteSlug);
  if (hit) return hit;

  const loading = (async (): Promise<Loaded> => {
    const { remote, base } = forestLocation(siteSlug);
    const ref = (file: string) => (remote ? `${base}/${file}` : join(base, file));

    const text = await fetchText(remote, siteSlug, ref(FILES.manifest));
    if (!text) {
      throw new ForestUnavailable(
        "missing",
        `No forest inventory has been computed for this site. Run: ` +
          `node scripts/forest-run.mjs --slug ${siteSlug} ` +
          `--out portal-data/forest/${siteSlug}`,
      );
    }

    let manifest: ForestManifest;
    try {
      manifest = JSON.parse(text) as ForestManifest;
    } catch {
      throw new ForestUnavailable("incomplete", "The forest manifest could not be read.");
    }
    if (!manifest.grid?.cellSize) {
      throw new ForestUnavailable("incomplete", "The forest manifest has no analysis grid.");
    }

    let summaryPromise: Promise<ForestSummary> | null = null;
    const summary = () => {
      if (!summaryPromise) {
        summaryPromise = (async () => {
          const body = await fetchText(remote, siteSlug, ref(FILES.summary));
          if (!body) {
            throw new ForestUnavailable(
              "incomplete",
              `The forest inventory for this site is missing ${FILES.summary}. Re-run forest-run.mjs.`,
            );
          }
          try {
            return JSON.parse(body) as ForestSummary;
          } catch {
            throw new ForestUnavailable("incomplete", `${FILES.summary} could not be parsed.`);
          }
        })();
        summaryPromise.catch(() => {
          summaryPromise = null;
        });
      }
      return summaryPromise;
    };

    let treesPromise: Promise<Buffer> | null = null;
    const treesBinBytes = () => {
      if (!treesPromise) {
        treesPromise = (async () => {
          const bytes = await fetchBytes(remote, siteSlug, ref(FILES.trees));
          if (!bytes) {
            throw new ForestUnavailable(
              "incomplete",
              `The forest inventory for this site is missing ${FILES.trees}. Re-run forest-run.mjs.`,
            );
          }
          return bytes;
        })();
        treesPromise.catch(() => {
          treesPromise = null;
        });
      }
      return treesPromise;
    };

    let crownsPromise: Promise<unknown> | null = null;
    const crowns = () => {
      if (!crownsPromise) {
        crownsPromise = (async () => {
          const body = await fetchText(remote, siteSlug, ref(FILES.crowns));
          if (!body) {
            throw new ForestUnavailable(
              "incomplete",
              `The forest inventory for this site is missing ${FILES.crowns}. Re-run forest-run.mjs.`,
            );
          }
          try {
            return JSON.parse(body) as unknown;
          } catch {
            throw new ForestUnavailable("incomplete", `${FILES.crowns} could not be parsed.`);
          }
        })();
        crownsPromise.catch(() => {
          crownsPromise = null;
        });
      }
      return crownsPromise;
    };

    let chmPromise: Promise<OpenRaster> | null = null;
    const chm = () => {
      if (!chmPromise) {
        chmPromise = (async () => {
          const at = ref(FILES.chm);
          if (!remote && !existsSync(at)) {
            throw new ForestUnavailable(
              "incomplete",
              `The forest inventory for this site is missing ${FILES.chm}. Re-run forest-run.mjs.`,
            );
          }
          try {
            return await openRaster(
              cached(
                remote
                  ? httpSource(at, {
                      headers: async () => ({
                        Cookie: `${TILE_GRANT_COOKIE}=${await createTileGrant(siteSlug)}`,
                      }),
                    })
                  : await fileSource(at),
              ),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (remote && /not found|not authorised/i.test(message)) {
              throw new ForestUnavailable("incomplete", `No ${FILES.chm} published for this site at ${at}.`);
            }
            throw error;
          }
        })();
        chmPromise.catch(() => {
          chmPromise = null;
        });
      }
      return chmPromise;
    };

    return { manifest, summary, treesBinBytes, crowns, chm, cellSize: manifest.grid.cellSize };
  })();

  cache.set(siteSlug, loading);
  loading.catch(() => cache.delete(siteSlug));
  return loading;
}
