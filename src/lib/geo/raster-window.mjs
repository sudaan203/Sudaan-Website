/**
 * Read part of a GeoTIFF, rather than all of it.
 *
 *   const raster = await openRaster(cached(await fileSource(path)));
 *   const grid = await raster.readWindow(raster.windowFor([minX, minY, maxX, maxY]));
 *
 * ## Why this exists
 *
 * `readGeoTiff` reads the whole file into memory. That is the right choice for
 * the surveys on a laptop and it is why the analysis was quick to get correct.
 * It does not survive contact with production: the rasters are 145 MB and
 * 150 MB, a serverless function has a read only filesystem and a bundle limit
 * around 250 MB, and Dang Forest at 450 km² will be tens of gigabytes.
 *
 * The cost of a measurement should scale with the polygon a client drew, not
 * with the survey it was drawn on. A hectare at 24 cm is 170,000 cells whether
 * it sits in Kotba or in a forest the size of a county, and reading it should
 * cost the same in both.
 *
 * ## What makes it possible
 *
 * Nothing here converts anything. The rasters the pipeline already produces are
 * exactly the right shape: Aektanagar's DTM and DSM are BigTIFF, tiled 256x256,
 * LZW, with five levels of overviews. A tiled TIFF's directory lists the byte
 * range of every tile, so the tiles overlapping a window can be fetched
 * individually and nothing else has to be touched.
 *
 * Kotba's DTM is stripped rather than tiled, one row per strip, which windows
 * just as well in the vertical direction: the strips covering the window's rows
 * are read and the rest of the file is left alone.
 *
 * ## The returned grid is a real grid
 *
 * `readWindow` hands back an ordinary `Grid` whose origin is the window's own
 * top left corner. Because `Grid.xOf` and `Grid.yOf` derive world coordinates
 * from that origin, every analysis function works on it unchanged and cannot
 * tell it apart from a whole raster. That is the property that keeps this from
 * spreading: `spotLevel`, `polygonStats`, `cutFill` and `profile` did not need a
 * single edit.
 *
 * The one rule the caller must respect is that the window has to contain
 * everything the analysis will look at. `ringWindow` clamps to the grid it is
 * given, so a polygon reaching past the window would be silently measured over
 * less ground. `windowFor` therefore pads by a margin, and the padding is not
 * optional: bilinear interpolation reads the four cells around a point, so a
 * sample on the window's edge needs a neighbour outside it.
 */

import {
  Grid,
  TYPE_SIZE,
  pixelReader,
  undoHorizontalPredictor,
} from "./raster.mjs";
// Straight from lzw.mjs rather than through raster.mjs's re-export: this is the
// file that pays for the decoder — a window over Kiru decodes 650 tiles — so
// the dependency is worth seeing at the top of it.
import { lzwDecode } from "./lzw.mjs";

/** Cells either side of a requested window, so edge interpolation has neighbours. */
const MARGIN_CELLS = 2;

/**
 * Parse a TIFF or BigTIFF directory without reading the image data.
 *
 * Structurally the same walk `readGeoTiff` does, against a byte source rather
 * than a Buffer. Kept as its own function rather than shared with the eager
 * reader because the eager one is synchronous over a whole buffer and this one
 * awaits every field; merging them would make the simple path async for no
 * benefit and put the file everything depends on at risk for a refactor.
 */
