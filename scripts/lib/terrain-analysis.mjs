/**
 * Universal tools 1 to 5: the measurements a client operates themselves.
 *
 * Spot level, cross section, grid levels, cut and fill, surface comparison. All
 * five are the same thing underneath, a windowed read of an elevation grid, and
 * building them as one library is what makes them cheap. The UI and the HTTP
 * layer come later and belong in phase 0; this is the part where being wrong
 * matters, so it is the part that gets written first and tested hardest.
 *
 * Three rules run through everything here, from
 * `docs/portal-map-architecture.md` section 6b:
 *
 * 1. **Everything is computed in the grid's projected CRS, never in degrees.**
 *    A polygon drawn on a web map arrives as lon/lat, and computing its area on
 *    those numbers gives square degrees, which is meaningless and varies with
 *    latitude. Callers convert to UTM before they get here, and `Grid` only ever
 *    holds projected metres.
 *
 * 2. **A volume has no meaning without a stated reference surface.** Cut and
 *    fill against what: a flat plane, the polygon's own boundary, a design
 *    surface, or a previous survey? The answer changes completely, so the
 *    reference is a required argument with no default and it is echoed back in
 *    the result.
 *
 * 3. **Every number carries its uncertainty.** Sudaan advertises plus or minus
 *    3 to 4 cm. Over a hectare, 4 cm of systematic error is 400 m3, which can
 *    dwarf the quantity being measured. A volume quoted bare invites a client to
 *    treat it as exact, and that is a commercial risk before it is an accuracy
 *    one.
 */

/**
 * Elevation at an arbitrary point, by bilinear interpolation.
 *
 * Bilinear rather than nearest neighbour, which is what the browser side
 * `dem-sampler.ts` currently does. Nearest returns the value of whichever cell
 * the click happened to land in, so on a 1 m grid a spot level can be half a
 * cell away from where the client pointed. On a 15 degree slope that is 13 cm of
 * error invented by the sampler, three times the survey's own accuracy.
 *
 * Returns null rather than a number where any contributing cell is nodata.
 * Interpolating across the edge of a survey would invent ground, and a hole has
 * to stay a hole.
 */
export function spotLevel(grid, x, y) {
  // Position in cell-centre space: the centre of cell 0 sits at 0.0.
  const fx = (x - grid.originX) / grid.cellSize - 0.5;
  const fy = (grid.originY - y) / grid.cellSize - 0.5;
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const tx = fx - c0;
  const ty = fy - r0;

  const at = (col, row) => {
    if (!grid.inside(col, row)) return null;
    const v = grid.get(col, row);
    return grid.isNoData(v) ? null : v;
  };

  const z00 = at(c0, r0);
  const z10 = at(c0 + 1, r0);
  const z01 = at(c0, r0 + 1);
  const z11 = at(c0 + 1, r0 + 1);
  if (z00 === null || z10 === null || z01 === null || z11 === null) return null;

  const top = z00 * (1 - tx) + z10 * tx;
  const bottom = z01 * (1 - tx) + z11 * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Ray casting point in polygon, in projected coordinates. */
export function pointInPolygon(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shoelace area of a ring in projected units. Always positive. */
export function polygonArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum / 2);
}

/** Perimeter of a ring in projected units. */
export function polygonPerimeter(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  return sum;
}

/**
 * Fraction of a cell that falls inside a polygon.
 *
 * Interior and exterior cells answer 1 and 0 from their corners alone. Only
 * cells the boundary actually crosses are subsampled, which keeps the cost
 * proportional to the perimeter rather than the area.
 *
 * Worth doing rather than the usual "is the cell centre inside" test. That test
 * is wrong by up to half a cell all the way around the edge, and for a long thin
 * polygon, a road corridor or a haul road, the boundary cells can be most of the
 * cells there are.
 */
function cellCoverage(grid, col, row, ring, samples = 4) {
  const x0 = grid.cornerX(col);
  const y0 = grid.cornerY(row);
  const cs = grid.cellSize;
  const corners = [
    pointInPolygon(x0, y0, ring),
    pointInPolygon(x0 + cs, y0, ring),
    pointInPolygon(x0, y0 - cs, ring),
    pointInPolygon(x0 + cs, y0 - cs, ring),
  ];
  if (corners.every(Boolean)) return 1;
  if (!corners.some(Boolean)) {
    // A small polygon can sit entirely inside one cell with every corner outside.
    if (!pointInPolygon(x0 + cs / 2, y0 - cs / 2, ring)) return 0;
  }
  let hits = 0;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x0 + ((sx + 0.5) / samples) * cs;
      const py = y0 - ((sy + 0.5) / samples) * cs;
      if (pointInPolygon(px, py, ring)) hits += 1;
    }
  }
  return hits / (samples * samples);
}

