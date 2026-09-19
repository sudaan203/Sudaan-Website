/**
 * Forest inventory arithmetic: CHM, crown extraction, the six non-tree
 * discriminators, confidence, DBH and height classification.
 *
 * ## Where this sits after the pivot
 *
 * `docs/forest-tools-plan.md` §3 was written for a LiDAR local-maxima and
 * marker-watershed pipeline. That is not what runs. Per the plan's own
 * "Addendum, 19 Sep 2026", detection is now a Python track (DeepForest, run
 * against the orthomosaic) that hands over candidate tree-crown *boxes* —
 * axis-aligned rectangles in EPSG:32643, each with a model confidence score.
 * This module owns everything downstream of those boxes and never runs or
 * imports a model. The six discriminators, the confidence blend, the DBH
 * attempt and the height classes are unchanged in spirit from §3.4-§3.7; what
 * changed is the seed (a box, not a local maximum) and one new input to
 * confidence (the model's own score, §0.2's "seventh input").
 *
 * ## Pure, like `hydrology.mjs`
 *
 * Every function here takes grids and plain data in and returns grids and
 * plain data out. No file reads, no network, no point cloud decoding — those
 * live in `scripts/forest-run.mjs`, which is the only place I/O happens. That
 * is what lets `scripts/forest-test.mjs` build a handful of hand-placed cones
 * in memory and assert exact numbers, the same discipline `hydro-test.mjs`
 * holds hydrology to.
 *
 * ## Two grids that do not agree, and why that is normal here
 *
 * Kotba's DSM (0.157 m) and DTM (0.241 m) are on different grids entirely —
 * different cell size, different origin, same extent. `chmFrom` does not
 * assume alignment: it builds a fresh analysis grid at the requested cell
 * size and samples both surfaces into it independently by bilinear
 * interpolation, exactly the way the `difference` render layer already does
 * for the same reason (see the route's own comment on why: "there is no
 * shared cell to subtract"). Ektanagar 1's DSM and DTM happen to share a grid,
 * which only means the interpolation is exact rather than that it can be
 * skipped — the code path is the same either way, and staying on one path is
 * the point.
 */

import { Grid } from "./raster.mjs";
import { polygonizeComponents, ringArea } from "./vectorise.mjs";
import { spotLevel } from "./terrain-analysis.mjs";

// ---------------------------------------------------------------------------
// Small numeric helpers with no home elsewhere. Kept local rather than added
// to a shared module because nothing outside forestry needs a circle fit or a
// convex hull, and a one-off export nobody else calls is worse than a
// documented local function.
// ---------------------------------------------------------------------------

function medianOf(values) {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Pearson correlation. Null rather than NaN when either series has no spread. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Convex hull, Andrew's monotone chain. Returns hull vertices counter
 * clockwise with no repeated closing point, which is what `hullMeasures`
 * below wants.
 */
function convexHull(points) {
  const seen = new Map();
  for (const [x, y] of points) seen.set(`${x},${y}`, [x, y]);
  const pts = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Max diameter, min width and the minimum-area bounding rectangle of a convex
 * hull, in one rotating-calipers pass.
 *
 * Three quantities that sound like they need three algorithms turn out to
 * share one: the classic width-minimisation theorem says the polygon's
 * minimum width, over every possible direction, is always realised with one
 * calliper flush against a hull edge — so walking the edges once and
 * measuring the extent perpendicular to each gives the true global minimum,
 * not an approximation of it. The minimum-area bounding rectangle is the same
 * theorem's twin: it too always has a side collinear with a hull edge, so the
 * same per-edge projection gives both the width (`extentPerp`) and, paired
 * with the extent along the edge, the smallest enclosing rectangle's area.
 *
 * The maximum diameter (the farthest pair of hull vertices) is the one
 * quantity here that is *not* edge-anchored — it needs antipodal pairs in
 * general — but at the vertex counts a simplified crown polygon actually has
 * (tens, never thousands, because `simplifyCollinear` already ran), an O(n^2)
 * search over all pairs costs nothing and there is no reason to reach for the
 * O(n) rotating-calipers refinement just to say it was used.
 */
function hullMeasures(hull) {
  const n = hull.length;
  if (n < 2) return { minWidth: 0, maxDiameter: 0, minAreaRect: { area: 0, extentAlong: 0, extentPerp: 0 } };
  if (n === 2) {
    const d = Math.hypot(hull[1][0] - hull[0][0], hull[1][1] - hull[0][1]);
    return { minWidth: 0, maxDiameter: d, minAreaRect: { area: 0, extentAlong: d, extentPerp: 0 } };
  }

  let maxDiameter = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = Math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1]);
      if (d > maxDiameter) maxDiameter = d;
    }
  }

  let minWidth = Infinity;
  let minRectArea = Infinity;
  let minRectAlong = 0;
  let minRectPerp = 0;
  for (let i = 0; i < n; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    const ux = ex / len;
    const uy = ey / len;
    const vx = -uy;
    const vy = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = x * vx + y * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const extentAlong = maxU - minU;
    const extentPerp = maxV - minV;
    if (extentPerp < minWidth) minWidth = extentPerp;
    const area = extentAlong * extentPerp;
    if (area < minRectArea) {
      minRectArea = area;
      minRectAlong = extentAlong;
      minRectPerp = extentPerp;
    }
  }
  return { minWidth, maxDiameter, minAreaRect: { area: minRectArea, extentAlong: minRectAlong, extentPerp: minRectPerp } };
}

