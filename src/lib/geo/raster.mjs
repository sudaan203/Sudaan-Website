/**
 * Elevation grids: reading, writing, and knowing when two of them line up.
 *
 * Deliberately free of dependencies, for the same reason as geo.mjs: GDAL is not
 * installed on the operator machine and "install GDAL first" is not an
 * instruction that survives contact with a delivery deadline. The production
 * hydrology engine will run WhiteboxTools inside a container, but the validation
 * harness has to run here, today, against the sample data Malhar sent.
 *
 * Two formats, because the Kherwada fixture ships both:
 *
 * - GeoTIFF, which is the input (`fill dem.tif`)
 * - SAGA .sgrd/.sdat, which is what their outputs came out as
 *
 * The whole point of this file is the last function, `assertAligned`. Comparing
 * two grids that are one half cell apart produces a plausible looking agreement
 * figure that is quietly measuring the wrong thing, and that is exactly the
 * class of error this module exists to make impossible.
 */

import { readFileSync, writeFileSync } from "node:fs";

// A re-export does not create a local binding, and `decodeChunk` below calls it.
import { lzwDecode } from "./lzw.mjs";

/**
 * A north-up raster on a square cell.
 *
 * `originX` and `originY` are the *outer corner* of the top left cell, which is
 * the GeoTIFF convention. SAGA uses the *centre* of the bottom left cell, and
 * converting between the two is where half a cell goes missing if nobody is
 * paying attention. `readSagaGrid` does that conversion in one place.
 *
 * Row 0 is always north. SAGA stores rows south to north, and `readSagaGrid`
 * flips them, so nothing downstream has to remember which way up a file was.
 */
/**
 * A cell coordinate, with floating-point noise around a boundary removed.
 *
 * See `Grid.cellAt` for why this exists. Deliberately a snap rather than an
 * epsilon added before flooring: adding a constant biases every coordinate one
 * way, while snapping only moves values that are already indistinguishable
 * from an integer and leaves everything else exactly as it was.
 */
function snapToCell(cells, origin, cellSize) {
  /*
   * The tolerance is set by the *origin's* magnitude, not by the cell index.
   *
   * `(originY - y)` is a small difference between two large numbers: a northing
   * is around 2.4 million metres, so one unit in its last place is 5.4e-10 m,
   * which at a 7.7 cm cell is already 7e-9 of a cell — before the window's own
   * origin drift is added. The cell index says nothing about that error, which
   * is what an earlier attempt keyed off, and it produced the worst possible
   * outcome: the whole-file frame (index 2820) got a tolerance large enough to
   * snap while the window frame (index 4) got one that was too small, so the
   * two readers were pushed further apart rather than brought together.
   *
   * Scaled this way the tolerance is about 3e-7 of a cell on Aektanagar — some
   * tens of nanometres of ground, eight orders below anything a survey can
   * resolve, and comfortably above the arithmetic noise it exists to absorb.
   */
  const nearest = Math.round(cells);
  const tolerance = Math.max(1e-9, (Math.abs(origin) / cellSize) * 1e-14);
  return Math.abs(cells - nearest) < tolerance ? nearest : cells;
}

export class Grid {
  constructor({
    width, height, cellSize, originX, originY, data, nodata = -99999, crs = null, epsg = null,
  }) {
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originY = originY;
    this.data = data;
    this.nodata = nodata;
    this.crs = crs;
    this.epsg = epsg;
  }

  /**
   * UTM zone and hemisphere, from the EPSG code.
   *
   * Needed because GeoJSON is defined in WGS84 lon/lat but every one of these
   * grids is in UTM metres, and the conversion cannot be guessed from the
   * numbers: 345308 E is a valid easting in all sixty zones. Returns null rather
   * than assuming zone 43, so an unprojected or foreign grid fails loudly at the
   * point of export instead of silently landing the survey in the wrong country.
   */
  get utmZone() {
    if (!Number.isFinite(this.epsg)) return null;
    if (this.epsg >= 32601 && this.epsg <= 32660) return { zone: this.epsg - 32600, northern: true };
    if (this.epsg >= 32701 && this.epsg <= 32760) return { zone: this.epsg - 32700, northern: false };
    return null;
  }

