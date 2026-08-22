/**
 * Colour ramps, and the rules about which one is allowed where.
 *
 * ## The rainbow question, decided rather than avoided
 *
 * `docs/dashboard-tools-plan.md` A3 asks for the classic elevation rainbow,
 * blue through cyan, green, yellow and orange to red, because that is what
 * Malhar's reference image shows and what a surveyor reads without a key.
 *
 * A rainbow is also perceptually non-uniform: equal steps in elevation are not
 * equal steps in apparent brightness, so it manufactures edges where the terrain
 * is smooth and hides real breaks where it is not. Both things are true, so the
 * resolution is not to pick a side but to bound it:
 *
 * - **rainbow** is the default for elevation, because he asked and it reads
 * - **viridis** and **terrain** sit beside it for anyone who wants honesty
 * - **rainbow is refused outright for signed quantities.** Cut and fill, or a
 *   surface difference, must use a diverging ramp centred on zero, because the
 *   one thing that must survive the colour choice is the sign, and a rainbow
 *   destroys it: -2 m and +2 m land on unrelated hues with no visual centre.
 *
 * `rampFor` enforces that last rule so a caller cannot ask for the wrong thing.
 */

/** Stops as [position 0..1, r, g, b]. Interpolated linearly in sRGB. */
const STOPS = {
  /** The classic elevation rainbow, as A3 specifies it. */
  rainbow: [
    [0.0, 46, 74, 158],
    [0.2, 45, 158, 190],
    [0.4, 92, 178, 96],
    [0.6, 226, 210, 92],
    [0.8, 226, 140, 60],
    [1.0, 178, 40, 34],
  ],
  /** Perceptually uniform, and the right default for anything but elevation. */
  viridis: [
    [0.0, 68, 1, 84],
    [0.25, 59, 82, 139],
    [0.5, 33, 145, 140],
    [0.75, 94, 201, 98],
    [1.0, 253, 231, 37],
  ],
  /** Low ground green through upland brown to rock and snow. */
  terrain: [
    [0.0, 86, 130, 84],
    [0.35, 168, 175, 108],
    [0.6, 168, 133, 92],
    [0.85, 140, 118, 110],
    [1.0, 245, 245, 245],
  ],
  /**
   * Diverging, centred on the midpoint. Blue is below, red is above, and the
   * centre is deliberately near-white so zero is visible as zero.
   */
  difference: [
    [0.0, 33, 102, 172],
    [0.25, 103, 169, 207],
    [0.5, 247, 247, 247],
    [0.75, 214, 96, 77],
    [1.0, 178, 24, 43],
  ],
  /** Water depth and accumulation: pale where there is little, dark where much. */
  water: [
    [0.0, 222, 235, 247],
    [0.35, 158, 202, 225],
    [0.7, 49, 130, 189],
    [1.0, 8, 48, 107],
  ],
};

export const RAMP_NAMES = Object.freeze(Object.keys(STOPS));

/** Ramps that carry a sign and must stay centred. */
const DIVERGING = new Set(["difference"]);

/**
 * Pick a ramp by name for a given quantity, refusing combinations that would
 * misrepresent the data.
 *
 * @param {string} name
 * @param {{ signed?: boolean }} [options] signed quantities are differences,
 *   cut and fill, anything where zero is a meaningful centre.
 */
export function rampFor(name, { signed = false } = {}) {
  const key = STOPS[name] ? name : signed ? "difference" : "rainbow";
  if (signed && !DIVERGING.has(key)) {
    throw new Error(
      `colour: "${key}" is a sequential ramp and this quantity is signed. ` +
        "A difference coloured with a rainbow loses the one thing that matters about it, " +
        "which is whether it is above or below zero. Use \"difference\".",
    );
  }
  if (!signed && DIVERGING.has(key)) {
    throw new Error(
      `colour: "${key}" is diverging and centres on a midpoint that means nothing here. ` +
        "Use a sequential ramp for an unsigned quantity.",
    );
  }
  return STOPS[key];
}

/**
 * Colour at a position along a ramp.
 *
 * `t` is clamped rather than wrapped: a value above the stated maximum is drawn
 * as the top of the ramp, which reads as "at least this", where wrapping would
 * draw the highest ground in the colour of the lowest.
 */
export function sampleRamp(stops, t) {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  for (let i = 1; i < stops.length; i += 1) {
    const [p1, r1, g1, b1] = stops[i];
    if (x <= p1 || i === stops.length - 1) {
      const [p0, r0, g0, b0] = stops[i - 1];
      const span = p1 - p0;
      const f = span <= 0 ? 0 : Math.min(1, Math.max(0, (x - p0) / span));
      return [
        Math.round(r0 + (r1 - r0) * f),
        Math.round(g0 + (g1 - g0) * f),
        Math.round(b0 + (b1 - b0) * f),
      ];
    }
  }
  const [, r, g, b] = stops[0];
  return [r, g, b];
}

/**
 * Round tick values across a range, for the vertical colourbar A3 asks for.
 *
 * Ticks land on 1, 2, 2.5 or 5 times a power of ten, which is what makes a
 * legend readable: a bar labelled 337.14, 351.68, 366.22 is technically correct
 * and useless. The ends are the true minimum and maximum, so the bar never
 * implies data outside the range it was stretched across.
 */
export function legendTicks(min, max, target = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const raw = (max - min) / Math.max(2, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const step =
    magnitude * (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10);

  const ticks = [];
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max + step * 1e-9; v += step) {
    // Snap away the floating point dust that repeated addition accumulates,
    // otherwise a legend reads 350.00000000000006.
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

/**
 * A legend as data, not as a picture.
 *
 * The plan asks for legends "built as data rather than hardcoded, with dynamic
 * ranges", so this returns the swatches and the ticks and lets the client draw
 * them. A PNG legend cannot be restyled, cannot be read by a screen reader, and
 * cannot be copied into a report.
 */
export function legend({ ramp, min, max, unit = "m", label = "", signed = false }) {
  const stops = rampFor(ramp, { signed });
  const swatches = Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    const [r, g, b] = sampleRamp(stops, t);
    return { t, colour: `rgb(${r} ${g} ${b})`, value: min + (max - min) * t };
  });
  return { ramp, unit, label, min, max, signed, swatches, ticks: legendTicks(min, max) };
}