function ringLength(ring) {
  let len = 0;
  for (let i = 1; i < ring.length; i += 1) {
    len += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  }
  return len;
}

// ---------------------------------------------------------------------------
// CHM
// ---------------------------------------------------------------------------

/**
 * Remove single-cell dips fully surrounded by higher ground.
 *
 * A canopy height model built from a photogrammetric or lightly-filtered
 * surface can have a one-cell hole where the matching briefly saw through a
 * gap in the leaves to something lower. Left alone, that hole is a hair below
 * the per-box threshold in `crownFromBox` and silently splits one crown's
 * connected component into two, or opens a channel that lets one crown's
 * flood-fill leak past its rim into a neighbour's. Only a cell whose entire
 * 8-neighbourhood carries data is touched — a real slope down towards a
 * crown's own edge, or towards the survey boundary, is never a "surrounded"
 * cell and is left exactly as measured.
 *
 * This is deliberately not `hydrology.mjs`'s Priority-Flood: that fills every
 * depression of any size and any shape, which is right for routing water and
 * wrong here — a genuine gap in the canopy (a real, if narrow, opening in the
 * crown) is data, not noise, and only a single isolated cell is assumed to be
 * an artefact.
 */
export function fillSingleCellPits(grid, { marginM = 0.5 } = {}) {
  const { width, height, data } = grid;
  const out = grid.clone();
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const v = data[i];
      if (grid.isNoData(v)) continue;
      let neighbourMin = Infinity;
      let ringComplete = true;
      for (let dr = -1; dr <= 1 && ringComplete; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nc < 0 || nr >= height || nc >= width) { ringComplete = false; break; }
          const nv = data[nr * width + nc];
          if (grid.isNoData(nv)) { ringComplete = false; break; }
          if (nv < neighbourMin) neighbourMin = nv;
        }
      }
      if (ringComplete && neighbourMin - v > marginM) out.data[i] = neighbourMin;
    }
  }
  return out;
}

/**
 * Canopy height model: DSM minus DTM, clipped at zero, on a fresh analysis
 * grid at `cellSize` covering the two rasters' overlap.
 *
 * Built by sampling both surfaces independently at every target cell centre
 * (bilinear, via `spotLevel`) rather than by subtracting the source arrays
 * directly — see the header for why that is required rather than an
 * abundance of caution. Either surface missing at a point leaves the CHM cell
 * as nodata: zero would claim "no canopy", which is a different fact from
 * "no measurement".
 *
 * Always coarsens, never invents detail: the analysis cell (0.25 m per
 * `docs/forest-tools-plan.md` §2.3) is coarser than either surface's own
 * resolution on every survey this pipeline runs against, so every sample is a
 * genuine reduction, the same direction `resample` in `raster.mjs` insists on
 * for hydrology.
 *
 * The result is pit-filled per `fillSingleCellPits` before being handed back,
 * because every caller of this function wants a connected crown surface, not
 * a raw difference full of one-cell noise holes.
 */
export function chmFrom(dsmGrid, dtmGrid, { cellSize, pitFillMarginM = 0.5 } = {}) {
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new Error("chmFrom: cellSize must be a positive number of metres");
  }
  const [dMinX, dMinY, dMaxX, dMaxY] = dsmGrid.bounds;
  const [tMinX, tMinY, tMaxX, tMaxY] = dtmGrid.bounds;
  const minX = Math.max(dMinX, tMinX);
  const minY = Math.max(dMinY, tMinY);
  const maxX = Math.min(dMaxX, tMaxX);
  const maxY = Math.min(dMaxY, tMaxY);
  if (minX >= maxX || minY >= maxY) {
    throw new Error("chmFrom: the DSM and DTM do not overlap at all");
  }

  const width = Math.max(1, Math.round((maxX - minX) / cellSize));
  const height = Math.max(1, Math.round((maxY - minY) / cellSize));
  const nodata = -99999;
  const chm = new Grid({
    width, height, cellSize, originX: minX, originY: maxY,
    data: new Float32Array(width * height).fill(nodata), nodata,
    epsg: dsmGrid.epsg ?? dtmGrid.epsg ?? null,
  });

  for (let row = 0; row < height; row += 1) {
    const y = chm.yOf(row);
    for (let col = 0; col < width; col += 1) {
      const x = chm.xOf(col);
      const top = spotLevel(dsmGrid, x, y);
      const ground = spotLevel(dtmGrid, x, y);
      if (top === null || ground === null) continue;
      const h = top - ground;
      chm.data[row * width + col] = h > 0 ? h : 0;
    }
  }

  return fillSingleCellPits(chm, { marginM: pitFillMarginM });
}

// ---------------------------------------------------------------------------
// Candidate boxes -> crown polygons
// ---------------------------------------------------------------------------

/**
 * Read a candidate box feature (the DeepForest contract: an axis-aligned
 * rectangle `Polygon`, `score` and `box_id` properties) down to the plain
 * bounds `crownFromBox` wants. Pure geometry, kept here rather than in
 * `forest-run.mjs` so `forest-test.mjs` can build fixtures the same way the
 * real pipeline reads its input, rather than fabricating a second shape.
 */
