"use client";

import { legend, RAMP_NAMES } from "@/lib/geo/colour.mjs";

/**
 * The layers the tiler draws, and the colourbar that makes them readable.
 *
 * These are the six rasters `hydro-run.mjs` writes plus the two elevation
 * models, and until the tiler existed none of them could be seen at all: they
 * are GeoTIFFs, and a browser cannot draw a GeoTIFF. The hydrology panel
 * therefore reported their values by clicking and deliberately carried no
 * legends, because a legend for something invisible is decoration. That
 * reasoning expires here.
 *
 * ## The range is the layer's, never the tile's
 *
 * Every layer carries an explicit min and max, taken from the statistics the
 * pipeline recorded, and those are sent with every tile request. Letting each
 * tile stretch to its own contents produces a chessboard: the same elevation
 * takes a different colour either side of a tile boundary and the seams become
 * the most prominent thing on the map. Measured on Kotba, that is the difference
 * between a mean seam of 23 and one of 97, out of 765.
 *
 * ## Why some layers are drawn logarithmically
 *
 * Flow accumulation on Kotba runs from 1 to 7,246 cells, and a drainage network
 * is always shaped like that: nearly every cell drains nearly nothing and a thin
 * thread carries everything. Drawn linearly, 99% of the map is the bottom colour
 * and the channels are a few bright pixels. The legend says which scale was used
 * rather than leaving the colours to be read as proportional.
 */

export type RenderedLayer = {
  key: string;
  title: string;
  /** What the numbers mean, in a sentence a non-GIS reader can use. */
  description: string;
  unit: string;
  min: number;
  max: number;
  ramp: string;
  /** Relief shading composited into the colour, for surfaces only. */
  relief: boolean;
  logarithmic: boolean;
  /**
   * True when the values carry a sign and zero means something.
   *
   * Such a layer must be drawn with a diverging ramp centred on zero, and the
   * server refuses any other with a 400. So the ramp chooser is hidden rather
   * than offering four buttons of which three produce an error.
   */
  signed?: boolean;
};

