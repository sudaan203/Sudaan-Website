import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { figuresAt } from "@/lib/geo/hypsometry.mjs";

export { figuresAt };

/**
 * Loading and caching a survey's hypsometric table.
 *
 * The arithmetic lives in `src/lib/geo/hypsometry.mjs` beside the rest of the
 * geo engine, so the suites can hold it to the per-cell walk it replaces
 * without standing a server up. This file is the portal's half: where the table
 * lives, and not reading it twice.
 */

export type HypsometricTable = {
  lo: number;
  binM: number;
  bins: number;
  /** Cumulative cell count up to each bin. */
  n: number[];
  /** Cumulative sum of native ground elevation up to each bin. */
  s: number[];
  /**
   * Lowest native ground up to each bin, prefix-minimised.
   *
   * Deepest water is `level - the lowest wet ground`, and a minimum does not
   * decompose into per-bin totals the way a sum does, so it needs its own
   * accumulator. Null where a bin holds no cells.
   */
  m: (number | null)[];
};

export type Hypsometry = {
  kind: "hypsometry";
  generatedAt: string;
  source: string;
  cellArea: number;
  cellSize: number;
  epsg: number | null;
  surveyedCells: number;
  surveyedArea_m2: number;
  /** Every cell at or below the level, whether water could reach it or not. */
  threshold: HypsometricTable | null;
  /** Only ground water reaches rising from outside the survey. Null until a spill surface exists. */
  rising: HypsometricTable | null;
  /** The connectivity cell the rising table's reachability was decided at. */
  spillCellSize: number | null;
};

/** Where a survey's table lives, beside the rasters it was built from. */
function hypsometryPath(siteSlug: string) {
  const base = process.env.PORTAL_TERRAIN_DIR ?? join(process.cwd(), "portal-data", "terrain");
  return join(base, siteSlug, "hypsometry.json");
}

/*
 * Cached per process, like the rasters. The file is a few hundred kilobytes and
 * a client moving a slider asks for level after level against the same survey;
 * re-reading and re-parsing it per request would make the thing this exists to
 * speed up slow again for a different reason.
 *
 * Keyed by path so a republished site is not served from a stale entry, which
 * is the same rule `terrain-source` follows for grids.
 */
const cache = new Map<string, Hypsometry | null>();

export function loadHypsometry(siteSlug: string): Hypsometry | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteSlug)) return null;
  const path = hypsometryPath(siteSlug);
  if (cache.has(path)) return cache.get(path) ?? null;

  let value: Hypsometry | null = null;
  if (existsSync(path)) {
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as Hypsometry;
    } catch {
      // A truncated or half-written table is worse than none: every figure it
      // produced would be confidently wrong. Treated as absent, so the request
      // falls back to walking the ground.
      value = null;
    }
  }
  cache.set(path, value);
  return value;
}