export function boxFromFeature(feature) {
  const ring = feature.geometry.coordinates[0];
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
    minX, minY, maxX, maxY,
    boxId: feature.properties?.box_id ?? null,
    score: Number.isFinite(feature.properties?.score) ? feature.properties.score : null,
  };
}

/**
 * A candidate box's crown, tied to real elevation rather than to its own
 * rectangle.
 *
 * ## The apex belongs to the box, never the halo
 *
 * The highest CHM cell is searched for only inside the box's own footprint,
 * not the padded window around it. DeepForest drew this box around a
 * particular treetop in the orthomosaic; if the search were allowed to range
 * over the padding, a taller neighbour half outside the box could steal the
 * apex, and every attribute downstream would describe the wrong tree.
 *
 * ## The threshold is per box, and anchored to this box's own apex
 *
 * `threshold = max(minHeight, apexHeight * thresholdFraction)`. A fixed
 * absolute threshold would either miss short, real trees (the threshold set
 * for the tallest canopy on the survey) or merge a tall tree with everything
 * around its base (the threshold set for the shortest). Anchoring to the
 * apex this box actually found makes the threshold self-scaling, which is
 * the same argument §3.2 of the plan made for a height-scaled search radius,
 * carried over to a box-driven pipeline.
 *
 * ## The radius fence is what separates two trees whose canopies touch
 *
 * A pure threshold mask can span two adjacent crowns wherever they touch at
 * or above the threshold — real canopies do touch. `maxCrownRadius` caps how
 * far from *this box's* apex a cell may be and still count, so a neighbour's
 * crown is excluded by distance even on a survey where the two physically
 * overlap. `scripts/forest-test.mjs`'s two-cone case is exactly this
 * situation and asserts each box's own apex stays inside its own segment.
 *
 * ## Reused rather than reimplemented
 *
 * The boundary trace is `polygonizeComponents` from `vectorise.mjs` — the
 * same function catchments and basins use — run once over the padded
 * window's threshold mask, with the returned label at the apex's own cell
 * picking out which of (possibly several) components in that window is this
 * box's crown. `simplifyCollinear` runs inside it already, so nothing here
 * touches boundary tracing directly.
 *
 * @returns `null` when the box has no data at all in its footprint (fully
 *   off the survey). Otherwise an object that is always `{ boxId, apex,
 *   apexHeight, rejected }`, with `rejected` naming why no crown could be
 *   built (`"below_min_height"`, `"apex_not_in_mask"`, `"no_polygon"`) or
 *   `null` on success, in which case `threshold`, `cells`, `boundaryCells`
 *   and `polygon` are also present.
 */
