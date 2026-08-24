/**
 * A ZIP container, read and write, for bundling a shapefile's four sibling
 * files into the one download Malhar's tool asks for.
 *
 * Written out rather than pulled in for the same reason the PNG encoder and the
 * DXF writer were: this is a well-specified binary format, the whole of what is
 * needed here is "store a handful of small named byte buffers, and read them
 * back," and a general purpose zip library is built for archives with folders,
 * timestamps, permissions, streaming and encryption, none of which apply to
 * four files under a hundred kilobytes.
 *
 * ## Store, not deflate, on write
 *
 * Every file this writes is put in the archive uncompressed (method 0, STORE).
 * A shapefile's four parts are already small and mostly numeric, deflating them
 * saves little, and STORE is a completely valid, universally read zip entry —
 * QGIS, ArcGIS, Global Mapper and `unzip` all open a stored-only zip without
 * complaint. Skipping compression means the writer has no encoder to get wrong.
 *
 * ## Deflate, on read
 *
 * The reader has to handle both. A zip a client uploads did not come from this
 * writer — it came from whatever GIS software they use, and the common ones
 * default to deflating. `node:zlib`'s raw inflate handles that; there is no
 * reason to write our own.
 */

import { inflateRawSync } from "node:zlib";

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

/** CRC-32 with the same reflected polynomial every zip and PNG implementation uses. */
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time packed the way a zip local header wants it, from "now". */
function dosDateTime() {
  const d = new Date();
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a zip archive from named entries.
 *
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const { time, date } = dosDateTime();
  const local = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: 0 = store
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    local.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: store
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // offset of local header

    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  offset += centralBuf.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // size of central directory
  end.writeUInt32LE(centralStart, 16); // offset of central directory
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...local, centralBuf, end]);
}

/**
 * Read a zip archive back into named entries.
 *
 * Walked from the end of central directory record backward, which is how every
 * zip reader has to work: the format was designed for tape, so the authoritative
 * table of what is in the archive is written last and points backward at
 * records that may themselves be preceded by junk. Reading forward from byte
 * zero and hoping local headers agree with the central directory is the
 * approach that breaks on the first file a spanning archive or a self-extractor
 * stub produces.
 *
 * @param {Buffer} buffer
 * @returns {{ name: string, data: Buffer }[]}
 */
export function readZip(buffer) {
  // The end-of-central-directory record is fixed size with a variable comment
  // after it, so it is found by scanning backward for its signature rather than
  // assumed to be at a fixed offset.
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive: no end of central directory record found");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) {
      throw new Error(`zip central directory entry ${i} has a bad signature`);
    }
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);

    // The local header repeats sizes but its own name and extra field lengths
    // can differ from the central directory's, so the data start has to be
    // computed from the local header's own fields, not assumed to match.
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`zip local header for "${name}" has a bad signature`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(
        `"${name}" uses zip compression method ${method}, which is not store or deflate. ` +
          "Re-save it with a standard tool.",
      );
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`"${name}" decompressed to ${data.length} bytes, expected ${uncompressedSize}`);
    }

    entries.push({ name, data });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
