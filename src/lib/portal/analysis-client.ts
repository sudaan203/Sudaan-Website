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
 * Tool 2. A grid of levels inside a polygon, at a stated spacing.
 *
 * Points come back in the survey's own projected metres, which is what a total
 * station and a CAD drawing take. Turning them into longitude and latitude for
 * export would be actively unhelpful.
 */
export type GridLevelsResult = {
  points: { easting: number; northing: number; elevation: number }[];
  spacing: number;
  /** Grid nodes inside the polygon with no survey underneath them. */
  pointsOutsideSurvey: number;
  stats: PolygonStatsResult;
};

/**
 * Tools 5 and 13. How far one surface sits from another, over a polygon.
 *
 * The tolerance fields are null unless a tolerance was asked for: deviation and
 * classification are one measurement and one reading of it, not two answers.
 */
export type CompareResult = {
  reference: string;
  comparedArea: number;
  polygonArea: number;
  nodataArea: number;
  referenceMissingArea: number;
  complete: boolean;

  minChange: number | null;
  maxChange: number | null;
  meanChange: number | null;
  /** The one that does not cancel: 2 m up and 2 m down is a mean of zero. */
  meanAbsoluteChange: number | null;
  volumeGained: number;
  volumeLost: number;
  netVolume: number;

  tolerance: number | null;
  withinArea: number | null;
  aboveArea: number | null;
  belowArea: number | null;
  withinShare: number | null;
  worstAbove: number | null;
  worstBelow: number | null;
  /** False when the tolerance is finer than the survey can resolve. */
  resolvable: boolean | null;
  note: string | null;
  rmseZ: number | null;
  uncertainty: number | null;
  computedIn: string;
};

// ---------------------------------------------------------------------------
// Tools 16, 19, 20 and 21: everything measured along an alignment
// ---------------------------------------------------------------------------

/**
 * The four tools that take a drawn line rather than a polygon.
 *
 * They share a geometry and nothing else, which is why they share a mode on the
 * map and have separate results here. Chainage walks the line; cross sections
 * and corridor cut across it; bench reads it as a profile of a face.
 */
export type AlignmentOp = "chainage" | "cross-sections" | "corridor" | "bench";

export type ChainageStation = {
  chainage: number;
  /** "1+234.500", the form a drawing uses. */
  label: string;
  easting: number;
  northing: number;
  /** Added by the route so the map can draw the station without reprojecting. */
  lonlat?: Pair;
  elevation: number | null;
  /** Grade to the previous station, not the grade end to end. Null at the start. */
  gradePercent?: number | null;
};

export type ChainageResult = {
  stations: ChainageStation[];
  interval: number;
  length: number;
  /** The steepest grade between two consecutive stations. */
  maxGradePercent: number | null;
  meanGradePercent: number | null;
  rmseZ: number | null;
  stationsWithoutData: number;
};

export type CrossSection = {
  chainage: number;
  label: string;
  centreEasting: number;
  centreNorthing: number;
  centreLonLat?: Pair;
  /** The two ends of the cut, so the map can draw the tick it was taken along. */
  endsLonLat?: [Pair, Pair] | null;
  centreElevation: number | null;
  samples: { offset: number; easting: number; northing: number; elevation: number | null }[];
  min: number | null;
  max: number | null;
  crossfallPercent: number | null;
};

export type CrossSectionsResult = {
  sections: CrossSection[];
  interval: number;
  halfWidth: number;
  sampleSpacing: number;
  length: number;
};

export type CorridorStation = {
  chainage: number;
  label: string;
  easting?: number;
  northing?: number;
  lonlat?: Pair;
  centreElevation: number | null;
  gradePercent: number | null;
  crossfallPercent: number | null;
  usableWidth: number | null;
  unsafe: boolean;
};

export type CorridorResult = {
  stations: CorridorStation[];
  limits: { maxGradePercent: number; maxCrossfallPercent: number; usableSlopePercent: number };
  meanUsableWidth: number | null;
  minUsableWidth: number | null;
  unsafeStations: CorridorStation[];
  /** How width was derived, which is not a survey of the kerb lines. */
  widthMethod: string;
};

export type BenchRun = {
  fromChainage: number;
  toChainage: number;
  width: number;
  height: number;
  slopePercent: number | null;
  slopeDegrees: number | null;
};

