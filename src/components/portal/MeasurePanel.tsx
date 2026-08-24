"use client";

import type { PolygonStatsResult, ProfileResult, Surface } from "@/lib/portal/analysis-client";
import { formatArea, formatDistance, formatElevation } from "@/lib/portal/geodesy";

/**
 * The readout for a measurement in progress or finished.
 *
 * Kept apart from MapViewer because it is the part a client actually reads a
 * number off, and it carries the qualifiers that stop that number being
 * misunderstood: which CRS it was computed in, what a volume is measured
 * against, and the survey's own tolerance. A bare "1.23 ha" invites a client to
 * treat it as exact, which over a hectare of ±4 cm terrain it is not.
 *
 * ## Two kinds of number, deliberately distinguished
 *
 * **Geometry** — length, area, perimeter — is computed in the browser by
 * `geodesy.ts`, which projects into the survey's UTM zone and applies the
 * shoelace formula. That is exact arithmetic on the vertices the client drew,
 * needs no elevation model, and is instant, so it appears the moment a point is
 * placed.
 *
 * **Elevation** — the profile, the min/max/mean, the volumes — comes from the
 * server, read bilinearly from the source GeoTIFF at native resolution in the
 * survey's own projection. It cannot be computed in the browser without
 * repeating the Terrain-RGB mistake described in `analysis-client.ts`.
 *
 * So the panel fills in twice: geometry immediately, heights a moment later.
 * That is honest about what is known when, and it is why the elevation block
 * carries its own loading and error states rather than blanking the whole panel.
 */

export type Measurement = {
  mode: "distance" | "area";
  points: [number, number][];
  /** Horizontal length of the path, or the ring's perimeter when closed. */
  length: number;
  /** Plan area, zero unless this is a closed area measurement. */
  area: number;
  utmZone: number;
  closed: boolean;
};

/** What the server has said about the elevations under this geometry, so far. */
export type ElevationState =
  | { state: "idle" }
  | { state: "loading" }
  | {
      state: "profile";
      data: ProfileResult;
      cellSize: number;
      computedIn: string;
      /**
       * The other surface's profile over the same line, fetched alongside the
       * primary one wherever both models exist for this survey — so a client
       * can read canopy and structures against bare earth off the one graph
       * instead of flipping the surface toggle and comparing by memory. `null`
       * when the survey only has one surface to measure against.
       */
      other: { surface: Surface; result: ProfileResult } | null;
    }
  | { state: "stats"; data: PolygonStatsResult; cellSize: number; computedIn: string }
  | { state: "error"; message: string };

export function MeasurePanel({
  measurement,
  elevation,
  surface,
  onClear,
  toleranceM,
}: {
  measurement: Measurement;
  elevation: ElevationState;
  surface: Surface;
  onClear: () => void;
  toleranceM: number;
}) {
  const { mode, points, length, area, utmZone } = measurement;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          {mode === "area" ? "Area" : "Distance"}
        </h3>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
        >
          Clear
        </button>
      </div>

      <dl className="space-y-1.5 text-sm">
        {mode === "area" ? <Row label="Area" value={formatArea(area)} /> : null}
        <Row label={mode === "area" ? "Perimeter" : "Length"} value={formatDistance(length)} />
        <Row label="Points" value={String(points.length)} />
        <ElevationRows elevation={elevation} toleranceM={toleranceM} length={length} />
      </dl>

      {elevation.state === "profile" && elevation.data.points.length > 2 ? (
        <Profile result={elevation.data} surface={surface} other={elevation.other} />
      ) : null}

      <ElevationFootnote elevation={elevation} surface={surface} />

      <p className="border-t border-ink/[0.08] pt-2 text-[11px] leading-snug text-ink/55">
        {mode === "area" ? "Plan area" : "Horizontal distance"} computed in UTM zone{" "}
        {utmZone}, the survey&apos;s own projection, not in the map&apos;s Web Mercator,
        which would overstate area here by about 16%.
        {mode === "area"
          ? " Slope is not included: this is the footprint, as a plan drawing shows it."
          : ""}
      </p>
    </div>
  );
}

/**
 * The height half of the readout.
 *
 * Every branch says something. An empty space where a number should be reads as
 * a bug, and "no data" and "still loading" are very different facts about a
 * survey.
 */