  get length() {
    return this.width * this.height;
  }

  /** Cell area in square metres. Every area and volume in the engine uses this. */
  get cellArea() {
    return this.cellSize * this.cellSize;
  }

  idx(col, row) {
    return row * this.width + col;
  }

  get(col, row) {
    return this.data[row * this.width + col];
  }

  set(col, row, value) {
    this.data[row * this.width + col] = value;
  }

  inside(col, row) {
    return col >= 0 && row >= 0 && col < this.width && row < this.height;
  }

  /**
   * Is this cell nodata?
   *
   * NaN is checked separately because `NaN !== nodata` is true, so a NaN would
   * sail through a plain equality test and be routed as if it were ground.
   */
  isNoData(value) {
    return Number.isNaN(value) || value === this.nodata;
  }

  isNoDataAt(col, row) {
    return this.isNoData(this.data[row * this.width + col]);
  }

  /** Easting of a cell centre. */
  xOf(col) {
    return this.originX + (col + 0.5) * this.cellSize;
  }

  /** Northing of a cell centre. */
  yOf(row) {
    return this.originY - (row + 0.5) * this.cellSize;
  }

  /**
   * The cell containing a projected coordinate, or null if it falls outside.
   *
   * The floor is taken on a value snapped to the nearest cell boundary when it
   * is within floating-point noise of one, and that is not fastidiousness —
   * without it the same world coordinate lands in different cells depending on
   * which reader produced the grid.
   *
   * A windowed read gives its grid an origin of `originX + col0 * cellSize`.
   * On a survey whose cell size has a long mantissa — Aektanagar's is
   * 0.07686839999999892 — that product does not round-trip: at col0 = 2812 the
   * window sits 2811.9999999999786 cells from the raster origin. So a point
   * exactly on a boundary is at cell *k* in the window's frame and a hair
   * under `dCol + k` in the whole file's, and `Math.floor` sends the two
   * readers one cell apart. Measured on Aektanagar: **258 of 1,047 boundary
   * coordinates resolved differently.** Points land on boundaries more often
   * than intuition suggests — a grid of levels at a stated spacing generates
   * them by construction.
   *
   * The tolerance is in cells, and the gap it bridges is enormous compared to
   * the error it hides: 1e-9 of a cell is 0.08 nanometres on Aektanagar, while
   * the drift is ~1e-10 cells and grows with the window offset. Nothing real
   * is ever measured to within a billionth of a cell of a boundary, so a
   * coordinate that close to one is on it.
   */
  cellAt(x, y) {
    const col = Math.floor(snapToCell((x - this.originX) / this.cellSize, this.originX, this.cellSize));
    const row = Math.floor(snapToCell((this.originY - y) / this.cellSize, this.originY, this.cellSize));
    return this.inside(col, row) ? { col, row } : null;
  }

  /** Outer bounds, [minX, minY, maxX, maxY]. */
  get bounds() {
    return [
      this.originX,
      this.originY - this.height * this.cellSize,
      this.originX + this.width * this.cellSize,
      this.originY,
    ];
  }

  /**
   * A grid of the same shape, different payload.
   *
   * The payload type is genuinely open: the engine already builds Int8 pointer
   * grids, Int16 Strahler orders, Uint8 masks and Float32 surfaces from this.
   * Annotated because the default argument otherwise narrows the inferred type
   * to Float32Array alone, and every other caller then needs a cast that says
   * nothing except "the annotation is missing".
   *
   * @param {Float32ArrayConstructor|Float64ArrayConstructor|Int8ArrayConstructor|Uint8ArrayConstructor|Int16ArrayConstructor|Uint16ArrayConstructor|Int32ArrayConstructor|Uint32ArrayConstructor} [ArrayType]
   * @param {number} [fill]
   * @param {number} [nodata]
   */
  like(ArrayType = Float32Array, fill = 0, nodata = this.nodata) {
    const data = new ArrayType(this.length);
    if (fill !== 0) data.fill(fill);
    return new Grid({
      width: this.width,
      height: this.height,
      cellSize: this.cellSize,
      originX: this.originX,
      originY: this.originY,
      data,
      nodata,
      crs: this.crs,
      epsg: this.epsg,
    });
  }

