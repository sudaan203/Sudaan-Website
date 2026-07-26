/**
 * Makes a raster's flat background transparent, so a survey footprint stops
 * looking like a rectangle.
 *
 * The problem this solves. An orthomosaic footprint is an irregular polygon, but
 * the file holding it is a rectangle, and the processing software fills the
 * difference with a flat colour, usually white. JPEG and ECW carry no alpha
 * channel, so that filler is indistinguishable from real white pixels as far as
 * the format is concerned. `ensureAlpha()` then marks all of it opaque, and the
 * portal draws a white slab over the basemap around every survey.
 *
 * Aektanagar's orthomosaic is 25.8% near-white, and all four corners are pure
 * white. Blanket "white becomes transparent" would be wrong: concrete, roofs and
 * road markings are legitimately near-white, and punching holes through them is a
 * worse artifact than the slab.
 *
 * So the rule is **contiguous with the border**. Filler touches the edge of the
 * image; a white roof in the middle does not. A flood fill inward from the border
 * separates the two without a threshold that has to be tuned per site.
 *
 * The background colour is detected from the corners rather than assumed, so a
 * black filled export works the same way.
 */

/**
 * The flat colour filling the corners, or null if the image reaches its own edges.
 *
 * At least three of the four corners have to agree, which is what distinguishes
 * "there is filler here" from "the imagery covers the whole frame". Requiring all
 * four would miss an export whose footprint happens to touch one corner.
 */
export function detectBackground(rgba, width, height, tolerance = 6) {
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
  };
  const corners = [
    at(0, 0),
    at(width - 1, 0),
    at(0, height - 1),
    at(width - 1, height - 1),
  ];

  let best = null;
  let bestVotes = 0;
  for (const c of corners) {
    const votes = corners.filter(
      (o) =>
        Math.abs(o[0] - c[0]) <= tolerance &&
        Math.abs(o[1] - c[1]) <= tolerance &&
        Math.abs(o[2] - c[2]) <= tolerance,
    ).length;
    if (votes > bestVotes) {
      bestVotes = votes;
      best = c;
    }
  }
  if (bestVotes < 3) return null;

  /**
   * The candidate must look like a sentinel, not like ground.
   *
   * Agreeing corners are not enough on their own. An orthomosaic of dense forest
   * or open water can be near uniform at all four corners, and without this test
   * the fill walks straight through the whole image: a synthetic all green raster
   * had 100% of itself cleared, which the test suite caught.
   *
   * Processing software fills with a sentinel, effectively always white and
   * occasionally black. Real ground is essentially never pure 255 or pure 0 across
   * every channel, so requiring an extreme is what separates "there is filler
   * here" from "this imagery is simply flat".
   */
  const isWhite = best.slice(0, 3).every((c) => c >= 250);
  const isBlack = best.slice(0, 3).every((c) => c <= 5);
  if (!isWhite && !isBlack) return null;

  // Filler is flat by construction. A corner sitting on textured ground would
  // vary between its neighbours, so refuse anything that is not locally uniform.
  const [bx, by] = [Math.min(8, width - 1), Math.min(8, height - 1)];
  const near = at(bx, by);
  const flat =
    Math.abs(near[0] - best[0]) <= tolerance * 3 &&
    Math.abs(near[1] - best[1]) <= tolerance * 3 &&
    Math.abs(near[2] - best[2]) <= tolerance * 3;
  return flat ? [best[0], best[1], best[2]] : null;
}

/**
 * Flood fill the background inward from every edge, setting alpha to 0.
 *
 * Scanline fill rather than per pixel BFS: the stack holds row spans instead of
 * pixels, which keeps it in the thousands rather than the tens of millions on a
 * 120 Mpx raster where a quarter of the image is filler.
 *
 * Returns how many pixels were cleared, so a caller can report it and a caller
 * can notice when a threshold was obviously wrong.
 */
export function clearBorderBackground(rgba, width, height, background, tolerance = 10) {
  const [br, bg, bb] = background;
  const matches = (i) => {
    if (rgba[i * 4 + 3] === 0) return false; // already cleared
    return (
      Math.abs(rgba[i * 4] - br) <= tolerance &&
      Math.abs(rgba[i * 4 + 1] - bg) <= tolerance &&
      Math.abs(rgba[i * 4 + 2] - bb) <= tolerance
    );
  };

  let cleared = 0;
  const stack = [];
  const push = (x, y) => {
    if (y < 0 || y >= height) return;
    stack.push(x, y);
  };

  // Seed from all four edges.
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  while (stack.length) {
    const y = stack.pop();
    const sx = stack.pop();
    let i = y * width + sx;
    if (!matches(i)) continue;

    // Walk left and right to the ends of this run.
    let left = sx;
    while (left > 0 && matches(y * width + left - 1)) left -= 1;
    let right = sx;
    while (right < width - 1 && matches(y * width + right + 1)) right += 1;

    for (let x = left; x <= right; x += 1) {
      i = y * width + x;
      rgba[i * 4 + 3] = 0;
      cleared += 1;
    }

    // Any pixel in the rows above and below that still matches starts a new run.
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      for (let x = left; x <= right; x += 1) {
        if (matches(ny * width + x)) push(x, ny);
      }
    }
  }

  return cleared;
}

/**
 * Detect and clear in one call.
 *
 * `null` means nothing was done, either because the imagery fills its frame or
 * because the corners were not flat enough to trust. Doing nothing is the right
 * answer there: a slab of white is a cosmetic problem, and holes through real
 * imagery are a data problem.
 */
export function maskBorderBackground(rgba, width, height, { tolerance = 10 } = {}) {
  const background = detectBackground(rgba, width, height);
  if (!background) return null;
  const cleared = clearBorderBackground(rgba, width, height, background, tolerance);
  const share = cleared / (width * height);
  return { background, cleared, share };
}
