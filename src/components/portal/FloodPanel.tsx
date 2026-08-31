"use client";

import type { FloodLevel, FloodResult } from "@/lib/portal/analysis-client";

/**
 * Malhar's "Simulation Water Level Rise" tool, from his own nine-page prompt.
 *
 * A water-level-rise simulation over the survey's DTM: pick a water source or
 * an elevation, pick a rise interval, press start, and watch the flood spread
 * step by step with the area updating beside it.
 *
 * ## The one distinction the whole tool turns on
 *
 * His §13 is right, and it is the reason this is not a colour ramp with a
 * threshold on it: a flood *from a water source* is not the same thing as
 * every pixel below an elevation. The second floods hilltop hollows no water
 * could ever reach, and the two pictures look equally plausible. So the panel
 * never hides which one it is showing — the mode is a visible choice, the
 * result restates it, and choosing a source on the map is what switches it.
 *
 * ## Levels are simulated ahead, then animated locally
 *
 * "The 2 m, 5 m and 10 m interval buttons must work automatically" is his most
 * important requirement, and the honest way to make an animation smooth is not
 * to fetch a frame at a time. The whole ladder from the starting elevation to
 * the maximum is computed in one request — the server reads the DTM once
 * either way — and playback then steps through data already in the browser.
 * The slider does the same, which is why it can be dragged without stuttering
 * and why it keeps working with the animation paused.
 */

export type FloodMode = "source" | "elevation";

export type FloodControls = {
  /** Where the water comes from: a place on the map, or just an elevation. */
  mode: FloodMode;
  startElevation: number | null;
  maxElevation: number | null;
  interval: number;
  speed: "slow" | "normal" | "fast";
};

export type FloodState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; data: FloodResult }
  | { state: "error"; message: string };

/** The three intervals Malhar's spec names, and no others. */
const INTERVALS = [2, 5, 10];

const SPEEDS: { value: FloodControls["speed"]; label: string }[] = [
  { value: "slow", label: "Slow" },
  { value: "normal", label: "Normal" },
  { value: "fast", label: "Fast" },
];

