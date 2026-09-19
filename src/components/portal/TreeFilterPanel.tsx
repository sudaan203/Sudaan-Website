"use client";

import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_FILTERS,
  isDefaultFilters,
  type HeightClassDef,
  type Range,
  type TreeFilters,
} from "@/lib/portal/forest-client";

/**
 * The tree filter panel — `docs/forest-tools-plan.md` §9's seven axes, plus
 * the quick height-class buttons and the per-class editing §4/§5.4 ask for.
 *
 * Styled after `HydrologyPanel.tsx`: a `<fieldset>` per group of controls, a
 * live readout below the controls rather than a separate "apply" step, and
 * the same input sizing and colour tokens (`text-ink/60`, `border-ink/15`,
 * `accent-600`) so this reads as one more panel in the same product rather
 * than a visitor from a different one.
 *
 * ## Why two number inputs per axis, not a dual-handle slider
 *
 * A slider needs its own drag/keyboard/touch handling to get right, and this
 * repository has no slider component anywhere to match. Two `<input
 * type="number">` fields do the identical job — set a lower and an upper
 * bound — with zero new interaction code, and they are exact where a slider
 * dragged with a mouse is not: a client filtering for "crowns over 18 m²"
 * types 18, they do not hunt for the pixel that means exactly that.
 *
 * ## Why the live count is a prop, not computed here
 *
 * `MapViewer.tsx` already holds the decoded tree pack and calls
 * `filterTrees` once per filter change to redraw the map; recomputing the
 * same filter a second time here, just to print a number, would be running
 * the same scan twice for every keystroke. This panel only ever displays a
 * count its caller already had to produce anyway.
 */

const AXES: { key: keyof AxisFilters; label: string; unit: string; step: string }[] = [
  { key: "height", label: "Height", unit: "m", step: "0.1" },
  { key: "crownArea", label: "Crown area", unit: "m²", step: "0.5" },
  { key: "crownDiameter", label: "Crown diameter", unit: "m", step: "0.1" },
  { key: "elevation", label: "Ground elevation", unit: "m", step: "0.5" },
  { key: "confidence", label: "Confidence", unit: "", step: "0.01" },
];

type AxisFilters = Pick<TreeFilters, "height" | "crownArea" | "crownDiameter" | "elevation" | "confidence">;

export type AxisDomains = Record<keyof AxisFilters, [number, number]>;