export function crownFromBox(box, chmGrid, options = {}) {
  const { padRadius = 2, thresholdFraction = 0.4, minHeight = 2, maxCrownRadius = 6 } = options;
  const { minX, minY, maxX, maxY } = box;
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const col0 = clampInt(Math.floor((minX - padRadius - chmGrid.originX) / chmGrid.cellSize), 0, chmGrid.width - 1);
  const row0 = clampInt(Math.floor((chmGrid.originY - (maxY + padRadius)) / chmGrid.cellSize), 0, chmGrid.height - 1);
  const col1 = clampInt(Math.ceil((maxX + padRadius - chmGrid.originX) / chmGrid.cellSize), 0, chmGrid.width - 1);
  const row1 = clampInt(Math.ceil((chmGrid.originY - (minY - padRadius)) / chmGrid.cellSize), 0, chmGrid.height - 1);
  if (col0 > col1 || row0 > row1) return null;

  let apexCol = -1;
  let apexRow = -1;
  let apexHeight = -Infinity;
  for (let row = row0; row <= row1; row += 1) {
    const y = chmGrid.yOf(row);
    if (y < minY || y > maxY) continue;
    for (let col = col0; col <= col1; col += 1) {
      const x = chmGrid.xOf(col);
      if (x < minX || x > maxX) continue;
      const v = chmGrid.get(col, row);
      if (chmGrid.isNoData(v)) continue;
      if (v > apexHeight) { apexHeight = v; apexCol = col; apexRow = row; }
    }
  }
  if (apexCol < 0) return null;

  if (apexHeight < minHeight) {
    return { boxId: box.boxId, apex: { col: apexCol, row: apexRow }, apexHeight, rejected: "below_min_height" };
  }

  const threshold = Math.max(minHeight, apexHeight * thresholdFraction);
  const apexX = chmGrid.xOf(apexCol);
  const apexY = chmGrid.yOf(apexRow);

  const w = col1 - col0 + 1;
  const h = row1 - row0 + 1;
  const mask = new Uint8Array(w * h);
  for (let row = row0; row <= row1; row += 1) {
    for (let col = col0; col <= col1; col += 1) {
      const v = chmGrid.get(col, row);
      if (chmGrid.isNoData(v) || v < threshold) continue;
      const x = chmGrid.xOf(col);
      const y = chmGrid.yOf(row);
      if (Math.hypot(x - apexX, y - apexY) > maxCrownRadius) continue;
      mask[(row - row0) * w + (col - col0)] = 1;
    }
  }

  // A Grid-shaped geometry carrier for `polygonizeComponents`, which reads
  // only `width`/`height`/`cellSize`/`originX`/`originY` off it. The data
  // array is never touched by that function — the mask above is the payload.
  const windowGrid = new Grid({
    width: w, height: h, cellSize: chmGrid.cellSize,
    originX: chmGrid.originX + col0 * chmGrid.cellSize,
    originY: chmGrid.originY - row0 * chmGrid.cellSize,
    data: new Float32Array(0), nodata: chmGrid.nodata, epsg: chmGrid.epsg,
  });

  const apexLocalCol = apexCol - col0;
  const apexLocalRow = apexRow - row0;
  if (mask[apexLocalRow * w + apexLocalCol] !== 1) {
    // Cannot happen given threshold <= apexHeight above; named rather than
    // left to throw if that invariant is ever loosened.
    return { boxId: box.boxId, apex: { col: apexCol, row: apexRow }, apexHeight, rejected: "apex_not_in_mask" };
  }

  const { labels, components } = polygonizeComponents({ data: mask }, windowGrid);
  const apexLabel = labels[apexLocalRow * w + apexLocalCol];
  const component = components.find((c) => c.label === apexLabel);
  if (!component || component.rings.length === 0) {
    return { boxId: box.boxId, apex: { col: apexCol, row: apexRow }, apexHeight, rejected: "no_polygon" };
  }
  // Four-connected labelling cannot produce two disjoint patches under one
  // label, so `component.rings` holding more than one polygon would mean a
  // hole-only split `groupRingsIntoPolygons` resolved oddly; guarded by
  // keeping the larger one rather than assumed impossible.
  const polygonRings = component.rings.length === 1
    ? component.rings[0]
    : component.rings.reduce((best, r) => (Math.abs(ringArea(r[0])) > Math.abs(ringArea(best[0])) ? r : best));

  const cells = [];
  const boundaryCells = [];
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let row = row0; row <= row1; row += 1) {
    for (let col = col0; col <= col1; col += 1) {
      const li = (row - row0) * w + (col - col0);
      if (labels[li] !== apexLabel) continue;
      cells.push({ col, row });
      let onBoundary = false;
      for (const [dc, dr] of NEIGHBOURS) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < col0 || nc > col1 || nr < row0 || nr > row1) { onBoundary = true; break; }
        if (labels[(nr - row0) * w + (nc - col0)] !== apexLabel) { onBoundary = true; break; }
      }
      if (onBoundary) boundaryCells.push({ col, row });
    }
  }

  return {
    boxId: box.boxId,
    apex: { col: apexCol, row: apexRow },
    apexHeight,
    threshold,
    cells,
    boundaryCells,
    polygon: { rings: polygonRings },
    rejected: null,
  };
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * Area, perimeter and three diameters, exactly as `docs/forest-tools-plan.md`
 * §3.4 defines them — deliberately different numbers, kept separate rather
 * than collapsed into one "diameter" the way three call sites drifting apart
 * would eventually do:
 *
 * - **max diameter** — the farthest pair of points on the convex hull.
 * - **min diameter** — the polygon's true minimum width, over every
 *   direction, not merely its narrowest bounding-box side.
 * - **avg diameter** — the diameter of a circle with the same area,
 *   `2 * sqrt(area / pi)`. Independent of shape entirely; two crowns of equal
 *   area report the same average diameter however different their outlines.
 */
export function crownMetrics(polygon) {
  const [outer, ...holes] = polygon.rings;
  const area = Math.abs(ringArea(outer)) - holes.reduce((s, hRing) => s + Math.abs(ringArea(hRing)), 0);
  const perimeter = ringLength(outer);
  const points = outer.slice(0, -1); // drop the repeated closing vertex
  const hull = convexHull(points);
  const { minWidth, maxDiameter, minAreaRect } = hullMeasures(hull);
  const avgDiameter = area > 0 ? 2 * Math.sqrt(area / Math.PI) : 0;
  return {
    area,
    perimeter,
    maxDiameter,
    minDiameter: minWidth,
    avgDiameter,
    minAreaRectArea: minAreaRect.area,
    hullVertexCount: hull.length,
  };
}

// ---------------------------------------------------------------------------
// Non-tree rejection, §3.5
// ---------------------------------------------------------------------------

/**
 * The six discriminators of §3.5, each computed and returned individually so
 * a client-facing popup can say *why* a tree scored low rather than only
 * that it did (§3.6's requirement).
 *
 * `pointStats` and `greenness` are optional, precomputed enrichments — this
 * function does no I/O, so a caller that walked the point cloud or sampled
 * the orthomosaic hands the results in rather than a path to read them from.
 * Missing either one degrades gracefully: the discriminator reports
 * `available: false` rather than a fabricated value, and `confidenceScore`
 * downstream treats an unavailable discriminator as absent evidence, never
 * as a failing one. A Kotba tree, which has neither a point cloud nor an
 * orthomosaic-derived greenness figure computed for it, is exactly this case.
 *
 * @param segment the object `crownFromBox` returns on success: `{ cells,
 *   boundaryCells, apex, area, minAreaRectArea }`. Heights are looked up
 *   fresh from `chmGrid` by cell coordinate rather than carried on the
 *   segment, so a caller building a synthetic segment by hand (as
 *   `forest-test.mjs` does for the flat-roof case) only has to supply cell
 *   coordinates and a grid, not a third copy of every height.
 */
