"use client";

import { useState } from "react";
import type {
  CompareResult,
  Surface,
  SurveyAccuracy,
  VolumeReference,
} from "@/lib/portal/analysis-client";
import { describeReference } from "@/lib/portal/analysis-client";
import { centimetres } from "@/lib/portal/accuracy.mjs";
import { formatArea } from "@/lib/portal/geodesy";
import { AccuracyNote } from "./AccuracyNote";

/**
 * Tools 5 and 13: surface comparison, and tolerance analysis.
 *
 * One panel, because they are one act — how far does this surface sit from that
 * one, over this area — and a tolerance is a reading of the same numbers rather
 * than a second measurement. Turning the tolerance on adds the classification;
 * it does not change what was measured.
 *
 * Three things the shape of this enforces:
 *
 * 1. **The reference is a choice, never a default**, exactly as for cut and
 *    fill. Against the other model, against a design level, and against the
 *    polygon's own rim are three different questions.
 * 2. **A tolerance finer than the survey cannot be checked**, and the panel
 *    says so instead of colouring it in. A ±20 mm check on a survey good to
 *    ±40 mm produces a map of survey noise that looks exactly like a map of
 *    defects, and that is the failure mode a contractor would act on.
 *
 *    That gate is only as good as the accuracy figure behind it, which is why
 *    the panel now says where the figure came from. Passing the gate against
 *    Sudaan's typical ±4 cm is not the same as passing it against a measurement
 *    of this ground, and a contractor signing off to a tolerance needs to know
 *    which one they have.
 * 3. **Mean and mean absolute are both shown.** A surface half a metre up over
 *    one half of a polygon and half a metre down over the other has a mean
 *    change of zero. Only the second number says the two surfaces disagree.
 */

export type SurfaceState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; data: CompareResult; reference: VolumeReference; surface: Surface }
  | { state: "error"; message: string };

/** Tolerances a contractor actually sets, in millimetres. */
const TOLERANCES = [10, 20, 50, 100];

