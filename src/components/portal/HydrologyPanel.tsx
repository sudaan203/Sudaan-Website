"use client";

import type {
  FloodResult,
  HydrologyAnalysis,
  InspectResult,
  SinksResult,
  WatershedResult,
} from "@/lib/portal/hydrology-client";
import { formatArea, formatDistance } from "@/lib/portal/geodesy";

/**
 * The hydrology controls and readout.
 *
 * ## What is drawn, and what is only computed
 *
 * `hydro-run.mjs` writes eight layers, six of them rasters. Only the two vector
 * ones — the channel network and the basins — can be drawn today, because the
 * rasters are GeoTIFFs and there is no dynamic tiler yet to colour them. So this
 * panel offers a legend for stream order, which is genuinely rendered, and does
 * not offer legends for flow accumulation, slope or sink depth, which would be
 * decorating something invisible. Those values are still *reported*, by clicking
 * the map, which is the honest way to expose a raster nobody can see.
 *
 * ## Colour
 *
 * Sequential ramps, single hue, darker with more water. Never a rainbow: it is
 * perceptually non-uniform and invents edges where the data is smooth, and the
 * one place a surveyor genuinely expects it is an elevation surface, which this
 * is not.
 */

export const STREAM_ORDER_COLOURS = [
  "#bfdbfe",
  "#93c5fd",
  "#60a5fa",
  "#3b82f6",
  "#2563eb",
  "#1d4ed8",
  "#1e3a8a",
] as const;

export type HydrologyMode = "off" | "inspect" | "watershed" | "flood";

export type HydrologyState = {
  analysis: HydrologyAnalysis | null;
  /** Wording from the route: why hydrology is coarser than the survey. */
  resolutionNote: string;
  generatedAt: string;
  maxStreamOrder: number;
};

export function HydrologyPanel({
  state,
  mode,
  setMode,
  showStreams,
  setShowStreams,
  showBasins,
  setShowBasins,
  inspected,
  watershed,
  flood,
  sinks,
  floodLevel,
  setFloodLevel,
  sinkDepth,
  setSinkDepth,
  onFindSinks,
  busy,
  error,
  onClear,
}: {
  state: HydrologyState;
  mode: HydrologyMode;
  setMode: (m: HydrologyMode) => void;
  showStreams: boolean;
  setShowStreams: (v: boolean) => void;
  showBasins: boolean;
  setShowBasins: (v: boolean) => void;
  inspected: InspectResult | null;
  watershed: WatershedResult | null;
  flood: FloodResult | null;
  sinks: SinksResult | null;
  floodLevel: string;
  setFloodLevel: (v: string) => void;
  sinkDepth: number;
  setSinkDepth: (v: number) => void;
  onFindSinks: () => void;
  busy: boolean;
  error: string | null;
  onClear: () => void;
}) {
  const { analysis } = state;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Hydrology
        </h3>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
        >
          Clear
        </button>
      </div>

      {error ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {error}
        </p>
      ) : null}

      {/* ---- what is drawn ------------------------------------------------ */}
      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Layers</legend>
        <Toggle
          checked={showStreams}
          onChange={setShowStreams}
          label="Channel network"
          hint={
            analysis
              ? `Cells with at least ${formatArea(analysis.streamThresholdArea_m2)} draining through them`
              : undefined
          }
        />
        <Toggle
          checked={showBasins}
          onChange={setShowBasins}
          label="Basins"
          hint="Where each part of the survey drains to"
        />
      </fieldset>

      {showStreams && state.maxStreamOrder > 0 ? (
        <StreamOrderLegend max={state.maxStreamOrder} />
      ) : null}

      {/* ---- tools --------------------------------------------------------- */}
      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Ask the map</legend>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["inspect", "Inspect"],
              ["watershed", "Watershed"],
              ["flood", "Flood"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(mode === value ? "off" : value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                mode === value
                  ? "bg-accent-600 text-white"
                  : "border border-ink/15 text-ink/70 hover:border-accent-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode !== "off" ? (
          <p className="text-[10px] leading-snug text-ink/55">
            {mode === "inspect"
              ? "Click anywhere to read the terrain and the water at that point."
              : mode === "watershed"
                ? "Click a point on a channel. Everything draining through it is traced upstream."
                : "Set a water level, then click where the water starts."}
          </p>
        ) : null}
      </fieldset>

      {mode === "flood" ? (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            value={floodLevel}
            onChange={(e) => setFloodLevel(e.target.value)}
            aria-label="Water level in metres"
            placeholder="level"
            className="w-24 rounded border border-ink/15 bg-paper px-2 py-1 font-mono text-[12px] text-ink-900 focus:border-accent-600 focus:outline-none"
          />
          <span className="text-[11px] text-ink/55">m water level</span>
        </div>
      ) : null}

      {busy ? <p className="text-[11px] text-ink/45">Reading the model…</p> : null}

      {/* ---- results ------------------------------------------------------- */}
      {inspected ? <Inspected r={inspected} /> : null}
      {watershed ? <Watershed r={watershed} /> : null}
      {flood ? <Flood r={flood} /> : null}

      {/* ---- sinks --------------------------------------------------------- */}
      <fieldset className="space-y-1.5 border-t border-ink/[0.08] pt-2.5">
        <legend className="text-[11px] font-semibold text-ink/60">Depressions</legend>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={0.05}
            step={0.05}
            value={sinkDepth}
            onChange={(e) => setSinkDepth(Number(e.target.value))}
            aria-label="Minimum sink depth in metres"
            className="w-20 rounded border border-ink/15 bg-paper px-2 py-1 font-mono text-[12px] text-ink-900 focus:border-accent-600 focus:outline-none"
          />
          <span className="text-[11px] text-ink/55">m or deeper</span>
          <button
            type="button"
            onClick={onFindSinks}
            className="ml-auto rounded-full border border-ink/15 px-2.5 py-1 text-[11px] font-semibold text-ink/70 transition hover:border-accent-600 hover:text-accent-700"
          >
            Find
          </button>
        </div>
        {sinks ? (
          <dl className="space-y-1 text-[12px]">
            <Row label="Area" value={formatArea(sinks.area_m2)} />
            <Row label="Storage" value={`${Math.round(sinks.storage_m3).toLocaleString("en-GB")} m³`} />
            <Row label="Deepest" value={formatDistance(sinks.deepest_m)} />
          </dl>
        ) : null}
      </fieldset>

      {/* ---- provenance ---------------------------------------------------- */}
      {analysis ? (
        <p className="border-t border-ink/[0.08] pt-2 text-[11px] leading-snug text-ink/55">
          {state.resolutionNote} Computed over {analysis.surveyArea_ha} ha
          {state.generatedAt
            ? ` on ${new Date(state.generatedAt).toLocaleDateString("en-GB")}`
            : ""}
          .
        </p>
      ) : null}
    </div>
  );
}

