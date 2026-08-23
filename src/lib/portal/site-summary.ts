/**
 * Tool 40: the project summary.
 *
 * Malhar asks for "survey area, highest/lowest elevation, average slope, contour
 * interval, point density, stockpile count, cut/fill volume and survey date in a
 * single dashboard". Almost all of it had already been computed by one pipeline
 * or another and was sitting unread in three separate manifests. This is the
 * panel, not an engine.
 *
 * ## Two rules it follows
 *
 * **A figure we do not have is absent, never zero.** Every value is nullable and
 * the panel prints what is missing rather than a confident 0. Stockpile count
 * and cut/fill volume are the honest cases: both depend on an area a client
 * draws, so there is no site-wide answer, and the summary names the tool that
 * produces one instead of inventing a number.
 *
 * **Every figure states where it came from.** A client asking "where does 19.2°
 * come from" gets an answer without anyone opening the code, and a figure whose
 * provenance cannot be stated does not belong on a dashboard.
 *
 * Node runtime only: it reads manifests from disk or from object storage.
 */

import { readMapFile, readMapManifest } from "@/lib/portal/map-data";
import { loadHydrology } from "@/lib/portal/hydrology-source";
import { loadCloudManifest } from "@/lib/portal/cloud-source";
import { listSurveys } from "@/lib/portal/store";
import { surveyRmseZ } from "@/lib/portal/terrain-source";

/** One line of the summary: a number, its unit, and where it came from. */
export type SummaryFigure = {
  label: string;
  /** Null when we genuinely do not have it. Never substituted with zero. */
  value: number | null;
  unit: string;
  decimals?: number;
  /** Where the figure came from, in one clause. */
  source: string;
  /** Printed instead of a number when `value` is null. */
  absent?: string;
};

export type SiteSummary = {
  site: string;
  /** ISO date of the most recent flight, or null when none is recorded. */
  flownOn: string | null;
  flightLabel: string | null;
  flightCount: number;
  crs: string | null;
  figures: SummaryFigure[];
  /** Which deliverables exist, for the "what we hold" row. */
  has: {
    terrain: boolean;
    surface: boolean;
    orthomosaic: boolean;
    contours: boolean;
    hydrology: boolean;
    pointCloud: boolean;
  };
};

/**
 * The contour interval and the number of distinct levels, read from the file.
 *
 * Derived from the levels themselves rather than from the range and the feature
 * count, because those give the wrong answer: one 372 m contour is several
 * separate LineStrings after clipping, so Kotba's 201 features are 87 levels.
 *
 * The interval is the *commonest* gap, not the smallest and not the mean. A
 * survey's contours need not be complete — a level with no ground at that height
 * produces no line at all, leaving a gap of two intervals — so the minimum would
 * be right by luck and the mean would be wrong by design.
 *
 * Cached per process: this reads a few hundred kilobytes of GeoJSON, which is
 * cheap once and wasteful on every page load.
 */
type Contours = { interval: number | null; levels: number };
const contourCache = new Map<string, Promise<Contours | null>>();

function readContours(siteSlug: string, file: string): Promise<Contours | null> {
  const key = `${siteSlug}/${file}`;
  const hit = contourCache.get(key);
  if (hit) return hit;

  const loading = (async (): Promise<Contours | null> => {
    const found = await readMapFile(siteSlug, file).catch(() => null);
    if (!found) return null;

    let parsed: { features?: { properties?: { elevation?: unknown } }[] };
    try {
      parsed = JSON.parse(found.body.toString("utf8"));
    } catch {
      return null;
    }

    const levels = [
      ...new Set(
        (parsed.features ?? [])
          .map((f) => f.properties?.elevation)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
      ),
    ].sort((a, b) => a - b);
    if (levels.length === 0) return null;

    const gaps = new Map<number, number>();
    for (let i = 1; i < levels.length; i += 1) {
      const gap = Number((levels[i] - levels[i - 1]).toFixed(4));
      gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
    }
    let best = 0;
    let interval: number | null = null;
    for (const [gap, count] of gaps) {
      if (count > best) {
        best = count;
        interval = gap;
      }
    }
    return { interval, levels: levels.length };
  })();

  contourCache.set(key, loading);
  loading.catch(() => contourCache.delete(key));
  return loading;
}

