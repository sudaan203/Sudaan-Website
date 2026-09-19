/**
 * One way to turn an elevation grid into a picture.
 *
 * ## Why this module exists
 *
 * Every renderer in this repository had independently grown its own answer to
 * the same three questions — which ramp, which percentile clip, which
 * hillshade — and they had drifted apart:
 *
 * | Renderer                    | Ramp           | Relief                    |
 * |-----------------------------|----------------|---------------------------|
 * | `prepare-site.mjs` tiles    | shared rainbow | `render.mjs`, correct     |
 * | the dynamic tiler           | shared rainbow | `render.mjs`, correct     |
 * | `make-site-previews.mjs`    | inline sepia   | its own, lit from the SE  |
 * | `process-dem.mjs`           | inline sepia   | its own, different again  |
 * | `prepare-map-data.mjs`      | inline sepia   | none at all               |
 *
 * So the preview thumbnail a client saw first and the map they opened next were
 * two different pictures of the same ground, and `make-site-previews.mjs` said
 * in a comment that its stops were "the same stops as prepare-site.mjs" — true
 * when it was written, false ever since `prepare-site.mjs` moved to the shared
 * ramp and nobody updated the copy.
 *
 * That is not a bug to fix three times. Fixing it three times is what produced
 * it. A renderer should not be able to *have* an opinion about elevation
 * colour, so this module holds the only one and every baker calls it.
 *
 * ## The two things that were actually wrong, not just inconsistent
 *
 * `make-site-previews.mjs` computed its north-south gradient as (south row)
 * minus (north row) and used it directly, without the negation `render.mjs`
 * documents at length. That is the "lit from the south-east" error: the image
 * still looks like terrain, which is why it survived review, but every ridge
 * reads as a valley.
 *
 * `prepare-map-data.mjs` passed the native cell size for a grid it had already
 * decimated, so its relief — when it had any — read gradients several times
 * shallower than the ground. `cellSize` here is required and must describe the
 * grid actually being shaded, not the raster it came from.
 */

import { rampFor } from "./colour.mjs";
import { hillshade, renderGrid } from "./render.mjs";

/**
 * The elevation ramp, for every representation of height in the product.
 *
 * `docs/dashboard-tools-plan.md` A3 specifies it and Malhar's reference image
 * shows it. It is exported as a name rather than as stops so that a caller
 * cannot pass it to a signed quantity: `rampFor` refuses that combination, and
 * a cut-and-fill or a surface difference must stay diverging and centred.
 */
export const ELEVATION_RAMP = "rainbow";

/**
 * The ramp for the forest CHM (canopy height model), registered here rather
 * than as a literal in the render route or `forest-source.ts`, because this
 * module is the one place a ramp is allowed to be decided — `docs/forest-
 * tools-plan.md` §4 and the CI check in `colour-consistency-test.mjs` both say
 * so, and a name defined beside a `LAYERS` table elsewhere is exactly the
 * "copied correctly, then the original moved" failure that check exists to
 * catch.
 *
 * Deliberately the *same* ramp as `ELEVATION_RAMP` rather than a new one. A CHM
 * is a height quantity like a DTM or DSM — 0 m at the ground up to Ektanagar
 * 1's ~26 m canopy rather than 0 m up to a summit — and inventing a second
 * "height ramp" table would only invite the two to drift the way the five
 * pre-this-module renderers did. It gets its own name, not a bare reuse of
 * `ELEVATION_RAMP`, so a reader can tell the choice was made rather than
 * copied, and so revisiting it later (a CHM is unsigned but arguably wants a
 * ramp that reads as "vegetation" rather than "terrain") is a one-line change
 * here rather than a hunt through every caller.
 */
export const CHM_RAMP = ELEVATION_RAMP;

/**
 * The sun, everywhere.
 *
 * Upper left is not a preference. The eye reads relief correctly only when the
 * light comes from the upper left, which is why every GIS ships this default,
 * and two images of one site lit from different corners cannot be compared.
 */
export const SUN = Object.freeze({ azimuth: 315, altitude: 45, exaggeration: 1.6 });

/** Percentile clip, as A3 asks for: colour across the middle of the spread. */
export const CLIP = Object.freeze({ low: 0.02, high: 0.98 });

