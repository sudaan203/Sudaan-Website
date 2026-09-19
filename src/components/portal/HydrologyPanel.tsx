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

/** The generated layers that can leave the portal, and in what. */
export type HydrologyExport = "basins" | "streams" | "depressions";
export type ExportFormat = "geojson" | "shapefile";

export type HydrologyState = {
  analysis: HydrologyAnalysis | null;
  /** Wording from the route: why hydrology is coarser than the survey. */
  resolutionNote: string;
  generatedAt: string;
  maxStreamOrder: number;
};

/**
 * Two formats, because they are not interchangeable.
 *
 * GeoJSON is lossless, opens in everything, and carries attribute names in
 * full. Shapefile is what most of this client's downstream work actually
 * consumes, and it truncates field names to ten characters and splits into four
 * files in a zip. Offering only the tidier one would mean the client converting
 * it themselves; offering only the expected one would mean losing attribute
 * names for no reason.
 */
function Download({
  what,
  label,
  onDownload,
  downloading,
}: {
  what: HydrologyExport;
  label: string;
  onDownload: (layer: HydrologyExport, format: ExportFormat) => void;
  downloading: string | null;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-ink/55">{label}</span>
      {(["geojson", "shapefile"] as ExportFormat[]).map((format) => {
        const key = `${what}:${format}`;
        const busy = downloading === key;
        return (
          <button
            key={format}
            type="button"
            disabled={busy}
            onClick={() => onDownload(what, format)}
            className="rounded border border-ink/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/65 hover:border-accent-600 hover:text-accent-700 disabled:opacity-50"
          >
            {busy ? "…" : format === "geojson" ? "GeoJSON" : "SHP"}
          </button>
        );
      })}
    </div>
  );
}

export function HydrologyPanel({
  state,
  mode,
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
  onDownload,
  downloading,
  busy,
  error,
  onClear,
}: {
  state: HydrologyState;
  mode: HydrologyMode;
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
  /**
   * Item 7. These layers were computable and drawable but not removable: a
   * client could see where the site drains and could not take it to their own
   * GIS, which is where the decision actually gets made.
   */
  onDownload: (layer: HydrologyExport, format: ExportFormat) => void;
  /** Which export is in flight, so its button can say so. */
  downloading: string | null;
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

      <Download
        what="basins"
        label="Basins"
        onDownload={onDownload}
        downloading={downloading}
      />
      <Download
        what="streams"
        label="Channel network"
        onDownload={onDownload}
        downloading={downloading}
      />

      {showStreams && state.maxStreamOrder > 0 ? (
        <StreamOrderLegend max={state.maxStreamOrder} />
      ) : null}

      {/*
        Tools 24, 26 and 28 used to be chosen here. They now live in the tool
        rail above the map with the rest of Malhar's numbered tools, so that one
        control switches a tool on and switches every other tool off. Two places
        to start a mode meant two ways to leave a measure tool and a hydrology
        tool both listening for the same click.
      */}

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
          <>
            <dl className="space-y-1 text-[12px]">
              {/* The count first, because it is what changed: these used to be
                  one dissolved shape carrying one set of totals. */}
              <Row label="Depressions" value={String(sinks.depressions ?? "—")} />
              <Row label="Area" value={formatArea(sinks.area_m2)} />
              <Row label="Storage" value={`${Math.round(sinks.storage_m3).toLocaleString("en-GB")} m³`} />
              <Row label="Deepest" value={formatDistance(sinks.deepest_m)} />
            </dl>
            <p className="text-[11px] leading-snug text-ink/55">
              Totals across every depression {sinks.minDepth_m} m or deeper. The export
              carries one feature per depression, each with its own area, storage and
              deepest point.
            </p>
            <Download
              what="depressions"
              label="Depressions"
              onDownload={onDownload}
              downloading={downloading}
            />
          </>
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
