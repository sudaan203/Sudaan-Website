/**
 * Enumerate the compressed chunks of a TIFF, without decoding any of them.
 *
 * Exists for `scripts/lzw-test.mjs`, which has to feed every LZW stream in a
 * real survey to two decoders and compare the results. That needs the raw byte
 * range of each tile or strip and the number of bytes it is supposed to expand
 * to, which is exactly the part `openRaster` keeps to itself: it hands back a
 * Grid, and by then the decoding has already happened.
 *
 * Deliberately a second, independent implementation of the directory walk rather
 * than a refactor that exposes the internals of `raster-window.mjs`. Two
 * reasons, and the first is the real one:
 *
 * 1. A differential test that shares code with the thing it tests can only find
 *    disagreements the shared code allows. This walker knowing nothing about the
 *    reader is the point.
 * 2. The reader is the file every raster operation in the portal depends on.
 *    Widening its surface so a test can reach inside is how a test ends up
 *    dictating production structure.
 *
 * Reads are targeted `readSync` calls rather than `readFileSync`, because Kiru's
 * DTM is 2.3 GB and the directory of interest is a few kilobytes of it.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// 16 is LONG8, the 64 bit unsigned integer that only BigTIFF uses.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/**
 * Open a TIFF and list its compressed chunks.
 *
 * Returns `{ close, compression, predictor, chunks }` where each chunk is
 * `{ index, offset, byteCount, expectedBytes, read() }`. `expectedBytes` is the
 * *uncompressed* size the decoder is asked for, which for a tile is the full
 * tile including the padding that edge tiles carry, and for a strip is however
 * many rows that strip actually holds — the last one is usually short, and a
 * test that assumed a uniform size would quietly compare the wrong lengths.
 */
export function openTiffChunks(path) {
  const fd = openSync(path, "r");
  const { size } = fstatSync(fd);

  const at = (offset, length) => {
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
    if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, offset);
    return buffer;
  };

  const head = at(0, 16);
  const little = head.readUInt16LE(0) === 0x4949;
  if (!little && head.readUInt16BE(0) !== 0x4d4d) {
    closeSync(fd);
    throw new Error(`${path}: not a TIFF`);
  }
  const u16 = (b, o) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const f64 = (b, o) => (little ? b.readDoubleLE(o) : b.readDoubleBE(o));
  const u64 = (b, o) => {
    const lo = little ? b.readUInt32LE(o) : b.readUInt32BE(o + 4);
    const hi = little ? b.readUInt32LE(o + 4) : b.readUInt32BE(o);
    return hi * 4294967296 + lo;
  };

  const version = u16(head, 2);
  const big = version === 43;
  if (version !== 42 && !big) {
    closeSync(fd);
    throw new Error(`${path}: not a TIFF or BigTIFF (version word ${version})`);
  }

  const entrySize = big ? 20 : 12;
  const valueOffsetAt = big ? 12 : 8;
  const inlineCapacity = big ? 8 : 4;

  const ifd = big ? u64(head, 8) : u32(head, 4);
  const countBytes = at(ifd, big ? 8 : 2);
  const count = big ? u64(countBytes, 0) : u16(countBytes, 0);
  const table = at(ifd + (big ? 8 : 2), count * entrySize);

  const tags = new Map();
  for (let i = 0; i < count; i += 1) {
    const e = i * entrySize;
    const tag = u16(table, e);
    const type = u16(table, e + 2);
    const n = big ? u64(table, e + 4) : u32(table, e + 4);
    const unit = TYPE_SIZE[type] ?? 1;
    const bytes = unit * n <= inlineCapacity
      ? table
      : at(big ? u64(table, e + valueOffsetAt) : u32(table, e + valueOffsetAt), unit * n);
    const base = unit * n <= inlineCapacity ? e + valueOffsetAt : 0;

    const values = [];
    for (let k = 0; k < n; k += 1) {
      const o = base + k * unit;
      if (type === 3) values.push(u16(bytes, o));
      else if (type === 4) values.push(u32(bytes, o));
      else if (type === 16) values.push(u64(bytes, o));
      else if (type === 12) values.push(f64(bytes, o));
      else values.push(bytes[o]);
    }
    tags.set(tag, values);
  }

  const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag)[0] : fallback);
  const width = one(256);
  const height = one(257);
  const bits = one(258, 32);
  const samples = one(277, 1);
  const bytesPerSample = (bits / 8) * samples;

  const tiled = tags.has(324);
  const offsets = tiled ? tags.get(324) : tags.get(273);
  const counts = tiled ? tags.get(325) : tags.get(279);
  if (!offsets || !counts) {
    closeSync(fd);
    throw new Error(`${path}: no strip or tile offsets`);
  }

  const tileWidth = tiled ? one(322) : width;
  const tileHeight = tiled ? one(323) : one(278, height);

  const chunks = offsets.map((offset, index) => {
    // A tile is always the full tileWidth x tileHeight, padding included. A
    // strip is only as tall as the rows it actually covers, so the last one is
    // short whenever the height is not a multiple of rowsPerStrip.
    const rows = tiled ? tileHeight : Math.min(tileHeight, height - index * tileHeight);
    return {
      index,
      offset,
      byteCount: counts[index],
      expectedBytes: tileWidth * rows * bytesPerSample,
      read: () => at(offset, counts[index]),
    };
  });

  return {
    path,
    width,
    height,
    bits,
    tiled,
    tileWidth,
    tileHeight,
    fileSize: size,
    compression: one(259, 1),
    predictor: one(317, 1),
    chunks,
    close: () => closeSync(fd),
  };
}