  /** Projected coordinate of a grid *corner*, as polygon rings need. */
  cornerX(col) {
    return this.originX + col * this.cellSize;
  }

  cornerY(row) {
    return this.originY - row * this.cellSize;
  }

  clone() {
    const copy = this.like(this.data.constructor);
    copy.data.set(this.data);
    return copy;
  }

  /** Min, max, mean and count over data cells only. */
  stats() {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < this.data.length; i += 1) {
      const v = this.data[i];
      if (this.isNoData(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count += 1;
    }
    return count === 0
      ? { min: null, max: null, mean: null, count: 0, validFraction: 0 }
      : {
          min,
          max,
          mean: sum / count,
          count,
          validFraction: count / this.length,
        };
  }
}

// 16 is LONG8, a 64 bit unsigned integer, which only BigTIFF uses.
export const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/**
 * TIFF LZW decompression, which now lives in `./lzw.mjs`.
 *
 * It moved because it stopped being one function. Profiling put 96% of a
 * windowed read on the Kiru DTM inside it — 1,267 ms of 1,318 ms, against 51 ms
 * of disk — so there is now a Rust/WASM kernel beside the JavaScript one, a
 * switch between them on `PORTAL_LZW`, and a fallback path. That is a file's
 * worth of concern, and it is a concern about LZW rather than about rasters.
 *
 * Re-exported under the old name so nothing that imports it from here has to
 * care. `lzwDecode` is the switch; `lzwDecodeJs` is the original implementation,
 * unchanged, kept as the oracle the WASM kernel is tested against and as the
 * runtime fallback.
 */
export { lzwDecode, lzwDecodeJs, lzwDecodeWasm, lzwBackend } from "./lzw.mjs";

/** Undo horizontal differencing (TIFF Predictor 2). */
export function undoHorizontalPredictor(bytes, width, samples, bitsPerSample) {
  if (bitsPerSample !== 8) {
    throw new Error(
      `Predictor 2 is only implemented for 8 bit samples, this file has ${bitsPerSample}. ` +
        `Re-export without a predictor, or convert in the container.`,
    );
  }
  for (let row = 0; row * width * samples < bytes.length; row += 1) {
    const base = row * width * samples;
    for (let i = samples; i < width * samples; i += 1) {
      bytes[base + i] = (bytes[base + i] + bytes[base + i - samples]) & 0xff;
    }
  }
  return bytes;
}

/**
 * Baseline TIFF reader, enough for a single band float or integer DEM.
 *
 * Scope is deliberate. It reads uncompressed, strip organised, single sample
 * rasters, which is what GDAL, SAGA and QGIS all write by default for a DEM and
 * what the Kherwada fixture is. Anything else throws by name rather than
 * returning something that looks like elevation, which is the same rule the rest
 * of this pipeline follows: the orthomosaic fed to the DEM path is refused, not
 * guessed at.
 */
export function readGeoTiff(path) {
  const buf = readFileSync(path);
  const little = buf.readUInt16LE(0) === 0x4949;
  if (!little && buf.readUInt16BE(0) !== 0x4d4d) {
    throw new Error(`${path}: not a TIFF (bad byte order mark)`);
  }
  const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));

  /**
   * BigTIFF, which is what a large survey actually arrives as.
   *
   * Classic TIFF addresses everything with 32 bit offsets and therefore stops at
   * 4 GB. Aektanagar's DTM is already past what fits comfortably, and Dang
   * Forest at 450 km² will be far past it, so every serious deliverable from
   * here on is BigTIFF. Refusing it would mean the reader only opens the small
   * sites.
   *
   * Three differences, all mechanical: the version word is 43 rather than 42,
   * offsets and counts become 64 bit, and an IFD entry grows from 12 bytes to
   * 20 with an 8 byte entry count in front of it.
   */
  const version = u16(2);
  const big = version === 43;
  if (version !== 42 && !big) {
    throw new Error(`${path}: not a TIFF or BigTIFF (version word ${version})`);
  }
  if (big) {
    const offsetSize = u16(4);
    if (offsetSize !== 8) {
      throw new Error(`${path}: BigTIFF with ${offsetSize} byte offsets is not supported`);
    }
  }

  // 64 bit reads. Values past Number.MAX_SAFE_INTEGER cannot occur here: they
  // would describe a file larger than 9 petabytes.
  const u64 = (o) => {
    const lo = little ? buf.readUInt32LE(o) : buf.readUInt32BE(o + 4);
    const hi = little ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o);
    return hi * 4294967296 + lo;
  };

  const entrySize = big ? 20 : 12;
  const valueOffsetAt = big ? 12 : 8; // where the inline value or pointer sits
  const inlineCapacity = big ? 8 : 4;
  const readOffset = big ? u64 : u32;

  const tags = new Map();
  const ifd = big ? u64(8) : u32(4);
  const count = big ? u64(ifd) : u16(ifd);
  const firstEntry = ifd + (big ? 8 : 2);

  for (let i = 0; i < count; i += 1) {
    const entry = firstEntry + i * entrySize;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const n = big ? u64(entry + 4) : u32(entry + 4);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const at = size <= inlineCapacity ? entry + valueOffsetAt : readOffset(entry + valueOffsetAt);
    const values = [];
    for (let k = 0; k < n; k += 1) {
      const o = at + k * (TYPE_SIZE[type] ?? 1);
      if (type === 3) values.push(u16(o));
      else if (type === 4) values.push(u32(o));
      else if (type === 16) values.push(u64(o)); // LONG8, BigTIFF only
      else if (type === 12) values.push(f64(o));
      else if (type === 2) values.push(String.fromCharCode(buf[o]));
      else values.push(buf[o]);
    }
    tags.set(tag, type === 2 ? values.join("").replace(/\0+$/, "") : values);
  }

  const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag)[0] : fallback);

  const width = one(256);
  const height = one(257);
  if (!width || !height) throw new Error(`${path}: missing image dimensions`);

  const compression = one(259, 1);
  if (compression !== 1 && compression !== 5) {
    throw new Error(
      `${path}: compression ${compression} is not supported by this reader ` +
        `(only none and LZW). Re-export, or run the conversion in the container.`,
    );
  }
  const predictor = one(317, 1);
  if (predictor === 3) {
    throw new Error(
      `${path}: uses the floating point predictor (Predictor 3), which this reader ` +
        `does not implement. Re-export with PREDICTOR=1, or convert in the container.`,
    );
  }
  const samples = one(277, 1);
  if (samples !== 1) {
    throw new Error(
      `${path}: ${samples} samples per pixel. A DEM has one. ` +
        `An orthomosaic fed in here would read colour channels as metres.`,
    );
  }

  const bits = one(258, 32);
  const format = one(339, 1); // 1 unsigned, 2 signed, 3 float
  const stripOffsets = tags.get(273);
  const stripCounts = tags.get(279);
  const rowsPerStrip = one(278, height);
  if (!tags.has(324) && (!stripOffsets || !stripCounts)) {
    throw new Error(`${path}: missing both strip offsets and tile offsets`);
  }

  const bytesPerSample = bits / 8;
  const data = new Float32Array(width * height);

  /** Decompress one strip or tile into a readable buffer. */
  const decodeChunk = (offset, byteCount, expectedBytes, rowWidth) => {
    if (compression !== 5) return { source: buf, base: offset };
    const raw = buf.subarray(offset, offset + byteCount);
    let decoded = lzwDecode(raw, expectedBytes);
    if (predictor === 2) decoded = undoHorizontalPredictor(decoded, rowWidth, samples, bits);
    return { source: Buffer.from(decoded.buffer, decoded.byteOffset, decoded.length), base: 0 };
  };

  if (tags.has(324)) {
    // Tiled layout, which is what every large raster and every COG uses. Tiles
    // run left to right then top to bottom, each one a full tileWidth by
    // tileLength block even at the right and bottom edges, where the surplus is
    // padding that must be skipped rather than copied.
    const tileWidth = one(322);
    const tileLength = one(323);
    const tileOffsets = tags.get(324);
    const tileCounts = tags.get(325);
    if (!tileWidth || !tileLength || !tileOffsets || !tileCounts) {
      throw new Error(`${path}: tiled TIFF is missing its tile geometry tags`);
    }

    const across = Math.ceil(width / tileWidth);
    const down = Math.ceil(height / tileLength);
    const tileBytes = tileWidth * tileLength * bytesPerSample;

    for (let ty = 0; ty < down; ty += 1) {
      for (let tx = 0; tx < across; tx += 1) {
        const index = ty * across + tx;
        if (index >= tileOffsets.length) continue;
        const { source, base } = decodeChunk(
          tileOffsets[index], tileCounts[index], tileBytes, tileWidth,
        );
        const read = pixelReader(source, little, bits, format, path);

        const rows = Math.min(tileLength, height - ty * tileLength);
        const cols = Math.min(tileWidth, width - tx * tileWidth);
        for (let r = 0; r < rows; r += 1) {
          const from = base + r * tileWidth * bytesPerSample;
          const to = (ty * tileLength + r) * width + tx * tileWidth;
          for (let c = 0; c < cols; c += 1) data[to + c] = read(from + c * bytesPerSample);
        }
      }
    }
  } else {
    let row = 0;
    for (let s = 0; s < stripOffsets.length && row < height; s += 1) {
      const rows = Math.min(rowsPerStrip, height - row);
      const { source, base } = decodeChunk(
        stripOffsets[s], stripCounts[s], rows * width * bytesPerSample, width,
      );
      const read = pixelReader(source, little, bits, format, path);
      for (let r = 0; r < rows; r += 1) {
        const rowBase = base + r * width * bytesPerSample;
        const out = (row + r) * width;
        for (let c = 0; c < width; c += 1) data[out + c] = read(rowBase + c * bytesPerSample);
      }
      row += rows;
    }
  }

  const scale = tags.get(33550);
  const tie = tags.get(33922);
  if (!scale || !tie) {
    throw new Error(`${path}: no georeferencing (needs ModelPixelScale and ModelTiepoint)`);
  }
  if (Math.abs(scale[0] - scale[1]) > 1e-9) {
    throw new Error(`${path}: non square cells ${scale[0]} x ${scale[1]}, not supported`);
  }

  // NoData is an ASCII tag, and GDAL writes "nan" for a float raster.
  const rawNoData = tags.has(42113) ? tags.get(42113) : null;
  const nodata = rawNoData === null ? -99999 : Number(rawNoData);

  // The GeoKey directory is a flat list of 4-value records after a 4-value
  // header. Key 3072 is ProjectedCSTypeGeoKey, which carries the EPSG code, and
  // that is the only reliable way to know which UTM zone this is. The GeoAscii
  // string says "UTM zone 43N" here but is free text and not worth parsing.
  let epsg = null;
  const geoKeys = tags.get(34735);
  if (geoKeys && geoKeys.length >= 4) {
    for (let i = 4; i + 3 < geoKeys.length; i += 4) {
      if (geoKeys[i] === 3072 && geoKeys[i + 1] === 0) epsg = geoKeys[i + 3];
    }
  }

  return new Grid({
    width,
    height,
    cellSize: scale[0],
    // The tie point maps a raster coordinate to a model coordinate. For the
    // usual raster space (0,0) it is the outer corner of the top left cell,
    // which is exactly what Grid wants.
    originX: tie[3] - tie[0] * scale[0],
    originY: tie[4] + tie[1] * scale[1],
    data,
    nodata: Number.isFinite(nodata) ? nodata : NaN,
    crs: tags.get(34737) ?? null,
    epsg,
  });
}

