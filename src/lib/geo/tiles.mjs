/**
 * Slippy map tiles, and the reprojection between them and a survey grid.
 *
 * ## The whole idea, in one line
 *
 * A tile is a window. `raster-window.mjs` already reads an arbitrary window out
 * of a GeoTIFF over byte ranges, so a dynamic tiler is a thin layer on top of it
 * rather than a container running GDAL. That retires the "two new services for
 * one operator" risk in `docs/dashboard-tools-plan.md` section 5, which was the
 * main cost of the tiler as originally scoped.
 *
 * ## Two coordinate systems, and why the conversion is per pixel
 *
 * Tiles are Web Mercator, EPSG:3857. Every survey here is UTM. Those are
 * different projections, not different units, so the mapping between them is not
 * affine: a square Mercator tile is a slightly curved quadrilateral in UTM, and
 * the distortion grows with the tile's extent.
 *
 * Sampling the four corners and interpolating between them is the fast way and
 * it is wrong in exactly the manner this project keeps guarding against: at low
 * zoom the error is tens of metres, the picture still looks like terrain, and
 * nothing announces that the hillshade is offset from the orthophoto beneath it.
 * So every pixel is unprojected individually. It is 65,536 conversions for a
 * 256 px tile, which is microseconds, and it cannot drift.
 */

const DEG = Math.PI / 180;

/** Longitude and latitude of a point inside a tile, in degrees. */
export function tileLonLat(z, x, y, px, py, size = 256) {
  const n = 2 ** z;
  const lon = ((x + px / size) / n) * 360 - 180;
  const ty = 1 - (2 * (y + py / size)) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * ty)) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * Outer lon/lat bounds of a whole tile.
 * @returns {[number, number, number, number]} [west, south, east, north]
 */
export function tileBoundsLonLat(z, x, y) {
  const [west, north] = tileLonLat(z, x, y, 0, 0);
  const [east, south] = tileLonLat(z, x, y, 1, 1, 1);
  return [west, south, east, north];
}

/**
 * The projected bounding box a tile covers, in the survey's own CRS.
 *
 * Sampled around the tile's edge rather than at its corners alone. The image of
 * a Mercator tile in UTM bulges, so its extreme easting or northing can lie on
 * an edge between two corners; a bbox from the corners alone would clip a sliver
 * off the tile and show a seam. Twelve points per edge is far more than enough
 * and costs nothing next to the per-pixel work that follows.
 *
 * @returns {[number, number, number, number]} [minX, minY, maxX, maxY]
 */
export function tileBoundsProjected(z, x, y, project) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const steps = 12;
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    for (const [px, py] of [
      [f, 0],
      [f, 1],
      [0, f],
      [1, f],
    ]) {
      const [lon, lat] = tileLonLat(z, x, y, px, py, 1);
      const [px2, py2] = project(lon, lat);
      if (px2 < minX) minX = px2;
      if (px2 > maxX) maxX = px2;
      if (py2 < minY) minY = py2;
      if (py2 > maxY) maxY = py2;
    }
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Does a tile overlap a raster at all?
 *
 * Cheap, and worth doing: a survey is a few hundred metres across and the world
 * is not, so at any useful zoom the overwhelming majority of requested tiles
 * miss it entirely and should cost one bounding box test rather than a read.
 */
export function overlaps([aMinX, aMinY, aMaxX, aMaxY], [bMinX, bMinY, bMaxX, bMaxY]) {
  return aMinX <= bMaxX && aMaxX >= bMinX && aMinY <= bMaxY && aMaxY >= bMinY;
}

/**
 * Resample a projected grid into a tile's pixel raster.
 *
 * Bilinear, and nodata-aware in the strict sense: if any of the four
 * contributing cells has no data, the pixel has no data. Interpolating across
 * the edge of a survey would invent ground, and at a survey's ragged boundary
 * that is precisely where a client is most likely to be looking.
 *
 * Returns a grid-shaped object rather than a bare array so `renderGrid` can
 * treat it exactly like any other grid, nodata test included.
 */
export function sampleIntoTile(grid, z, x, y, project, size = 256) {
  const data = new Float32Array(size * size);
  const NODATA = NaN;
  const { width, height, originX, originY, cellSize } = grid;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const [lon, lat] = tileLonLat(z, x, y, px + 0.5, py + 0.5, size);
      const [ex, ny] = project(lon, lat);

      // Continuous cell coordinates, offset by half a cell because a cell's
      // value belongs at its centre.
      const fc = (ex - originX) / cellSize - 0.5;
      const fr = (originY - ny) / cellSize - 0.5;
      const c0 = Math.floor(fc);
      const r0 = Math.floor(fr);

      if (c0 < 0 || r0 < 0 || c0 + 1 >= width || r0 + 1 >= height) {
        data[py * size + px] = NODATA;
        continue;
      }

      const v00 = grid.data[r0 * width + c0];
      const v10 = grid.data[r0 * width + c0 + 1];
      const v01 = grid.data[(r0 + 1) * width + c0];
      const v11 = grid.data[(r0 + 1) * width + c0 + 1];
      if (
        grid.isNoData(v00) || grid.isNoData(v10) ||
        grid.isNoData(v01) || grid.isNoData(v11)
      ) {
        data[py * size + px] = NODATA;
        continue;
      }

      const tx = fc - c0;
      const ty = fr - r0;
      const top = v00 + (v10 - v00) * tx;
      const bottom = v01 + (v11 - v01) * tx;
      data[py * size + px] = top + (bottom - top) * ty;
    }
  }

  return {
    width: size,
    height: size,
    data,
    nodata: NaN,
    /**
     * Metres per pixel at this tile's latitude, which the hillshade needs: the
     * shading has to be computed against the tile's own spacing, not the source
     * raster's, or relief changes strength as the client zooms.
     */
    cellSize: metresPerTilePixel(z, y, size),
    isNoData(v) {
      return Number.isNaN(v) || v === this.nodata;
    },
  };
}

/**
 * Ground distance one tile pixel spans, at the tile's centre latitude.
 *
 * Web Mercator's scale varies with latitude, so a pixel is not a fixed number of
 * metres. The hillshade divides elevation differences by this, and using the
 * wrong value does not produce an error, it produces relief that is too strong
 * or too weak and changes as you zoom.
 */
export function metresPerTilePixel(z, y, size = 256) {
  const n = 2 ** z;
  const ty = 1 - (2 * (y + 0.5)) / n;
  const lat = Math.atan(Math.sinh(Math.PI * ty));
  return (156543.03392804097 * Math.cos(lat)) / n / (size / 256);
}
