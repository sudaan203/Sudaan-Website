"use client";

import { useState } from "react";
import type {
  StockpileResult,
  Surface,
  VolumeReference,
  VolumeResult,
} from "@/lib/portal/analysis-client";
import { describeReference } from "@/lib/portal/analysis-client";
import { formatArea, formatDistance } from "@/lib/portal/geodesy";

/**
 * Tools 4 and 15: cut and fill, and stockpile volume. The important ones, and
 * the ones most likely to be quietly wrong.
 *
 * One panel for both because they are the same act — draw a polygon, pick what
 * to measure against, get a volume — and splitting it would duplicate the three
 * rules below, which is where the risk lives. What changes in `pile` mode is the
 * wording and the figures reported: a stockpile is quoted as volume, base area
 * and height, and its net is meaningless because a pile is all cut by
 * construction.
 *
 * Three rules from `docs/dashboard-tools-plan.md` A1 are enforced by this panel's
 * shape rather than by a note in it:
 *
 * 1. **The reference surface is a choice, never a default.** There is no
 *    "Compute" until one is picked, because cut and fill against a level plane,
 *    against the polygon's own rim, and against a second surface are three
 *    different questions with three different answers. The server refuses an
 *    unstated reference too; this is the same rule, made visible.
 * 2. **The uncertainty travels with the number.** Systematic error over an area
 *    is `bias × area`, so ±4 cm over a hectare is ±400 m³ — the figure that turns
 *    up in a dispute. It is printed next to the volume, not in a footnote.
 * 3. **A partly covered polygon says so.** The arithmetic is happy to measure
 *    less ground than the client drew and return a plausible number.
 */

export type VolumeState =
  | { state: "idle" }
  | { state: "loading" }
  | {
      state: "done";
      data: VolumeResult | StockpileResult;
      reference: VolumeReference;
      surface: Surface;
    }
  | { state: "error"; message: string };

export function VolumePanel({
  ready,
  polygonArea,
  surface,
  result,
  pile = false,
  onCompute,
  onClear,
}: {
  /** True once a closed polygon of at least three points exists. */
  ready: boolean;
  polygonArea: number;
  surface: Surface;
  result: VolumeState;
  /** Tool 15 rather than tool 4: the polygon is a stockpile, not an earthwork. */
  pile?: boolean;
  onCompute: (reference: VolumeReference) => void;
  onClear: () => void;
}) {
  const [kind, setKind] = useState<VolumeReference["kind"]>("boundary");
  const [planeText, setPlaneText] = useState("");
  const [against, setAgainst] = useState<Surface>(surface === "dtm" ? "dsm" : "dtm");

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

  // Measuring a surface against itself is identically zero. It is a slip rather
  // than a question, and it is worth catching before it produces a confident
  // "net 0 m³" that looks like a finished site.
  const degenerate = kind === "surface" && against === surface;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          {pile ? "Stockpile volume" : "Cut and fill"}
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
          {pile
            ? "Draw a polygon around the toe of the pile: click to place each corner, double click to close it. Follow the bottom of the heap, not the top."
            : "Draw a polygon over the area you want quantified: click to place each corner, double click to close it."}
        </p>
      ) : (
        <>
          <p className="text-[12px] text-ink/70">
            Polygon <span className="font-mono">{formatArea(polygonArea)}</span>
          </p>

          <fieldset className="space-y-2">
            <legend className="text-[11px] font-semibold text-ink/60">
              Measure against
            </legend>

            <Choice
              checked={kind === "boundary"}
              onChange={() => setKind("boundary")}
              label={pile ? "The ground around the toe" : "The polygon's own rim"}
              hint={
                pile
                  ? "Best fit plane through the ground the pile is standing on. The usual way a stockpile is quoted."
                  : "Best fit plane through the ground around the edge. The usual meaning of levelling a site to its surroundings."
              }
            />

            <Choice
              checked={kind === "plane"}
              onChange={() => setKind("plane")}
              label="A level plane"
              hint="A stated design or formation level."
            >
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={planeText}
                  onChange={(e) => setPlaneText(e.target.value)}
                  onFocus={() => setKind("plane")}
                  aria-label="Plane elevation in metres"
                  placeholder="elevation"
                  className="w-28 rounded border border-ink/15 bg-paper px-2 py-1 font-mono text-[12px] text-ink-900 focus:border-accent-600 focus:outline-none"
                />
                <span className="text-[11px] text-ink/55">m</span>
              </div>
            </Choice>

            <Choice
              checked={kind === "surface"}
              onChange={() => setKind("surface")}
              label="Another surface"
              hint={
                surface === "dtm"
                  ? "Against the DSM this gives the height of everything standing on the ground: canopy, stockpiles, structures."
                  : "Against the DTM this gives the height of everything standing on the ground."
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
          </fieldset>

          {degenerate ? (
            <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
              That is the same surface you are measuring, so every difference would be
              zero. Pick the other one.
            </p>
          ) : null}

          <button
            type="button"
            disabled={!reference || degenerate || result.state === "loading"}
            onClick={() => reference && onCompute(reference)}
            className="w-full rounded-full bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {result.state === "loading"
              ? "Computing…"
              : pile
                ? "Compute pile volume"
                : "Compute volumes"}
          </button>

          {kind === "plane" && !planeValid && planeText.trim() !== "" ? (
            <p className="text-[11px] text-signal-600">
              That is not a number of metres.
            </p>
          ) : null}

          <Result result={result} pile={pile} />
        </>
      )}
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
          name="volume-reference"
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

