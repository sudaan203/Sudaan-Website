"use client";

import type {
  AlignmentOp,
  BenchResult,
  ChainageResult,
  CorridorResult,
  CrossSectionsResult,
} from "@/lib/portal/analysis-client";
import { formatDistance } from "@/lib/portal/geodesy";

/**
 * Tools 19, 20, 21 and 16: everything measured along a drawn alignment.
 *
 * One panel for four tools because they take one geometry. A road engineer draws
 * the centreline once and then asks it four questions; making them four modes
 * would mean drawing the same line four times, which is the sort of thing that
 * makes a dashboard feel like a form.
 *
 * These four engines were written and tested weeks before this panel existed and
 * were unreachable the whole time, because nothing on the map could draw a line
 * and hand it over. That was the single largest block of finished-but-dead work
 * in the project.
 *
 * Two rules the shape of this enforces:
 *
 * 1. **Interval is a choice, shown in the result.** Malhar asks for 5, 10 and
 *    20 m sections. The interval changes every number here — a 25 m chainage
 *    misses the crest a 5 m one finds — so it is a control, and the answer says
 *    which one produced it.
 * 2. **Derived figures are labelled as derived.** Usable width is the run of
 *    the section that stays within a slope limit, not a survey of the kerb
 *    lines, and "unsafe" is a threshold someone chose rather than a
 *    geotechnical finding. Both say so where they are read.
 */

export type AlignmentState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; op: AlignmentOp; data: unknown }
  | { state: "error"; message: string };

export type AlignmentControls = {
  op: AlignmentOp;
  interval: number;
  halfWidth: number;
  maxGradePercent: number;
  maxCrossfallPercent: number;
  benchSlopePercent: number;
};

const OPS: { op: AlignmentOp; n: number; label: string; hint: string }[] = [
  { op: "chainage", n: 19, label: "Chainage", hint: "Stations along the line, with grade" },
  { op: "corridor", n: 20, label: "Corridor", hint: "Width, gradient and crossfall" },
  { op: "cross-sections", n: 21, label: "Sections", hint: "Cut across at fixed intervals" },
  { op: "bench", n: 16, label: "Benches", hint: "Flats and faces across a mine bench" },
];

/** The intervals Malhar names, plus the 25 m a road drawing usually uses. */
const INTERVALS = [5, 10, 20, 25];

