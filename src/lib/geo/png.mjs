/**
 * A minimal PNG encoder: 8 bit truecolour with alpha, and nothing else.
 *
 * ## Why hand written rather than sharp
 *
 * `sharp` is present in `node_modules` but **not in `package.json`** — it
 * arrives transitively through Next's image optimisation, so depending on it
 * would mean depending on a package this project never declared and which a
 * different Next release could stop shipping. Adding it properly is worse: it is
 * a native binary of tens of megabytes, and the deployment that serves these
 * tiles already has a bundle limit that the survey rasters could not fit inside.
 *
 * The alternative is sixty lines against `node:zlib`, which is built in. That is
 * the same trade this repository has already made three times, for the same
 * reason: LZW decoding in `raster.mjs`, SigV4 in `upload-site.mjs`, and the
 * GeoTIFF writer. A tile encoder is a small enough piece of specification to own.
 *
 * ## What it does not do
 *
 * No palettes, no interlacing, no 16 bit channels, and no filter types beyond
 * None. A filter is a per-scanline predictor that helps deflate find patterns;
 * `Sub` and `Paeth` would shave bytes off a photograph. These tiles are a colour
 * ramp over smooth terrain, where deflate already finds the runs, and every
 * filter type is one more thing to get subtly wrong for a few percent.
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * CRC-32, as PNG defines it: the standard reflected polynomial 0xEDB88320.
 *
 * Built once into a lookup table. A per-bit implementation is four lines
 * shorter and roughly eight times slower, which matters when every tile CRCs
 * its own image data.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC over type and payload. */
function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * `rgba` is width * height * 4 bytes, row major from the top left, which is the
 * order both a canvas and a raster window already use.
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`encodePng: bad dimensions ${width} x ${height}`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodePng: expected ${expected} bytes of RGBA, got ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6: truecolour with alpha
  ihdr[10] = 0; // deflate, the only compression PNG defines
  ihdr[11] = 0; // adaptive filtering, the only filter method PNG defines
  ihdr[12] = 0; // no interlace

  // Every scanline carries a leading filter byte. Zero is "None".
  const pixels = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A fully transparent tile.
 *
 * Returned where a tile falls entirely outside the survey. A 204 would be
 * tidier, but MapLibre treats a missing tile and an empty one differently at
 * the edges of a source, and a transparent PNG composites correctly in every
 * case without special handling in the style.
 */
export function transparentPng(size = 256) {
  return encodePng(size, size, new Uint8Array(size * size * 4));
}
