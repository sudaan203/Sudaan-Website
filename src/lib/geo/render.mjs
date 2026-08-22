/**
 * Turning an elevation grid into a picture of terrain.
 *
 * ## What was wrong with the pictures we had
 *
 * `docs/dashboard-tools-plan.md` A3 names three reasons the DSM did not show
 * trees: a single-hue ramp stretched across the 2nd to 98th percentile has
 * almost no local contrast, the hillshade was a separate toggleable layer rather
 * than being composited *under* the colour, and resolution was lost to a
 * pre-baked pyramid.
 *
 * The third is fixed by rendering from the source raster through a windowed
 * read. The first two are fixed here: colour across the true minimum and
 * maximum, and multiply the relief into it so the shading shapes the colour
 * instead of greying it out.
 *
 * ## Hillshade, and the sign conventions that make it wrong
 *
 * Horn's method, which is the same 3x3 kernel `slopeDegrees` already uses, so a
 * shaded slope and a measured slope cannot disagree.
 *
 * Two conventions have to be stated or they will be guessed differently by the
 * next person:
 *
 * - **Rows increase southward.** A raster's first row is its northern edge, so
 *   `dz/drow` is the gradient going south, and the northward gradient is its
 *   negation. Getting this backwards produces a hillshade lit from the
 *   south-east: it looks like terrain, and every ridge reads as a valley.
 * - **Azimuth is compass bearing**, clockwise from north, so the conversion to
 *   the mathematical angle used by the cosine is `90 - azimuth`, not `azimuth`.
 *
 * The default sun is azimuth 315 and altitude 45, which is A3's specification
 * and also the convention every GIS ships, precisely because the eye reads
 * relief correctly only when the light comes from the upper left.
 */

import { sampleRamp } from "./colour.mjs";

const DEG = Math.PI / 180;

/**
 * Relief shading in 0..1, one value per cell.
 *
 * `zFactor` scales elevation against horizontal distance and must be 1 in a
 * projected CRS, where both are already metres. It exists for the case where a
 * grid is in degrees, and in that case a hillshade is wrong for other reasons
 * too.
 *
 * `exaggeration` is the honest knob: it multiplies the gradient before the
 * lighting, so relief can be made legible on flat ground without pretending the
 * slope is steeper than it is anywhere a number is reported.
 */
export function hillshade(
  grid,
  { azimuth = 315, altitude = 45, zFactor = 1, exaggeration = 1.6 } = {},
) {
  const { width, height, cellSize } = grid;
  const out = new Float32Array(width * height);

  const zenith = (90 - altitude) * DEG;
  // Compass bearing to the mathematical angle the cosine below expects.
  const sun = (90 - azimuth) * DEG;
  const cosZenith = Math.cos(zenith);
  const sinZenith = Math.sin(zenith);

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const centre = grid.data[i];
      if (grid.isNoData(centre)) {
        out[i] = NaN;
        continue;
      }

      // Clamped at the edges, and nodata neighbours fall back to the centre, so
      // a ragged survey edge does not produce a cliff of invented shadow.
      const z = (dc, dr) => {
        const c = Math.min(width - 1, Math.max(0, col + dc));
        const r = Math.min(height - 1, Math.max(0, row + dr));
        const v = grid.data[r * width + c];
        return grid.isNoData(v) ? centre : v;
      };

      const dzdx =
        ((z(1, -1) + 2 * z(1, 0) + z(1, 1) - z(-1, -1) - 2 * z(-1, 0) - z(-1, 1)) /
          (8 * cellSize)) *
        zFactor *
        exaggeration;
      // Rows increase southward, so this is the gradient going south; negate it
      // to get the northward gradient the lighting expects.
      const dzdsouth =
        ((z(-1, 1) + 2 * z(0, 1) + z(1, 1) - z(-1, -1) - 2 * z(0, -1) - z(1, -1)) /
          (8 * cellSize)) *
        zFactor *
        exaggeration;
      const dzdy = -dzdsouth;

      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      /*
       * Aspect is the direction the ground **faces**, which is downhill: the
       * negated gradient, as a mathematical angle with east at zero.
       *
       * Using the uphill direction instead puts every aspect 180 degrees out.
       * That is not a subtle error, but it hides well: the east-west component
       * of the lighting stays correct because the sun's own angle is measured
       * the same wrong way round, so only the north-south component inverts, and
       * a north-west sun then lights north-west and south-east slopes
       * identically. The picture still looks like terrain. It was caught here
       * only because the test lights four plane surfaces whose answers are known
       * before the code runs.
       */
      const aspect = Math.atan2(-dzdy, -dzdx);

      const shade =
        cosZenith * Math.cos(slope) + sinZenith * Math.sin(slope) * Math.cos(sun - aspect);
      out[i] = Math.min(1, Math.max(0, shade));
    }
  }
  return out;
}

/**
 * Colour a grid, optionally with relief multiplied through it.
 *
 * Returns RGBA bytes, row major from the top left, ready for `encodePng`.
 *
 * Nodata is transparent rather than any colour at all. Painting it black would
 * put a hard edge around every survey; painting it the bottom of the ramp would
 * claim the ground is at the lowest elevation in the file, which is worse: it is
 * a plausible reading of real terrain.
 */
/**
 * @param {any} grid
 * @param {{ stops: number[][], min: number, max: number,
 *           relief?: Float32Array | null, shadeFloor?: number,
 *           shadeCeiling?: number, opacity?: number }} options
 */
export function renderGrid(
  grid,
  {
    stops,
    min,
    max,
    relief = null,
    /**
     * How hard the shading bites. A3 asks for the hillshade normalised to
     * roughly 0.4 to 1.2 gain, which is what this range does: fully lit ground
     * is brightened slightly and deep shadow darkens to 40%, so the colour still
     * reads through it. A plain multiply by the raw 0..1 shade would take the
     * whole image to half brightness and grey out the ramp, which is the mistake
     * the previous render made.
     */
    shadeFloor = 0.4,
    shadeCeiling = 1.2,
    opacity = 1,
  },
) {
  const { width, height } = grid;
  const rgba = new Uint8Array(width * height * 4);
  const span = max - min;
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255);

  for (let i = 0; i < width * height; i += 1) {
    const value = grid.data[i];
    if (grid.isNoData(value) || !Number.isFinite(value)) continue; // transparent

    const t = span > 0 ? (value - min) / span : 0.5;
    let [r, g, b] = sampleRamp(stops, t);

    if (relief) {
      const shade = relief[i];
      if (Number.isFinite(shade)) {
        const gain = shadeFloor + (shadeCeiling - shadeFloor) * shade;
        r = Math.min(255, Math.round(r * gain));
        g = Math.min(255, Math.round(g * gain));
        b = Math.min(255, Math.round(b * gain));
      }
    }

    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = alpha;
  }
  return rgba;
}
