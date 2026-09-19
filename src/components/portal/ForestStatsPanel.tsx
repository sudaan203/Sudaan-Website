"use client";

import { DEFAULT_CONFIDENCE_THRESHOLD, type ConfidenceStats } from "@/lib/portal/forest-client";
import type {
  DensityGridCell,
  ForestManifestClient,
  ForestSummaryClient,
  HistogramBin,
  ScatterPoint,
  TreeRecord,
} from "@/lib/portal/forest-client";

/**
 * The forest statistics dashboard — `docs/forest-tools-plan.md` §10's eleven
 * summary cards and five charts, plus a sixth chart this pass adds: the
 * confidence distribution, which nothing in the engine's own `summary.json`
 * schema currently reports (that schema is a fixed contract owned by the
 * engine track, and confidence-over-the-whole-inventory was never one of its
 * fields). Computed client side from the decoded `trees.bin` pack instead —
 * see `confidenceStats` in `forest-client.ts` — and placed first, above the
 * eleven cards, not after them.
 *
 * ## Why confidence goes first, in its own callout, styled like a warning
 *
 * The task this panel was built for is explicit: median confidence across
 * this inventory is 0.317 and not one tree reaches 0.6, and that fact must
 * not be presented as a footnote under a set of otherwise-confident-looking
 * numbers. Burying it as card twelve of twelve would technically satisfy
 * "show it somewhere" while defeating the actual point, which is that anyone
 * reading "26,776 trees" should see, in the same glance, that this is a
 * first-pass, over-detecting inventory and not a finished count. So it is
 * drawn first, in the same signal-coloured callout style
 * `HydrologyPanel.tsx` uses for a truncated catchment — an honest number
 * dressed as what it is, not as an error, but not as reassurance either.
 *
 * ## No chart library
 *
 * Five (now six) charts do not justify adding one to this bundle — the same
 * call `docs/forest-tools-plan.md` §5.3 already made — so every chart here is
 * inline SVG, in the layout style `MeasurePanel.tsx`'s profile chart already
 * set: a `viewBox` sized in SVG units, `polyline`/`rect` marks, `fontSize` in
 * raw px on `<text>` rather than a Tailwind class, because SVG text does not
 * take one.
 */

const W = 260;
const BAR_H = 90;
const PAD = { left: 4, right: 4, top: 4, bottom: 14 };

