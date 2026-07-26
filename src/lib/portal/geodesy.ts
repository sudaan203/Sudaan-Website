/**
 * Measurement on the survey's own coordinate system.
 *
 * This is the part that decides whether a number the portal shows a client is
 * true or merely plausible, so it is worth being explicit about the trap it
 * avoids.
 *
 * A polygon drawn on a web map arrives as longitude and latitude, in degrees.
 * Two things go wrong if you measure those numbers directly:
 *
 *   1. Degrees are not metres, and a degree of longitude is not a degree of
 *      latitude. Area comes out in square degrees, which means nothing.
 *   2. The obvious fix, measuring in the map's own Web Mercator coordinates, is
 *      also wrong. Web Mercator inflates distance by 1/cos(latitude) and area by
 *      its square. At Aektanagar, latitude 21.89, that is 7.8% on every length
 *      and **16.3% on every area**. A hectare would read as 1.16 hectares.
 *
 * So every measurement here is converted to the survey's UTM zone first, which
 * is metres on the ground and what the deliverables were produced in. UTM has its
 * own scale distortion, but it is about 1 part in 2500 at worst inside a zone and
 * near zero close to the central meridian, which is far below the plus or minus
 * 3 to 4 cm the survey claims.
 *
 * The forward projection is ported from scripts/lib/geo.mjs so the browser and
 * the pipeline agree by construction. Ported rather than shared because that file
 * is an .mjs Node script that reads the filesystem.
 */

export type LonLat = [number, number];

const A = 6378137.0;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);

/** WGS84 lon/lat to UTM easting/northing, in metres. */
export function lonLatToUtm(
  lon: number,
  lat: number,
  zone: number,
  northern = true,
): [number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;

  const n = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = EP2 * Math.cos(phi) ** 2;
  const a2 = Math.cos(phi) * (lambda - lambda0);

  const m =
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));

  const easting =
    K0 *
      n *
      (a2 +
        ((1 - t + c) * a2 ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a2 ** 5) / 120) +
    500000;

  let northing =
    K0 *
    (m +
      n *
        Math.tan(phi) *
        ((a2 * a2) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a2 ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a2 ** 6) / 720));
  if (!northern) northing += 10000000;

  return [easting, northing];
}

/** Horizontal ground distance along a path, in metres. */
export function pathLength(points: LonLat[], zone: number, northern = true): number {
  if (points.length < 2) return 0;
  let total = 0;
  let prev = lonLatToUtm(points[0][0], points[0][1], zone, northern);
  for (let i = 1; i < points.length; i += 1) {
    const cur = lonLatToUtm(points[i][0], points[i][1], zone, northern);
    total += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
  }
  return total;
}

/**
 * Planimetric area of a closed ring, in square metres, by the shoelace formula
 * on UTM coordinates.
 *
 * "Planimetric" matters: this is the area of the footprint, not the area of the
 * terrain surface inside it. On a slope the real surface is larger. Anything
 * quoting area over steep ground should say which one it means, and this returns
 * the footprint, which is what a plan drawing shows.
 */
export function ringArea(points: LonLat[], zone: number, northern = true): number {
  if (points.length < 3) return 0;
  const utm = points.map((p) => lonLatToUtm(p[0], p[1], zone, northern));
  // Close the ring if the caller did not.
  const first = utm[0];
  const last = utm[utm.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) utm.push(first);

  let sum = 0;
  for (let i = 0; i < utm.length - 1; i += 1) {
    sum += utm[i][0] * utm[i + 1][1] - utm[i + 1][0] * utm[i][1];
  }
  return Math.abs(sum) / 2;
}

/**
 * Points spaced evenly along a path, for sampling an elevation profile.
 *
 * Spacing is chosen by the caller from the DEM's own ground resolution: asking
 * for samples closer together than one DEM cell invents detail, and the profile
 * would show interpolation rather than measurement.
 */
export function densifyPath(
  points: LonLat[],
  spacingMetres: number,
  zone: number,
  northern = true,
): { point: LonLat; distance: number }[] {
  if (points.length < 2) return [];
  const total = pathLength(points, zone, northern);
  if (total === 0) return [];

  const steps = Math.max(2, Math.min(512, Math.ceil(total / spacingMetres) + 1));
  const out: { point: LonLat; distance: number }[] = [];

  // Cumulative length of each input segment, so a target distance can be placed.
  const segEnd: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    segEnd.push(pathLength(points.slice(0, i + 1), zone, northern));
  }

  for (let s = 0; s < steps; s += 1) {
    const target = (total * s) / (steps - 1);
    let i = 1;
    while (i < segEnd.length - 1 && segEnd[i] < target) i += 1;
    const from = points[i - 1];
    const to = points[i];
    const segLen = segEnd[i] - segEnd[i - 1];
    const t = segLen === 0 ? 0 : (target - segEnd[i - 1]) / segLen;
    out.push({
      point: [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t],
      distance: target,
    });
  }
  return out;
}

/**
 * Ground metres per screen pixel, used to pick a profile sampling interval and
 * to warn when a measurement is being taken at a zoom where the DEM cannot
 * support it.
 */
export function metresPerPixel(latitude: number, zoom: number): number {
  return (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

/** 1234.5 m as "1.23 km", 12.3 as "12.3 m". */
export function formatDistance(metres: number): string {
  if (metres < 1) return `${(metres * 100).toFixed(0)} cm`;
  if (metres < 1000) return `${metres.toFixed(metres < 100 ? 2 : 1)} m`;
  return `${(metres / 1000).toFixed(3)} km`;
}

/** Square metres as m², hectares past 1 ha, km² past 100 ha. */
export function formatArea(sqMetres: number): string {
  if (sqMetres < 10000) return `${sqMetres.toFixed(sqMetres < 100 ? 2 : 1)} m²`;
  if (sqMetres < 1000000) return `${(sqMetres / 10000).toFixed(3)} ha`;
  return `${(sqMetres / 1000000).toFixed(4)} km²`;
}

/** Elevation with its tolerance, because a bare number reads as exact. */
export function formatElevation(metres: number, toleranceM = 0.04): string {
  return `${metres.toFixed(2)} m ±${(toleranceM * 100).toFixed(0)} cm`;
}

/**
 * How wrong measuring in Web Mercator would have been, at this latitude.
 * Kept as a function rather than a comment so the claim in the docs is checkable
 * and the tests can assert it.
 */
export function mercatorAreaInflation(latitude: number): number {
  return 1 / Math.cos((latitude * Math.PI) / 180) ** 2;
}