/**
 * Resample a DEM to a coarser cell size by area-weighted averaging.
 *
 * This is the step that makes hydrology tractable and, less obviously, better.
 * Routing flow across a 2.5 cm photogrammetric surface is not more accurate than
 * routing it across 1 m: every wheel rut and vegetation artefact becomes a pit,
 * and the stream network turns into noise driven braiding. Their own SAGA run
 * used 1 m from a 2.5 cm ortho, a 40x reduction. It is also the difference
 * between 450 million cells and 180 billion on a site the size of Dang Forest.
 *
 * Area weighting rather than picking the nearest source cell, because a DEM is a
 * continuous field and dropping 39 of every 40 samples throws away exactly the
 * information that makes the average trustworthy. Nodata is excluded from the
 * weighting rather than counted as zero, which would drag a coastal or ragged
 * edge downwards and invent a slope that is not there.
 *
 * Refuses to upsample. Inventing detail a survey does not contain, and then
 * routing water over it, is the kind of quiet wrongness this pipeline exists to
 * avoid.
 */
export function resample(grid, targetCellSize) {
  if (targetCellSize < grid.cellSize - 1e-12) {
    throw new Error(
      `resample: refusing to upsample from ${grid.cellSize} m to ${targetCellSize} m. ` +
        `That would invent detail the survey does not contain.`,
    );
  }
  if (Math.abs(targetCellSize - grid.cellSize) < 1e-12) return grid;

  const width = Math.max(1, Math.round((grid.width * grid.cellSize) / targetCellSize));
  const height = Math.max(1, Math.round((grid.height * grid.cellSize) / targetCellSize));
  const out = new Grid({
    width,
    height,
    cellSize: targetCellSize,
    originX: grid.originX,
    originY: grid.originY,
    data: new Float32Array(width * height),
    nodata: grid.nodata,
    crs: grid.crs,
    epsg: grid.epsg,
  });

  for (let row = 0; row < height; row += 1) {
    // Source rows overlapped by this output row, in fractional source units.
    const y0 = (row * targetCellSize) / grid.cellSize;
    const y1 = ((row + 1) * targetCellSize) / grid.cellSize;
    const r0 = Math.max(0, Math.floor(y0));
    const r1 = Math.min(grid.height, Math.ceil(y1));

    for (let col = 0; col < width; col += 1) {
      const x0 = (col * targetCellSize) / grid.cellSize;
      const x1 = ((col + 1) * targetCellSize) / grid.cellSize;
      const c0 = Math.max(0, Math.floor(x0));
      const c1 = Math.min(grid.width, Math.ceil(x1));

      let sum = 0;
      let weight = 0;
      for (let r = r0; r < r1; r += 1) {
        const hy = Math.min(y1, r + 1) - Math.max(y0, r);
        if (hy <= 0) continue;
        for (let c = c0; c < c1; c += 1) {
          const hx = Math.min(x1, c + 1) - Math.max(x0, c);
          if (hx <= 0) continue;
          const v = grid.data[r * grid.width + c];
          if (grid.isNoData(v)) continue;
          const w = hx * hy;
          sum += v * w;
          weight += w;
        }
      }
      out.data[row * width + col] = weight > 0 ? sum / weight : out.nodata;
    }
  }
  return out;
}

