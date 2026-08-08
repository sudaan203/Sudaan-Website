/**
 * Turning hydrology rasters into vectors a client can open in CAD or GIS.
 *
 * Two conversions, with quite different shapes.
 *
 * `polygonize` traces the outline of a 0/1 mask, for catchments and basins. It
 * follows cell edges rather than smoothing, which produces the staircase outline
 * every GIS package produces from a raster. That is the honest shape: a
 * catchment derived from a 1 m grid is known to 1 m, and drawing it as a smooth
 * curve would imply a precision the analysis does not have.
 *
 * `vectoriseStreams` walks the flow network into segments between junctions,
 * which is the same structure SAGA writes: their `channel network.dbf` carries
 * SEGMENT_ID, NODE_A, NODE_B and ORDER. Producing the same structure means the
 * segment count is directly comparable, which is another independent check on
 * top of the cell-by-cell agreement in `hydro-validate.mjs`.
 *
 * On coordinates: everything here works in the grid's projected CRS, and
 * `toGeoJson` converts to WGS84 at the very last step because RFC 7946 requires
 * lon/lat. The projected easting and northing are kept in the properties, since
 * that is what a surveyor actually wants to type into a total station, and the
 * conversion is never applied twice.
 */

import { utmToLonLat } from "./geo.mjs";
import { downstreamOf } from "./hydrology.mjs";

/**
 * Closed rings around every connected run of set cells in a mask.
 *
 * Works by emitting one directed edge for each cell side that faces a cell
 * outside the mask, oriented so the inside is always on the left. Chaining those
 * edges head to tail then closes every ring automatically, and orientation falls
 * out for free: outer rings come back counter clockwise and holes clockwise,
 * which is what GeoJSON asks for and what makes an island in a catchment render
 * as a hole rather than a solid patch.
 */
export function polygonize(mask, grid) {
  const { width, height } = grid;
  const inside = (col, row) =>
    col >= 0 && row >= 0 && col < width && row < height && mask.data[row * width + col] === 1;

  // Directed edges keyed by their start corner, in corner coordinates.
  const edges = new Map();
  const key = (col, row) => row * (width + 1) + col;
  const addEdge = (c0, r0, c1, r1) => {
    const k = key(c0, r0);
    const list = edges.get(k);
    if (list) list.push([c1, r1]);
    else edges.set(k, [[c1, r1]]);
  };

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!inside(col, row)) continue;
      // Counter clockwise around the cell in projected space, where north is up
      // and row increases southwards.
      if (!inside(col, row + 1)) addEdge(col, row + 1, col + 1, row + 1); // south side
      if (!inside(col + 1, row)) addEdge(col + 1, row + 1, col + 1, row); // east side
      if (!inside(col, row - 1)) addEdge(col + 1, row, col, row);         // north side
      if (!inside(col - 1, row)) addEdge(col, row, col, row + 1);         // west side
    }
  }

  const rings = [];
  for (const [startKey, startList] of edges) {
    while (startList.length > 0) {
      const startCol = startKey % (width + 1);
      const startRow = (startKey - startCol) / (width + 1);
      const ring = [[startCol, startRow]];
      let [col, row] = startList.pop();

      // Walk until the chain closes. Bounded by the edge count so a malformed
      // mask cannot spin here forever.
      let guard = width * height * 4 + 8;
      while (!(col === startCol && row === startRow) && guard > 0) {
        ring.push([col, row]);
        const list = edges.get(key(col, row));
        if (!list || list.length === 0) break;
        // At a vertex where two diagonal cells touch, two edges leave the same
        // corner. Either choice yields a valid partition of the same area; take
        // the last so the walk stays deterministic.
        const next = list.pop();
        col = next[0];
        row = next[1];
        guard -= 1;
      }
      ring.push([startCol, startRow]);
      if (ring.length >= 4) rings.push(ring);
    }
  }

  // Corner indices to projected metres, and drop collinear points: a staircase
  // along a straight edge is hundreds of vertices describing one line.
  return rings.map((ring) => simplifyCollinear(ring).map(([c, r]) => [grid.cornerX(c), grid.cornerY(r)]));
}

/**
 * Remove the middle of any three consecutive collinear vertices.
 *
 * Cyclic rather than linear, because the ring is closed and the walk starts
 * wherever the edge map happened to be iterated from. That start point is
 * usually the middle of a straight side, and a linear pass can never remove it:
 * it has no predecessor to compare against. A plain 3 x 3 square came back with
 * five corners instead of four for exactly that reason.
 *
 * Runs to a fixed point, since removing one vertex can make its neighbours
 * collinear in turn along a staircase.
 */