/** Cells whose bounding box could touch the ring. */
function ringWindow(grid, ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    col0: Math.max(0, Math.floor((minX - grid.originX) / grid.cellSize)),
    col1: Math.min(grid.width - 1, Math.ceil((maxX - grid.originX) / grid.cellSize)),
    row0: Math.max(0, Math.floor((grid.originY - maxY) / grid.cellSize)),
    row1: Math.min(grid.height - 1, Math.ceil((grid.originY - minY) / grid.cellSize)),
  };
}

/**
 * Statistics over the terrain inside a polygon.
 *
 * Tool 4's drawing companion: area, perimeter, and the min, max and mean
 * elevation the drawing tools are supposed to report alongside them.
 */
export function polygonStats(grid, ring) {
  const { col0, col1, row0, row1 } = ringWindow(grid, ring);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let weight = 0;
  let nodataWeight = 0;

  for (let row = row0; row <= row1; row += 1) {
    for (let col = col0; col <= col1; col += 1) {
      const f = cellCoverage(grid, col, row, ring);
      if (f === 0) continue;
      const v = grid.get(col, row);
      if (grid.isNoData(v)) { nodataWeight += f; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v * f;
      weight += f;
    }
  }

  const area = polygonArea(ring);
  return {
    area,
    areaHectares: area / 10000,
    perimeter: polygonPerimeter(ring),
    min: weight > 0 ? min : null,
    max: weight > 0 ? max : null,
    mean: weight > 0 ? sum / weight : null,
    coveredArea: weight * grid.cellArea,
    // A polygon straying off the survey is the commonest way a volume comes back
    // confidently wrong, so the gap is reported rather than silently skipped.
    nodataArea: nodataWeight * grid.cellArea,
    complete: nodataWeight === 0,
  };
}

/**
 * Elevation profile along a polyline. Tool 3.
 *
 * Samples at roughly one cell spacing by default, because sampling finer than
 * the grid does not add information, it just makes the chart look smoother than
 * the data is. Returns chainage so the result drops straight into a cross
 * section drawing, and grade as a percentage, which is what a road engineer
 * reads.
 */
export function profile(grid, line, { spacing = grid.cellSize } = {}) {
  const points = [];
  let chainage = 0;

  for (let i = 1; i < line.length; i += 1) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const segment = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(segment / spacing));
    for (let s = i === 1 ? 0 : 1; s <= steps; s += 1) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      points.push({
        chainage: chainage + segment * t,
        easting: x,
        northing: y,
        elevation: spotLevel(grid, x, y),
      });
    }
    chainage += segment;
  }

  const withData = points.filter((p) => p.elevation !== null && Number.isFinite(p.elevation));
  const elevations = withData.map((p) => p.elevation);

  // Gain and loss walk consecutive samples that both have data, so a hole in the
  // survey does not read as a cliff down and a cliff back up.
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1].elevation;
    const b = points[i].elevation;
    if (a === null || b === null) continue;
    const d = b - a;
    if (d > 0) gain += d; else loss -= d;
  }

  // Slope between consecutive samples, in percent and degrees.
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || a.elevation === null || b.elevation === null) { points[i].slopePercent = null; continue; }
    const run = b.chainage - a.chainage;
    points[i].slopePercent = run > 0 ? ((b.elevation - a.elevation) / run) * 100 : null;
  }

  return {
    points,
    length: chainage,
    sampleSpacing: spacing,
    min: elevations.length ? Math.min(...elevations) : null,
    max: elevations.length ? Math.max(...elevations) : null,
    gain,
    loss,
    // Straight line grade end to end, which is not the same as the steepest
    // section and should never be labelled "maximum".
    gradePercent:
      withData.length >= 2 && chainage > 0
        ? ((withData[withData.length - 1].elevation - withData[0].elevation) / chainage) * 100
        : null,
    maxSlopePercent: points.reduce(
      (m, p) => (p.slopePercent === null ? m : Math.max(m, Math.abs(p.slopePercent))),
      0,
    ),
    samplesWithoutData: points.length - withData.length,
  };
}

