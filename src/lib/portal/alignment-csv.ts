"use client";

/**
 * The Roads tools as files, because a table on screen is not a deliverable.
 *
 * Malhar's item 5: the Sections tool builds a chainage table with centre, low
 * and high at a chosen interval, and it was only ever readable on screen. A
 * setting-out crew needs it in a total station, a designer needs it in a
 * spreadsheet, and the answer to both was to retype it.
 *
 * All four alignment modes export, not just Sections, because they are one tool
 * asked four questions and there is no reason the other three should stay
 * trapped. Each gets the columns it actually has rather than a shared shape
 * padded with blanks.
 *
 * ## What every file carries
 *
 * Eastings and northings in the survey's own projected CRS, and its EPSG code
 * in the filename. A chainage table without a CRS is a list of numbers that
 * cannot be set out — and the portal's own rule everywhere else is that a
 * measurement states what it was computed in.
 *
 * Elevations to 3 decimals, which is millimetres: past the survey's own
 * accuracy, but rounding a delivery tighter than its source is how a re-export
 * stops matching the first export. Chainages to 3 as well, for the same reason.
 *
 * Nulls are written as empty cells, never as 0 or -9999. A station with no
 * survey under it has no elevation, and a zero there is a number a designer
 * will build to.
 */

import { csv } from "./download";
import type {
  ChainageResult,
  CrossSectionsResult,
  CorridorResult,
  BenchResult,
} from "./analysis-client";

/** Metres to millimetres, or blank. Never a sentinel. */
const m = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(3);

/** A percentage to two decimals, or blank. */
const pc = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(2);

/**
 * Chainage: one row per station, which is what a setting-out sheet is.
 */
export function chainageCsv(r: ChainageResult) {
  return csv(
    ["chainage_m", "station", "easting", "northing", "elevation_m", "grade_percent"],
    r.stations.map((s) => [
      m(s.chainage), s.label, m(s.easting), m(s.northing), m(s.elevation), pc(s.gradePercent),
    ]),
  );
}

/**
 * Sections: the columns Malhar named — chainage, centre, low, high — plus the
 * ones a section is useless without.
 *
 * `low` and `high` are the minimum and maximum across the cut, so they are
 * *across the section*, not along the road. The header says `_across_section`
 * because "low" and "high" alone have been read as "start and end of the
 * grade" by more than one person looking at a chainage table.
 *
 * Crossfall comes too: it is computed from the same samples, it is what a
 * drainage check reads first, and leaving it out would mean exporting the table
 * and then asking for it separately.
 */
export function sectionsCsv(r: CrossSectionsResult) {
  return csv(
    [
      "chainage_m", "station", "centre_easting", "centre_northing",
      "centre_elevation_m", "low_across_section_m", "high_across_section_m",
      "crossfall_percent", "half_width_m", "sample_spacing_m",
    ],
    r.sections.map((s) => [
      m(s.chainage), s.label, m(s.centreEasting), m(s.centreNorthing),
      m(s.centreElevation), m(s.min), m(s.max),
      pc(s.crossfallPercent), m(r.halfWidth), m(r.sampleSpacing),
    ]),
  );
}

/**
 * Sections, every sample.
 *
 * The summary above is one row per section; this is one row per *point* across
 * every cut, which is what a cross-section drawing is actually plotted from.
 * Offered separately rather than instead, because at 25 m intervals with a 15 m
 * half width and 0.24 m spacing a kilometre of road is forty rows one way and
 * five thousand the other, and a client wanting the first does not want the
 * second.
 */
export function sectionSamplesCsv(r: CrossSectionsResult) {
  const rows: (string | number)[][] = [];
  for (const s of r.sections) {
    for (const p of s.samples) {
      rows.push([
        m(s.chainage), s.label, m(p.offset), m(p.easting), m(p.northing), m(p.elevation),
      ]);
    }
  }
  return csv(
    ["chainage_m", "station", "offset_m", "easting", "northing", "elevation_m"],
    rows,
  );
}

/**
 * Corridor: the per-station audit, with the limits it was judged against.
 *
 * `unsafe` is carried as a word rather than a number, because a column of 0s
 * and 1s under a heading like that is read backwards by somebody eventually.
 * The limits are repeated on every row for the same reason the depression
 * threshold is: the classification means nothing without them, and a file that
 * does not carry them cannot be compared with another run.
 */
export function corridorCsv(r: CorridorResult) {
  return csv(
    [
      "chainage_m", "station", "easting", "northing", "centre_elevation_m",
      "grade_percent", "crossfall_percent", "usable_width_m", "within_limits",
      "max_grade_percent", "max_crossfall_percent",
    ],
    r.stations.map((s) => [
      m(s.chainage), s.label, m(s.easting), m(s.northing), m(s.centreElevation),
      pc(s.gradePercent), pc(s.crossfallPercent), m(s.usableWidth),
      s.unsafe ? "no" : "yes",
      pc(r.limits.maxGradePercent), pc(r.limits.maxCrossfallPercent),
    ]),
  );
}

/**
 * Benches and faces, in one file, distinguished by a column.
 *
 * Two files would be tidier and wrong: a bench and the face below it are one
 * measurement of one slope, and reading them apart loses which face belongs to
 * which bench. Ordered by chainage so the file reads up the slope the way the
 * line was drawn.
 */
export function benchCsv(r: BenchResult) {
  const rows = [
    ...r.benches.map((b) => ["bench", b] as const),
    ...r.faces.map((f) => ["face", f] as const),
  ]
    .sort((a, b) => a[1].fromChainage - b[1].fromChainage)
    .map(([kind, b]) => [
      kind,
      m(b.fromChainage), m(b.toChainage), m(b.width), m(b.height),
      pc(b.slopePercent),
      b.slopeDegrees === null || b.slopeDegrees === undefined ? "" : b.slopeDegrees.toFixed(2),
    ]);
  return csv(
    ["kind", "from_chainage_m", "to_chainage_m", "width_m", "height_m",
      "slope_percent", "slope_degrees"],
    rows,
  );
}