function ElevationRows({
  elevation,
  toleranceM,
  length,
}: {
  elevation: ElevationState;
  toleranceM: number;
  length: number;
}) {
  if (elevation.state === "loading") {
    return <Row label="Heights" value="reading the model…" muted />;
  }
  if (elevation.state === "error") {
    return <Row label="Heights" value="unavailable" muted />;
  }
  if (elevation.state === "idle") return null;

  if (elevation.state === "stats") {
    const { min, max, mean } = elevation.data;
    if (min === null || max === null) {
      return <Row label="Heights" value="no data inside" muted />;
    }
    return (
      <>
        <Row label="Lowest" value={formatElevation(min, toleranceM)} />
        <Row label="Highest" value={formatElevation(max, toleranceM)} />
        {mean !== null ? <Row label="Mean" value={formatElevation(mean, toleranceM)} /> : null}
        <Row label="Fall" value={formatDistance(max - min)} />
      </>
    );
  }

  const { min, max, gain, loss, gradePercent, maxSlopePercent } = elevation.data;
  if (min === null || max === null) {
    return <Row label="Heights" value="no data under this line" muted />;
  }
  return (
    <>
      <Row label="Lowest" value={formatElevation(min, toleranceM)} />
      <Row label="Highest" value={formatElevation(max, toleranceM)} />
      <Row label="Fall" value={formatDistance(max - min)} />
      {gain > 0 ? <Row label="Total climb" value={formatDistance(gain)} /> : null}
      {loss > 0 ? <Row label="Total descent" value={formatDistance(loss)} /> : null}
      {/*
        End to end grade and the steepest sampled step are different numbers and
        the difference matters to a road engineer: a line can fall 1% overall
        while containing a 9% pitch. Labelling either one "grade" on its own is
        how a haul road gets signed off on the average.
      */}
      {gradePercent !== null && length > 0 ? (
        <Row label="Grade, end to end" value={`${gradePercent.toFixed(1)}%`} />
      ) : null}
      {maxSlopePercent > 0 ? (
        <Row label="Steepest step" value={`${maxSlopePercent.toFixed(1)}%`} />
      ) : null}
    </>
  );
}

/**
 * The provenance line. This is the sentence that makes the number defensible, so
 * it states the surface, the sampling interval and the projection rather than
 * implying them.
 */
function ElevationFootnote({
  elevation,
  surface,
}: {
  elevation: ElevationState;
  surface: Surface;
}) {
  if (elevation.state === "error") {
    return (
      <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
        {elevation.message}
      </p>
    );
  }
  if (elevation.state !== "profile" && elevation.state !== "stats") return null;

  const model = surface === "dsm" ? "surface model (DSM)" : "terrain model (DTM)";

  /**
   * How much of the drawn polygon was actually measured.
   *
   * Deliberately `area - coveredArea` rather than the `nodataArea` and
   * `complete` the analysis returns. Those two describe only what is inside the
   * raster's own extent: the window the statistics walk is clamped to the grid,
   * so a polygon reaching past the edge of the survey contributes its outside
   * part to neither figure. A polygon drawn *entirely* off the survey comes back
   * with `complete: true` and no elevations at all, which would print as a clean
   * result with a blank height. Comparing measured against drawn cannot be
   * fooled that way, because both are areas of the same polygon.
   */
  const shortfall =
    elevation.state === "stats"
      ? elevation.data.area - elevation.data.coveredArea
      : 0;
  const gap =
    elevation.state === "stats"
      ? shortfall > elevation.data.area * 0.001
      : elevation.data.samplesWithoutData > 0;

  return (
    <div className="space-y-1.5">
      {/*
        A polygon straying off the survey footprint is the commonest way a volume
        comes back confidently wrong: the arithmetic is fine, it just measured
        less ground than the client thinks they drew. Never silent.
      */}
      {gap ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {elevation.state === "stats"
            ? elevation.data.coveredArea === 0
              ? "None of this polygon has survey data underneath it."
              : `${formatArea(shortfall)} of this polygon has no survey data. ` +
                `The heights above describe only the ${formatArea(elevation.data.coveredArea)} that does.`
            : `${elevation.data.samplesWithoutData} of ${elevation.data.points.length} samples ` +
              `fall where the survey has no data, so the profile has gaps.`}
        </p>
      ) : null}
      <p className="text-[11px] leading-snug text-ink/55">
        Heights read from the {model} at its native {elevation.cellSize.toFixed(2)} m cell,
        bilinearly, in {elevation.computedIn}
        {elevation.state === "profile"
          ? `, sampled every ${elevation.data.sampleSpacing.toFixed(2)} m`
          : ""}
        .
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink/60">{label}</dt>
      <dd className={`font-mono text-[13px] ${muted ? "text-ink/45" : "text-ink-900"}`}>
        {value}
      </dd>
    </div>
  );
}

/** A point with a real elevation, not a gap in the survey. */
type ProfileSample = { chainage: number; elevation: number };

function hasElevation<T extends { elevation: number | null }>(
  p: T,
): p is T & { elevation: number } {
  return p.elevation !== null && Number.isFinite(p.elevation);
}