/**
 * Copy a possibly-strided decoder output into a dense grid, marking nodata NaN.
 *
 * `sharp(...).raw({ depth: "float" })` returns interleaved channels for a
 * multi-band file, so `data[i]` is not pixel `i` unless the stride is 1.
 * Hillshade reads eight neighbours per pixel, and at a stride of anything but
 * one it would silently sample the wrong ones — a picture that is plausible and
 * wrong, which is the worst kind. Densifying once, here, is cheaper than every
 * caller remembering.
 *
 * @param {Float32Array} all raw decoder output, possibly interleaved
 * @param {{ pixels: number, stride?: number, isValid: (v: number) => boolean }} options
 * @returns {Float32Array} one value per pixel, NaN where there is no data
 */
export function denseFloats(all, { pixels, stride = 1, isValid }) {
  const dense = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const v = all[i * stride];
    dense[i] = isValid(v) ? v : NaN;
  }
  return dense;
}

/**
 * The range to colour across: true extremes, and the percentile clip to use.
 *
 * Both are returned because both are needed and they mean different things. The
 * clip is what the picture is stretched across, so one wild value cannot flatten
 * a survey into a single shade. The true minimum and maximum are what a legend
 * or a summary must report, because a client comparing our stated range against
 * their own processing is comparing the real one.
 *
 * @param {Float32Array} dense NaN for nodata
 * @param {{ maxSamples?: number }} [options]
 */
export function elevationRange(dense, { maxSamples = 200000 } = {}) {
  let min = Infinity;
  let max = -Infinity;
  let covered = 0;
  const sample = [];
  const step = Math.max(1, Math.floor(dense.length / maxSamples));

  for (let i = 0; i < dense.length; i += 1) {
    const v = dense[i];
    if (!Number.isFinite(v)) continue;
    covered += 1;
    if (v < min) min = v;
    if (v > max) max = v;
    if (i % step === 0) sample.push(v);
  }
  if (covered === 0) return null;

  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * CLIP.low)] ?? min;
  const hi = sample[Math.floor(sample.length * CLIP.high)] ?? max;
  return { min, max, lo, hi, covered, coverage: covered / dense.length };
}

/**
 * An elevation grid as RGBA bytes: the ramp, the clip and the relief, once.
 *
 * Nodata stays fully transparent rather than taking any colour at all. Black
 * would put a hard edge around every survey, and the bottom of the ramp would
 * claim the ground is at the lowest elevation in the file — a plausible reading
 * of real terrain, and therefore a lie a client cannot catch.
 *
 * @param {Float32Array} dense one value per pixel, NaN for nodata
 * @param {{ width: number, height: number, cellSize: number, flat?: boolean,
 *           opacity?: number, range?: { lo: number, hi: number } }} options
 *   `cellSize` is metres per cell **of this grid**. A decimated overview must
 *   pass its own spacing, not the source raster's, or the relief is wrong by
 *   exactly the decimation factor.
 *
 *   `flat` draws the ramp with no relief at all, for the one honest case: a
 *   raster with no georeferencing, where the cell size is unknown. Colour is
 *   still correct without it, whereas relief against a guessed spacing is
 *   confidently wrong, and a reader cannot tell which they are looking at.
 * @returns {{ rgba: Buffer, width: number, height: number,
 *             min: number, max: number, lo: number, hi: number,
 *             covered: number, coverage: number } | null} null when the grid
 *   holds no usable elevations, which is a condition to report rather than throw
 *   on: a survey folder can legitimately contain an empty or all-nodata raster.
 */
export function renderElevation(
  dense,
  { width, height, cellSize, flat = false, opacity = 1, range = null },
) {
  if (!flat && (!Number.isFinite(cellSize) || cellSize <= 0)) {
    throw new Error(
      `renderElevation: cellSize must be the metres per cell of this grid, got ${cellSize}. ` +
        "A defaulted cell size exaggerates every slope by the factor it is wrong by, " +
        "and the result looks entirely convincing.",
    );
  }

  const stats = elevationRange(dense);
  if (!stats) return null;
  const lo = range?.lo ?? stats.lo;
  const hi = range?.hi ?? stats.hi;

  const grid = {
    width,
    height,
    data: dense,
    cellSize,
    isNoData: (v) => !Number.isFinite(v),
  };

  const relief = flat ? null : hillshade(grid, SUN);
  const shaded = renderGrid(grid, {
    stops: rampFor(ELEVATION_RAMP),
    min: lo,
    max: hi,
    relief,
    opacity,
  });

  return {
    rgba: Buffer.from(shaded.buffer, shaded.byteOffset, shaded.byteLength),
    width,
    height,
    ...stats,
    lo,
    hi,
  };
}