/**
 * A grid of spot levels inside a polygon. Tool 2.
 *
 * The grid snaps to whole multiples of the spacing in the projected CRS, rather
 * than starting from the polygon's own corner. That is what makes two adjacent
 * areas requested at 1 m line up with each other, and what makes a re-run at the
 * same spacing reproduce the same points, which a client checking a delivery
 * will expect.
 *
 * `maxPoints` exists because 0.5 m over 100 hectares is four million points, and
 * the honest failure there is a refusal with the number in it, not a browser
 * running out of memory.
 */
export function gridLevels(grid, ring, spacing, { maxPoints = 250000 } = {}) {
  if (!(spacing > 0)) throw new Error("gridLevels: spacing must be positive");

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const startX = Math.ceil(minX / spacing) * spacing;
  const startY = Math.ceil(minY / spacing) * spacing;
  const estimate =
    (Math.floor((maxX - startX) / spacing) + 1) * (Math.floor((maxY - startY) / spacing) + 1);
  if (estimate > maxPoints) {
    throw new Error(
      `gridLevels: ${spacing} m spacing over this polygon is about ${estimate.toLocaleString()} ` +
        `points, over the ${maxPoints.toLocaleString()} limit. Use a coarser spacing or a ` +
        `smaller area.`,
    );
  }

  const points = [];
  let outside = 0;
  for (let y = startY; y <= maxY + 1e-9; y += spacing) {
    for (let x = startX; x <= maxX + 1e-9; x += spacing) {
      if (!pointInPolygon(x, y, ring)) continue;
      const z = spotLevel(grid, x, y);
      if (z === null) { outside += 1; continue; }
      points.push({ easting: x, northing: y, elevation: z });
    }
  }
  return { points, spacing, pointsOutsideSurvey: outside };
}

/**
 * Reference surfaces a volume can be measured against.
 *
 * Deliberately an explicit union rather than an optional argument. Cut and fill
 * against a flat plane, against the polygon's own rim, and against a design
 * surface are three different questions with three different answers, and the
 * UI has to make the client choose rather than defaulting silently to whichever
 * was easiest to implement.
 */
export const REFERENCE = {
  /** A horizontal plane at a stated elevation. */
  plane: (elevation) => ({ kind: "plane", elevation, at: () => elevation }),

  /**
   * The best fit plane through the terrain on the polygon boundary, which is the
   * usual meaning of "level this site to its surroundings".
   */
  boundaryPlane: (grid, ring) => {
    // Least squares z = ax + by + c over samples along the rim. Coordinates are
    // centred first: raw UTM eastings are around 3.4e5 and their squares around
    // 1.2e11, which loses most of the precision in the normal equations.
    const samples = [];
    const step = grid.cellSize;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.round(len / step));
      for (let s = 0; s < n; s += 1) {
        const t = s / n;
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        const z = spotLevel(grid, x, y);
        if (z !== null) samples.push([x, y, z]);
      }
    }
    if (samples.length < 3) {
      throw new Error("boundaryPlane: fewer than 3 boundary samples carry elevation");
    }
    const mx = samples.reduce((s, p) => s + p[0], 0) / samples.length;
    const my = samples.reduce((s, p) => s + p[1], 0) / samples.length;
    const mz = samples.reduce((s, p) => s + p[2], 0) / samples.length;

    let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
    for (const [x, y, z] of samples) {
      const dx = x - mx;
      const dy = y - my;
      const dz = z - mz;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * dz; syz += dy * dz;
    }
    const det = sxx * syy - sxy * sxy;
    const a = Math.abs(det) < 1e-9 ? 0 : (sxz * syy - syz * sxy) / det;
    const b = Math.abs(det) < 1e-9 ? 0 : (syz * sxx - sxz * sxy) / det;
    return {
      kind: "boundaryPlane",
      samples: samples.length,
      at: (x, y) => mz + a * (x - mx) + b * (y - my),
    };
  },

  /** A second elevation grid: a design surface, or an earlier survey. */
  surface: (other) => ({
    kind: "surface",
    at: (x, y) => spotLevel(other, x, y),
  }),
};

/**
 * Cut and fill inside a polygon against a stated reference. Tool 4.
 *
 * Sign convention, stated because half the arguments about earthwork quantities
 * are really arguments about this: **cut** is ground standing above the
 * reference, material that has to come out. **Fill** is ground below it, the
 * void that has to be made up. Net is cut minus fill, so a positive net means a
 * site with material to export.
 *
 * The uncertainty is deliberately the systematic figure and not the random one.
 * Random error averages away: at 10 cm cells over a hectare it is under a cubic
 * metre and irrelevant. Systematic error does not: a survey biased 4 cm high
 * over a hectare is 400 m3 out, and that is the number that turns up in a
 * dispute.
 */