export function rejectNonTree(segment, chmGrid, options = {}) {
  const {
    flatBandM = 0.25,
    rejectFlatnessMin = 0.7,
    rejectRectangularityMin = 0.85,
    pointStats = null,
    greenness = null,
  } = options;

  const apexHeight = chmGrid.get(segment.apex.col, segment.apex.row);
  const cellHeights = segment.cells.map(({ col, row }) => chmGrid.get(col, row));
  const median = medianOf(cellHeights);

  // 1. Flatness: a roof holds its cells within a narrow band around the
  // median; a crown's foliage does not.
  const withinBand = cellHeights.filter((v) => Math.abs(v - median) <= flatBandM).length;
  const flatness = cellHeights.length ? withinBand / cellHeights.length : 0;

  // 2. Rectangularity: how much of the crown's own minimum bounding
  // rectangle it actually fills. A building approaches 1; a rounded crown
  // sits near pi/4 (~0.785) even when perfectly circular.
  const rectangularity = segment.minAreaRectArea > 0 ? segment.area / segment.minAreaRectArea : null;

  // 3. Apex prominence: a crown has a distinct high point over its own rim; a
  // roof's edge sits nearly as high as its centre.
  const boundaryHeights = segment.boundaryCells.map(({ col, row }) => chmGrid.get(col, row));
  const boundaryMedian = medianOf(boundaryHeights);
  const apexProminence = apexHeight > 0 && boundaryHeights.length > 0
    ? (apexHeight - boundaryMedian) / apexHeight
    : null;

  // 4. Radial decay: height should fall away from the apex for a crown
  // (strong positive correlation between distance and height-drop) and stay
  // flat for a structure (correlation near zero).
  const apexX = chmGrid.xOf(segment.apex.col);
  const apexY = chmGrid.yOf(segment.apex.row);
  const distances = [];
  const drops = [];
  for (const { col, row } of segment.cells) {
    distances.push(Math.hypot(chmGrid.xOf(col) - apexX, chmGrid.yOf(row) - apexY));
    drops.push(apexHeight - chmGrid.get(col, row));
  }
  const radialDecay = pearson(distances, drops);

  // 5. Return porosity, point-cloud only. A roof is opaque: no multiple
  // returns pass through it and nothing classified ground appears beneath.
  const returnPorosity = pointStats
    ? {
        available: true,
        multiReturnFraction: pointStats.multiReturnFraction,
        groundReturnsBeneath: pointStats.groundReturnsBeneath,
      }
    : { available: false };

  // 6. Greenness, where an orthomosaic exists. RGB only — no NDVI, there is
  // no near-infrared band in any survey here.
  const greennessResult = greenness
    ? { available: true, excessGreenMean: greenness.excessGreenMean }
    : { available: false };

  // A segment failing hard on BOTH flatness and rectangularity is dropped as
  // a structure outright, per §3.5. Everything else, including a segment
  // that is merely flat-ish or merely boxy but not both, still feeds
  // `confidenceScore` rather than being silently discarded.
  const isStructure = flatness >= rejectFlatnessMin
    && rectangularity !== null && rectangularity >= rejectRectangularityMin;

  return {
    discriminators: { flatness, rectangularity, apexProminence, radialDecay, returnPorosity, greenness: greennessResult },
    isStructure,
    reason: isStructure ? "flat_and_rectangular" : null,
  };
}

// ---------------------------------------------------------------------------
// Confidence, §3.6 (plus the model score, per the pivot addendum)
// ---------------------------------------------------------------------------

/**
 * Default weight per component. `returnPorosity` carries the most weight
 * deliberately: at Ektanagar 1's 31% multi-return rate it is, per §1.1 and
 * §3.5 point 5, the strongest single signal this dataset can offer, when it
 * is available at all. `modelScore` is weighted above the geometric
 * discriminators individually but below porosity, reflecting that DeepForest
 * already looked at the whole orthomosaic rather than one box in isolation,
 * while still being one trained model's opinion rather than a physical
 * measurement.
 */
export const DEFAULT_CONFIDENCE_WEIGHTS = Object.freeze({
  flatness: 1,
  rectangularity: 1,
  apexProminence: 1.5,
  radialDecay: 1,
  returnPorosity: 2,
  greenness: 1,
  modelScore: 1.5,
});

/**
 * Combine the six §3.5 discriminators and DeepForest's own per-box `score`
 * into one 0-1 confidence figure, stored component by component.
 *
 * Every component is mapped onto a 0-1 "goodness" — 1 reads as tree-like, 0
 * as structure-like — before being weight-averaged, so the combination step
 * never has to know that flatness and rectangularity read backwards from
 * apex prominence and the model score. Honesty about missing evidence is not
 * an afterthought: the weighted average runs only over the components that
 * are actually present, so a Kotba tree with neither a point cloud nor a
 * greenness figure is scored from five inputs rather than seven, and
 * `evidenceOf` and `note` say so explicitly rather than letting a caller
 * assume every tree was judged on the same evidence.
 */