function Result({ result, pile }: { result: VolumeState; pile: boolean }) {
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

  const { data, reference, surface } = result;
  /*
   * The server answers a stockpile with a wider result than a cut and fill, and
   * this is the honest way to tell them apart on the client: ask whether the
   * extra figures arrived, rather than trusting the panel's own `pile` flag,
   * which describes what was *asked for* and not what came back.
   */
  const heap: StockpileResult | null = "baseArea" in data ? data : null;
  const band = data.uncertainty;
  // How decisive the answer is. A net of 200 m³ carrying ±400 m³ is not a
  // quantity, it is a coin toss with a decimal point, and the client is far
  // better served by being told so than by the number on its own.
  const decisive = band === null || Math.abs(data.net) > band;

  if (heap) {
    return (
      <div className="space-y-2 border-t border-ink/[0.08] pt-2">
        <dl className="space-y-1.5 text-sm">
          <Row label="Volume" value={`${round(heap.volume)} m³`} strong />
          {band !== null ? <Row label="Uncertainty" value={`± ${round(band)} m³`} /> : null}
        </dl>
        <dl className="space-y-1 text-[12px]">
          <Row label="Base area" value={formatArea(heap.baseArea)} small />
          <Row label="Footprint drawn" value={formatArea(heap.footprintArea)} small />
          <Row label="Greatest height" value={formatDistance(heap.maxHeight)} small />
          {heap.meanHeight !== null ? (
            <Row label="Mean height" value={`${heap.meanHeight.toFixed(2)} m`} small />
          ) : null}
        </dl>

        {/*
          A pile is all cut. Anything below the fitted base is the polygon drawn
          past the toe into a dip, and it is reported rather than netted off,
          because netting it off would quietly shrink the pile by however much
          the operator overdrew.
        */}
        {heap.volumeBelowBase > heap.volume * 0.02 ? (
          <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
            {round(heap.volumeBelowBase)} m³ of the polygon lies below the fitted base,
            which usually means it was drawn past the toe of the pile. That volume is not
            in the figure above. Tighten the outline to the bottom of the heap.
          </p>
        ) : null}

        {data.measuredArea < data.polygonArea * 0.999 ? (
          <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
            {data.measuredArea === 0
              ? "None of this polygon has survey data underneath it, so there is no volume to report."
              : `This covers the ${formatArea(data.measuredArea)} that could be measured, not the full ${formatArea(data.polygonArea)} drawn.`}
          </p>
        ) : null}

        <p className="text-[11px] leading-snug text-ink/55">
          The volume of material standing above {describeReference(reference)}, on the{" "}
          {surface === "dsm" ? "surface model" : "terrain model"}, in {data.computedIn}
          {data.rmseZ !== null
            ? `. The ± band is the survey's own ${(data.rmseZ * 100).toFixed(0)} cm vertical accuracy across ${formatArea(data.measuredArea)}.`
            : "."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-ink/[0.08] pt-2">
      <dl className="space-y-1.5 text-sm">
        <Row label="Cut" value={`${round(data.cut)} m³`} hint="material above the reference" />
        <Row label="Fill" value={`${round(data.fill)} m³`} hint="void below the reference" />
        <Row
          label="Net"
          value={`${data.net >= 0 ? "+" : "−"}${round(Math.abs(data.net))} m³`}
          strong
        />
        {band !== null ? (
          <Row label="Uncertainty" value={`± ${round(band)} m³`} />
        ) : null}
      </dl>

      {band !== null && !decisive ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          The net is smaller than the survey&apos;s own uncertainty over this area, so it
          cannot be read as a quantity. Cut and fill roughly balance here.
        </p>
      ) : null}

      <dl className="space-y-1 text-[12px]">
        <Row label="Area in cut" value={formatArea(data.cutArea)} small />
        <Row label="Area in fill" value={formatArea(data.fillArea)} small />
        <Row label="Deepest cut" value={formatDistance(data.maxCutDepth)} small />
        <Row label="Deepest fill" value={formatDistance(data.maxFillDepth)} small />
        {data.meanDepth !== null ? (
          <Row
            label="Mean depth"
            value={`${data.meanDepth >= 0 ? "+" : "−"}${Math.abs(data.meanDepth).toFixed(2)} m`}
            small
          />
        ) : null}
      </dl>

      {/*
        Measured against drawn, not the `complete` flag the analysis returns.
        That flag and `nodataArea` describe only what lies inside the raster's
        own extent, so a polygon reaching past the edge of the survey — or drawn
        entirely off it — can come back marked complete with a volume computed
        over a fraction of the ground, or none of it. Comparing the two areas of
        the same polygon cannot be fooled that way.
      */}
      {data.measuredArea < data.polygonArea * 0.999 ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {data.measuredArea === 0 ? (
            "None of this polygon has survey data underneath it, so there is no volume to report."
          ) : (
            <>
              {data.referenceMissingArea > 0
                ? `${formatArea(data.referenceMissingArea)} has no reference surface underneath it. `
                : ""}
              These volumes cover the {formatArea(data.measuredArea)} that could be measured,
              not the full {formatArea(data.polygonArea)} drawn. Scaling them up to the whole
              polygon would be inventing ground.
            </>
          )}
        </p>
      ) : null}

      <p className="text-[11px] leading-snug text-ink/55">
        Cut is ground standing above the reference, fill is the void below it, and net is
        cut minus fill, so a positive net is material to export. Measured against{" "}
        {describeReference(reference)}, on the{" "}
        {surface === "dsm" ? "surface model" : "terrain model"}, in {data.computedIn}
        {data.rmseZ !== null
          ? `. The ± band is the survey's own ${(data.rmseZ * 100).toFixed(0)} cm vertical accuracy across ${formatArea(data.measuredArea)}, which is the error that does not average away.`
          : "."}
      </p>
    </div>
  );
}

/** Cubic metres to a sensible number of figures: never more than the ± band. */
function round(cubicMetres: number): string {
  if (cubicMetres >= 1000) return Math.round(cubicMetres).toLocaleString("en-GB");
  if (cubicMetres >= 10) return cubicMetres.toFixed(0);
  return cubicMetres.toFixed(1);
}

function Row({
  label,
  value,
  hint,
  strong = false,
  small = false,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={small ? "text-[11px] text-ink/55" : "text-ink/60"}>
        {label}
        {hint ? <span className="block text-[10px] text-ink/40">{hint}</span> : null}
      </dt>
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