function simplifyCollinear(ring) {
  const pts = ring.slice(0, -1); // drop the repeated closing point
  if (pts.length < 4) return ring;

  let changed = true;
  let guard = pts.length * 2;
  while (changed && guard > 0) {
    changed = false;
    guard -= 1;
    for (let i = 0; i < pts.length && pts.length > 3; i += 1) {
      const [ax, ay] = pts[(i - 1 + pts.length) % pts.length];
      const [bx, by] = pts[i];
      const [cx, cy] = pts[(i + 1) % pts.length];
      if ((bx - ax) * (cy - by) === (by - ay) * (cx - bx)) {
        pts.splice(i, 1);
        changed = true;
        i -= 1;
      }
    }
  }
  return [...pts, pts[0]];
}

/** Signed area of a ring in projected units. Positive is counter clockwise. */
export function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/**
 * Split a flow network into segments running between junctions.
 *
 * A node is a cell where the network structurally changes: a source with nothing
 * upstream, a junction where two or more channels arrive, or an outlet where the
 * channel leaves the network. Everything between two nodes is one segment of
 * constant Strahler order, which is what makes the order a sensible attribute to
 * hang on a line rather than on every cell.
 */
export function vectoriseStreams(dir, streams, order, grid) {
  const { width } = grid;
  const upstreamCount = new Int32Array(grid.length);
  for (let i = 0; i < grid.length; i += 1) {
    if (!streams.data[i]) continue;
    const d = downstreamOf(dir, i);
    if (d >= 0 && streams.data[d]) upstreamCount[d] += 1;
  }

  // A node is where the network structurally changes: nothing upstream (a
  // source) or more than one thing upstream (a junction). Everything else is
  // the middle of a channel.
  const isNode = (i) => upstreamCount[i] !== 1;
  const segments = [];

  // Each cell has exactly one downstream, so each node begins at most one
  // segment, running from that node to the next one. Walking from every node
  // therefore covers the network exactly once with no overlaps and no gaps.
  for (let start = 0; start < grid.length; start += 1) {
    if (!streams.data[start] || !isNode(start)) continue;

    const path = [start];
    let current = start;
    let guard = grid.length;
    for (;;) {
      const next = downstreamOf(dir, current);
      if (next < 0 || !streams.data[next]) break;
      path.push(next);
      current = next;
      if (isNode(next)) break;
      if ((guard -= 1) <= 0) break;
    }
    if (path.length < 2) continue; // an outlet with nowhere to go

    const coords = path.map((i) => {
      const c = i % width;
      const r = (i - c) / width;
      return [grid.xOf(c), grid.yOf(r)];
    });
    let length = 0;
    for (let i = 1; i < coords.length; i += 1) {
      length += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    }

    segments.push({
      coords,
      // Taken from the first cell, not the last: a segment ending at a junction
      // touches the cell where the order has already been promoted, and
      // labelling the tributary with the trunk's order would be wrong.
      order: order.data[start],
      length,
      cells: path.length,
    });
  }
  return segments;
}

/**
 * Wrap features as a GeoJSON FeatureCollection in WGS84.
 *
 * RFC 7946 fixes the coordinate reference system as lon/lat, so the projected
 * coordinates are converted here and only here. Both are carried: the geometry
 * for anything that reads GeoJSON, and the easting and northing in the
 * properties for the CAD workflow this actually feeds.
 */
export function toGeoJson(features, grid) {
  const utm = grid.utmZone;
  if (!utm) {
    throw new Error(
      `toGeoJson: grid has EPSG ${grid.epsg ?? "unknown"}, which is not a UTM zone. ` +
        `GeoJSON requires WGS84 and the conversion cannot be guessed.`,
    );
  }
  const project = ([x, y]) => {
    const [lon, lat] = utmToLonLat(x, y, utm.zone, utm.northern);
    return [Number(lon.toFixed(8)), Number(lat.toFixed(8))];
  };

  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature",
      geometry:
        f.geometry.type === "LineString"
          ? { type: "LineString", coordinates: f.geometry.coordinates.map(project) }
          : { type: "Polygon", coordinates: f.geometry.coordinates.map((r) => r.map(project)) },
      properties: f.properties,
    })),
  };
}