export function cutFill(grid, ring, reference, { rmseZ = null } = {}) {
  if (!reference || typeof reference.at !== "function") {
    throw new Error(
      "cutFill: a reference surface is required. A volume against an unstated " +
        "reference is not a measurement. Use REFERENCE.plane, .boundaryPlane or .surface.",
    );
  }

  const { col0, col1, row0, row1 } = ringWindow(grid, ring);
  let cut = 0;
  let fill = 0;
  let cutArea = 0;
  let fillArea = 0;
  let weight = 0;
  let nodataWeight = 0;
  let referenceMissing = 0;
  let maxCut = 0;
  let maxFill = 0;

  for (let row = row0; row <= row1; row += 1) {
    for (let col = col0; col <= col1; col += 1) {
      const f = cellCoverage(grid, col, row, ring);
      if (f === 0) continue;
      const z = grid.get(col, row);
      if (grid.isNoData(z)) { nodataWeight += f; continue; }

      const x = grid.xOf(col);
      const y = grid.yOf(row);
      const ref = reference.at(x, y);
      if (ref === null || !Number.isFinite(ref)) { referenceMissing += f; continue; }

      const d = z - ref;
      const area = f * grid.cellArea;
      weight += f;
      if (d > 0) { cut += d * area; cutArea += area; if (d > maxCut) maxCut = d; }
      else if (d < 0) { fill += -d * area; fillArea += area; if (-d > maxFill) maxFill = -d; }
    }
  }

  const measuredArea = weight * grid.cellArea;
  return {
    reference: reference.kind,
    cut,
    fill,
    net: cut - fill,
    cutArea,
    fillArea,
    measuredArea,
    polygonArea: polygonArea(ring),
    maxCutDepth: maxCut,
    maxFillDepth: maxFill,
    meanDepth: measuredArea > 0 ? (cut - fill) / measuredArea : null,
    // Both are reported because a partly covered polygon still returns a
    // plausible number, and the client has to be told it is partial.
    nodataArea: nodataWeight * grid.cellArea,
    referenceMissingArea: referenceMissing * grid.cellArea,
    complete: nodataWeight === 0 && referenceMissing === 0,
    // Plus or minus, in cubic metres, from a stated vertical accuracy.
    uncertainty: rmseZ === null ? null : rmseZ * measuredArea,
    rmseZ,
    computedIn: grid.epsg ? `EPSG:${grid.epsg}` : "projected metres",
  };
}

/**
 * Difference between two elevation grids. Tool 5.
 *
 * Requires the same grid, rather than resampling one onto the other, because a
 * silent resample is where a change detection quietly becomes a measurement of
 * the interpolation. Callers align first and are told if they did not.
 */
export function surfaceDifference(newer, older) {
  if (
    newer.width !== older.width ||
    newer.height !== older.height ||
    Math.abs(newer.cellSize - older.cellSize) > newer.cellSize / 1000 ||
    Math.abs(newer.originX - older.originX) > newer.cellSize / 1000 ||
    Math.abs(newer.originY - older.originY) > newer.cellSize / 1000
  ) {
    throw new Error(
      "surfaceDifference: the two surfaces are not on the same grid. Resample one " +
        "onto the other first, deliberately, rather than having it happen here.",
    );
  }

  const diff = newer.like(Float32Array, 0, -99999);
  let rise = 0;
  let drop = 0;
  let cells = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < newer.length; i += 1) {
    const a = newer.data[i];
    const b = older.data[i];
    if (newer.isNoData(a) || older.isNoData(b)) { diff.data[i] = diff.nodata; continue; }
    const d = a - b;
    diff.data[i] = d;
    cells += 1;
    if (d > 0) rise += d; else drop -= d;
    if (d < min) min = d;
    if (d > max) max = d;
  }

  const cellArea = newer.cellArea;
  return {
    grid: diff,
    volumeGained: rise * cellArea,
    volumeLost: drop * cellArea,
    netVolume: (rise - drop) * cellArea,
    comparedArea: cells * cellArea,
    minChange: cells ? min : null,
    maxChange: cells ? max : null,
    meanChange: cells ? (rise - drop) / cells : null,
  };
}