export function AlignmentPanel({
  ready,
  length,
  vertices,
  controls,
  setControls,
  result,
  onCompute,
  onClear,
}: {
  /** True once at least two points have been placed and the line is finished. */
  ready: boolean;
  length: number;
  vertices: number;
  controls: AlignmentControls;
  setControls: (fn: (c: AlignmentControls) => AlignmentControls) => void;
  result: AlignmentState;
  onCompute: () => void;
  onClear: () => void;
}) {
  const across = controls.op === "corridor" || controls.op === "cross-sections";

  return (
    <div role="region" aria-label="Alignment" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Alignment
        </h3>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
        >
          Clear
        </button>
      </div>

      {!ready ? (
        <p className="text-[11px] leading-snug text-ink/55">
          Draw the centreline: click to place each point along it, double click to
          finish. A road, a haul road, or a section across a face.
        </p>
      ) : (
        <>
          <p className="text-[12px] text-ink/70">
            <span className="font-mono">{formatDistance(length)}</span>
            <span className="text-ink/45"> · {vertices} points</span>
          </p>

          <fieldset className="space-y-1.5">
            <legend className="text-[11px] font-semibold text-ink/60">Measure</legend>
            <div className="flex flex-wrap gap-1.5">
              {OPS.map(({ op, n, label, hint }) => (
                <button
                  key={op}
                  type="button"
                  aria-pressed={controls.op === op}
                  aria-label={label}
                  title={hint}
                  onClick={() => setControls((c) => ({ ...c, op }))}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    controls.op === op
                      ? "bg-accent-600 text-white"
                      : "border border-ink/15 text-ink/70 hover:border-accent-600"
                  }`}
                >
                  <span aria-hidden className="mr-1 font-mono text-[9px] opacity-55">
                    {n}
                  </span>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[10px] leading-snug text-ink/50">
              {OPS.find((o) => o.op === controls.op)?.hint}
            </p>
          </fieldset>

          {controls.op !== "bench" ? (
            <label className="block text-[10px] text-ink/50">
              Interval
              <div className="mt-0.5 flex gap-1">
                {INTERVALS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={controls.interval === v}
                    onClick={() => setControls((c) => ({ ...c, interval: v }))}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                      controls.interval === v
                        ? "bg-ink-900 text-white"
                        : "border border-ink/15 text-ink/70 hover:border-accent-600"
                    }`}
                  >
                    {v} m
                  </button>
                ))}
              </div>
            </label>
          ) : null}

          {across ? (
            <Number
              label="Half width"
              hint="How far either side of the centreline to sample"
              unit="m"
              value={controls.halfWidth}
              min={1}
              max={100}
              onChange={(v) => setControls((c) => ({ ...c, halfWidth: v }))}
            />
          ) : null}

          {controls.op === "corridor" ? (
            <>
              <Number
                label="Grade limit"
                hint="Longitudinal slope a station is flagged above"
                unit="%"
                value={controls.maxGradePercent}
                min={1}
                max={40}
                onChange={(v) => setControls((c) => ({ ...c, maxGradePercent: v }))}
              />
              <Number
                label="Crossfall limit"
                unit="%"
                value={controls.maxCrossfallPercent}
                min={1}
                max={30}
                onChange={(v) => setControls((c) => ({ ...c, maxCrossfallPercent: v }))}
              />
            </>
          ) : null}

          {controls.op === "bench" ? (
            <Number
              label="Bench slope"
              hint="Flatter than this counts as a bench, steeper as a face"
              unit="%"
              value={controls.benchSlopePercent}
              min={1}
              max={45}
              onChange={(v) => setControls((c) => ({ ...c, benchSlopePercent: v }))}
            />
          ) : null}

          <button
            type="button"
            disabled={result.state === "loading"}
            onClick={onCompute}
            className="w-full rounded-full bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {result.state === "loading" ? "Computing…" : "Measure"}
          </button>

          <Result result={result} />
        </>
      )}
    </div>
  );
}

function Number({
  label,
  hint,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-[10px] text-ink/50">
      {label}
      {hint ? <span className="block text-ink/40">{hint}</span> : null}
      <span className="mt-0.5 flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          min={min}
          max={max}
          value={value}
          aria-label={`${label} in ${unit}`}
          onChange={(e) => {
            // `Number("")` is 0 and 0 is finite, which is how a blank box once
            // asked the server to flood a site to sea level. An empty field
            // leaves the last good value alone.
            const next = globalThis.Number(e.target.value);
            if (e.target.value.trim() !== "" && globalThis.Number.isFinite(next)) onChange(next);
          }}
          className="w-20 rounded border border-ink/15 bg-paper px-2 py-1 font-mono text-[12px] text-ink-900 focus:border-accent-600 focus:outline-none"
        />
        <span className="text-[11px] text-ink/55">{unit}</span>
      </span>
    </label>
  );
}

function Result({ result }: { result: AlignmentState }) {
  if (result.state === "idle") return null;
  if (result.state === "loading") {
    return <p className="text-[11px] text-ink/45">Reading the model…</p>;
  }
  if (result.state === "error") {
    return (
      <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
        {result.message}
      </p>
    );
  }

  return (
    <div className="space-y-2 border-t border-ink/[0.08] pt-2">
      {result.op === "chainage" ? <Chainage r={result.data as ChainageResult} /> : null}
      {result.op === "corridor" ? <Corridor r={result.data as CorridorResult} /> : null}
      {result.op === "cross-sections" ? (
        <Sections r={result.data as CrossSectionsResult} />
      ) : null}
      {result.op === "bench" ? <Bench r={result.data as BenchResult} /> : null}
    </div>
  );
}