export function RenderedLayersPanel({
  layers,
  active,
  setActive,
  opacity,
  setOpacity,
  exaggeration,
  setExaggeration,
  ramp,
  setRamp,
}: {
  layers: RenderedLayer[];
  active: string | null;
  setActive: (key: string | null) => void;
  opacity: number;
  setOpacity: (v: number) => void;
  exaggeration: number;
  setExaggeration: (v: number) => void;
  ramp: string | null;
  setRamp: (v: string | null) => void;
}) {
  if (layers.length === 0) return null;
  const current = layers.find((l) => l.key === active) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Rendered layers
        </h3>
        {current ? (
          <button
            type="button"
            onClick={() => setActive(null)}
            className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
          >
            Off
          </button>
        ) : null}
      </div>

      {/*
        One at a time, by design. These are full-coverage rasters: stacking two
        means the upper one hides the lower, and the client is left adjusting
        opacity to guess at what is underneath. A radio group says that plainly
        where a set of checkboxes would invite the confusion.
      */}
      <fieldset className="space-y-1">
        <legend className="sr-only">Layer to draw</legend>
        {layers.map((layer) => (
          <label
            key={layer.key}
            className="flex cursor-pointer items-start gap-2 text-[12px] text-ink-900"
          >
            <input
              type="radio"
              name="rendered-layer"
              checked={active === layer.key}
              onChange={() => setActive(layer.key)}
              className="mt-0.5 h-3.5 w-3.5 border-ink/25 text-accent-600 focus:ring-accent-600"
            />
            <span className="flex-1">
              {layer.title}
              <span className="block text-[10px] leading-snug text-ink/55">
                {layer.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {current ? (
        <>
          <Colourbar layer={current} ramp={ramp ?? current.ramp} />

          <div className="space-y-2">
            <Slider
              id="rendered-opacity"
              label="Opacity"
              value={Math.round(opacity * 100)}
              suffix="%"
              min={10}
              max={100}
              onChange={(v) => setOpacity(v / 100)}
            />
            {current.relief ? (
              <Slider
                id="rendered-exaggeration"
                label="Relief"
                value={Math.round(exaggeration * 10)}
                suffix="×"
                display={(v) => (v / 10).toFixed(1)}
                min={5}
                max={40}
                onChange={(v) => setExaggeration(v / 10)}
              />
            ) : null}
          </div>

          {current.signed ? (
            <p className="text-[11px] leading-snug text-ink/55">
              Drawn on a diverging ramp centred on zero, which is the only honest
              colouring for a signed quantity: the midpoint has to mean no change.
            </p>
          ) : (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-ink/45">Ramp</span>
            {RAMP_NAMES.filter((n: string) => n !== "difference").map((name: string) => (
              <button
                key={name}
                type="button"
                aria-pressed={(ramp ?? current.ramp) === name}
                onClick={() => setRamp(name === current.ramp ? null : name)}
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize transition ${
                  (ramp ?? current.ramp) === name
                    ? "bg-ink-900 text-white"
                    : "border border-ink/15 text-ink/70 hover:border-accent-600"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          )}

          <p className="text-[11px] leading-snug text-ink/55">
            Drawn from the source raster at the resolution you are viewing, not from a
            picture made earlier.
            {current.logarithmic
              ? " Colour follows a logarithmic scale, so a step up the bar is a multiplication rather than an addition."
              : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * The vertical colourbar A3 asks for: round ticks, labelled in the layer's own
 * unit, with the true extremes at the ends so the bar never implies data outside
 * the range it was stretched across.
 */
function Colourbar({ layer, ramp }: { layer: RenderedLayer; ramp: string }) {
  /*
   * `signed` has to travel with the ramp, and forgetting it is not a cosmetic
   * slip: `rampFor` refuses a diverging ramp for an unsigned quantity, so this
   * threw for the difference layer and the error boundary took the whole map
   * panel down with it. Found the first time the layer was switched on.
   */
  const data = legend({
    ramp,
    min: layer.min,
    max: layer.max,
    unit: layer.unit,
    label: layer.title,
    signed: Boolean(layer.signed),
  }) as {
    swatches: { t: number; colour: string; value: number }[];
    ticks: number[];
  };

  // Bottom to top, because that is the way an elevation bar is read.
  const gradient = `linear-gradient(to top, ${data.swatches
    .map((s) => `${s.colour} ${(s.t * 100).toFixed(1)}%`)
    .join(", ")})`;

  const position = (value: number) =>
    layer.max > layer.min ? ((value - layer.min) / (layer.max - layer.min)) * 100 : 0;

  const decimals = layer.max - layer.min < 5 ? 2 : layer.max - layer.min < 50 ? 1 : 0;

  return (
    <figure className="flex gap-2" aria-label={`Legend for ${layer.title}`}>
      <div
        className="h-32 w-4 shrink-0 rounded-sm border border-ink/15"
        style={{ background: gradient }}
        role="img"
        aria-label={`${layer.title} from ${layer.min.toFixed(decimals)} to ${layer.max.toFixed(decimals)} ${layer.unit}`}
      />
      <div className="relative h-32 flex-1">
        {data.ticks.map((tick) => (
          <div
            key={tick}
            className="absolute left-0 flex -translate-y-1/2 items-center gap-1"
            style={{ bottom: `${position(tick)}%` }}
          >
            <span className="h-px w-1.5 bg-ink/30" />
            <span className="font-mono text-[10px] text-ink/60">
              {tick.toFixed(decimals)}
              {layer.unit ? ` ${layer.unit}` : ""}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  suffix,
  display,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  display?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[10px] uppercase tracking-wide text-ink/45">
          {label}
        </label>
        <span aria-hidden className="font-mono text-[10px] text-ink/45">
          {display ? display(value) : value}
          {suffix}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 w-full cursor-pointer accent-accent-600"
      />
    </div>
  );
}
