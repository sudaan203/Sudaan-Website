"use client";

/**
 * The browser's one and only source of elevation truth.
 *
 * Every number a client reads off this portal that came from the terrain model
 * comes through here, and the reason is `docs/dashboard-tools-plan.md` phase 0
 * item 6: **sever the measurement path from the display path**. Before this
 * file, `DemSampler` answered "how high is that" by decoding a Terrain-RGB tile
 * in the browser. That is wrong in four compounding ways, none of which look
 * wrong on screen:
 *
 * - Terrain-RGB quantises elevation to 0.1 m, two and a half times coarser than
 *   the ±4 cm the survey is sold on.
 * - The sampler took the nearest pixel (`Math.floor`), not a bilinear read, so a
 *   point could resolve half a cell away. On a 15° slope at 24 cm cells that is
 *   ~13 cm of error the browser invented.
 * - Tiles are Web Mercator, so the value has been through a reprojection and a
 *   resample before anybody measured it.
 * - The tile is chosen by *map zoom*, so the same point answered differently
 *   depending on how far the client happened to be zoomed in.
 *
 * The server reads the source GeoTIFF, bilinearly, at native resolution, in the
 * survey's own UTM zone. Same click, one answer, and the answer does not move
 * when the map does.
 *
 * ## Why this file exists rather than a bare fetch in the component
 *
 * Two things that are easy to get wrong and impossible to see once wrong:
 *
 * 1. **Out of order responses.** Clicking three points quickly fires three
 *    requests, and nothing guarantees they come back in order. A slow first
 *    response landing after a fast third silently overwrites the newer answer
 *    with an older one, and the panel then describes geometry that is no longer
 *    on screen. `latest()` makes staleness structural rather than a race the
 *    reviewer has to spot.
 * 2. **Failure taxonomy.** A 409 here means "this site has no terrain yet",
 *    which is not an error the client did anything about, while a 400 carries a
 *    message the API deliberately wrote *for the client to read* (see the
 *    reference-surface refusal in the analysis route). Flattening those into
 *    "something went wrong" throws away the most useful part.
 */

import {
  classifyStatus,
  describeReference as describeReferenceCore,
  latest as latestCore,
  referenceToWire as referenceToWireCore,
} from "./analysis-core.mjs";

export type Crs = "lonlat" | "utm";
export type Surface = "dtm" | "dsm";

/** A coordinate pair. Longitude/latitude, or easting/northing, per `crs`. */
export type Pair = [number, number];

export type AnalysisErrorKind =
  | "auth"
  | "not-found"
  | "no-terrain"
  | "bad-request"
  | "network"
  | "server";

/**
 * Carries the distinction the UI needs to decide between "tell the client to
 * sign in", "tell them nothing is published yet" and "tell them what they typed
 * was refused, quoting the API".
 */
export class AnalysisError extends Error {
  readonly kind: AnalysisErrorKind;
  /** `TerrainUnavailable.reason` for a 409: missing | too-large | not-projected. */
  readonly reason?: string;