export function FloodPanel({
  controls,
  setControls,
  source,
  onPickSource,
  onClearSource,
  result,
  onRun,
  onClear,
  step,
  setStep,
  playing,
  onPlay,
  onPause,
  onReset,
  opacity,
  setOpacity,
  onExport,
  exporting,
}: {
  controls: FloodControls;
  setControls: (fn: (c: FloodControls) => FloodControls) => void;
  /** The chosen water source: its ground elevation, once the map has one. */
  source: { lon: number; lat: number; ground: number | null } | null;
  /** Arm the map to take the next click as the water source. */
  onPickSource: () => void;
  onClearSource: () => void;
  /** True while the map is armed and waiting for that click. */
  result: FloodState;
  onRun: () => void;
  onClear: () => void;
  step: number;
  setStep: (n: number) => void;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  opacity: number;
  setOpacity: (n: number) => void;
  onExport: (what: "current" | "all", format: "geojson" | "shapefile") => void;
  exporting: boolean;
}) {
  const levels = result.state === "done" ? result.data.levels : [];
  const current: FloodLevel | null = levels[step] ?? null;
  const start = levels[0]?.level_m ?? controls.startElevation;

  return (
    <div role="region" aria-label="Flood" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Water level rise
        </h3>
        {result.state === "done" || source ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* ---------------------------------------------------- water source -- */}
      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Water source</legend>
        <div className="flex gap-1.5">
          {(
            [
              ["source", "Select on map"],
              ["elevation", "From elevation"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={controls.mode === value}
              onClick={() => setControls((c) => ({ ...c, mode: value }))}
              className={`flex-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                controls.mode === value
                  ? "bg-accent-600 text-white"
                  : "border border-ink/15 text-ink/70 hover:border-accent-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {controls.mode === "source" ? (
          source ? (
            <div className="flex items-baseline justify-between gap-2 rounded-md bg-ink/[0.04] px-2 py-1.5">
              <p className="text-[11px] text-ink/70">
                Ground here:{" "}
                <span className="font-mono text-ink-900">
                  {source.ground === null ? "—" : `${source.ground.toFixed(2)} m`}
                </span>
              </p>
              <button
                type="button"
                onClick={onClearSource}
                className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
              >
                Move
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onPickSource}
              className="w-full rounded-lg border border-dashed border-ink/20 px-3 py-2 text-[11px] text-ink/60 transition hover:border-accent-600 hover:text-accent-700"
            >
              Click the map where the water starts
            </button>
          )
        ) : (
          <p className="text-[10px] leading-snug text-ink/50">
            Every hollow below the level floods, whether water could reach it or
            not. Pick a source on the map instead to flood only ground the water
            can actually get to.
          </p>
        )}
      </fieldset>

      {/* --------------------------------------------------- the ladder ----- */}
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Start"
          value={controls.startElevation}
          placeholder={source?.ground != null ? source.ground.toFixed(1) : "—"}
          onChange={(n) => setControls((c) => ({ ...c, startElevation: n }))}
        />
        <Field
          label="Maximum"
          value={controls.maxElevation}
          placeholder="—"
          onChange={(n) => setControls((c) => ({ ...c, maxElevation: n }))}
        />
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Rise interval</legend>
        <div className="flex gap-1.5">
          {INTERVALS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={controls.interval === n}
              aria-label={`${n} m interval`}
              onClick={() => setControls((c) => ({ ...c, interval: n }))}
              className={`flex-1 rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold transition ${
                controls.interval === n
                  ? "bg-accent-600 text-white"
                  : "border border-ink/15 text-ink/70 hover:border-accent-600"
              }`}
            >
              {n} m
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        disabled={result.state === "loading"}
        onClick={onRun}
        className="w-full rounded-full bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {result.state === "loading" ? "Simulating…" : "▶ Start simulation"}
      </button>

      {result.state === "error" ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {result.message}
        </p>
      ) : null}

      {/* --------------------------------------------------- the results ---- */}
      {result.state === "done" && levels.length > 0 ? (
        <div className="space-y-3 border-t border-ink/[0.08] pt-3">
          {/* Playback. Step back and forward move one level either way; the
              slider goes anywhere, which is his §5 and works while paused. */}
          <div className="flex items-center gap-1">
            <Control
              label="Step back"
              glyph="◀◀"
              onClick={() => setStep(Math.max(0, step - 1))}
              disabled={step === 0}
            />
            {playing ? (
              <Control label="Pause" glyph="⏸" onClick={onPause} wide />
            ) : (
              <Control label="Play" glyph="▶" onClick={onPlay} wide disabled={step >= levels.length - 1} />
            )}
            <Control
              label="Step forward"
              glyph="▶▶"
              onClick={() => setStep(Math.min(levels.length - 1, step + 1))}
              disabled={step >= levels.length - 1}
            />
            <Control label="Reset" glyph="↻" onClick={onReset} />
          </div>

          <label className="block space-y-1">
            <span className="flex items-baseline justify-between text-[11px] text-ink/60">
              <span>Water level</span>
              <span className="font-mono text-[12px] font-semibold text-ink-900">
                {current ? `${current.level_m.toFixed(2)} m` : "—"}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={levels.length - 1}
              step={1}
              value={step}
              aria-label="Water level"
              onChange={(e) => setStep(Number(e.target.value))}
              className="w-full accent-accent-600"
            />
          </label>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink/55">Speed</span>
            <div className="flex flex-1 gap-1">
              {SPEEDS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={controls.speed === value}
                  onClick={() => setControls((c) => ({ ...c, speed: value }))}
                  className={`flex-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition ${
                    controls.speed === value
                      ? "bg-ink/[0.12] text-ink-900"
                      : "text-ink/50 hover:text-ink-900"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {current ? (
            <>
              <dl className="space-y-1 text-[12px]">
                <Row label="Starting elevation" value={`${(start ?? 0).toFixed(2)} m`} />
                <Row label="Current level" value={`${current.level_m.toFixed(2)} m`} strong />
                <Row
                  label="Rise"
                  value={`+${(current.level_m - (start ?? current.level_m)).toFixed(2)} m`}
                />
                <Row label="Flooded" value={`${current.area_ha.toFixed(2)} ha`} strong />
                <Row label="" value={`${current.area_km2.toFixed(4)} km²`} />
                <Row label="Deepest" value={`${current.maxDepth_m.toFixed(2)} m`} />
                <Row label="Step" value={`${step + 1} of ${levels.length}`} />
              </dl>

              {current.truncated ? (
                <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
                  This flood reaches the edge of the surveyed ground, so it continues
                  past what the survey can see. The area above is a lower bound.
                </p>
              ) : null}
            </>
          ) : null}

          <label className="block space-y-1">
            <span className="text-[11px] text-ink/60">Water opacity</span>
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={opacity}
              aria-label="Water opacity"
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="w-full accent-accent-600"
            />
          </label>

          {/* The whole ladder as a table, his §9. Rows are clickable because a
              client reading "24.5 ha at 115 m" almost always wants to see it. */}
          <div className="max-h-40 overflow-auto rounded border border-ink/10">
            <table className="w-full border-collapse text-[10px]">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <th scope="col" className="border-b border-ink/10 px-1.5 py-1 text-left font-semibold text-ink/55">
                    Water level
                  </th>
                  <th scope="col" className="border-b border-ink/10 px-1.5 py-1 text-right font-semibold text-ink/55">
                    Flooded
                  </th>
                </tr>
              </thead>
              <tbody className="font-mono text-ink-900">
                {levels.map((l, i) => (
                  <tr
                    key={l.level_m}
                    onClick={() => setStep(i)}
                    className={`cursor-pointer ${i === step ? "bg-accent-50" : "hover:bg-ink/[0.03]"}`}
                  >
                    <td className="border-b border-ink/[0.06] px-1.5 py-0.5">
                      {l.level_m.toFixed(2)} m
                    </td>
                    <td className="border-b border-ink/[0.06] px-1.5 py-0.5 text-right">
                      {l.area_ha.toFixed(2)} ha
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ------------------------------------------------------ export -- */}
          <fieldset className="space-y-1.5">
            <legend className="text-[11px] font-semibold text-ink/60">Export</legend>
            <div className="grid grid-cols-2 gap-1.5">
              <Export label="This level" onClick={(f) => onExport("current", f)} busy={exporting} />
              <Export label="All levels" onClick={(f) => onExport("all", f)} busy={exporting} />
            </div>
            <p className="text-[10px] leading-snug text-ink/45">
              Each polygon carries its water level, the interval, and its area in
              m², hectares and km². Shapefiles are written in the survey&apos;s own
              UTM zone with a .prj; GeoJSON is lon/lat, as RFC 7946 requires.
            </p>
          </fieldset>
        </div>
      ) : null}

      <p className="border-t border-ink/[0.08] pt-2 text-[11px] leading-snug text-ink/55">
        {result.state === "done" && result.data.method === "connected"
          ? "Flooded from the source you chose: hollows at this level with no path from it stay dry."
          : "Every hollow at or below the level, connected to the source or not."}{" "}
        Read from the terrain model, not the surface model — water runs over bare
        earth, not over canopy.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | null;
  placeholder: string;
  onChange: (n: number | null) => void;
}) {
  return (
    <label className="block space-y-0.5">
      <span className="text-[11px] text-ink/60">{label}</span>
      <span className="flex items-baseline gap-1">
        <input
          type="number"
          step="any"
          value={value ?? ""}
          placeholder={placeholder}
          aria-label={`${label} elevation in metres`}
          onChange={(e) => {
            /*
             * An empty box is null, never zero. `Number("")` is 0 and finite,
             * and a starting elevation of 0 m on a 340 m survey asks the server
             * to simulate the sea arriving — the same trap that has cost this
             * codebase three features, and the reason `numbers.ts` exists.
             */
            const raw = e.target.value.trim();
            if (raw === "") return onChange(null);
            const next = globalThis.Number(raw);
            if (globalThis.Number.isFinite(next)) onChange(next);
          }}
          className="w-full min-w-0 rounded border border-ink/15 bg-paper px-2 py-1 font-mono text-[12px] text-ink-900 focus:border-accent-600 focus:outline-none"
        />
        <span className="text-[11px] text-ink/55">m</span>
      </span>
    </label>
  );
}

function Control({
  label,
  glyph,
  onClick,
  disabled = false,
  wide = false,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
  disabled?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border border-ink/15 py-1 text-[11px] text-ink/70 transition hover:border-accent-600 hover:text-accent-700 disabled:cursor-not-allowed disabled:opacity-35 ${
        wide ? "flex-[2]" : "flex-1"
      }`}
    >
      {glyph}
    </button>
  );
}

function Export({
  label,
  onClick,
  busy,
}: {
  label: string;
  onClick: (format: "geojson" | "shapefile") => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold text-ink/55">{label}</p>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={busy}
          aria-label={`${label} as GeoJSON`}
          onClick={() => onClick("geojson")}
          className="flex-1 rounded border border-ink/15 px-1 py-0.5 text-[10px] font-semibold text-ink/70 transition hover:border-accent-600 hover:text-accent-700 disabled:opacity-40"
        >
          GeoJSON
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label={`${label} as Shapefile`}
          onClick={() => onClick("shapefile")}
          className="flex-1 rounded border border-ink/15 px-1 py-0.5 text-[10px] font-semibold text-ink/70 transition hover:border-accent-600 hover:text-accent-700 disabled:opacity-40"
        >
          Shapefile
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
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