async function readDirectory(source) {
  await source.warm?.();

  const head = await source.read(0, 16);
  const little = head.readUInt16LE(0) === 0x4949;
  if (!little && head.readUInt16BE(0) !== 0x4d4d) {
    throw new Error(`${source.label}: not a TIFF (bad byte order mark)`);
  }

  const version = little ? head.readUInt16LE(2) : head.readUInt16BE(2);
  const big = version === 43;
  if (version !== 42 && !big) {
    throw new Error(`${source.label}: not a TIFF or BigTIFF (version word ${version})`);
  }
  if (big) {
    const offsetSize = little ? head.readUInt16LE(4) : head.readUInt16BE(4);
    if (offsetSize !== 8) {
      throw new Error(`${source.label}: BigTIFF with ${offsetSize} byte offsets is not supported`);
    }
  }

  const u16 = (b, o) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const f64 = (b, o) => (little ? b.readDoubleLE(o) : b.readDoubleBE(o));
  const u64 = (b, o) => {
    const lo = little ? b.readUInt32LE(o) : b.readUInt32BE(o + 4);
    const hi = little ? b.readUInt32LE(o + 4) : b.readUInt32BE(o);
    return hi * 4294967296 + lo;
  };

  const ifdOffset = big ? u64(head, 8) : u32(head, 4);
  const countBytes = await source.read(ifdOffset, big ? 8 : 2);
  const count = big ? u64(countBytes, 0) : u16(countBytes, 0);

  const entrySize = big ? 20 : 12;
  const valueOffsetAt = big ? 12 : 8;
  const inlineCapacity = big ? 8 : 4;
  const firstEntry = ifdOffset + (big ? 8 : 2);

  const table = await source.read(firstEntry, count * entrySize);
  const tags = new Map();

  for (let i = 0; i < count; i += 1) {
    const e = i * entrySize;
    const tag = u16(table, e);
    const type = u16(table, e + 2);
    const n = big ? u64(table, e + 4) : u32(table, e + 4);
    const unit = TYPE_SIZE[type] ?? 1;
    const size = unit * n;

    let bytes;
    let base;
    if (size <= inlineCapacity) {
      bytes = table;
      base = e + valueOffsetAt;
    } else {
      const at = big ? u64(table, e + valueOffsetAt) : u32(table, e + valueOffsetAt);
      bytes = await source.read(at, size);
      base = 0;
    }

    const values = [];
    for (let k = 0; k < n; k += 1) {
      const o = base + k * unit;
      if (type === 3) values.push(u16(bytes, o));
      else if (type === 4) values.push(u32(bytes, o));
      else if (type === 16) values.push(u64(bytes, o));
      else if (type === 12) values.push(f64(bytes, o));
      else if (type === 2) values.push(String.fromCharCode(bytes[o]));
      else values.push(bytes[o]);
    }
    tags.set(tag, type === 2 ? values.join("").replace(/\0+$/, "") : values);
  }

  return { tags, little, big };
}

/**
 * Open a raster for windowed reading.
 *
 * Refuses the same things `readGeoTiff` refuses, and for the same reasons: an
 * unsupported compression, the floating point predictor, and multi sample
 * images, which are orthomosaics whose colour channels would be read as metres.
 */