function Chainage({ r }: { r: ChainageResult }) {
  return (
    <>
      <dl className="space-y-1 text-[12px]">
        <Row label="Length" value={formatDistance(r.length)} />
        <Row label="Stations" value={`${r.stations.length} at ${r.interval} m`} />
        <Row
          label="Steepest grade"
          value={r.maxGradePercent === null ? "—" : `${r.maxGradePercent.toFixed(1)} %`}
          strong
        />
        <Row
          label="Mean grade"
          value={r.meanGradePercent === null ? "—" : `${r.meanGradePercent.toFixed(1)} %`}
        />
      </dl>
      {r.stationsWithoutData > 0 ? (
        <Warn>
          {r.stationsWithoutData} of {r.stations.length} stations fall where the survey has
          no data, so the line runs off the surveyed ground.
        </Warn>
      ) : null}
      <Table
        head={["Chainage", "Level", "Grade"]}
        rows={r.stations.map((s) => [
          s.label,
          s.elevation === null ? "—" : `${s.elevation.toFixed(3)} m`,
          s.gradePercent == null ? "—" : `${s.gradePercent.toFixed(1)} %`,
        ])}
      />
      <Note>
        Grade is measured to the previous station, which is what a longitudinal
        section plots. The end to end grade is a different and gentler number.
      </Note>
    </>
  );
}

function Corridor({ r }: { r: CorridorResult }) {
  return (
    <>
      <dl className="space-y-1 text-[12px]">
        <Row
          label="Mean usable width"
          value={r.meanUsableWidth === null ? "—" : formatDistance(r.meanUsableWidth)}
          strong
        />
        <Row
          label="Narrowest"
          value={r.minUsableWidth === null ? "—" : formatDistance(r.minUsableWidth)}
        />
        <Row label="Stations" value={String(r.stations.length)} />
        <Row label="Flagged" value={String(r.unsafeStations.length)} />
      </dl>
      {r.unsafeStations.length > 0 ? (
        <Warn>
          {r.unsafeStations.length} station{r.unsafeStations.length === 1 ? "" : "s"} exceed
          the limits set above ({r.limits.maxGradePercent}% grade,{" "}
          {r.limits.maxCrossfallPercent}% crossfall). Those limits are the ones you chose,
          not a standard.
        </Warn>
      ) : null}
      <Table
        head={["Chainage", "Width", "Grade", "Crossfall"]}
        rows={r.stations.map((s) => [
          s.label,
          s.usableWidth === null ? "—" : `${s.usableWidth.toFixed(1)} m`,
          s.gradePercent === null ? "—" : `${s.gradePercent.toFixed(1)} %`,
          s.crossfallPercent === null ? "—" : `${s.crossfallPercent.toFixed(1)} %`,
        ])}
        flag={r.stations.map((s) => s.unsafe)}
      />
      <Note>{r.widthMethod}</Note>
    </>
  );
}

function Sections({ r }: { r: CrossSectionsResult }) {
  return (
    <>
      <dl className="space-y-1 text-[12px]">
        <Row label="Sections" value={`${r.sections.length} at ${r.interval} m`} strong />
        <Row label="Width sampled" value={`± ${r.halfWidth} m`} />
        <Row label="Sample spacing" value={`${r.sampleSpacing.toFixed(2)} m`} />
      </dl>
      <Table
        head={["Chainage", "Centre", "Low", "High"]}
        rows={r.sections.map((s) => [
          s.label,
          s.centreElevation === null ? "—" : `${s.centreElevation.toFixed(2)} m`,
          s.min === null ? "—" : `${s.min.toFixed(2)} m`,
          s.max === null ? "—" : `${s.max.toFixed(2)} m`,
        ])}
      />
      <Note>
        Each section is cut perpendicular to the alignment. A section taken along
        the grid axes instead is wider than the road by one over the cosine of the
        bearing, and looks entirely reasonable on a plan.
      </Note>
    </>
  );
}