export function confidenceScore(discriminators, modelScore, options = {}) {
  const { weights = DEFAULT_CONFIDENCE_WEIGHTS } = options;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const components = {};

  components.flatness = { available: true, value: discriminators.flatness, goodness: clamp01(1 - discriminators.flatness), weight: weights.flatness };

  components.rectangularity = discriminators.rectangularity === null
    ? { available: false }
    : { available: true, value: discriminators.rectangularity, goodness: clamp01(1 - discriminators.rectangularity), weight: weights.rectangularity };

  components.apexProminence = discriminators.apexProminence === null
    ? { available: false }
    : { available: true, value: discriminators.apexProminence, goodness: clamp01(discriminators.apexProminence), weight: weights.apexProminence };

  components.radialDecay = discriminators.radialDecay === null
    ? { available: false }
    : { available: true, value: discriminators.radialDecay, goodness: clamp01(discriminators.radialDecay), weight: weights.radialDecay };

  components.returnPorosity = discriminators.returnPorosity?.available
    ? {
        available: true,
        value: discriminators.returnPorosity,
        // 70/30 split: the multi-return fraction is a continuous, graded
        // signal; a ground return beneath the crown is closer to a yes/no
        // fact, so it contributes as a bonus rather than on the same scale.
        goodness: clamp01(
          0.7 * clamp01(discriminators.returnPorosity.multiReturnFraction)
            + 0.3 * (discriminators.returnPorosity.groundReturnsBeneath > 0 ? 1 : 0),
        ),
        weight: weights.returnPorosity,
      }
    : { available: false };

  components.greenness = discriminators.greenness?.available
    ? {
        available: true,
        value: discriminators.greenness.excessGreenMean,
        // 60 (of a possible +/-510 for 8-bit RGB excess-green) is a working
        // placeholder for "clearly vegetation", not a calibrated figure —
        // there is no ground truth on this survey to calibrate it against
        // (plan §0.1 row 2), and this is exactly the kind of constant that
        // belongs in the manifest once one exists to tune it.
        goodness: clamp01(discriminators.greenness.excessGreenMean / 60),
        weight: weights.greenness,
      }
    : { available: false };

  components.modelScore = Number.isFinite(modelScore)
    ? { available: true, value: modelScore, goodness: clamp01(modelScore), weight: weights.modelScore }
    : { available: false };

  let weightSum = 0;
  let goodnessSum = 0;
  let evidenceCount = 0;
  for (const key of Object.keys(components)) {
    const c = components[key];
    if (!c.available) continue;
    weightSum += c.weight;
    goodnessSum += c.weight * c.goodness;
    evidenceCount += 1;
  }
  const evidenceOf = Object.keys(components).length;
  const score = weightSum > 0 ? goodnessSum / weightSum : 0;

  return {
    score: Number(score.toFixed(4)),
    components,
    evidenceCount,
    evidenceOf,
    note: evidenceCount < evidenceOf
      ? `Computed from ${evidenceCount} of ${evidenceOf} possible inputs; the missing ones are omitted from the average, not scored as failing.`
      : `Computed from all ${evidenceOf} inputs.`,
  };
}

// ---------------------------------------------------------------------------
// DBH, §3.7
// ---------------------------------------------------------------------------

/** Returned in place of a number whenever a DBH attempt does not clear the bar. Never a fabricated radius. */
export const DBH_NOT_RELIABLE = "Not reliably detectable";

/**
 * Taubin's algebraic circle fit (the Newton-on-eta form, after Chernov).
 *
 * Minimises an approximation of the true geometric (orthogonal) distance from
 * each point to the circle, which is why it is preferred here over the
 * simpler Kåsa fit: Kåsa is biased towards smaller circles when points sample
 * less than a full ring, and a stem-band point cloud is exactly that — an arc
 * around one side of the trunk, never a full collar. Returns null rather than
 * throwing when the Newton iteration fails to produce a usable result, which
 * `estimateDbh` turns into the "not reliably detectable" sentinel like every
 * other failure mode.
 */
function taubinCircleFit(points) {
  const n = points.length;
  let xBar = 0;
  let yBar = 0;
  for (const [x, y] of points) { xBar += x; yBar += y; }
  xBar /= n;
  yBar /= n;

  let Mxx = 0;
  let Myy = 0;
  let Mxy = 0;
  let Mxz = 0;
  let Myz = 0;
  let Mzz = 0;
  for (const [x, y] of points) {
    const u = x - xBar;
    const v = y - yBar;
    const z = u * u + v * v;
    Mxx += u * u; Myy += v * v; Mxy += u * v; Mxz += u * z; Myz += v * z; Mzz += z * z;
  }
  Mxx /= n; Myy /= n; Mxy /= n; Mxz /= n; Myz /= n; Mzz /= n;

  const Mz = Mxx + Myy;
  const covXy = Mxx * Myy - Mxy * Mxy;
  const A3 = 4 * Mz;
  const A2 = -3 * Mz * Mz - Mzz;
  const A1 = Mzz * Mz + 4 * covXy * Mz - Mxz * Mxz - Myz * Myz - Mz * Mz * Mz;
  const A0 = Mxz * Mxz * Myy + Myz * Myz * Mxx - Mzz * covXy - 2 * Mxz * Myz * Mxy + Mz * Mz * covXy;
  const A22 = A2 * 2;
  const A33 = A3 * 3;

  let eta = 0;
  for (let iter = 0; iter < 99; iter += 1) {
    const yVal = A0 + eta * (A1 + eta * (A2 + eta * A3));
    const dy = A1 + eta * (A22 + A33 * eta);
    if (dy === 0) break;
    const etaNew = eta - yVal / dy;
    if (!Number.isFinite(etaNew)) return null;
    const converged = Math.abs(etaNew - eta) < 1e-12 * (1 + Math.abs(eta));
    eta = etaNew;
    if (converged) break;
  }

  const det = eta * eta - eta * Mz + covXy;
  if (det === 0 || !Number.isFinite(det)) return null;
  const centreXu = ((Mxz * (Myy - eta) - Myz * Mxy) / det) / 2;
  const centreYu = ((Myz * (Mxx - eta) - Mxz * Mxy) / det) / 2;
  const radiusSq = centreXu * centreXu + centreYu * centreYu + Mz;
  if (!(radiusSq > 0)) return null;
  return { centreX: centreXu + xBar, centreY: centreYu + yBar, radius: Math.sqrt(radiusSq) };
}

