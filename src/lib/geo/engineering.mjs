/**
 * Contractor, mining and road tools: numbers 11 to 21 of Malhar's specification.
 *
 * Almost all of these are thin over `terrain-analysis.mjs`, and that is the
 * point of having built that first. A stockpile volume is a cut and fill against
 * the pile's own rim. A tolerance map is a surface difference classified into
 * bands. Chainage is a profile sampled at fixed stations. Building the
 * measurement core correctly once is what makes eleven tools cheap rather than
 * eleven separate opportunities to be quietly wrong.
 *
 * Where a tool needs a genuine decision rather than a rearrangement, it is
 * called out in the function. Three worth knowing about before reading:
 *
 * - **Slope classification is unit sensitive and Malhar's documents disagree.**
 *   The hydrology doc says 0-3/3-8/8-15/>15 degrees, `slope legend.txt` says
 *   5/15/30/45, and `Important Notes.txt` says 0-5/5-15/15-25/25+ **percent**.
 *   15 degrees is 27 percent, so these cannot be reconciled and nothing here
 *   picks for him: the bands are an argument, and the unit travels with them.
 *
 * - **A stockpile has no volume without a base.** Same rule as cut and fill: the
 *   reference is the argument, not a default.
 *
 * - **Grade is not the same as steepest grade.** A road that climbs 2 percent end
 *   to end can contain a 9 percent pitch, and only one of those numbers gets a
 *   vehicle stuck. Both are returned, separately named.
 */

import {
  spotLevel,
  profile,
  polygonArea,
  cutFill,
  REFERENCE,
} from "./terrain-analysis.mjs";

// ---------------------------------------------------------------------------
// Tool 14: slope classification, and the unit trap
// ---------------------------------------------------------------------------

/** Slope in percent from slope in degrees. They are not interchangeable. */
export const degreesToPercent = (deg) => Math.tan((deg * Math.PI) / 180) * 100;
export const percentToDegrees = (pct) => (Math.atan(pct / 100) * 180) / Math.PI;

/**
 * The three classifications Malhar has supplied, kept verbatim rather than
 * merged. Whichever he confirms becomes the default; until then the caller must
 * name one, so nobody silently gets somebody else's bands.
 */
export const SLOPE_SCHEMES = {
  /** Hydrology docx, for water storage suitability. */
  hydrology: {
    unit: "degrees",
    source: "2. Hydrology Tool.docx",
    bands: [
      { max: 3, label: "Flat, ideal for water storage", colour: "#22c55e" },
      { max: 8, label: "Gentle slope", colour: "#eab308" },
      { max: 15, label: "Moderate slope", colour: "#f97316" },
      { max: Infinity, label: "Steep terrain", colour: "#ef4444" },
    ],
  },
  /** slope legend.txt, shipped beside the Kherwada data. */
  terrain: {
    unit: "degrees",
    source: "slope legend.txt",
    bands: [
      { max: 5, label: "Gentle slope", colour: "#22c55e" },
      { max: 15, label: "Moderate slope", colour: "#84cc16" },
      { max: 30, label: "Steep slope", colour: "#eab308" },
      { max: 45, label: "Very steep slope", colour: "#f97316" },
      { max: Infinity, label: "Extremely steep slope", colour: "#ef4444" },
    ],
  },
  /** Important Notes.txt item 6, the only one stated in percent. */
  earthwork: {
    unit: "percent",
    source: "Important Notes.txt item 6",
    bands: [
      { max: 5, label: "0 to 5%", colour: "#22c55e" },
      { max: 15, label: "5 to 15%", colour: "#eab308" },
      { max: 25, label: "15 to 25%", colour: "#f97316" },
      { max: Infinity, label: "over 25%", colour: "#ef4444" },
    ],
  },
};

/**
 * Classify a slope raster into bands. Tool 14.
 *
 * `slopeGrid` is always in degrees, because that is what `slopeDegrees` returns
 * and mixing units inside a pipeline is how a slope map ends up plausible and
 * wrong. Conversion happens here, once, when the scheme asks for percent.
 */