/** Split a profile's points into runs of consecutive samples that both have data. */
function runsOf(points: { chainage: number; elevation: number | null }[]): ProfileSample[][] {
  const runs: ProfileSample[][] = [];
  let run: ProfileSample[] = [];
  for (const point of points) {
    if (point.elevation === null || !Number.isFinite(point.elevation)) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    run.push({ chainage: point.chainage, elevation: point.elevation });
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** The vertical extent a profile actually needs drawn, falling back to its samples. */
function boundsOf(result: ProfileResult, withData: ProfileSample[]): [number, number] {
  return [
    result.min ?? Math.min(...withData.map((p) => p.elevation)),
    result.max ?? Math.max(...withData.map((p) => p.elevation)),
  ];
}

const SURFACE_LABEL: Record<Surface, string> = {
  dtm: "Terrain (DTM)",
  dsm: "Surface (DSM)",
};

/**
 * Elevation against chainage. Inline SVG rather than a chart library: it is a
 * polyline and two axis labels, and the portal's CSP has no reason to grow for
 * it.
 *
 * Gaps in the survey break the line rather than bridging it. A polyline drawn
 * straight across a hole looks like flat ground, which is the one reading the
 * data does not support.
 *
 * `other` overlays the second surface's profile over the same line — Malhar
 * asked to see DSM and DTM on the one graph rather than reading them one at a
 * time behind the surface toggle. It is drawn dashed and unfilled, deliberately
 * secondary to the filled primary line: the two describe the same ground, and
 * flipping which one looks "on top" every time the toggle is touched would
 * make the chart harder to read, not easier.
 */
function Profile({
  result,
  surface,
  other,
}: {
  result: ProfileResult;
  surface: Surface;
  other: { surface: Surface; result: ProfileResult } | null;
}) {
  const W = 240;
  const H = 72;
  const pad = { top: 6, right: 2, bottom: 14, left: 2 };

  const withData = result.points.filter(hasElevation);
  if (withData.length < 2) return null;

  const otherWithData = other ? other.result.points.filter(hasElevation) : [];
  const hasOverlay = other !== null && otherWithData.length >= 2;

  const maxD = result.length || 1;
  const [primaryLo, primaryHi] = boundsOf(result, withData);
  const [lo, hi] = hasOverlay
    ? [
        Math.min(primaryLo, boundsOf(other.result, otherWithData)[0]),
        Math.max(primaryHi, boundsOf(other.result, otherWithData)[1]),
      ]
    : [primaryLo, primaryHi];
  const span = hi - lo || 1;

  const x = (d: number) => pad.left + (d / maxD) * (W - pad.left - pad.right);
  const y = (e: number) => pad.top + (1 - (e - lo) / span) * (H - pad.top - pad.bottom);

  const runs = runsOf(result.points);
  const otherRuns = hasOverlay ? runsOf(other.result.points) : [];
  const primaryLabel = SURFACE_LABEL[surface];
  const otherLabel = hasOverlay ? SURFACE_LABEL[other.surface] : null;

  return (
    <figure className="space-y-1">
      {hasOverlay ? (
        <div className="flex items-center gap-3 text-[10px] text-ink/55">
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 rounded-full bg-[#C2410C]" />
            {primaryLabel}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 rounded-full bg-[#1D4ED8] opacity-80" />
            {otherLabel}
          </span>
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={
          hasOverlay
            ? `Elevation profile, ${lo.toFixed(1)} to ${hi.toFixed(1)} metres over ` +
              `${formatDistance(maxD)}, ${primaryLabel} overlaid with ${otherLabel}`
            : `Elevation profile, ${lo.toFixed(1)} to ${hi.toFixed(1)} metres over ${formatDistance(maxD)}`
        }
      >
        {/* The overlay is drawn first, so the primary's filled area sits on top of it. */}
        {otherRuns.map((segment, index) => (
          <polyline
            key={`other-${index}`}
            points={segment
              .map((p) => `${x(p.chainage).toFixed(1)},${y(p.elevation).toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke="#1D4ED8"
            strokeWidth={1.2}
            strokeDasharray="3 2"
            opacity={0.8}
          />
        ))}
        {runs.map((segment, index) => {
          const line = segment
            .map((p) => `${x(p.chainage).toFixed(1)},${y(p.elevation).toFixed(1)}`)
            .join(" ");
          const first = segment[0];
          const last = segment[segment.length - 1];
          const fill =
            `${x(first.chainage).toFixed(1)},${(H - pad.bottom).toFixed(1)} ` +
            `${line} ` +
            `${x(last.chainage).toFixed(1)},${(H - pad.bottom).toFixed(1)}`;
          return (
            <g key={index}>
              <polygon points={fill} fill="rgb(229 142 58 / 0.18)" />
              <polyline points={line} fill="none" stroke="#C2410C" strokeWidth={1.4} />
            </g>
          );
        })}
        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={H - pad.bottom}
          y2={H - pad.bottom}
          stroke="currentColor"
          className="text-ink/20"
          strokeWidth={0.75}
        />
        <text x={pad.left} y={H - 4} className="fill-current text-ink/50" fontSize={8}>
          0
        </text>
        <text
          x={W - pad.right}
          y={H - 4}
          textAnchor="end"
          className="fill-current text-ink/50"
          fontSize={8}
        >
          {formatDistance(maxD)}
        </text>
      </svg>
      <figcaption className="text-[11px] text-ink/55">
        {hi.toFixed(1)} m at the top, {lo.toFixed(1)} m at the bottom
        {runs.length > 1 ? `, in ${runs.length} sections either side of missing data` : ""}.
        {hasOverlay ? ` Dashed line is the ${otherLabel!.toLowerCase()}.` : ""}
      </figcaption>
    </figure>
  );
}
