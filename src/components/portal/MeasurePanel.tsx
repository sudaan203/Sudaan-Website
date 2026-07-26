"use client";

import { formatArea, formatDistance, formatElevation } from "@/lib/portal/geodesy";

/**
 * The readout for a measurement in progress or finished.
 *
 * Kept apart from MapViewer because it is the part a client actually reads a
 * number off, and it carries the qualifiers that stop that number being
 * misunderstood: which CRS it was computed in, what a volume is measured against,
 * and the survey's own tolerance. A bare "1.23 ha" invites a client to treat it as
 * exact, which over a hectare of plus or minus 4 cm terrain it is not.
 */

export type ProfilePoint = { distance: number; elevation: number | null };

export type Measurement = {
  mode: "distance" | "area";
  points: [number, number][];
  length: number;
  area: number;
  profile: ProfilePoint[];
  utmZone: number;
  closed: boolean;
};

export function MeasurePanel({
  measurement,
  onClear,
  toleranceM,
}: {
  measurement: Measurement;
  onClear: () => void;
  toleranceM: number;
}) {
  const { mode, points, length, area, profile, utmZone } = measurement;
  // Number.isFinite rather than `!== null`: a NaN would pass a null check and
  // then render as an SVG polyline full of NaN coordinates.
  const withData = profile.filter(
    (p): p is { distance: number; elevation: number } =>
      p.elevation !== null && Number.isFinite(p.elevation),
  );

  const min = withData.length ? Math.min(...withData.map((p) => p.elevation)) : null;
  const max = withData.length ? Math.max(...withData.map((p) => p.elevation)) : null;
  const gain = withData.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const d = p.elevation - withData[i - 1].elevation;
    return d > 0 ? sum + d : sum;
  }, 0);
  const grade =
    min !== null && max !== null && length > 0 ? ((max - min) / length) * 100 : null;

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
        {mode === "area" ? (
          <Row label="Area" value={formatArea(area)} />
        ) : null}
        <Row label={mode === "area" ? "Perimeter" : "Length"} value={formatDistance(length)} />
        <Row label="Points" value={String(points.length)} />
        {min !== null && max !== null ? (
          <>
            <Row label="Lowest" value={formatElevation(min, toleranceM)} />
            <Row label="Highest" value={formatElevation(max, toleranceM)} />
            <Row label="Fall" value={formatDistance(max - min)} />
            {gain > 0 ? <Row label="Total climb" value={formatDistance(gain)} /> : null}
            {grade !== null ? <Row label="Average grade" value={`${grade.toFixed(1)}%`} /> : null}
          </>
        ) : null}
      </dl>

      {withData.length > 2 ? (
        <Profile points={withData} />
      ) : profile.length ? (
        <p className="text-[11px] leading-snug text-ink/55">
          No terrain data under this line, so there is no height profile. The survey
          has gaps where ground could not be seen.
        </p>
      ) : null}

      <p className="border-t border-ink/[0.08] pt-2 text-[11px] leading-snug text-ink/55">
        {mode === "area" ? "Plan area" : "Horizontal distance"} computed in UTM zone{" "}
        {utmZone}, the survey&apos;s own projection, not in the map&apos;s Web Mercator,
        which would overstate area here by about 16%.
        {mode === "area" ? " Slope is not included: this is the footprint, as a plan drawing shows it." : ""}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink/60">{label}</dt>
      <dd className="font-mono text-[13px] text-ink-900">{value}</dd>
    </div>
  );
}

/**
 * Elevation against distance. Inline SVG rather than a chart library: it is a
 * polyline and two axis labels, and the portal's CSP has no reason to grow for it.
 */
function Profile({ points }: { points: { distance: number; elevation: number }[] }) {
  const W = 240;
  const H = 72;
  const pad = { top: 6, right: 2, bottom: 14, left: 2 };

  const maxD = points[points.length - 1].distance || 1;
  const lo = Math.min(...points.map((p) => p.elevation));
  const hi = Math.max(...points.map((p) => p.elevation));
  const span = hi - lo || 1;

  const x = (d: number) => pad.left + (d / maxD) * (W - pad.left - pad.right);
  const y = (e: number) =>
    pad.top + (1 - (e - lo) / span) * (H - pad.top - pad.bottom);

  const line = points.map((p) => `${x(p.distance).toFixed(1)},${y(p.elevation).toFixed(1)}`).join(" ");
  const fill = `${x(0).toFixed(1)},${(H - pad.bottom).toFixed(1)} ${line} ${x(maxD).toFixed(1)},${(H - pad.bottom).toFixed(1)}`;

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Elevation profile, ${lo.toFixed(1)} to ${hi.toFixed(1)} metres over ${formatDistance(maxD)}`}
      >
        <polygon points={fill} fill="rgb(229 142 58 / 0.18)" />
        <polyline points={line} fill="none" stroke="#C2410C" strokeWidth={1.4} />
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
        <text x={W - pad.right} y={H - 4} textAnchor="end" className="fill-current text-ink/50" fontSize={8}>
          {formatDistance(maxD)}
        </text>
      </svg>
      <figcaption className="text-[11px] text-ink/55">
        {hi.toFixed(1)} m at the top, {lo.toFixed(1)} m at the bottom, sampled from the
        terrain model.
      </figcaption>
    </figure>
  );
}