export function classifySlope(slopeGrid, schemeName) {
  const scheme = SLOPE_SCHEMES[schemeName];
  if (!scheme) {
    throw new Error(
      `classifySlope: unknown scheme "${schemeName}". Malhar's documents give three ` +
        `different classifications (${Object.keys(SLOPE_SCHEMES).join(", ")}), one of them in ` +
        `percent, and they cannot be reconciled. Pick one explicitly.`,
    );
  }

  const classes = slopeGrid.like(Int16Array, 0, -1);
  const counts = new Array(scheme.bands.length).fill(0);
  let classified = 0;

  for (let i = 0; i < slopeGrid.length; i += 1) {
    const deg = slopeGrid.data[i];
    if (slopeGrid.isNoData(deg)) { classes.data[i] = -1; continue; }
    const value = scheme.unit === "percent" ? degreesToPercent(deg) : deg;
    let band = scheme.bands.findIndex((b) => value <= b.max);
    if (band === -1) band = scheme.bands.length - 1;
    classes.data[i] = band;
    counts[band] += 1;
    classified += 1;
  }

  const cellArea = slopeGrid.cellArea;
  return {
    classes,
    unit: scheme.unit,
    source: scheme.source,
    legend: scheme.bands.map((band, i) => ({
      index: i,
      label: band.label,
      colour: band.colour,
      max: band.max === Infinity ? null : band.max,
      unit: scheme.unit,
      cells: counts[i],
      area: counts[i] * cellArea,
      areaHectares: (counts[i] * cellArea) / 10000,
      share: classified === 0 ? 0 : counts[i] / classified,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool 13: tolerance analysis
// ---------------------------------------------------------------------------

/**
 * Classify a surface against a design to a stated tolerance. Tool 13.
 *
 * `tolerance` is a half band in metres: plus or minus 0.02 for the 20 mm the
 * specification asks for. Three outcomes, and they are not symmetric in what
 * they cost a contractor: material above tolerance has to be cut back, material
 * below has to be brought in and compacted, and only one of those is expensive.
 * So they are counted separately rather than as "out of tolerance".
 *
 * The survey's own accuracy is reported beside the result and not folded into
 * it. A 20 mm tolerance checked with a survey good to plus or minus 40 mm cannot
 * actually resolve the question, and the honest answer is to say so rather than
 * to produce a confident green map.
 */
/**
 * @param {any} surfaceGrid
 * @param {any} referenceGrid
 * @param {number} tolerance
 * @param {{ rmseZ?: number|null }} [options]
 */
export function toleranceAnalysis(surfaceGrid, referenceGrid, tolerance, { rmseZ = null } = {}) {
  if (!(tolerance > 0)) throw new Error("toleranceAnalysis: tolerance must be positive metres");

  const classes = surfaceGrid.like(Int16Array, 0, -9);
  let within = 0;
  let above = 0;
  let below = 0;
  let sumAbs = 0;
  let worstAbove = 0;
  let worstBelow = 0;

  for (let i = 0; i < surfaceGrid.length; i += 1) {
    const a = surfaceGrid.data[i];
    const b = referenceGrid.data[i];
    if (surfaceGrid.isNoData(a) || referenceGrid.isNoData(b)) { classes.data[i] = -9; continue; }
    const d = a - b;
    sumAbs += Math.abs(d);
    if (d > tolerance) { classes.data[i] = 1; above += 1; if (d > worstAbove) worstAbove = d; }
    else if (d < -tolerance) { classes.data[i] = -1; below += 1; if (-d > worstBelow) worstBelow = -d; }
    else { classes.data[i] = 0; within += 1; }
  }

  const cellArea = surfaceGrid.cellArea;
  const total = within + above + below;
  return {
    classes,
    tolerance,
    withinArea: within * cellArea,
    aboveArea: above * cellArea,
    belowArea: below * cellArea,
    comparedArea: total * cellArea,
    withinShare: total === 0 ? 0 : within / total,
    meanAbsoluteDeviation: total === 0 ? null : sumAbs / total,
    worstAbove,
    worstBelow,
    rmseZ,
    // The check is only meaningful if the survey can resolve the tolerance.
    resolvable: rmseZ === null ? null : rmseZ < tolerance,
    note:
      rmseZ !== null && rmseZ >= tolerance
        // "a vertical accuracy of", not "the survey's": see the same note in
        // terrain-analysis.mjs compareSurfaces. The number reaching here may be
        // the company's typical figure rather than a measurement of this ground.
        ? `A vertical accuracy of ${rmseZ} m is not finer than the tolerance ` +
          `(${tolerance} m), so this map cannot distinguish a real deviation from survey noise.`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Tool 15: stockpile volume
// ---------------------------------------------------------------------------

/**
 * Volume, base area and height of a stockpile. Tool 15.
 *
 * The reference defaults to nothing, exactly as in `cutFill`, because a pile's
 * volume depends entirely on where its base is taken to be. `boundaryPlane`
 * fits the ground around the toe of the pile and is the usual meaning of
 * "how much material is in that heap"; a flat plane is right when the pile sits
 * on a known pad level.
 *
 * `fill` coming back non zero is a useful signal rather than an error: it means
 * ground inside the polygon sits below the fitted base, so the polygon has been
 * drawn wider than the toe and is picking up a ditch or a slope. It is reported
 * rather than discarded.
 */
/**
 * @param {any} demGrid
 * @param {number[][]} ring
 * @param {{ kind: string, at: Function }} reference
 * @param {{ rmseZ?: number|null }} [options]
 */
export function stockpileVolume(demGrid, ring, reference, { rmseZ = null } = {}) {
  const result = cutFill(demGrid, ring, reference, { rmseZ });
  const baseArea = result.cutArea;
  return {
    ...result,
    volume: result.cut,
    baseArea,
    maxHeight: result.maxCutDepth,
    meanHeight: baseArea > 0 ? result.cut / baseArea : null,
    // Below the fitted base: usually the polygon overshooting the toe.
    volumeBelowBase: result.fill,
    footprintArea: polygonArea(ring),
  };
}

// ---------------------------------------------------------------------------
// Tools 19 to 21: chainage, corridor, automatic cross sections
// ---------------------------------------------------------------------------

/** Total planar length of a polyline in projected metres. */
function alignmentLength(line) {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  }
  return total;
}

/** Point and unit direction at a distance along a polyline. */
function pointAtChainage(line, distance) {
  let travelled = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const segment = Math.hypot(x1 - x0, y1 - y0);
    if (segment === 0) continue;
    if (travelled + segment >= distance - 1e-9) {
      const t = (distance - travelled) / segment;
      return {
        point: [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t],
        direction: [(x1 - x0) / segment, (y1 - y0) / segment],
      };
    }
    travelled += segment;
  }
  const [x0, y0] = line[line.length - 2];
  const [x1, y1] = line[line.length - 1];
  const segment = Math.hypot(x1 - x0, y1 - y0) || 1;
  return { point: line[line.length - 1], direction: [(x1 - x0) / segment, (y1 - y0) / segment] };
}

/**
 * Chainage markers along an alignment, with elevation and grade. Tool 19.
 *
 * Stations land on whole multiples of the interval from the start of the
 * alignment, which is what a drawing expects: chainage 0+000, 0+025, 0+050. The
 * end of the alignment is always included even when it is not a whole station,
 * because leaving it out loses the end of the road.
 */
/**
 * @param {any} demGrid
 * @param {number[][]} line
 * @param {number} interval
 * @param {{ rmseZ?: number|null }} [options]
 */
export function chainage(demGrid, line, interval, { rmseZ = null } = {}) {
  if (!(interval > 0)) throw new Error("chainage: interval must be positive metres");
  const total = alignmentLength(line);
  const stations = [];

  for (let d = 0; d <= total + 1e-9; d += interval) {
    const { point } = pointAtChainage(line, Math.min(d, total));
    stations.push({
      chainage: Math.min(d, total),
      label: formatChainage(Math.min(d, total)),
      easting: point[0],
      northing: point[1],
      elevation: spotLevel(demGrid, point[0], point[1]),
    });
  }
  const last = stations[stations.length - 1];
  if (!last || Math.abs(last.chainage - total) > 1e-6) {
    const { point } = pointAtChainage(line, total);
    stations.push({
      chainage: total,
      label: formatChainage(total),
      easting: point[0],
      northing: point[1],
      elevation: spotLevel(demGrid, point[0], point[1]),
    });
  }

  // Grade between consecutive stations, which is what a longitudinal section
  // actually plots, rather than the overall grade.
  for (let i = 1; i < stations.length; i += 1) {
    const a = stations[i - 1];
    const b = stations[i];
    const run = b.chainage - a.chainage;
    b.gradePercent =
      a.elevation === null || b.elevation === null || run <= 0
        ? null
        : ((b.elevation - a.elevation) / run) * 100;
  }
  if (stations.length > 0) stations[0].gradePercent = null;

  const grades = stations.map((s) => s.gradePercent).filter((g) => g !== null);
  return {
    stations,
    interval,
    length: total,
    // Tool 10 in Important Notes: maximum longitudinal slope. Deliberately named
    // apart from the end to end grade, which is a different and gentler number.
    maxGradePercent: grades.length ? Math.max(...grades.map(Math.abs)) : null,
    meanGradePercent: grades.length ? grades.reduce((s, g) => s + g, 0) / grades.length : null,
    rmseZ,
    stationsWithoutData: stations.filter((s) => s.elevation === null).length,
  };
}

/** 1234.5 m as "1+234.500", the form a drawing uses. */
export function formatChainage(metres) {
  const km = Math.floor(metres / 1000);
  const rest = metres - km * 1000;
  return `${km}+${rest.toFixed(3).padStart(7, "0")}`;
}

/**
 * Cross sections at fixed intervals along an alignment. Tools 20 and 21.
 *
 * Each section is cut perpendicular to the alignment, which is the part worth
 * getting right: a section taken along the grid axes rather than across the road
 * is wider than the road by a factor of one over the cosine of the bearing, and
 * it looks entirely reasonable on a plan.
 *
 * Offsets run left to right in the direction of travel, so a drafter reading the
 * output knows which side of the centreline they are on. Left is negative.
 */
/**
 * @param {any} demGrid
 * @param {number[][]} line
 * @param {{ interval?: number, halfWidth?: number, spacing?: number|null }} [options]
 */
export function crossSections(demGrid, line, { interval = 10, halfWidth = 15, spacing = null } = {}) {
  const total = alignmentLength(line);
  const step = spacing ?? demGrid.cellSize;
  const sections = [];

  for (let d = 0; d <= total + 1e-9; d += interval) {
    const at = Math.min(d, total);
    const { point, direction } = pointAtChainage(line, at);
    // Left normal in a right handed projected CRS with north up.
    const normal = [-direction[1], direction[0]];

    const samples = [];
    for (let offset = -halfWidth; offset <= halfWidth + 1e-9; offset += step) {
      const x = point[0] + normal[0] * offset;
      const y = point[1] + normal[1] * offset;
      samples.push({ offset, easting: x, northing: y, elevation: spotLevel(demGrid, x, y) });
    }

    const withData = samples.filter((s) => s.elevation !== null);
    const centre = spotLevel(demGrid, point[0], point[1]);
    sections.push({
      chainage: at,
      label: formatChainage(at),
      centreEasting: point[0],
      centreNorthing: point[1],
      centreElevation: centre,
      samples,
      min: withData.length ? Math.min(...withData.map((s) => s.elevation)) : null,
      max: withData.length ? Math.max(...withData.map((s) => s.elevation)) : null,
      // Crossfall: the fall from one side of the section to the other, as a
      // percentage. Drainage depends on it and it is what a haul road audit
      // looks at first.
      crossfallPercent: crossfall(withData),
    });
  }
  return { sections, interval, halfWidth, sampleSpacing: step, length: total };
}

function crossfall(samples) {
  if (samples.length < 2) return null;
  const left = samples[0];
  const right = samples[samples.length - 1];
  const run = right.offset - left.offset;
  return run === 0 ? null : ((right.elevation - left.elevation) / run) * 100;
}

/**
 * Corridor summary along an alignment. Tool 20, and tool 18 for haul roads.
 *
 * Width is measured as the run of the section that stays inside a grade limit
 * either side of the centreline, which is a serviceable proxy for "the part a
 * vehicle can actually use" without needing edge detection. It is a derived
 * figure, not a survey of the kerb lines, and is labelled that way.
 *
 * `unsafeSections` is the output that earns its keep on a mine site: stations
 * where the longitudinal grade or the crossfall exceeds the limits given.
 */
export function corridorAnalysis(
  demGrid,
  line,
  {
    interval = 10,
    halfWidth = 15,
    maxGradePercent = 10,
    maxCrossfallPercent = 6,
    usableSlopePercent = 12,
  } = {},
) {
  const { sections } = crossSections(demGrid, line, { interval, halfWidth });
  const stations = chainage(demGrid, line, interval).stations;
  const byChainage = new Map(stations.map((s) => [Math.round(s.chainage * 1000), s]));

  const rows = sections.map((section) => {
    const station = byChainage.get(Math.round(section.chainage * 1000));
    const grade = station?.gradePercent ?? null;
    return {
      chainage: section.chainage,
      label: section.label,
      // Carried through from the section rather than dropped. Every other
      // result here can be placed on a map, and a corridor station that cannot
      // is the one a client most wants to point at: it is the flagged one.
      easting: section.centreEasting,
      northing: section.centreNorthing,
      centreElevation: section.centreElevation,
      gradePercent: grade,
      crossfallPercent: section.crossfallPercent,
      usableWidth: usableWidth(section.samples, usableSlopePercent),
      unsafe:
        (grade !== null && Math.abs(grade) > maxGradePercent) ||
        (section.crossfallPercent !== null &&
          Math.abs(section.crossfallPercent) > maxCrossfallPercent),
    };
  });

  const widths = rows.map((r) => r.usableWidth).filter((w) => w !== null);
  return {
    stations: rows,
    limits: { maxGradePercent, maxCrossfallPercent, usableSlopePercent },
    meanUsableWidth: widths.length ? widths.reduce((s, w) => s + w, 0) / widths.length : null,
    minUsableWidth: widths.length ? Math.min(...widths) : null,
    unsafeStations: rows.filter((r) => r.unsafe),
    widthMethod:
      "Run of the cross section either side of the centreline staying within the usable " +
      "slope limit. A derived figure, not a survey of the road edges.",
  };
}

function usableWidth(samples, slopeLimitPercent) {
  const centreIndex = samples.findIndex((s) => s.offset >= 0);
  if (centreIndex === -1 || samples[centreIndex].elevation === null) return null;

  const walk = (from, step) => {
    let last = samples[from];
    let reach = 0;
    for (let i = from + step; i >= 0 && i < samples.length; i += step) {
      const s = samples[i];
      if (s.elevation === null) break;
      const run = Math.abs(s.offset - last.offset);
      if (run === 0) continue;
      const slope = Math.abs(((s.elevation - last.elevation) / run) * 100);
      if (slope > slopeLimitPercent) break;
      reach = Math.abs(s.offset - samples[centreIndex].offset);
      last = s;
    }
    return reach;
  };
  return walk(centreIndex, -1) + walk(centreIndex, 1);
}

// ---------------------------------------------------------------------------
// Tools 16 and 17: bench and highwall
// ---------------------------------------------------------------------------

/**
 * Bench geometry along a section across a mine face. Tool 16.
 *
 * A bench is read off the profile as an alternating run of flats and risers:
 * anything flatter than `benchSlopePercent` is a bench, anything steeper is the
 * face between two benches. That is a geometric reading of the ground, not an
 * interpretation of the mine plan, and it will find terraces that are not
 * benches if you point it at a hillside.
 */
export function benchAnalysis(demGrid, line, { benchSlopePercent = 10, minBenchWidth = 2 } = {}) {
  const p = profile(demGrid, line);
  const points = p.points.filter((q) => q.elevation !== null);
  if (points.length < 3) return { benches: [], faces: [], profile: p };

  const benches = [];
  const faces = [];
  /** Flats classified as such but shorter than `minBenchWidth`. */
  const narrowFlats = [];
  let runStart = 0;
  let runIsFlat = null;

  const flush = (endIndex) => {
    const a = points[runStart];
    const b = points[endIndex];
    const width = b.chainage - a.chainage;
    const rise = b.elevation - a.elevation;
    const entry = {
      fromChainage: a.chainage,
      toChainage: b.chainage,
      width,
      height: Math.abs(rise),
      slopePercent: width === 0 ? null : (rise / width) * 100,
      slopeDegrees: width === 0 ? null : (Math.atan(rise / width) * 180) / Math.PI,
    };
    if (runIsFlat) {
      /*
       * A flat too narrow to be a bench is still ground, and dropping it
       * silently left the report unable to account for the line: on a noisy
       * natural slope, benches and faces together came to 159 m of a 209 m
       * alignment and nothing said where the rest went. Counted instead, so the
       * three add up and a client can see how much of the line was neither.
       */
      if (width >= minBenchWidth) benches.push(entry);
      else narrowFlats.push(entry);
    } else {
      faces.push({ ...entry, angleDegrees: Math.abs(entry.slopeDegrees ?? 0) });
    }
  };

  for (let i = 1; i < points.length; i += 1) {
    const run = points[i].chainage - points[i - 1].chainage;
    const slope = run === 0 ? 0 : Math.abs(((points[i].elevation - points[i - 1].elevation) / run) * 100);
    const isFlat = slope <= benchSlopePercent;
    if (runIsFlat === null) { runIsFlat = isFlat; runStart = i - 1; continue; }
    if (isFlat !== runIsFlat) { flush(i - 1); runIsFlat = isFlat; runStart = i - 1; }
  }
  flush(points.length - 1);

  const total = (runs) => runs.reduce((sum, r) => sum + r.width, 0);
  return {
    benches,
    faces,
    profile: p,
    meanBenchWidth: benches.length ? benches.reduce((s, b) => s + b.width, 0) / benches.length : null,
    meanBenchHeight: faces.length ? faces.reduce((s, f) => s + f.height, 0) / faces.length : null,
    maxFaceAngleDegrees: faces.length ? Math.max(...faces.map((f) => f.angleDegrees)) : null,
    /**
     * Where the line went, in metres, so the three account for all of it.
     *
     * `narrowFlat` is ground flatter than the threshold but too short to call a
     * bench. On a mine face it is close to zero; on a natural slope read by this
     * tool it can be a quarter of the line, and that is worth seeing rather than
     * being quietly absent from the totals.
     */
    lengthBreakdown: {
      bench: total(benches),
      face: total(faces),
      narrowFlat: total(narrowFlats),
      /*
       * The ends of the line with no survey underneath them.
       *
       * Computed from where the data starts and stops rather than as whatever
       * is left over, so the four figures are produced independently and their
       * sum is a real check rather than an identity. Interior gaps are not
       * counted here: a run spanning one already includes it.
       */
      unsurveyed:
        points[0].chainage -
        p.points[0].chainage +
        (p.points[p.points.length - 1].chainage - points[points.length - 1].chainage),
      length: p.points.length ? p.points[p.points.length - 1].chainage : 0,
    },
    narrowFlats: narrowFlats.length,
  };
}

/**
 * Slopes exceeding a safe design angle. Tool 17.
 *
 * This finds steep ground. It does not assess stability, which depends on rock
 * mass, jointing, water and blast damage, none of which are in a terrain model.
 * The wording of the output says so, because "highwall stability" on a dashboard
 * invites a reading this data cannot support, and that is a safety question
 * rather than a marketing one.
 */
export function steepSlopeZones(slopeGrid, limitDegrees) {
  if (!(limitDegrees > 0)) throw new Error("steepSlopeZones: limitDegrees must be positive");
  const mask = slopeGrid.like(Uint8Array, 0, 0);
  let cells = 0;
  let steepest = 0;
  for (let i = 0; i < slopeGrid.length; i += 1) {
    const v = slopeGrid.data[i];
    if (slopeGrid.isNoData(v)) continue;
    if (v > steepest) steepest = v;
    if (v > limitDegrees) { mask.data[i] = 1; cells += 1; }
  }
  return {
    mask,
    limitDegrees,
    exceedingArea: cells * slopeGrid.cellArea,
    exceedingHectares: (cells * slopeGrid.cellArea) / 10000,
    steepestDegrees: steepest,
    caveat:
      "Identifies slopes steeper than the stated design angle. This is geometry only: " +
      "stability also depends on rock mass, jointing, groundwater and blast damage, none " +
      "of which are present in a terrain model.",
  };
}

// ---------------------------------------------------------------------------
// Tool 11: earthwork progress
// ---------------------------------------------------------------------------

/**
 * Progress across a run of surveys. Tool 11.
 *
 * `surfaces` is ordered oldest to newest and each entry is `{ label, grid }`.
 * Every step is measured against the one before it, and the whole run against a
 * design surface when one is supplied, so the output answers both "what moved
 * this month" and "how far from finished".
 *
 * Completion is deliberately volume based rather than area based: eighty percent
 * of the area touched can be twenty percent of the material.
 */
/**
 * @param {{label: string, grid: any}[]} surfaces
 * @param {number[][]} ring
 * @param {{ design?: any, rmseZ?: number|null }} [options]
 */
export function earthworkProgress(surfaces, ring, { design = null, rmseZ = null } = {}) {
  if (!Array.isArray(surfaces) || surfaces.length < 2) {
    throw new Error("earthworkProgress: needs at least two surveys, oldest first");
  }

  const steps = [];
  for (let i = 1; i < surfaces.length; i += 1) {
    const previous = surfaces[i - 1];
    const current = surfaces[i];
    const r = cutFill(current.grid, ring, REFERENCE.surface(previous.grid), { rmseZ });
    steps.push({
      from: previous.label,
      to: current.label,
      excavated: r.fill, // ground now lower than before: material removed
      filled: r.cut, // ground now higher: material placed
      net: r.cut - r.fill,
      uncertainty: r.uncertainty,
    });
  }

  let completion = null;
  if (design) {
    const first = cutFill(surfaces[0].grid, ring, REFERENCE.surface(design), { rmseZ });
    const last = cutFill(surfaces[surfaces.length - 1].grid, ring, REFERENCE.surface(design), { rmseZ });
    const started = first.cut + first.fill;
    const remaining = last.cut + last.fill;
    completion = {
      volumeAtStart: started,
      volumeRemaining: remaining,
      volumeMoved: started - remaining,
      percentComplete: started === 0 ? null : ((started - remaining) / started) * 100,
      remainingCut: last.cut,
      remainingFill: last.fill,
    };
  }

  return {
    steps,
    completion,
    totalExcavated: steps.reduce((s, x) => s + x.excavated, 0),
    totalFilled: steps.reduce((s, x) => s + x.filled, 0),
    basis: "Volumes computed in the grid's projected CRS against the preceding survey.",
  };
}