export function pixelReader(buf, little, bits, format, path) {
  if (format === 3 && bits === 32) return (o) => (little ? buf.readFloatLE(o) : buf.readFloatBE(o));
  if (format === 3 && bits === 64) return (o) => (little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  if (format === 2 && bits === 16) return (o) => (little ? buf.readInt16LE(o) : buf.readInt16BE(o));
  if (format === 2 && bits === 32) return (o) => (little ? buf.readInt32LE(o) : buf.readInt32BE(o));
  if (format === 1 && bits === 16) return (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  if (format === 1 && bits === 8) return (o) => buf[o];
  throw new Error(`${path}: unsupported sample format ${format} at ${bits} bits`);
}

/**
 * SAGA grid: a text .sgrd header beside a headerless binary .sdat.
 *
 * Two conversions happen here and both are easy to get silently wrong.
 *
 * 1. POSITION_XMIN and POSITION_YMIN are the *centre* of the bottom left cell.
 *    A GeoTIFF origin is the *outer corner* of the top left cell. So the origin
 *    moves half a cell left, and the northing has to be built up from the bottom
 *    of the grid rather than read off. Get this wrong and every comparison is
 *    offset by half a cell, which still produces a respectable looking overlap
 *    number.
 *
 * 2. TOPTOBOTTOM = FALSE means the first row in the file is the *southern* row.
 *    Rows are flipped on read so that row 0 is north everywhere in this codebase.
 */
export function readSagaGrid(sgrdPath) {
  const header = {};
  for (const line of readFileSync(sgrdPath, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    header[line.slice(0, at).trim().toUpperCase()] = line.slice(at + 1).trim();
  }

  const width = Number(header.CELLCOUNT_X);
  const height = Number(header.CELLCOUNT_Y);
  const cellSize = Number(header.CELLSIZE);
  const xMinCentre = Number(header.POSITION_XMIN);
  const yMinCentre = Number(header.POSITION_YMIN);
  if (![width, height, cellSize, xMinCentre, yMinCentre].every(Number.isFinite)) {
    throw new Error(`${sgrdPath}: incomplete SAGA header`);
  }

  const format = (header.DATAFORMAT ?? "FLOAT").toUpperCase();
  const bytes = { FLOAT: 4, DOUBLE: 8, SHORTINT: 2, INTEGER: 4, BYTE: 1 }[format];
  if (!bytes) throw new Error(`${sgrdPath}: unsupported DATAFORMAT ${format}`);

  const little = (header.BYTEORDER_BIG ?? "FALSE").toUpperCase() !== "TRUE";
  const buf = readFileSync(sgrdPath.replace(/\.sgrd$/i, ".sdat"));
  const expected = width * height * bytes;
  if (buf.length < expected) {
    throw new Error(
      `${sgrdPath}: .sdat holds ${buf.length} bytes, header describes ${expected}`,
    );
  }

  // "0.000000;0.000000" appears in these files; take the first number only.
  const nodata = Number(String(header.NODATA_VALUE ?? "-99999").split(";")[0]);

  const readAt = (o) => {
    if (format === "FLOAT") return little ? buf.readFloatLE(o) : buf.readFloatBE(o);
    if (format === "DOUBLE") return little ? buf.readDoubleLE(o) : buf.readDoubleBE(o);
    if (format === "SHORTINT") return little ? buf.readInt16LE(o) : buf.readInt16BE(o);
    if (format === "INTEGER") return little ? buf.readInt32LE(o) : buf.readInt32BE(o);
    return buf[o];
  };

  const flip = (header.TOPTOBOTTOM ?? "FALSE").toUpperCase() !== "TRUE";
  const data = new Float32Array(width * height);
  for (let r = 0; r < height; r += 1) {
    const src = flip ? height - 1 - r : r;
    for (let c = 0; c < width; c += 1) {
      data[r * width + c] = readAt((src * width + c) * bytes);
    }
  }

  const zFactor = Number(header.Z_FACTOR ?? 1) || 1;
  const zOffset = Number(header.Z_OFFSET ?? 0) || 0;
  if (zFactor !== 1 || zOffset !== 0) {
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== nodata) data[i] = data[i] * zFactor + zOffset;
    }
  }

  return new Grid({
    width,
    height,
    cellSize,
    originX: xMinCentre - cellSize / 2,
    originY: yMinCentre - cellSize / 2 + height * cellSize,
    data,
    nodata,
  });
}

/**
 * Do two grids describe the same cells?
 *
 * Called before every comparison in the validation harness. Two grids that are
 * half a cell apart still overlap by 99 point something percent, so a
 * misalignment does not announce itself in the agreement figure, it just quietly
 * caps it. Checking the geometry first turns that into an error instead.
 *
 * The tolerance is a thousandth of a cell, which is far tighter than any real
 * offset and far looser than float noise in a header written as decimal text.
 */
export function assertAligned(a, b, labelA = "A", labelB = "B") {
  const tol = a.cellSize / 1000;
  const problems = [];
  if (a.width !== b.width || a.height !== b.height) {
    problems.push(`size ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  if (Math.abs(a.cellSize - b.cellSize) > tol) {
    problems.push(`cell size ${a.cellSize} vs ${b.cellSize}`);
  }
  if (Math.abs(a.originX - b.originX) > tol) {
    problems.push(`origin X ${a.originX} vs ${b.originX}, off by ${(b.originX - a.originX).toFixed(4)} m`);
  }
  if (Math.abs(a.originY - b.originY) > tol) {
    problems.push(`origin Y ${a.originY} vs ${b.originY}, off by ${(b.originY - a.originY).toFixed(4)} m`);
  }
  if (problems.length > 0) {
    throw new Error(`${labelA} and ${labelB} are not on the same grid: ${problems.join("; ")}`);
  }
}

/**
 * Write a single band float32 GeoTIFF, uncompressed, with UTM georeferencing.
 *
 * Enough to hand a result back to Global Mapper or QGIS, which is the point:
 * every number this engine produces should be checkable in the software the
 * client already trusts. Not a COG, that is the container's job in B1.
 */
export function writeGeoTiff(path, grid, { epsg = grid.epsg ?? 32643 } = {}) {
  const { width, height, cellSize, originX, originY } = grid;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < grid.data.length; i += 1) pixels.writeFloatLE(grid.data[i], i * 4);

  const entries = [];
  const trailing = [];
  const HEADER = 8;
  // 8 byte header, 2 byte entry count, 12 bytes per entry, 4 byte next-IFD.
  const tagCount = 15;
  const afterIfd = HEADER + 2 + tagCount * 12 + 4;
  let tail = afterIfd;
  const stash = (buf) => {
    const at = tail;
    trailing.push(buf);
    tail += buf.length;
    return at;
  };

  const scaleAt = stash(doubles([cellSize, cellSize, 0]));
  const tieAt = stash(doubles([0, 0, 0, originX, originY, 0]));
  const geoKeys = shorts([
    1, 1, 0, 4,
    1024, 0, 1, 1, // GTModelType = projected
    1025, 0, 1, 1, // GTRasterType = PixelIsArea
    2054, 0, 1, 9102, // GeogAngularUnits = degree
    3072, 0, 1, epsg, // ProjectedCSType
  ]);
  const geoKeysAt = stash(geoKeys);
  const nodataText = Buffer.from(`${grid.nodata}\0`, "ascii");
  const nodataAt = stash(nodataText);
  const dataAt = tail;

  const add = (tag, type, count, value) => entries.push({ tag, type, count, value });
  add(256, 3, 1, width);
  add(257, 3, 1, height);
  add(258, 3, 1, 32);
  add(259, 3, 1, 1);
  add(262, 3, 1, 1);
  add(273, 4, 1, dataAt);
  add(277, 3, 1, 1);
  add(278, 3, 1, height);
  add(279, 4, 1, pixels.length);
  add(284, 3, 1, 1);
  add(339, 3, 1, 3);
  add(33550, 12, 3, scaleAt);
  add(33922, 12, 6, tieAt);
  add(34735, 3, geoKeys.length / 2, geoKeysAt);
  // Keep the count honest if this list is ever edited.
  if (entries.length !== tagCount - 1) {
    throw new Error(`writeGeoTiff: ${entries.length + 1} tags but space reserved for ${tagCount}`);
  }
  add(42113, 2, nodataText.length, nodataAt);
  entries.sort((a, b) => a.tag - b.tag);

  const head = Buffer.alloc(afterIfd);
  head.write("II", 0, "ascii");
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(HEADER, 4);
  head.writeUInt16LE(entries.length, HEADER);
  entries.forEach((e, i) => {
    const o = HEADER + 2 + i * 12;
    head.writeUInt16LE(e.tag, o);
    head.writeUInt16LE(e.type, o + 2);
    head.writeUInt32LE(e.count, o + 4);
    if (e.type === 3 && e.count === 1) head.writeUInt16LE(e.value, o + 8);
    else head.writeUInt32LE(e.value, o + 8);
  });
  head.writeUInt32LE(0, HEADER + 2 + entries.length * 12);

  writeFileSync(path, Buffer.concat([head, ...trailing, pixels]));
}

function doubles(values) {
  const b = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => b.writeDoubleLE(v, i * 8));
  return b;
}

function shorts(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return b;
}