/**
 * A cheap, closed-form algebraic circle fit (Kåsa's method — minimise
 * `x²+y²+Dx+Ey+F` in the least-squares sense, a single 3x3 linear solve).
 *
 * Used only to seed the angular-spread gate below, never as the accepted
 * answer: Kåsa is known to be biased on a partial arc (it tends to pull the
 * fitted radius inward), which is exactly why Taubin's fit is used for the
 * number that gets reported. But the gate does not need an unbiased radius,
 * it needs a centre that is actually near the stem, and Kåsa's is close
 * enough for that even when its radius is not the final word.
 *
 * @returns `null` on a degenerate (near-collinear) input, which the gate
 *   turns into a refusal like any other failure to find a circle at all.
 */
function kasaCircleCenter(points) {
  const n = points.length;
  /*
   * Centred on the points' own mean before anything else is computed, for a
   * reason that only shows up on real data: these points arrive in UTM
   * metres, six or seven digits before the decimal point, describing a
   * circle a few centimetres across. `Sxz` and `Syz` below are third-order
   * sums — x times (x^2+y^2) — so an uncentred easting around 3.68e5 cubes
   * to roughly 5e16, a hair under double precision's 2^53 (~9e15) exact-
   * integer ceiling. The stem's actual 12 cm of shape is encoded in
   * cancellation between terms of that size, and it is lost before the
   * matrix is even built. It is not a rare edge case: it is what every real
   * call to this function looks like, since nothing here is ever called
   * with small, origin-relative numbers outside a test. Subtracting the
   * mean first — exactly what `taubinCircleFit` already does, and the same
   * fix in the same place — brings every sum back down to the circle's own
   * scale, where a double has all the precision this needs.
   */
  let meanX = 0, meanY = 0;
  for (const [x, y] of points) { meanX += x; meanY += y; }
  meanX /= n; meanY /= n;

  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (const [px, py] of points) {
    const x = px - meanX;
    const y = py - meanY;
    const z = x * x + y * y;
    Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sxz += x * z; Syz += y * z; Sz += z;
  }
  // [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy n] [D E F]' = [-Sxz -Syz -Sz]', by Gaussian
  // elimination with partial pivoting rather than Cramer's rule, which is
  // needlessly unstable for a matrix this cheap to pivot.
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
  const v = [-Sxz, -Syz, -Sz];
  for (let i = 0; i < 3; i += 1) {
    let pivot = i;
    for (let k = i + 1; k < 3; k += 1) if (Math.abs(M[k][i]) > Math.abs(M[pivot][i])) pivot = k;
    if (Math.abs(M[pivot][i]) < 1e-12) return null; // near-collinear points
    [M[i], M[pivot]] = [M[pivot], M[i]];
    [v[i], v[pivot]] = [v[pivot], v[i]];
    for (let k = i + 1; k < 3; k += 1) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j < 3; j += 1) M[k][j] -= f * M[i][j];
      v[k] -= f * v[i];
    }
  }
  const coeffs = [0, 0, 0];
  for (let i = 2; i >= 0; i -= 1) {
    let s = v[i];
    for (let j = i + 1; j < 3; j += 1) s -= M[i][j] * coeffs[j];
    coeffs[i] = s / M[i][i];
  }
  const [D, E] = coeffs;
  return { centreX: -D / 2 + meanX, centreY: -E / 2 + meanY };
}

/**
 * DBH from a stem-band point cloud, per §3.7 — attempted properly and
 * expected to mostly fail, which the plan states in bold and this function
 * enforces by construction rather than by convention.
 *
 * ## The ordering is the entire point
 *
 * Angular spread is checked *before* the accepted (Taubin) circle is fit. A
 * fit to a one-sided arc is not merely inaccurate, it is confidently wrong —
 * an unconstrained algebraic fit to a shallow arc happily returns a small,
 * tight-looking circle nowhere near the real trunk — and checking spread
 * only after fitting would let exactly that number through.
 *
 * ## Why the gate is measured about a Kåsa fit, not the point centroid
 *
 * The first version of this function measured spread about the plain
 * centroid of the points, and it does not work: the centroid of points
 * sampled along ANY shallow arc sits close to the arc's own chord, and a
 * point near a chord sees the two ends of that chord roughly 180° apart *by
 * definition of being near the line between them* — every arc from 10° to
 * 170° measured this way came back reporting 180-240° of "spread", which is
 * the gate agreeing to fit exactly the one-sided cases it exists to refuse.
 * A cheap preliminary circle fit (`kasaCircleCenter`) does not have this
 * problem: its centre estimate sits near the true stem centre — outside the
 * arc, on its concave side — for the same reason any circle fit does, so
 * spread measured about it tracks the arc's true angular coverage rather
 * than an artefact of where the points' own average happens to sit.
 *
 * @param pointsInStemBand `[x, y]` pairs, already filtered by the caller to
 *   the plan's 1.0-2.0 m normalised height band and to one candidate crown's
 *   footprint. This function does no filtering of its own — it has no LAS to
 *   read, per the pure-functions rule this whole module follows.
 */