export type BenchResult = {
  benches: BenchRun[];
  faces: (BenchRun & { angleDegrees: number })[];
  meanBenchWidth: number | null;
  meanBenchHeight: number | null;
  maxFaceAngleDegrees: number | null;
  /** How many flats were classified but were too short to call a bench. */
  narrowFlats: number;
  /**
   * Where the line went, in metres. The four add up to `length`, and they are
   * computed independently so that is a fact rather than an identity.
   */
  lengthBreakdown: {
    bench: number;
    face: number;
    narrowFlat: number;
    /** The ends of the line with no survey underneath them. */
    unsurveyed: number;
    length: number;
  };
};

/**
 * One water level of Malhar's flood simulation, with its polygon and its
 * statistics.
 *
 * The area is repeated in three units because his spec asks for all three, and
 * because a client reading "0.245" wants to know without arithmetic whether
 * that is a quarter of a square kilometre or a quarter of a hectare.
 */
export type FloodLevel = {
  level_m: number;
  cells: number;
  area_m2: number;
  area_ha: number;
  area_km2: number;
  volume_m3: number;
  maxDepth_m: number;
  /**
   * The flood reaches the edge of the surveyed ground, so it may continue past
   * what was drawn. The area is then a lower bound, exactly as a catchment's
   * `truncatedBySurveyEdge` is.
   */
  truncated: boolean;
  geojson: GeoJSON.FeatureCollection;
};

export type FloodResult = {
  /** "connected" when a water source was given, "threshold" when none was. */
  method: "connected" | "threshold";
  /** Ground elevation at the water source, or null for a threshold flood. */
  seedGround_m: number | null;
  levels: FloodLevel[];
};

/** Every parameter the four alignment ops take, each optional and each defaulted
 *  on the server so a missing one is never silently zero. */
export type AlignmentOptions = {
  interval?: number;
  halfWidth?: number;
  maxGradePercent?: number;
  maxCrossfallPercent?: number;
  benchSlopePercent?: number;
  minBenchWidth?: number;
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

  /** Tool 2: a grid of levels inside a polygon, at a stated spacing. */
  gridLevels(
    polygon: Pair[],
    spacing: number,
    options: { surface?: Surface; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<GridLevelsResult>({ op: "grid-levels", polygon, spacing, ...options }, signal);
  }

  /**
   * Tools 5 and 13: deviation from a reference, and how much of it is within a
   * tolerance. Omitting `tolerance` asks only for the deviation.
   */
  compare(
    polygon: Pair[],
    reference: VolumeReference,
    options: { tolerance?: number; surface?: Surface; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<CompareResult>(
      { op: "compare", polygon, reference: referenceToWire(reference), ...options },
      signal,
    );
  }

  /**
   * Tools 16, 19, 20 and 21: one method, because they differ only in which
   * question is asked of the same drawn line.
   *
   * The result type is the caller's to narrow. Four near-identical methods
   * returning four types would read better at each call site and would put the
   * op string in two places, which is exactly where the last mismatch between
   * client and server came from.
   */
  alignment<T>(
    op: AlignmentOp,
    line: Pair[],
    options: AlignmentOptions & { surface?: Surface; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<T>({ op, line, ...options }, signal);
  }

  /**
   * Malhar's water-level-rise simulation.
   *
   * The whole ladder of levels goes in one request rather than one request per
   * animation step. The server reads the DTM once either way, so a fifteen-step
   * run costs barely more than a single level — and it means the animation
   * plays from data already in the browser instead of stuttering on the
   * network, which is what "the interval buttons must work automatically"
   * actually requires in practice.
   *
   * `at` or `polygon` names a water source and asks for a connected flood.
   * Neither asks for a plain elevation threshold, which floods every hollow
   * below the level whether water could reach it or not. There is no default:
   * the two are different questions, and which one was asked comes back in
   * `method` so the panel can say which one it is showing.
   *
   * No `surface` option, deliberately. Water spreads over bare earth; a flood
   * simulated over the surface model would be water flowing across treetops.
   * The server pins this op to the DTM and ignores the field.
   *
   * `bounds` is the map's current view as [[west, south], [east, north]], and
   * it is what makes this work on a large survey at all. Kiru's DTM is 2.5
   * billion cells; nothing reads that whole, and a flood across 21 km of gorge
   * is not a question anyone asks. The flood is computed over the ground on
   * screen, and water reaching the edge of it comes back flagged `truncated`.
   */
  flood(
    levels: number[],
    source: { at?: Pair; polygon?: Pair[] } = {},
    options: { interval?: number; bounds?: [Pair, Pair]; crs?: Crs } = {},
    signal?: AbortSignal,
  ) {
    return this.run<FloodResult>(
      {
        op: "flood",
        levels,
        ...(source.at ? { at: [source.at] } : {}),
        ...(source.polygon ? { polygon: source.polygon } : {}),
        ...options,
      },
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