export function TreeFilterPanel({
  totalCount,
  filteredCount,
  filters,
  setFilters,
  domains,
  classDefs,
  setClassDefs,
  showPoints,
  setShowPoints,
  showCrowns,
  setShowCrowns,
  crownColourByClass,
  setCrownColourByClass,
}: {
  totalCount: number;
  filteredCount: number;
  filters: TreeFilters;
  setFilters: (f: TreeFilters) => void;
  domains: AxisDomains;
  classDefs: HeightClassDef[];
  setClassDefs: (c: HeightClassDef[]) => void;
  showPoints: boolean;
  setShowPoints: (v: boolean) => void;
  showCrowns: boolean;
  setShowCrowns: (v: boolean) => void;
  crownColourByClass: boolean;
  setCrownColourByClass: (v: boolean) => void;
}) {
  const setAxis = (key: keyof AxisFilters, value: Range) => setFilters({ ...filters, [key]: value });

  const toggleClass = (label: string) => {
    const current = filters.heightClasses;
    if (current === null) {
      setFilters({ ...filters, heightClasses: new Set([label]) });
      return;
    }
    const next = new Set(current);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setFilters({ ...filters, heightClasses: next });
  };

  const editClass = (index: number, patch: Partial<HeightClassDef>) => {
    const next = classDefs.slice();
    next[index] = { ...next[index], ...patch };
    setClassDefs(next);
  };

  const removeClass = (index: number) => {
    setClassDefs(classDefs.filter((_, i) => i !== index));
  };

  const addClass = () => {
    const last = classDefs[classDefs.length - 1];
    const min = last && Number.isFinite(last.max) ? last.max : 0;
    setClassDefs([
      ...classDefs,
      { label: `${min}–${min + 5} m`, min, max: min + 5, enabled: true },
    ]);
  };

  /**
   * Whether "Clear filters" has anything left to do. Compared against
   * `DEFAULT_FILTERS`, not full-empty: this panel's resting state already
   * hides confidence below `DEFAULT_CONFIDENCE_THRESHOLD`, per
   * `docs/forest-validation-2026-09-19.md`'s finding that the raw, unfiltered
   * output is dominated by false positives on bare ground and rooftops.
   * "Clear filters" removes everything a client has added on top of that
   * floor; it does not itself reveal the noisy raw set — only the dedicated
   * toggle below does that, deliberately.
   */
  const notAtDefault = !isDefaultFilters(filters);
  const showingLowConfidence = filters.confidence === null || filters.confidence[0] < DEFAULT_CONFIDENCE_THRESHOLD;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Trees
        </h3>
        {notAtDefault ? (
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {/*
        The one control this panel opens with something already hidden behind.
        Per docs/forest-validation-2026-09-19.md: the raw 26,776-tree output
        is dominated by false positives on bare ground and rooftops, and
        filtering confidence >= 0.40 removed 82-86% of them in the patches
        checked while leaving real-forest density close to a human visual
        estimate. Off by default, and never silently: revealing the rest is
        one explicit click, named for what it does rather than hidden inside
        the general confidence range row below.
      */}
      <label className="flex cursor-pointer items-start gap-2 rounded-md bg-signal/10 px-2.5 py-2 text-[12px] text-signal-700">
        <input
          type="checkbox"
          checked={showingLowConfidence}
          onChange={(e) =>
            setFilters({
              ...filters,
              confidence: e.target.checked ? null : [DEFAULT_CONFIDENCE_THRESHOLD, 1],
            })
          }
          className="mt-0.5 h-3.5 w-3.5 rounded border-signal-600/40 text-signal-600 focus:ring-signal-600"
        />
        <span className="flex-1">
          Show low-confidence detections
          <span className="block text-[10.5px] leading-snug text-signal-600/90">
            Off by default: trees below {DEFAULT_CONFIDENCE_THRESHOLD.toFixed(2)} confidence are
            hidden, not deleted — this pass over-detects, and most of what it over-detects scores
            low.
          </span>
        </span>
      </label>

      {/* Live count: never a separate "apply" step, exactly as the panel's own
          header comment promises. */}
      <p className="text-[13px] text-ink-900">
        <span className="font-mono font-semibold">{filteredCount.toLocaleString("en-GB")}</span>
        {" of "}
        <span className="font-mono">{totalCount.toLocaleString("en-GB")}</span>
        {" trees shown"}
      </p>

      {/* ---- what is drawn ------------------------------------------------ */}
      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Layers</legend>
        <Toggle checked={showPoints} onChange={setShowPoints} label="Tree points" />
        <Toggle checked={showCrowns} onChange={setShowCrowns} label="Crown polygons" />
        {showCrowns ? (
          <Toggle
            checked={crownColourByClass}
            onChange={setCrownColourByClass}
            label="Colour crowns by height class"
            hint="Off colours crowns on a continuous height gradient, the same ramp the CHM layer uses."
          />
        ) : null}
      </fieldset>

      {/* ---- tree id --------------------------------------------------- */}
      <div className="space-y-1">
        <label className="text-[11px] font-semibold text-ink/60" htmlFor="tree-id-filter">
          Tree ID
        </label>
        <input
          id="tree-id-filter"
          type="text"
          value={filters.treeId}
          onChange={(e) => setFilters({ ...filters, treeId: e.target.value })}
          placeholder="e.g. 5047527d"
          className="w-full rounded border border-ink/15 bg-paper px-2 py-1 font-mono text-[12px] text-ink-900 focus:border-accent-600 focus:outline-none"
        />
      </div>

      {/* ---- the five numeric axes -------------------------------------- */}
      <fieldset className="space-y-2">
        <legend className="text-[11px] font-semibold text-ink/60">Range</legend>
        {AXES.map(({ key, label, unit, step }) => (
          <AxisRow
            key={key}
            label={label}
            unit={unit}
            step={step}
            domain={domains[key]}
            value={filters[key]}
            onChange={(v) => setAxis(key, v)}
          />
        ))}
      </fieldset>

      {/* ---- quick height-class filters ---------------------------------- */}
      <fieldset className="space-y-1.5 border-t border-ink/[0.08] pt-2.5">
        <legend className="text-[11px] font-semibold text-ink/60">Height classes</legend>
        <div className="flex flex-wrap gap-1">
          {classDefs.map((c) => {
            const on = filters.heightClasses?.has(c.label) ?? false;
            return (
              <button
                key={c.label}
                type="button"
                disabled={!c.enabled}
                aria-pressed={on}
                onClick={() => toggleClass(c.label)}
                title={c.enabled ? undefined : "Disabled below, in Edit classes"}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  on
                    ? "bg-ink-900 text-white"
                    : "bg-ink/[0.06] text-ink/70 hover:bg-ink/[0.12]"
                } disabled:cursor-not-allowed disabled:opacity-35`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        {filters.heightClasses ? (
          <button
            type="button"
            onClick={() => setFilters({ ...filters, heightClasses: null })}
            className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
          >
            Any class
          </button>
        ) : null}
      </fieldset>

      {/* ---- editing the class definitions, §4/§5.4 ---------------------- */}
      <details className="border-t border-ink/[0.08] pt-2.5">
        <summary className="cursor-pointer text-[11px] font-semibold text-ink/60">
          Edit classes
        </summary>
        <div className="mt-2 space-y-1.5">
          {classDefs.map((c, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={c.enabled}
                onChange={(e) => editClass(i, { enabled: e.target.checked })}
                aria-label={`Enable ${c.label}`}
                className="h-3.5 w-3.5 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
              />
              <input
                type="number"
                value={c.min}
                step="0.1"
                onChange={(e) => editClass(i, { min: Number(e.target.value) })}
                aria-label={`${c.label} minimum`}
                className="w-14 rounded border border-ink/15 bg-paper px-1 py-0.5 font-mono text-[11px] text-ink-900 focus:border-accent-600 focus:outline-none"
              />
              <span className="text-ink/40">–</span>
              <input
                type="number"
                value={Number.isFinite(c.max) ? c.max : ""}
                step="0.1"
                placeholder="∞"
                onChange={(e) =>
                  editClass(i, { max: e.target.value === "" ? Infinity : Number(e.target.value) })
                }
                aria-label={`${c.label} maximum`}
                className="w-14 rounded border border-ink/15 bg-paper px-1 py-0.5 font-mono text-[11px] text-ink-900 focus:border-accent-600 focus:outline-none"
              />
              <input
                type="text"
                value={c.label}
                onChange={(e) => editClass(i, { label: e.target.value })}
                aria-label="Class label"
                className="min-w-0 flex-1 rounded border border-ink/15 bg-paper px-1.5 py-0.5 text-[11px] text-ink-900 focus:border-accent-600 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => removeClass(i)}
                aria-label={`Remove ${c.label}`}
                className="text-ink/40 hover:text-signal-600"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addClass}
            className="rounded-full border border-dashed border-ink/20 px-2.5 py-1 text-[11px] font-medium text-ink/60 hover:border-accent-600 hover:text-accent-700"
          >
            + Add class
          </button>
          <p className="text-[10px] leading-snug text-ink/45">
            Saved on this device only, per survey. A tree&apos;s class is whichever band its
            height falls in among the classes checked on above; a height in no enabled band has
            no class and will not match any quick filter.
          </p>
        </div>
      </details>
    </div>
  );
}

function AxisRow({
  label,
  unit,
  step,
  domain,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  step: string;
  domain: [number, number];
  value: Range;
  onChange: (v: Range) => void;
}) {
  const [lo, hi] = value ?? domain;
  const active = value !== null;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-ink/60">
          {label}
          {unit ? ` (${unit})` : ""}
        </span>
        {active ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[10px] font-medium text-ink/40 hover:text-accent-600"
          >
            reset
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          step={step}
          value={Number.isFinite(lo) ? lo : ""}
          onChange={(e) => onChange([Number(e.target.value), hi])}
          aria-label={`${label} minimum`}
          className="w-full min-w-0 rounded border border-ink/15 bg-paper px-1.5 py-1 font-mono text-[11px] text-ink-900 focus:border-accent-600 focus:outline-none"
        />
        <span className="text-ink/30">–</span>
        <input
          type="number"
          step={step}
          value={Number.isFinite(hi) ? hi : ""}
          onChange={(e) => onChange([lo, Number(e.target.value)])}
          aria-label={`${label} maximum`}
          className="w-full min-w-0 rounded border border-ink/15 bg-paper px-1.5 py-1 font-mono text-[11px] text-ink-900 focus:border-accent-600 focus:outline-none"
        />
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12px] text-ink-900">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
      />
      <span className="flex-1">
        {label}
        {hint ? <span className="block text-[10px] leading-snug text-ink/55">{hint}</span> : null}
      </span>
    </label>
  );
}