export function estimateDbh(pointsInStemBand, options = {}) {
  const {
    minPoints = 12,
    minAngularSpreadDeg = 180,
    maxRmsM = 0.03,
    minRadiusM = 0.025,
    maxRadiusM = 0.60,
  } = options;

  const points = pointsInStemBand ?? [];
  if (points.length < minPoints) {
    return { dbh: DBH_NOT_RELIABLE, reason: `fewer than ${minPoints} points in the stem band (${points.length})`, pointCount: points.length };
  }

  const seed = kasaCircleCenter(points);
  if (!seed) {
    return { dbh: DBH_NOT_RELIABLE, reason: "points are too close to collinear to suggest any circle", pointCount: points.length };
  }
  const { centreX: cx, centreY: cy } = seed;

  const angles = points.map(([x, y]) => Math.atan2(y - cy, x - cx)).sort((a, b) => a - b);
  let maxGap = 2 * Math.PI - (angles[angles.length - 1] - angles[0]);
  for (let i = 1; i < angles.length; i += 1) {
    const gap = angles[i] - angles[i - 1];
    if (gap > maxGap) maxGap = gap;
  }
  const spreadDeg = (2 * Math.PI - maxGap) * (180 / Math.PI);
  if (spreadDeg < minAngularSpreadDeg) {
    return {
      dbh: DBH_NOT_RELIABLE,
      reason: `angular spread ${spreadDeg.toFixed(1)}° is under the ${minAngularSpreadDeg}° bar`,
      pointCount: points.length,
      angularSpreadDeg: spreadDeg,
    };
  }

  const fit = taubinCircleFit(points);
  if (!fit) {
    return { dbh: DBH_NOT_RELIABLE, reason: "circle fit did not converge", pointCount: points.length, angularSpreadDeg: spreadDeg };
  }

  const { centreX, centreY, radius } = fit;
  let sumSq = 0;
  for (const [x, y] of points) {
    const d = Math.hypot(x - centreX, y - centreY) - radius;
    sumSq += d * d;
  }
  const rms = Math.sqrt(sumSq / points.length);

  if (rms >= maxRmsM || radius < minRadiusM || radius > maxRadiusM) {
    return {
      dbh: DBH_NOT_RELIABLE,
      reason: rms >= maxRmsM
        ? `RMS residual ${(rms * 100).toFixed(1)} cm exceeds the ${(maxRmsM * 100).toFixed(0)} cm bar`
        : `fitted radius ${(radius * 100).toFixed(1)} cm is outside [${minRadiusM * 100}, ${maxRadiusM * 100}] cm`,
      pointCount: points.length,
      angularSpreadDeg: spreadDeg,
      rmsM: rms,
      radiusM: radius,
    };
  }

  // Girth is derived FROM the rounded DBH, not independently rounded from the
  // raw radius. Rounding both from the same unrounded value but separately
  // can leave `girth !== pi * dbh` by a rounding hair, and a client checking
  // that identity by hand should never see it fail on a number we published.
  const dbh = Number((radius * 2).toFixed(4));
  return {
    dbh,
    girth: Number((Math.PI * dbh).toFixed(4)),
    radiusM: radius,
    rmsM: rms,
    angularSpreadDeg: spreadDeg,
    pointCount: points.length,
    centre: [centreX, centreY],
    estimated: true,
  };
}

// ---------------------------------------------------------------------------
// Height classes, §4
// ---------------------------------------------------------------------------

/**
 * Malhar's ten default bands, half-open `[min, max)` and contiguous from 0.
 * Plain data, not a switch statement, because the client-side filter panel
 * (a later wave, per the plan §5.4) reads and edits this same shape.
 */
export const DEFAULT_HEIGHT_CLASSES = Object.freeze([
  { label: "0–2 m", min: 0, max: 2 },
  { label: "2–3 m", min: 2, max: 3 },
  { label: "3–4 m", min: 3, max: 4 },
  { label: "4–5 m", min: 4, max: 5 },
  { label: "5–6 m", min: 5, max: 6 },
  { label: "6–7 m", min: 6, max: 7 },
  { label: "7–8 m", min: 7, max: 8 },
  { label: "8–10 m", min: 8, max: 10 },
  { label: "10–15 m", min: 10, max: 15 },
  { label: ">15 m", min: 15, max: Infinity },
]);

/**
 * Which band a height falls in, by binary search over a sorted, contiguous,
 * half-open `classDefs` list. `classDefs` is a plain argument rather than a
 * hardcoded table so a client's edited bands (§5.4: add, remove, redefine)
 * can be looked up with the identical function the default bands use.
 *
 * Returns `null` for a height that is not finite, or that falls outside every
 * band `classDefs` covers (a negative height, or a gap the caller's own
 * edited bands left open) — never the nearest band, which would misreport a
 * gap as data.
 */
export function heightClass(height, classDefs = DEFAULT_HEIGHT_CLASSES) {
  if (!Number.isFinite(height)) return null;
  let lo = 0;
  let hi = classDefs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = classDefs[mid];
    if (height < c.min) hi = mid - 1;
    else if (height >= c.max) lo = mid + 1;
    else return c;
  }
  return null;
}

export { Grid };