  constructor(kind: AnalysisErrorKind, message: string, reason?: string) {
    super(message);
    this.name = "AnalysisError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** Every response repeats the CRS and the accuracy it was computed under. */
export type AnalysisEnvelope = {
  op: string;
  site: string;
  surface: Surface;
  computedIn: string;
  cellSize: number;
  rmseZ: number | null;
};

export type SpotResult = {
  easting: number;
  northing: number;
  elevation: number | null;
  method: string;
  note: string | null;
};

export type ProfilePoint = {
  chainage: number;
  easting: number;
  northing: number;
  elevation: number | null;
  slopePercent: number | null;
};

export type ProfileResult = {
  points: ProfilePoint[];
  length: number;
  sampleSpacing: number;
  min: number | null;
  max: number | null;
  gain: number;
  loss: number;
  gradePercent: number | null;
  maxSlopePercent: number;
  samplesWithoutData: number;
};

export type PolygonStatsResult = {
  area: number;
  areaHectares: number;
  perimeter: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  coveredArea: number;
  nodataArea: number;
  complete: boolean;
};

export type VolumeResult = {
  reference: string;
  cut: number;
  fill: number;
  net: number;
  cutArea: number;
  fillArea: number;
  measuredArea: number;
  polygonArea: number;
  maxCutDepth: number;
  maxFillDepth: number;
  meanDepth: number | null;
  nodataArea: number;
  referenceMissingArea: number;
  complete: boolean;
  uncertainty: number | null;
  rmseZ: number | null;
  computedIn: string;
};

/**
 * Tool 15. Everything cut and fill returns, plus the three figures Malhar asks
 * a stockpile for by name: volume, base area and height.
 *
 * `volume` is the cut alone, not the net. A pile measured against its own rim
 * has fill only where the polygon has been drawn past the toe and dips below the
 * fitted base, and adding that back in would quietly shrink the pile. It is
 * reported separately as `volumeBelowBase` so an overdrawn polygon is visible
 * rather than absorbed.
 */
export type StockpileResult = VolumeResult & {
  volume: number;
  baseArea: number;
  maxHeight: number;
  meanHeight: number | null;
  volumeBelowBase: number;
  footprintArea: number;
};

/**
 * How a volume is measured against. Never defaulted, here or on the server:
 * cut and fill against a flat plane, against the polygon's own rim, and against
 * a second surface are three different questions with three different answers,
 * and a client who was not asked cannot know which one they were given.
 */
export type VolumeReference =
  | { kind: "boundary" }
  | { kind: "plane"; elevation: number }
  | { kind: "surface"; surface: Surface };

export const referenceToWire = referenceToWireCore as (reference: VolumeReference) => string;

/** Human wording for a reference, used in the panel and in exports. */
export const describeReference = describeReferenceCore as (
  reference: VolumeReference,
) => string;

type Envelope<T> = AnalysisEnvelope & { result: T };

export type AnalysisRequest = {
  op: string;
  crs?: Crs;
  surface?: Surface;
  [key: string]: unknown;
};

/**
 * A client bound to one site.
 *
 * Bound rather than passed per call because the site is what the server's
 * tenant check keys on, and a component that can accidentally ask about a
 * different site is a component that can accidentally leak one.
 */
export class AnalysisClient {
  constructor(private readonly siteSlug: string) {}

  get endpoint(): string {
    return `/api/portal/sites/${encodeURIComponent(this.siteSlug)}/analysis`;
  }

  async run<T>(request: AnalysisRequest, signal?: AbortSignal): Promise<Envelope<T>> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The session cookie is what the tenant check reads. Without this the
        // route answers 401 and the failure looks like a bug in the analysis.
        credentials: "same-origin",
        body: JSON.stringify({ crs: "lonlat", ...request }),
        signal,
      });
    } catch (error) {
      // An abort is a deliberate supersede, not a failure to report. Rethrow it
      // unchanged so `latest()` can swallow it and the UI never flashes an error
      // for a request the UI itself cancelled.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new AnalysisError(
        "network",
        "The measurement could not be sent. Check the connection and try again.",
      );
    }

    if (!response.ok) throw await errorFor(response);

    return (await response.json()) as Envelope<T>;
  }

  spot(at: Pair, options: { surface?: Surface; crs?: Crs } = {}, signal?: AbortSignal) {
    return this.run<SpotResult>({ op: "spot", at: [at], ...options }, signal);
  }

  profile(
    line: Pair[],
    options: { spacing?: number; surface?: Surface; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<ProfileResult>({ op: "profile", line, ...options }, signal);
  }

  polygonStats(
    polygon: Pair[],
    options: { surface?: Surface; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<PolygonStatsResult>({ op: "polygon-stats", polygon, ...options }, signal);
  }

  volume(
    polygon: Pair[],
    reference: VolumeReference,
    options: { surface?: Surface; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<VolumeResult>(
      { op: "volume", polygon, reference: referenceToWire(reference), ...options },
      signal,
    );
  }

  /**
   * Tool 15, stockpile volume.
   *
   * A separate method rather than a flag on `volume`, because it is a separate
   * op on the server returning a wider result, and because the reference a
   * stockpile wants is almost always "boundary" — the pile's own toe — while a
   * cut and fill against the toe is the unusual choice. Keeping them apart lets
   * each panel default the way its tool should and neither inherit the other's
   * habit.
   */
  stockpile(
    polygon: Pair[],
    reference: VolumeReference,
    options: { surface?: Surface; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<StockpileResult>(
      { op: "stockpile", polygon, reference: referenceToWire(reference), ...options },
      signal,
    );
  }
}

/**
 * Client wording for the three ways a survey can have nothing to measure.
 *
 * Each is a different fact and deserves different words. "Not published yet"
 * invites the client to wait; "too large" is our limitation and should not be
 * dressed up as theirs; "not projected" is a data problem someone has to fix.
 */
function terrainMessage(reason: string | undefined): string {
  switch (reason) {
    case "missing":
      return "Measurements are not available for this survey yet.";
    case "too-large":
      return "This survey is too large to measure interactively. Ask us for the figures you need.";
    case "not-projected":
      return "This survey is not in a projected coordinate system, so it cannot be measured.";
    default:
      return "Measurements are not available for this survey.";
  }
}

async function errorFor(response: Response): Promise<AnalysisError> {
  let payload: { error?: string; reason?: string } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // A non JSON body from a proxy or an edge error. The status still carries
    // enough to classify it.
  }

  const kind = classifyStatus(response.status) as AnalysisErrorKind;

  switch (kind) {
    case "auth":
      return new AnalysisError(kind, "Your session has expired. Sign in again to keep measuring.");
    case "not-found":
      // The route answers 404 both for "no such site" and "not yours", on
      // purpose, so a slug is never confirmed. The client wording must not
      // distinguish them either.
      return new AnalysisError(kind, "This survey is no longer available.");
    case "no-terrain":
      /*
       * Deliberately NOT `payload.error`. A 409's message is written for whoever
       * operates the pipeline and reads like it: "Place the source GeoTIFF at
       * portal-data/terrain/<slug>/dtm.tif, in UTM, and restart." Putting that
       * in front of a client is both meaningless to them and a needless
       * disclosure of the server's directory layout. The machine readable
       * `reason` carries everything the UI actually needs to distinguish.
       */
      return new AnalysisError(kind, terrainMessage(payload.reason), payload.reason);
    case "bad-request":
      // Written by the API for the client to read: the reference-surface
      // refusal, the point cap, the CRS contract. Passing it through verbatim
      // is the point.
      return new AnalysisError(kind, payload.error ?? "That measurement was refused.");
    default:
      return new AnalysisError(
        "server",
        "The measurement could not be computed. The team has been notified.",
      );
  }
}

/**
 * Wrap an async call so only the most recent one can settle.
 *
 * Returns a function that aborts whatever is in flight before starting the next,
 * and resolves to `null` for any call that has since been superseded. The caller
 * writes `if (result === null) return;` and cannot then apply a stale answer,
 * which is the only reliable shape for this: a component that checks a sequence
 * number by hand gets it right until somebody adds a second `await`.
 */
export const latest = latestCore as <A extends unknown[], R>(
  work: (signal: AbortSignal, ...args: A) => Promise<R>,
) => { call: (...args: A) => Promise<R | null>; cancel: () => void; pending: boolean };