export async function openRaster(source) {
  const { tags, little } = await readDirectory(source);
  const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag)[0] : fallback);
  const label = source.label;

  const width = one(256);
  const height = one(257);
  if (!width || !height) throw new Error(`${label}: missing image dimensions`);

  const compression = one(259, 1);
  if (compression !== 1 && compression !== 5) {
    throw new Error(`${label}: compression ${compression} is not supported (only none and LZW)`);
  }
  const predictor = one(317, 1);
  if (predictor === 3) {
    throw new Error(`${label}: uses the floating point predictor, which this reader does not implement`);
  }
  const samples = one(277, 1);
  if (samples !== 1) {
    throw new Error(`${label}: ${samples} samples per pixel. A DEM has one.`);
  }

  const bits = one(258, 32);
  const format = one(339, 1);
  const bytesPerSample = bits / 8;

  const scale = tags.get(33550);
  const tie = tags.get(33922);
  if (!scale || !tie) {
    throw new Error(`${label}: no georeferencing (needs ModelPixelScale and ModelTiepoint)`);
  }
  if (Math.abs(scale[0] - scale[1]) > 1e-9) {
    throw new Error(`${label}: non square cells ${scale[0]} x ${scale[1]}, not supported`);
  }

  const cellSize = scale[0];
  const originX = tie[3] - tie[0] * scale[0];
  const originY = tie[4] + tie[1] * scale[1];

  const rawNoData = tags.has(42113) ? tags.get(42113) : null;
  const parsedNoData = rawNoData === null ? -99999 : Number(rawNoData);
  const nodata = Number.isFinite(parsedNoData) ? parsedNoData : NaN;

  let epsg = null;
  const geoKeys = tags.get(34735);
  if (geoKeys && geoKeys.length >= 4) {
    for (let i = 4; i + 3 < geoKeys.length; i += 4) {
      if (geoKeys[i] === 3072 && geoKeys[i + 1] === 0) epsg = geoKeys[i + 3];
    }
  }

  const tiled = tags.has(324);
  const tileWidth = tiled ? one(322) : width;
  const tileHeight = tiled ? one(323) : one(278, height);
  const offsets = tiled ? tags.get(324) : tags.get(273);
  const counts = tiled ? tags.get(325) : tags.get(279);
  if (!offsets || !counts) {
    throw new Error(`${label}: missing both strip offsets and tile offsets`);
  }
  const across = tiled ? Math.ceil(width / tileWidth) : 1;

  /** Decode one tile or strip into a pixel reader. */
  /**
   * Where a read's time actually went, for the request that wants to say so.
   *
   * Fetching bytes and decompressing them are the two halves of a windowed
   * read and they answer to completely different fixes — one is network or
   * disk, the other is CPU — so a single "read took 1.3 s" cannot tell you
   * which lever to pull. Locally the split is 51 ms of I/O against 1,267 ms of
   * LZW; across the internet from a serverless function to a bucket it will
   * not be, and *that difference* is the entire argument for moving compute
   * next to the data. It should be measured rather than assumed.
   *
   * Counters, not timers around the whole thing: a window is many chunk reads
   * and the interesting number is how many, how large, and how long they took
   * in total.
   */
  const stats = { requests: 0, bytes: 0, ioMs: 0, decodeMs: 0 };
  const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

  async function chunk(index, expectedBytes, rowWidth) {
    let t = now();
    const raw = await source.read(offsets[index], counts[index]);
    // Time only. After coalescing this is usually a cache hit costing nothing,
    // and counting it as a request would report 1,575 fetches for one. What
    // actually reached the network is counted from the source below.
    stats.ioMs += now() - t;
    if (compression !== 5) return { bytes: raw, base: 0 };
    t = now();
    let decoded = lzwDecode(raw, expectedBytes);
    if (predictor === 2) decoded = undoHorizontalPredictor(decoded, rowWidth, samples, bits);
    stats.decodeMs += now() - t;
    return { bytes: Buffer.from(decoded.buffer, decoded.byteOffset, decoded.length), base: 0 };
  }

  /**
   * Bytes that may be pulled in one fetch even though nothing wants the middle.
   *
   * Bridging a small gap is cheaper than a second round trip. Half a megabyte
   * is well under the cost of one network latency and bounds how much of a
   * tiled file's unwanted columns can be dragged in per row.
   */
  const COALESCE_GAP = 512 * 1024;

  /** Ceiling on one fetch, so a large window cannot ask for the file in one go. */
  const COALESCE_MAX = 16 * 1024 * 1024;

  /**
   * Fetch every chunk a window is about to decode, in as few requests as the
   * file's own layout allows.
   *
   * Without this, `chunk()` asks for each strip or tile the moment it needs it
   * — 1,575 sequential range requests for a full read of Kotba, whose strips
   * are one contiguous run with no gap between them. That is invisible on a
   * warm local disk and ruinous over a network.
   *
   * Sorting by file offset and joining neighbours turns that into one request
   * per contiguous run: one for Kotba, one for Aektanagar, about one per tile
   * row for a window into a large tiled file. The reads afterwards are
   * unchanged and simply hit the cache.
   *
   * Skipped entirely when the source cannot cache — a bare file source would
   * read the bytes here and read them again below, which is slower, not
   * faster.
   */
  async function prefetchChunks(indices) {
    if (typeof source.prefetch !== "function" || indices.length === 0) return;

    const wanted = [];
    for (const index of indices) {
      if (index < 0 || index >= offsets.length) continue;
      const length = counts[index];
      if (length > 0) wanted.push({ start: offsets[index], end: offsets[index] + length });
    }
    if (wanted.length === 0) return;
    wanted.sort((a, b) => a.start - b.start);

    let runStart = wanted[0].start;
    let runEnd = wanted[0].end;
    const runs = [];
    for (let i = 1; i < wanted.length; i += 1) {
      const w = wanted[i];
      const joinable = w.start - runEnd <= COALESCE_GAP && w.end - runStart <= COALESCE_MAX;
      if (joinable) {
        if (w.end > runEnd) runEnd = w.end;
      } else {
        runs.push([runStart, runEnd]);
        runStart = w.start;
        runEnd = w.end;
      }
    }
    runs.push([runStart, runEnd]);

    /*
     * Counted, because these are the fetches that actually reach the network.
     * The per-chunk reads below now hit the cache and cost nothing, so leaving
     * the prefetch uncounted made `readStats` — and the `Server-Timing` header
     * built from it — report "io 1 ms" for a read that had just pulled 4.6 MB
     * over the wire. An instrumentation that stops seeing the thing it was
     * added to measure is worse than none.
     */
    for (const [start, end] of runs) {
      const t = now();
      await source.prefetch(start, end - start);
      stats.ioMs += now() - t;
    }
  }

  return {
    label,
    width,
    height,
    cellSize,
    originX,
    originY,
    epsg,
    nodata,
    tiled,
    tileWidth,
    tileHeight,
    get utmZone() {
      if (!Number.isFinite(epsg)) return null;
      if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, northern: true };
      if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, northern: false };
      return null;
    },
    /**
     * Outer bounds of the whole raster.
     *
     * Typed as a fixed four-tuple rather than an array, because it is fed
     * straight into `windowFor`, which destructures exactly four corners and
     * would otherwise accept a short array and produce a window full of NaN.
     *
     * @returns {[number, number, number, number]} [minX, minY, maxX, maxY]
     */
    get bounds() {
      return [originX, originY - height * cellSize, originX + width * cellSize, originY];
    },

    /**
     * The cell window covering a projected bounding box, padded and clamped.
     *
     * Padding is required rather than generous: `spotLevel` interpolates between
     * the four cells around a point, so a sample landing on the last column of
     * the window needs the column after it to exist. Returns null when the box
     * misses the raster altogether, which the caller must treat as "no data"
     * rather than as an empty window.
     */
    windowFor([minX, minY, maxX, maxY], margin = MARGIN_CELLS) {
      const col0 = Math.floor((minX - originX) / cellSize) - margin;
      const col1 = Math.ceil((maxX - originX) / cellSize) + margin;
      const row0 = Math.floor((originY - maxY) / cellSize) - margin;
      const row1 = Math.ceil((originY - minY) / cellSize) + margin;

      const c0 = Math.max(0, col0);
      const c1 = Math.min(width - 1, col1);
      const r0 = Math.max(0, row0);
      const r1 = Math.min(height - 1, row1);
      if (c0 > c1 || r0 > r1) return null;
      return { col0: c0, row0: r0, cols: c1 - c0 + 1, rows: r1 - r0 + 1 };
    },

    /**
     * Read one window into a Grid whose origin is the window's own corner.
     *
     * Only the tiles or strips overlapping the window are fetched. Cells the
     * window covers but the file does not are left as nodata rather than zero,
     * because zero is a plausible elevation and would be measured as ground.
     */
    async readWindow(window) {
      if (!window) return null;
      const { col0, row0, cols, rows } = window;
      const data = new Float32Array(cols * rows);
      data.fill(Number.isNaN(nodata) ? NaN : nodata);

      // Everything this window will decode, fetched in as few requests as the
      // file's layout allows. See `prefetchChunks`.
      {
        const needed = [];
        if (tiled) {
          const across0 = Math.ceil(width / tileWidth);
          for (let ty = Math.floor(row0 / tileHeight); ty <= Math.floor((row0 + rows - 1) / tileHeight); ty += 1) {
            for (let tx = Math.floor(col0 / tileWidth); tx <= Math.floor((col0 + cols - 1) / tileWidth); tx += 1) {
              needed.push(ty * across0 + tx);
            }
          }
        } else {
          const rowsPerStrip = tileHeight;
          for (let s = Math.floor(row0 / rowsPerStrip); s <= Math.floor((row0 + rows - 1) / rowsPerStrip); s += 1) {
            needed.push(s);
          }
        }
        await prefetchChunks(needed);
      }

      if (tiled) {
        const tx0 = Math.floor(col0 / tileWidth);
        const tx1 = Math.floor((col0 + cols - 1) / tileWidth);
        const ty0 = Math.floor(row0 / tileHeight);
        const ty1 = Math.floor((row0 + rows - 1) / tileHeight);
        const tileBytes = tileWidth * tileHeight * bytesPerSample;

        for (let ty = ty0; ty <= ty1; ty += 1) {
          for (let tx = tx0; tx <= tx1; tx += 1) {
            const index = ty * across + tx;
            if (index >= offsets.length) continue;
            const { bytes, base } = await chunk(index, tileBytes, tileWidth);
            const read = pixelReader(bytes, little, bits, format, label);

            // Where this tile and the window overlap, in whole raster cells.
            const startCol = Math.max(col0, tx * tileWidth);
            const endCol = Math.min(col0 + cols - 1, (tx + 1) * tileWidth - 1, width - 1);
            const startRow = Math.max(row0, ty * tileHeight);
            const endRow = Math.min(row0 + rows - 1, (ty + 1) * tileHeight - 1, height - 1);

            for (let r = startRow; r <= endRow; r += 1) {
              const inTileRow = r - ty * tileHeight;
              const from = base + inTileRow * tileWidth * bytesPerSample;
              const to = (r - row0) * cols;
              for (let c = startCol; c <= endCol; c += 1) {
                data[to + (c - col0)] = read(from + (c - tx * tileWidth) * bytesPerSample);
              }
            }
          }
        }
      } else {
        const rowsPerStrip = tileHeight;
        const s0 = Math.floor(row0 / rowsPerStrip);
        const s1 = Math.floor((row0 + rows - 1) / rowsPerStrip);

        for (let s = s0; s <= s1; s += 1) {
          if (s >= offsets.length) continue;
          const stripRow = s * rowsPerStrip;
          const stripRows = Math.min(rowsPerStrip, height - stripRow);
          const { bytes, base } = await chunk(s, stripRows * width * bytesPerSample, width);
          const read = pixelReader(bytes, little, bits, format, label);

          const startRow = Math.max(row0, stripRow);
          const endRow = Math.min(row0 + rows - 1, stripRow + stripRows - 1);
          for (let r = startRow; r <= endRow; r += 1) {
            const rowBase = base + (r - stripRow) * width * bytesPerSample;
            const to = (r - row0) * cols;
            for (let c = col0; c < col0 + cols && c < width; c += 1) {
              data[to + (c - col0)] = read(rowBase + c * bytesPerSample);
            }
          }
        }
      }

      return new Grid({
        width: cols,
        height: rows,
        cellSize,
        // The window's own top left corner, which is what makes the result
        // indistinguishable from a whole raster to everything downstream.
        originX: originX + col0 * cellSize,
        originY: originY - row0 * cellSize,
        data,
        nodata,
        crs: null,
        epsg,
      });
    },

    /**
     * Byte-fetch and decode cost since the last `resetStats()`.
     *
     * Cumulative rather than per-call because `readWindow` issues many chunk
     * reads and a caller measuring one window wants the total of them.
     */
    get readStats() {
      /*
       * Requests and bytes come from the source, not from this file's own
       * counters, because only the source knows which reads actually reached
       * disk or network. Counting them here double-counted after coalescing:
       * the prefetch fetched 7 MB and then 1,575 cache hits claimed to fetch
       * it again, so a read of 7 MB reported 14 MB in 1,576 requests.
       *
       * `cached()` tracks its own spans; a source without that falls back to
       * this file's counters, which for an uncached source are exactly right
       * because every chunk read is then a real one.
       */
      const fromSource = source.stats;
      return {
        ...stats,
        requests: fromSource?.requests ?? stats.requests,
        bytes: fromSource?.bytes ?? stats.bytes,
      };
    },

    resetStats() {
      stats.requests = 0;
      stats.bytes = 0;
      stats.ioMs = 0;
      stats.decodeMs = 0;
    },

    async close() {
      await source.close();
    },
  };
}

/** Bounding box of a ring or line in projected coordinates. */
export function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