function BarChart({
  bars,
  formatLabel,
  title,
}: {
  bars: { label: string; value: number }[];
  formatLabel?: (label: string) => string;
  title: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const innerW = W - PAD.left - PAD.right;
  const innerH = BAR_H - PAD.top - PAD.bottom;
  const gap = 2;
  const barW = bars.length > 0 ? (innerW - gap * (bars.length - 1)) / bars.length : innerW;

  return (
    <svg viewBox={`0 0 ${W} ${BAR_H}`} className="w-full" role="img" aria-label={title}>
      {bars.map((b, i) => {
        const h = (b.value / max) * innerH;
        const x = PAD.left + i * (barW + gap);
        const y = PAD.top + (innerH - h);
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={Math.max(0, h)} fill="#3f6b3a" opacity={0.8} />
            <text
              x={x + barW / 2}
              y={BAR_H - 3}
              textAnchor="middle"
              fontSize={6.5}
              className="fill-current text-ink/55"
            >
              {formatLabel ? formatLabel(b.label) : b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ScatterChart({ points, title }: { points: readonly ScatterPoint[]; title: string }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = BAR_H - PAD.top - PAD.bottom;
  if (points.length === 0) return <p className="text-[11px] text-ink/45">No data.</p>;
  const xs = points.map((p) => p.groundElevation);
  const ys = points.map((p) => p.height);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const x = (v: number) => PAD.left + ((v - xMin) / xSpan) * innerW;
  const y = (v: number) => PAD.top + innerH - ((v - yMin) / ySpan) * innerH;

  return (
    <svg viewBox={`0 0 ${W} ${BAR_H}`} className="w-full" role="img" aria-label={title}>
      {points.map((p, i) => (
        <circle key={i} cx={x(p.groundElevation)} cy={y(p.height)} r={1.1} fill="#3f6b3a" opacity={0.5} />
      ))}
      <text x={PAD.left} y={BAR_H - 3} fontSize={6.5} className="fill-current text-ink/45">
        {xMin.toFixed(0)} m
      </text>
      <text x={W - PAD.right} y={BAR_H - 3} textAnchor="end" fontSize={6.5} className="fill-current text-ink/45">
        {xMax.toFixed(0)} m
      </text>
    </svg>
  );
}

function HeatGrid({ grid }: { grid: NonNullable<ForestSummaryClient["charts"]["treeDensityByHectareGrid"]> }) {
  const max = Math.max(1, ...grid.cells.map((c) => c.treesPerHa));
  const cell = 18;
  const w = grid.cols * cell;
  const h = grid.rows * cell;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Tree density by hectare">
      {grid.cells.map((c: DensityGridCell) => {
        const t = c.treesPerHa / max;
        return (
          <rect
            key={`${c.col}-${c.row}`}
            x={c.col * cell}
            y={(grid.rows - 1 - c.row) * cell}
            width={cell - 1}
            height={cell - 1}
            fill="#3f6b3a"
            opacity={0.15 + t * 0.75}
          />
        );
      })}
    </svg>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-ink/[0.08] bg-panel/60 p-2">
      <p className="text-[9.5px] uppercase tracking-wide text-ink/45">{label}</p>
      <p className="font-mono text-[15px] font-semibold text-ink-900">{value}</p>
      {sub ? <p className="text-[10px] text-ink/50">{sub}</p> : null}
    </div>
  );
}

export function ForestStatsPanel({
  manifest,
  summary,
  confidence,
  trees,
}: {
  manifest: ForestManifestClient;
  summary: ForestSummaryClient;
  confidence: ConfidenceStats;
  trees: readonly TreeRecord[];
}) {
  const charts = summary.charts ?? {};
  const heightHist = charts.heightClassHistogram ?? [];
  const crownAreaHist: HistogramBin[] = charts.crownAreaDistribution ?? [];
  const heightDist: HistogramBin[] = charts.treeHeightDistribution ?? [];
  const scatter = charts.elevationVsHeight ?? [];
  const grid = charts.treeDensityByHectareGrid;

  /*
   * Both numbers, side by side, per docs/forest-validation-2026-09-19.md's
   * own recommendation: the raw count is real data and stays visible, but it
   * is not the headline — the filtered count (confidence >= 0.40) is what a
   * client should read first, because the validation note found the raw set
   * dominated by false positives on bare ground and rooftops. Computed here
   * from the live decoded pack rather than taken from summary.json, which
   * predates that finding and only ever reported the unfiltered figure.
   */
  const areaHa = summary.treesPerHectare > 0 ? summary.count / summary.treesPerHectare : manifest.surveyAreaHa ?? 0;
  const aboveThreshold = trees.filter((t) => t.confidence >= DEFAULT_CONFIDENCE_THRESHOLD).length;
  const filteredPerHa = areaHa > 0 ? aboveThreshold / areaHa : 0;

  return (
    <div className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
        Forest statistics
      </h3>

      {/* ---- confidence, first, and styled as a caution -------------------- */}
      <div className="space-y-1.5 rounded-md bg-signal/10 px-2.5 py-2">
        <p className="text-[11px] font-semibold text-signal-700">
          Detection confidence: median {confidence.median.toFixed(3)}, none above{" "}
          {confidence.max.toFixed(2)}
        </p>
        <p className="text-[10.5px] leading-snug text-signal-600">
          This is a first-pass inventory, not a settled count — every tree carries a low
          confidence score, and the shape below is how low. It over-detects rather than
          under-detects: expect it to overcount before it undercounts. A spot check against
          three orthomosaic patches (dense forest, bare ground, a rooftop cluster) found the raw
          count dominated by false positives on bare ground and roofs specifically — see{" "}
          <span className="font-mono">docs/forest-validation-2026-09-19.md</span>.
        </p>
        <BarChart
          title="Confidence distribution"
          bars={confidence.histogram.map((b) => ({ label: b.binMin.toFixed(2), value: b.count }))}
        />
      </div>

      {/* ---- the two headline numbers, raw and filtered, never one without the other ---- */}
      <div className="grid grid-cols-2 gap-1.5">
        <Card
          label="Candidates (unfiltered)"
          value={summary.count.toLocaleString("en-GB")}
          sub={`${summary.treesPerHectare.toFixed(0)} / ha candidate density after automated filtering, not a measured tree count`}
        />
        <Card
          label={`Trees, confidence ≥ ${DEFAULT_CONFIDENCE_THRESHOLD.toFixed(2)}`}
          value={aboveThreshold.toLocaleString("en-GB")}
          sub={`${filteredPerHa.toFixed(0)} / ha — the default map view`}
        />
      </div>

      {/* ---- the rest of the eleven cards ----------------------------------- */}
      <div className="grid grid-cols-2 gap-1.5">
        <Card label="Avg height" value={`${summary.height.avg.toFixed(1)} m`} />
        <Card label="Max height" value={`${summary.height.max.toFixed(1)} m`} />
        <Card label="Min height" value={`${summary.height.min.toFixed(1)} m`} />
        <Card label="Avg crown area" value={`${summary.crownArea.avg.toFixed(1)} m²`} />
        <Card
          label="Crown-covered area"
          value={`${(summary.crownArea.totalCovered / 10000).toFixed(2)} ha`}
        />
        <Card label="Avg crown diameter" value={`${summary.crownDiameter.avg.toFixed(1)} m`} />
        <Card label="Max crown diameter" value={`${summary.crownDiameter.max.toFixed(1)} m`} />
        <Card label="Min crown diameter" value={`${(summary.minCrownDiameter ?? 0).toFixed(2)} m`} />
        <Card label="Canopy coverage" value={`${summary.canopyCoveragePct.toFixed(1)}%`} />
      </div>
      {summary.canopyCoveragePct > 100 ? (
        <p className="text-[10px] leading-snug text-ink/45">
          Over 100% because crown polygons overlap — this pipeline draws one polygon per
          detected tree without dissolving overlaps, so a coverage figure above 100% is a
          symptom of over-detection, not a data error.
        </p>
      ) : null}

      {/* ---- the five charts ------------------------------------------------ */}
      <div className="space-y-2 border-t border-ink/[0.08] pt-2.5">
        <p className="text-[10.5px] font-semibold text-ink/60">Trees by height class</p>
        <BarChart
          title="Trees by height class"
          bars={heightHist.map((b) => ({ label: b.label, value: b.count }))}
          formatLabel={(l) => l.replace(" m", "").replace("–", "-")}
        />
      </div>

      {grid ? (
        <div className="space-y-1">
          <p className="text-[10.5px] font-semibold text-ink/60">
            Density by {grid.cellSizeM} m cell (trees/ha)
          </p>
          <HeatGrid grid={grid} />
        </div>
      ) : null}

      <div className="space-y-1">
        <p className="text-[10.5px] font-semibold text-ink/60">Crown-area distribution</p>
        <BarChart
          title="Crown-area distribution"
          bars={crownAreaHist.map((b) => ({ label: `${b.binMin.toFixed(0)}`, value: b.count }))}
        />
      </div>

      <div className="space-y-1">
        <p className="text-[10.5px] font-semibold text-ink/60">Tree-height distribution</p>
        <BarChart
          title="Tree-height distribution"
          bars={heightDist.map((b) => ({ label: `${b.binMin.toFixed(0)}`, value: b.count }))}
        />
      </div>

      <div className="space-y-1">
        <p className="text-[10.5px] font-semibold text-ink/60">Elevation vs. height</p>
        <ScatterChart points={scatter} title="Elevation versus tree height" />
      </div>

      {/* ---- provenance ------------------------------------------------------ */}
      <p className="border-t border-ink/[0.08] pt-2 text-[10.5px] leading-snug text-ink/50">
        {manifest.groundTruthNote}
      </p>
    </div>
  );
}