export function SurfacePanel({
  ready,
  polygonArea,
  surface,
  accuracy,
  result,
  tolerance,
  onCompute,
  onClear,
}: {
  ready: boolean;
  polygonArea: number;
  surface: Surface;
  /**
   * What may be claimed about this survey's vertical accuracy. Null until the
   * first analysis response says.
   */
  accuracy: SurveyAccuracy | null;
  result: SurfaceState;
  /** Tool 13 when true: the deviation is additionally classified. */
  tolerance: boolean;
  onCompute: (reference: VolumeReference, toleranceM: number | null) => void;
  onClear: () => void;
}) {
  const [kind, setKind] = useState<VolumeReference["kind"]>("surface");
  const [planeText, setPlaneText] = useState("");
  const [against, setAgainst] = useState<Surface>(surface === "dtm" ? "dsm" : "dtm");
  const [toleranceMm, setToleranceMm] = useState(20);

  const planeValue = Number(planeText);
  const planeValid = planeText.trim() !== "" && Number.isFinite(planeValue);
  const reference: VolumeReference | null =
    kind === "boundary"
      ? { kind: "boundary" }
      : kind === "plane"
        ? planeValid
          ? { kind: "plane", elevation: planeValue }
          : null
        : { kind: "surface", surface: against };
  const degenerate = kind === "surface" && against === surface;

  return (
    <div role="region" aria-label="Surface comparison" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          {tolerance ? "Tolerance" : "Surface comparison"}
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
          {tolerance
            ? "Draw the area to check: click each corner, double click to close it."
            : "Draw the area to compare: click each corner, double click to close it."}
        </p>
      ) : (
        <>
          <p className="text-[12px] text-ink/70">
            Polygon <span className="font-mono">{formatArea(polygonArea)}</span>
          </p>

          <fieldset className="space-y-2">
            <legend className="text-[11px] font-semibold text-ink/60">Compare against</legend>
            <Choice
              checked={kind === "surface"}
              onChange={() => setKind("surface")}
              label="The other model"
              hint={
                surface === "dtm"
                  ? "Against the DSM this is the height of everything standing on the ground: canopy, stockpiles, structures."
                  : "Against the DTM this is the height of everything standing on the ground."
              }
            >
              <div className="mt-1 flex items-center gap-1">
                {(
                  [
                    ["dtm", "Terrain (DTM)"],
                    ["dsm", "Surface (DSM)"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={against === value}
                    onClick={() => {
                      setAgainst(value);
                      setKind("surface");
                    }}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${
                      against === value
                        ? "bg-accent-600 text-white"
                        : "border border-ink/15 text-ink/70 hover:border-accent-600"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Choice>

            <Choice
              checked={kind === "plane"}
              onChange={() => setKind("plane")}
              label="A design level"
              hint="A stated formation or pad level."
            >
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={planeText}
                  onChange={(e) => setPlaneText(e.target.value)}
                  onFocus={() => setKind("plane")}
                  aria-label="Design level in metres"
                  placeholder="elevation"
                  className="w-28 rounded border border-ink/15 bg-paper px-2 py-1 font-mono text-[12px] text-ink-900 focus:border-accent-600 focus:outline-none"
                />
                <span className="text-[11px] text-ink/55">m</span>
              </div>
            </Choice>

            <Choice
              checked={kind === "boundary"}
              onChange={() => setKind("boundary")}
              label="The polygon's own rim"
              hint="Best fit plane through the ground around the edge."
            />
          </fieldset>

          {tolerance ? (
            <fieldset className="space-y-1">
              <legend className="text-[11px] font-semibold text-ink/60">Tolerance</legend>
              <div className="flex flex-wrap gap-1">
                {TOLERANCES.map((mm) => (
                  <button
                    key={mm}
                    type="button"
                    aria-pressed={toleranceMm === mm}
                    onClick={() => setToleranceMm(mm)}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                      toleranceMm === mm
                        ? "bg-ink-900 text-white"
                        : "border border-ink/15 text-ink/70 hover:border-accent-600"
                    }`}
                  >
                    ± {mm} mm
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {degenerate ? (
            <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
              That is the same surface you are measuring, so every difference would be
              zero. Pick the other one.
            </p>
          ) : null}

          <button
            type="button"
            disabled={!reference || degenerate || result.state === "loading"}
            onClick={() => reference && onCompute(reference, tolerance ? toleranceMm / 1000 : null)}
            className="w-full rounded-full bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {result.state === "loading" ? "Computing…" : tolerance ? "Check" : "Compare"}
          </button>

          <Result result={result} accuracy={accuracy} />
        </>
      )}
    </div>
  );
}

function Result({
  result,
  accuracy,
}: {
  result: SurfaceState;
  accuracy: SurveyAccuracy | null;
}) {
  if (result.state === "idle") return null;
  if (result.state === "loading") {
    return <p className="text-[11px] text-ink/45">Reading both models…</p>;
  }
  if (result.state === "error") {
    return (
      <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
        {result.message}
      </p>
    );
  }

  const { data, reference, surface } = result;
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);
  const m = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)} m`);

  return (
    <div className="space-y-2 border-t border-ink/[0.08] pt-2">
      {/*
        The honesty gate, and it comes first because everything below it is
        meaningless when it fails. A tolerance the survey cannot resolve produces
        a map of noise indistinguishable from a map of defects.
      */}
      {data.note ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {data.note}
        </p>
      ) : null}

      {data.tolerance !== null ? (
        <dl className="space-y-1.5 text-sm">
          <Row label="Within tolerance" value={pct(data.withinShare)} strong />
          <Row label="Area within" value={formatArea(data.withinArea ?? 0)} small />
          <Row label="Above" value={formatArea(data.aboveArea ?? 0)} small />
          <Row label="Below" value={formatArea(data.belowArea ?? 0)} small />
          <Row
            label="Worst high"
            value={data.worstAbove ? `+${data.worstAbove.toFixed(3)} m` : "—"}
            small
          />
          <Row
            label="Worst low"
            value={data.worstBelow ? `−${data.worstBelow.toFixed(3)} m` : "—"}
            small
          />
        </dl>
      ) : null}

      <dl className="space-y-1 text-[12px]">
        <Row label="Mean difference" value={m(data.meanChange)} strong={data.tolerance === null} />
        <Row
          label="Mean, ignoring sign"
          value={data.meanAbsoluteChange === null ? "—" : `${data.meanAbsoluteChange.toFixed(3)} m`}
        />
        <Row label="Range" value={`${m(data.minChange)} to ${m(data.maxChange)}`} small />
        <Row label="Volume gained" value={`${Math.round(data.volumeGained).toLocaleString("en-GB")} m³`} small />
        <Row label="Volume lost" value={`${Math.round(data.volumeLost).toLocaleString("en-GB")} m³`} small />
        <Row label="Area compared" value={formatArea(data.comparedArea)} small />
      </dl>

      {/*
        Measured against drawn, not the `complete` flag: that flag describes only
        what lies inside the raster's own extent, so a polygon reaching past the
        edge of the survey can come back marked complete.
      */}
      {data.comparedArea < data.polygonArea * 0.999 ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {data.comparedArea === 0
            ? "Nothing inside this polygon has both surfaces underneath it."
            : `These figures cover the ${formatArea(data.comparedArea)} where both surfaces exist, not the full ${formatArea(data.polygonArea)} drawn.`}
        </p>
      ) : null}

      {/*
        The resolvability gate above is a comparison against a number, and this
        is where that number is accounted for. On a survey with no checkpoint
        report the gate has been judged against the company's typical figure,
        which is a prediction rather than a measurement — and a contractor
        signing work off to a stated tolerance is exactly the reader who must not
        find that out afterwards.
      */}
      {data.tolerance !== null && accuracy && !accuracy.measured && data.rmseZ !== null ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          Whether this survey can resolve a ±{(data.tolerance * 1000).toFixed(0)} mm tolerance has
          been judged against Sudaan&apos;s typical ±{centimetres(data.rmseZ)}, not against a
          measurement of this ground. Ask us for the checkpoint report before signing anything off
          to this tolerance.
        </p>
      ) : null}

      <p className="text-[11px] leading-snug text-ink/55">
        Positive is the {surface === "dsm" ? "surface model" : "terrain model"} standing
        above {describeReference(reference)}. Measured in {data.computedIn}.
      </p>
      <AccuracyNote accuracy={accuracy} />
    </div>
  );
}

function Choice({
  checked,
  onChange,
  label,
  hint,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2 text-[12px] text-ink-900">
        <input
          type="radio"
          name="compare-reference"
          checked={checked}
          onChange={onChange}
          className="mt-0.5 h-3.5 w-3.5 border-ink/25 text-accent-600 focus:ring-accent-600"
        />
        <span className="flex-1">
          <span className="font-semibold">{label}</span>
          <span className="block text-[10px] leading-snug text-ink/55">{hint}</span>
        </span>
      </label>
      {checked && children ? <div className="ml-5.5 pl-0.5">{children}</div> : null}
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
  small = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={small ? "text-[11px] text-ink/55" : "text-ink/60"}>{label}</dt>
      <dd
        className={`font-mono ${small ? "text-[11px]" : "text-[13px]"} ${
          strong ? "font-semibold text-ink-900" : "text-ink-900"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
