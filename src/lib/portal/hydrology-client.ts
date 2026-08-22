"use client";

import { AnalysisError, latest, type Pair } from "./analysis-client";

/**
 * The browser's view of the hydrology route.
 *
 * Deliberately a sibling of `analysis-client.ts` rather than part of it: the two
 * answer different questions from different data at different resolutions, and
 * the failure modes do not overlap. Measurement fails when a survey has no
 * raster; hydrology fails when nobody has run `hydro-run.mjs` for the site,
 * which is an operator action rather than a missing deliverable.
 *
 * It reuses `latest()` and `AnalysisError` because the request sequencing
 * problem is identical — a slow watershed landing after a fast one repaints the
 * map with a catchment the client already replaced — and solving it twice would
 * mean solving it twice.
 */

export type HydrologyOp =
  | "layers"
  | "streams"
  | "basins"
  | "inspect"
  | "watershed"
  | "sinks"
  | "flood";

export type HydrologyEnvelope = {
  site: string;
  op: string;
  computedIn: string;
  cellSize: number;
  resolutionNote: string;
  generatedAt: string;
  generator: string;
};

export type HydrologyAnalysis = {
  cellSize: number;
  width: number;
  height: number;
  streamThresholdCells: number;
  streamThresholdArea_m2: number;
  filledCells: number;
  maxFillDepth_m: number;
  surveyArea_ha: number;
};

export type LayerSummary = {
  key: string;
  title: string;
  group: string;
  format: string;
  description: string;
  derivedFrom: string;
  generator: string;
  params: Record<string, unknown>;
  stats: { min?: number; max?: number; mean?: number; dataCells?: number } | null;
};

export type InspectResult = {
  easting: number;
  northing: number;
  elevation: number | null;
  slopeDegrees: number | null;
  slopePercent: number | null;
  contributingCells: number | null;
  contributingArea_m2: number | null;
  contributingArea_ha: number | null;
  strahlerOrder: number | null;
  onChannel: boolean;
  sinkDepth_m: number | null;
  drainsTo: { easting: number; northing: number } | null;
};

export type WatershedResult = {
  pourPoint: {
    easting: number;
    northing: number;
    lonlat: Pair;
    snapped: boolean;
    snappedBy_m: number;
  };
  cells: number;
  area_m2: number;
  area_ha: number;
  truncatedBySurveyEdge: boolean;
  note: string | null;
  geojson: GeoJSON.FeatureCollection;
};

export type SinksResult = {
  minDepth_m: number;
  cells: number;
  area_m2: number;
  area_ha: number;
  storage_m3: number;
  deepest_m: number;
  geojson: GeoJSON.FeatureCollection;
};

export type FloodResult = {
  level_m: number;
  seedGround_m: number;
  cells: number;
  area_m2: number;
  area_ha: number;
  storage_m3: number;
  /** The deepest water anywhere in the lake, not the depth at the seed. */
  maxDepth_m: number;
  depthAtSeed_m: number;
  method: string;
  geojson: GeoJSON.FeatureCollection;
};

type Envelope<T> = HydrologyEnvelope & { result: T };

export class HydrologyClient {
  constructor(private readonly siteSlug: string) {}

  get endpoint(): string {
    return `/api/portal/sites/${encodeURIComponent(this.siteSlug)}/hydrology`;
  }

  async run<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<Envelope<T>> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ crs: "lonlat", ...body }),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new AnalysisError("network", "The hydrology request could not be sent.");
    }

    if (!response.ok) {
      let payload: { error?: string; reason?: string } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        /* a non JSON body from an edge error */
      }
      switch (response.status) {
        case 401:
          throw new AnalysisError("auth", "Your session has expired. Sign in again.");
        case 404:
          throw new AnalysisError("not-found", "This survey is no longer available.");
        case 409:
          /*
           * Unlike terrain, this message is safe to pass through and worth
           * passing through: a 409 here means nobody has run the hydrology for
           * this site yet, and the route's wording says so without naming a
           * server path. It is the one case where the client and the operator
           * want the same sentence.
           */
          throw new AnalysisError(
            "no-terrain",
            payload.error ?? "Hydrology has not been computed for this survey yet.",
            payload.reason,
          );
        case 400:
          throw new AnalysisError("bad-request", payload.error ?? "That request was refused.");
        default:
          throw new AnalysisError("server", "The hydrology could not be computed.");
      }
    }

    return (await response.json()) as Envelope<T>;
  }

  layers(signal?: AbortSignal) {
    return this.run<{ analysis: HydrologyAnalysis; layers: LayerSummary[] }>(
      { op: "layers" },
      signal,
    );
  }

  vector(op: "streams" | "basins", signal?: AbortSignal) {
    return this.run<{ geojson: GeoJSON.FeatureCollection }>({ op }, signal);
  }

  inspect(at: Pair, signal?: AbortSignal) {
    return this.run<InspectResult>({ op: "inspect", at }, signal);
  }

  watershed(at: Pair, options: { snap?: boolean } = {}, signal?: AbortSignal) {
    return this.run<WatershedResult>({ op: "watershed", at, ...options }, signal);
  }

  sinks(minDepth: number, signal?: AbortSignal) {
    return this.run<SinksResult>({ op: "sinks", minDepth }, signal);
  }

  flood(at: Pair, level: number, signal?: AbortSignal) {
    return this.run<FloodResult>({ op: "flood", at, level }, signal);
  }
}

export { latest, AnalysisError };
