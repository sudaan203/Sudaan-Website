"use client";

/**
 * The contour layer's elevation controls.
 *
 * Contours arrive with an `elevation` attribute on every line and, until now,
 * nothing on the map let a client do anything with it: the lines were one flat
 * brown, and a height was only readable by pointing at a line and waiting for a
 * hover readout. That is a drawing, not data.
 *
 * Four controls, each answering a question a surveyor actually asks of a contour
 * sheet:
 *
 *  - **Labels.** The number on the line, which is the whole point of a contour
 *    map. Drawn as HTML rather than as a MapLibre symbol layer, because symbols
 *    need glyph PBFs and the only two ways to get those are a font CDN, which
 *    the site's CSP rightly blocks, or shipping a self-hosted glyph set that
 *    would be larger than the contours themselves.
 *  - **Index contours.** Every fifth line heavier, the way a printed sheet is
 *    drawn, so the eye can count without reading every label.
 *  - **Colour by height.** Turns a set of lines back into a surface.
 *  - **An elevation band.** Show only 360-380 m and the question "where does the
 *    ground sit between these two levels" answers itself. This is the control
 *    that makes the attribute genuinely useful rather than merely visible.
 */

export type ContourState = {
  /** The layer key in the manifest, so the map knows what to restyle. */
  key: string;
  title: string;
  /** Every distinct level present, ascending. */
  levels: number[];
  /** The commonest gap between consecutive levels, in metres. */
  interval: number;
};

export type ContourControls = {
  labels: boolean;
  colour: boolean;
  /** Every nth level drawn heavier. 0 turns index contours off. */
  indexEvery: number;
  /** Only levels within [low, high] are drawn. */
  low: number;
  high: number;
};

/**
 * What a contour set contains, read from the data rather than assumed.
 *
 * The interval is the *commonest* gap, not the smallest and not the mean. A
 * survey's contours are not guaranteed to be complete — a level with no ground
 * at that height produces no line at all, leaving a gap of two intervals — so
 * the minimum would be right by luck and the mean would be wrong by design.
 */
export function describeContours(
  key: string,
  title: string,
  features: { properties?: { elevation?: unknown } | null }[],
): ContourState | null {
  const levels = [
    ...new Set(
      features
        .map((f) => f.properties?.elevation)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    ),
  ].sort((a, b) => a - b);
  if (levels.length === 0) return null;

  const gaps = new Map<number, number>();
  for (let i = 1; i < levels.length; i += 1) {
    const gap = Number((levels[i] - levels[i - 1]).toFixed(4));
    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  let interval = levels.length > 1 ? levels[1] - levels[0] : 1;
  let best = 0;
  for (const [gap, count] of gaps) {
    if (count > best) {
      best = count;
      interval = gap;
    }
  }
  return { key, title, levels, interval };
}

export function ContourPanel({
  contours,
  controls,
  setControls,
  visible,
  setVisible,
  /** How many labels are on screen, so a client knows why some lines have none. */
  labelCount,
}: {
  contours: ContourState;
  controls: ContourControls;
  setControls: (fn: (c: ContourControls) => ContourControls) => void;
  visible: boolean;
  setVisible: (on: boolean) => void;
  labelCount: number;
}) {
  const min = contours.levels[0];
  const max = contours.levels[contours.levels.length - 1];
  const banded = controls.low > min || controls.high < max;
  const shown = contours.levels.filter((l) => l >= controls.low && l <= controls.high).length;

  /**
   * Snap a slider to a level that exists.
   *
   * A range whose ends fall between contours is not wrong, but it reports
   * "372.4 m" for a band whose real edge is the 372 m line, and a client reading
   * a height off a control that cannot produce that height is being misled by a
   * rounding artefact.
   */
  const snap = (v: number) =>
    contours.levels.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), min);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          {contours.title}
        </h3>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink/70">
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => setVisible(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
          />
          Show
        </label>
      </div>

      <p className="text-[11px] text-ink/55">
        {contours.interval % 1 === 0 ? contours.interval : contours.interval.toFixed(2)} m
        interval, {min}–{max} m, {contours.levels.length} levels.
      </p>

      {visible ? (
        <>
          <div className="space-y-1.5">
            <Toggle
              checked={controls.labels}
              onChange={(on) => setControls((c) => ({ ...c, labels: on }))}
              label="Elevation labels"
              hint={
                controls.labels
                  ? labelCount > 0
                    ? `${labelCount} on screen. Zoom in for more.`
                    : "Zoom in until lines separate."
                  : "The height on each line"
              }
            />
            <Toggle
              checked={controls.colour}
              onChange={(on) => setControls((c) => ({ ...c, colour: on }))}
              label="Colour by height"
              hint="Low to high, over the range shown"
            />
            <Toggle
              checked={controls.indexEvery > 0}
              onChange={(on) => setControls((c) => ({ ...c, indexEvery: on ? 5 : 0 }))}
              label="Index contours"
              hint={
                controls.indexEvery > 0
                  ? `Every ${controls.indexEvery * contours.interval} m drawn heavier`
                  : "Every fifth line drawn heavier"
              }
            />
          </div>

          <fieldset className="space-y-1.5 border-t border-ink/[0.08] pt-2.5">
            <legend className="text-[11px] font-semibold text-ink/60">
              Elevation band
            </legend>

            <label className="block text-[10px] text-ink/50">
              Lowest shown
              <input
                type="range"
                min={min}
                max={max}
                step={contours.interval}
                value={controls.low}
                onChange={(e) =>
                  setControls((c) => {
                    const low = snap(Number(e.target.value));
                    return { ...c, low, high: Math.max(low, c.high) };
                  })
                }
                className="mt-0.5 w-full accent-accent-600"
                aria-label="Lowest contour shown, in metres"
              />
            </label>

            <label className="block text-[10px] text-ink/50">
              Highest shown
              <input
                type="range"
                min={min}
                max={max}
                step={contours.interval}
                value={controls.high}
                onChange={(e) =>
                  setControls((c) => {
                    const high = snap(Number(e.target.value));
                    return { ...c, high, low: Math.min(high, c.low) };
                  })
                }
                className="mt-0.5 w-full accent-accent-600"
                aria-label="Highest contour shown, in metres"
              />
            </label>

            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="font-mono text-ink-900">
                {controls.low} – {controls.high} m
              </span>
              <span className="text-ink/50">
                {shown} of {contours.levels.length}
              </span>
            </div>

            {banded ? (
              <button
                type="button"
                onClick={() => setControls((c) => ({ ...c, low: min, high: max }))}
                className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
              >
                Show every level
              </button>
            ) : null}

            {/*
              A band is a filter on what is drawn, not a statement about the
              ground. Saying so matters: hiding everything above 380 m does not
              mean nothing is up there, and a client who reads the map that way
              would draw exactly the wrong conclusion from an empty hillside.
            */}
            {banded && shown === 0 ? (
              <p className="text-[11px] leading-snug text-signal-600">
                No contour falls in that band, so nothing is drawn. The ground is
                still there.
              </p>
            ) : null}
          </fieldset>
        </>
      ) : null}
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
  onChange: (on: boolean) => void;
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
        <span className="font-semibold">{label}</span>
        {hint ? (
          <span className="block text-[10px] leading-snug text-ink/55">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}