export async function buildSiteSummary(
  siteSlug: string,
  siteId: string | null,
): Promise<SiteSummary> {
  const manifest = await readMapManifest(siteSlug);
  const layers = manifest?.layers ?? [];

  const dem = layers.find((l) => l.kind === "dem") ?? layers.find((l) => l.elevation);
  const contourLayer = layers.find((l) => l.kind === "vector");

  /*
   * Each source is optional and asked for separately, so a site with no
   * hydrology still gets its elevations and one with no LiDAR still gets its
   * slope. Anything that throws simply contributes nothing.
   */
  const [hydro, cloud, surveys, contours] = await Promise.all([
    loadHydrology(siteSlug).catch(() => null),
    loadCloudManifest(siteSlug).catch(() => null),
    siteId ? listSurveys(siteId).catch(() => []) : Promise.resolve([]),
    contourLayer?.file ? readContours(siteSlug, contourLayer.file) : Promise.resolve(null),
  ]);

  const latest = [...surveys].sort((a, b) => b.flownOn.localeCompare(a.flownOn))[0] ?? null;
  const areaHa = hydro?.manifest.analysis.surveyArea_ha ?? null;
  const meanSlope = (hydro?.manifest.layers.find((l) => l.key === "slope_degrees")?.stats?.mean ??
    null) as number | null;
  const elevation = dem?.elevation ?? null;

  const figures: SummaryFigure[] = [
    {
      label: "Area surveyed",
      value: areaHa,
      unit: "ha",
      decimals: 2,
      source: "cells carrying data in the 1 m analysis grid",
      absent: "No analysis grid has been computed for this site.",
    },
    {
      label: "Lowest point",
      value: elevation?.min ?? null,
      unit: "m",
      decimals: 2,
      source: "the terrain model",
    },
    {
      label: "Highest point",
      value: elevation?.max ?? null,
      unit: "m",
      decimals: 2,
      source: "the terrain model",
    },
    {
      label: "Relief",
      value: elevation ? elevation.max - elevation.min : null,
      unit: "m",
      decimals: 2,
      source: "highest minus lowest",
    },
    {
      label: "Average slope",
      value: meanSlope,
      unit: "°",
      decimals: 1,
      source: "mean over the 1 m slope grid",
      absent: "Slope comes with the hydrology, which has not been run for this site.",
    },
    {
      label: "Contour interval",
      value: contours?.interval ?? null,
      unit: "m",
      decimals: 2,
      source: "the commonest gap between levels in the published contours",
    },
    {
      label: "Contour levels",
      value: contours?.levels ?? null,
      unit: "",
      source: "distinct heights, which is fewer than the number of lines",
    },
    {
      label: "Analysis resolution",
      value: hydro?.cellSize ?? null,
      unit: "m",
      decimals: 2,
      source: "the grid slope and drainage are computed on",
    },
    {
      label: "Vertical accuracy",
      value: surveyRmseZ(),
      unit: "m",
      decimals: 3,
      source: "the survey's own checkpoint report",
    },
    {
      label: "LiDAR points",
      value: cloud?.sourcePointCount ?? null,
      unit: "",
      source: "the delivered point cloud",
      absent: "This survey is photogrammetric; no LiDAR was flown.",
    },
    {
      label: "Point density",
      value: cloud && areaHa ? cloud.sourcePointCount / (areaHa * 10_000) : null,
      unit: "per m²",
      decimals: 1,
      source: "points over the surveyed area",
    },
    /*
     * The two on Malhar's list that have no site-wide answer. Both depend on an
     * area a client draws, so a number here would be an invention. Named anyway,
     * with the tool that produces one, because a summary quietly missing two
     * requested fields reads as an oversight rather than a decision.
     */
    {
      label: "Stockpile count",
      value: null,
      unit: "",
      source: "tool 15, stockpile volume",
      absent: "Counted per pile you outline. Automatic detection is not built.",
    },
    {
      label: "Cut and fill",
      value: null,
      unit: "m³",
      source: "tool 4, cut and fill",
      absent: "Measured against a reference you choose, over an area you draw.",
    },
  ];

  return {
    site: siteSlug,
    flownOn: latest?.flownOn ?? null,
    flightLabel: latest?.label ?? null,
    flightCount: surveys.length,
    crs: hydro?.epsg ? `EPSG:${hydro.epsg}` : null,
    figures,
    has: {
      terrain: layers.some((l) => /dtm|terrain/i.test(`${l.key} ${l.title}`)),
      surface: layers.some((l) => /dsm|surface/i.test(`${l.key} ${l.title}`)),
      orthomosaic: layers.some((l) => /ortho/i.test(`${l.key} ${l.title}`)),
      contours: Boolean(contourLayer),
      hydrology: Boolean(hydro),
      pointCloud: Boolean(cloud),
    },
  };
}