function StreamOrderLegend({ max }: { max: number }) {
  /*
   * Built from the orders actually present rather than a fixed set of seven.
   * A survey whose network only reaches order 3 should not show four empty
   * swatches implying rivers it does not have.
   */
  const orders = Array.from({ length: Math.min(max, STREAM_ORDER_COLOURS.length) }, (_, i) => i + 1);
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wide text-ink/45">Stream order</p>
      <div className="flex items-end gap-1">
        {orders.map((order) => (
          <div key={order} className="flex flex-1 flex-col items-center gap-0.5">
            <span
              className="w-full rounded-sm"
              style={{
                background: STREAM_ORDER_COLOURS[order - 1],
                height: `${2 + order * 1.5}px`,
              }}
            />
            <span className="font-mono text-[9px] text-ink/45">{order}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] leading-snug text-ink/50">
        Strahler order. A channel becomes order 2 where two order 1 channels meet, and so on,
        so a higher number is further down the system and carries more water.
      </p>
    </div>
  );
}

function Inspected({ r }: { r: InspectResult }) {
  return (
    <dl className="space-y-1.5 border-t border-ink/[0.08] pt-2.5 text-sm">
      <Row label="Elevation" value={r.elevation === null ? "no data" : `${r.elevation.toFixed(2)} m`} />
      <Row
        label="Slope"
        value={
          r.slopeDegrees === null
            ? "no data"
            : `${r.slopeDegrees.toFixed(1)}° · ${r.slopePercent!.toFixed(1)}%`
        }
      />
      {/*
        Degrees and percent together, always. Malhar's three specifications give
        three different slope classifications and one of them is in percent, so
        the unit can never be left implied: 15 degrees is 27 percent, and a band
        read in the wrong unit is a wrong map.
      */}
      <Row
        label="Draining through"
        value={
          r.contributingArea_ha === null
            ? "no data"
            : r.contributingArea_ha >= 0.1
              ? `${r.contributingArea_ha.toFixed(2)} ha`
              : formatArea(r.contributingArea_m2!)
        }
      />
      <Row
        label="Channel"
        value={r.onChannel ? `yes, order ${r.strahlerOrder}` : "no"}
      />
      {r.sinkDepth_m !== null && r.sinkDepth_m > 0 ? (
        <Row label="In a depression" value={`${r.sinkDepth_m.toFixed(2)} m deep`} />
      ) : null}
    </dl>
  );
}

function Watershed({ r }: { r: WatershedResult }) {
  return (
    <div className="space-y-2 border-t border-ink/[0.08] pt-2.5">
      <dl className="space-y-1.5 text-sm">
        <Row label="Catchment" value={`${r.area_ha.toFixed(3)} ha`} strong />
        <Row label="Area" value={formatArea(r.area_m2)} />
      </dl>
      {r.pourPoint.snapped ? (
        <p className="text-[11px] leading-snug text-ink/55">
          The pour point was moved {r.pourPoint.snappedBy_m.toFixed(1)} m onto the nearest
          channel. A point beside a channel drains the hillside, not the valley, so this is
          almost always what you meant.
        </p>
      ) : null}
      {r.truncatedBySurveyEdge ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {r.note}
        </p>
      ) : null}
    </div>
  );
}

function Flood({ r }: { r: FloodResult }) {
  return (
    <div className="space-y-2 border-t border-ink/[0.08] pt-2.5">
      <dl className="space-y-1.5 text-sm">
        <Row label="Water at" value={`${r.level_m.toFixed(2)} m`} />
        <Row label="Covered" value={formatArea(r.area_m2)} strong />
        <Row label="Storage" value={`${Math.round(r.storage_m3).toLocaleString("en-GB")} m³`} strong />
        <Row label="Deepest" value={formatDistance(r.maxDepth_m)} />
      </dl>
      <p className="text-[11px] leading-snug text-ink/55">{r.method}</p>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink/60">{label}</dt>
      <dd className={`font-mono text-[13px] ${strong ? "font-semibold" : ""} text-ink-900`}>
        {value}
      </dd>
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
