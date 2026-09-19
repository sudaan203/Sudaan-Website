/**
 * Flooded area and stored volume at any water level, from a table built once.
 *
 * ## Why this is not computed per request
 *
 * A site-wide flood reduces over bands, so it is *answerable* at full
 * resolution — but the reduction reads every cell, and that is 1.6 s on
 * Ektanagar 1, about 28 s on Ektanagar 2 and 96 s on Kiru before the network is
 * involved. A client dragging a water-level slider cannot wait half a minute a
 * step, and it is work repeated for an answer that never changes: area and
 * volume against level is a one-dimensional function of the ground, fixed the
 * moment the survey is published.
 *
 * `scripts/hypsometry-run.mjs` walks the ground once and bins the cells by the
 * level at which each gets wet, carrying two running totals per bin — how many
 * cells, and the sum of their **native** ground elevation. Prefix-summed, a
 * query is a handful of array reads:
 *
 *     area(L)   = cellArea * N(L)
 *     volume(L) = cellArea * (L * N(L) - S(L))
 *
 * The second identity is what makes the table worth having: volume is the sum
 * of `L - dem` over the wet cells, and that separates into `L` times the count
 * minus the sum of the ground. So the level being binned does not bin the
 * depth.
 *
 * ## How exact, precisely
 *
 * Not exact, and the difference is worth stating rather than rounding away. A
 * level lands *inside* a bin, and the cells in that bin are a mixture of ones
 * at or below it and ones just above, so both totals are interpolated across
 * the bin rather than stepped to its edge. Interpolating rather than stepping
 * is worth about fifty times on area.
 *
 * Measured against the per-cell walk it replaces, on Kotba at 1 cm bins, across
 * nine levels spanning the survey's relief:
 *
 *     area    worst 0.0018%, typically under 0.001%
 *     volume  worst 0.00002%
 *
 * On a 2.2 ha flood that worst case is 0.4 m² — four hundred times smaller than
 * the survey's own stated accuracy would move the same figure. The comparison
 * that matters is not against arithmetic, it is against what the ground is
 * known to.
 */


/**
 * @typedef {{ lo: number, binM: number, bins: number, n: number[], s: number[],
 *             m: (number|null)[] }} HypsometricTable
 * @typedef {{ cellArea: number, surveyedCells: number, threshold: HypsometricTable|null,
 *             rising: HypsometricTable|null, spillCellSize: number|null }} Hypsometry
 */

/**
 * Interpolated cumulative totals at a level.
 *
 * Clamped at both ends on purpose: below the table nothing is wet, and above it
 * everything the table knows about is, which is the truthful answer rather than
 * an extrapolation into ground the survey does not cover.
 */
function lowestGroundAt(table, level) {
  if (!(level > table.lo)) return null;
  const bin = Math.min(table.bins - 1, Math.floor((level - table.lo) / table.binM));
  const m = table.m?.[bin];
  return typeof m === "number" ? m : null;
}

function totalsAt(table, level) {
  if (!(level > table.lo)) return { n: 0, s: 0 };
  const position = (level - table.lo) / table.binM;
  if (position >= table.bins) {
    return { n: table.n[table.bins - 1], s: table.s[table.bins - 1] };
  }
  const bin = Math.floor(position);
  const fraction = position - bin;
  const n0 = bin > 0 ? table.n[bin - 1] : 0;
  const s0 = bin > 0 ? table.s[bin - 1] : 0;
  return {
    n: n0 + fraction * (table.n[bin] - n0),
    s: s0 + fraction * (table.s[bin] - s0),
  };
}

/**
 * Area and volume at one level, in the shape the flood panel already reads.
 *
 * `maxDepth_m` comes from a third accumulator rather than from the other two.
 * Deepest water is `level - the lowest wet ground`, and a minimum does not
 * decompose into per-bin totals the way a sum does — so the table carries a
 * prefix-minimised lowest ground per bin, and this reads it.
 *
 * It is stepped to the bin rather than interpolated, because a minimum inside a
 * partial bin is not a weighted average of anything. That makes it exact for
 * every cell in the bins fully below the level and lets in at most one bin — a
 * centimetre — of ground that may not be wet yet. Erring by a centimetre deep
 * rather than reporting nothing at all.
 *
 * @param {Hypsometry} hypsometry
 * @param {HypsometricTable} table
 * @param {number} level
 */
export function figuresAt(hypsometry, table, level) {
  const { n, s } = totalsAt(table, level);
  const area = n * hypsometry.cellArea;
  return {
    level_m: level,
    cells: Math.round(n),
    area_m2: area,
    area_ha: area / 10000,
    area_km2: area / 1e6,
    // Never negative: interpolation across a bin can put the volume a hair
    // under zero at a level barely above the lowest ground, and a negative
    // water volume is not a small error, it is a nonsense one.
    volume_m3: Math.max(0, (level * n - s) * hypsometry.cellArea),
    maxDepth_m: (() => {
      const lowest = lowestGroundAt(table, level);
      if (lowest === null) return null;
      const depth = level - lowest;
      return depth > 0 ? depth : 0;
    })(),
    coverage: hypsometry.surveyedCells > 0 ? n / hypsometry.surveyedCells : null,
  };
}