function Bench({ r }: { r: BenchResult }) {
  return (
    <>
      <dl className="space-y-1 text-[12px]">
        <Row label="Benches" value={String(r.benches.length)} strong />
        <Row
          label="Mean bench width"
          value={r.meanBenchWidth === null ? "—" : formatDistance(r.meanBenchWidth)}
        />
        <Row
          label="Mean face height"
          value={r.meanBenchHeight === null ? "—" : formatDistance(r.meanBenchHeight)}
        />
        <Row
          label="Steepest face"
          value={
            r.maxFaceAngleDegrees === null ? "—" : `${r.maxFaceAngleDegrees.toFixed(1)}°`
          }
        />
      </dl>
      {/*
        Where the line actually went. Without this the panel reported 2.7 m of
        bench on a 209 m line and said nothing about the other 206, which reads
        as the tool having failed rather than as the ground not being benched.
      */}
      <div className="rounded-md bg-ink/[0.04] px-2 py-1.5">
        <p className="text-[10px] font-semibold text-ink/55">Along the line</p>
        <dl className="mt-0.5 space-y-0.5 text-[10px]">
          <Row label="Bench" value={formatDistance(r.lengthBreakdown.bench)} />
          <Row label="Face" value={formatDistance(r.lengthBreakdown.face)} />
          <Row
            label={`Flat, under the minimum (${r.narrowFlats})`}
            value={formatDistance(r.lengthBreakdown.narrowFlat)}
          />
          {r.lengthBreakdown.unsurveyed > 0.05 ? (
            <Row label="No survey data" value={formatDistance(r.lengthBreakdown.unsurveyed)} />
          ) : null}
        </dl>
      </div>

      <Table
        head={["From", "Width", "Height", "Angle"]}
        rows={r.benches.map((b) => [
          `${b.fromChainage.toFixed(1)} m`,
          `${b.width.toFixed(1)} m`,
          `${b.height.toFixed(2)} m`,
          b.slopeDegrees === null ? "—" : `${b.slopeDegrees.toFixed(1)}°`,
        ])}
      />
      {/*
        The honest caveat, and it is not boilerplate. This reads alternating
        flats and risers off a profile. Point it at a hillside and it will find
        terraces and call them benches, because geometrically that is what they
        are.
      */}
      <Note>
        Read as alternating flats and faces along the line. This is a measurement
        of the ground, not of the mine plan: pointed at a natural slope it will
        report terraces as benches.
      </Note>
    </>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-ink/55">{label}</dt>
      <dd
        className={`font-mono text-[12px] ${strong ? "font-semibold text-ink-900" : "text-ink-900"}`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * A scrolling table rather than a chart.
 *
 * A cross-section drawing is what a client ultimately wants and it belongs in
 * the PDF export, not squeezed into a 288 px sidebar where it would be too small
 * to read a level off. Numbers at this width are honest; a thumbnail chart is
 * decoration.
 */
function Table({
  head,
  rows,
  flag,
}: {
  head: string[];
  rows: string[][];
  flag?: boolean[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="max-h-56 overflow-auto rounded border border-ink/10">
      <table className="w-full border-collapse text-[10px]">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="border-b border-ink/10 px-1.5 py-1 text-left font-semibold text-ink/55"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono text-ink-900">
          {rows.map((row, i) => (
            <tr key={i} className={flag?.[i] ? "bg-signal/10" : undefined}>
              {row.map((cell, j) => (
                <td key={j} className="border-b border-ink/[0.06] px-1.5 py-0.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
      {children}
    </p>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] leading-snug text-ink/50">{children}</p>;
}
