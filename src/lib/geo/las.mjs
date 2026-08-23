/**
 * A reader for LAS point clouds, streaming.
 *
 * Written rather than taken from a package for the same reason the GeoTIFF
 * reader was: the surveys arrive as one 1.7 GB file, the only operation the
 * portal needs is "walk every point once", and every library that does this
 * either wants the file in memory or drags in a native build. LAS is a fixed
 * width record after a fixed header, which is the easiest binary format in this
 * repository to read correctly.
 *
 * LAZ is *not* supported and is not a small addition: it is an arithmetic coder
 * with per-field context models, not a container we can skip past. If a client
 * sends one, it has to be expanded with `laszip` before it reaches this.
 */

import { open } from "node:fs/promises";

/** Byte offsets into the public header block, LAS 1.2 through 1.4. */
const H = {
  signature: 0,
  versionMajor: 24,
  versionMinor: 25,
  headerSize: 94,
  offsetToPointData: 96,
  variableLengthRecords: 100,
  pointDataFormat: 104,
  pointDataRecordLength: 105,
  legacyPointCount: 107,
  scale: 131,
  offset: 155,
  extent: 179,
  // 1.4 only: the 64-bit count that supersedes the legacy 32-bit one.
  pointCount14: 247,
};

/**
 * Which point formats we can read, and where the colour sits in each.
 *
 * Formats 4, 5, 9 and 10 carry waveform data after the fields we want, which
 * changes the record length but not the offsets of anything we read, so they
 * come along for free. Formats 6 to 10 moved the classification byte and widened
 * the return fields, which is why they are described separately rather than
 * assumed.
 */
const FORMATS = {
  0: { rgb: null, classification: 15, legacy: true },
  1: { rgb: null, classification: 15, legacy: true },
  2: { rgb: 20, classification: 15, legacy: true },
  3: { rgb: 28, classification: 15, legacy: true },
  4: { rgb: null, classification: 15, legacy: true },
  5: { rgb: 28, classification: 15, legacy: true },
  6: { rgb: null, classification: 16, legacy: false },
  7: { rgb: 30, classification: 16, legacy: false },
  8: { rgb: 30, classification: 16, legacy: false },
  9: { rgb: null, classification: 16, legacy: false },
  10: { rgb: 30, classification: 16, legacy: false },
};

/**
 * @typedef {object} LasHeader
 * @property {number} versionMajor
 * @property {number} versionMinor
 * @property {number} pointDataFormat
 * @property {number} pointDataRecordLength
 * @property {number} pointCount
 * @property {number} offsetToPointData
 * @property {{x:number,y:number,z:number}} scale
 * @property {{x:number,y:number,z:number}} offset
 * @property {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}} bounds
 * @property {number|null} epsg
 * @property {string|null} crsName
 */

/** Read and validate the public header block, plus the CRS if one is declared. */
export async function readLasHeader(path) {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(375);
    await file.read(head, 0, 375, 0);
    if (head.toString("latin1", 0, 4) !== "LASF") {
      throw new Error(
        `${path} is not a LAS file. LAZ is compressed and has to be expanded first.`,
      );
    }

    const versionMajor = head[H.versionMajor];
    const versionMinor = head[H.versionMinor];
    const headerSize = head.readUInt16LE(H.headerSize);
    const offsetToPointData = head.readUInt32LE(H.offsetToPointData);
    const variableLengthRecords = head.readUInt32LE(H.variableLengthRecords);
    // The high bits of the format byte are compression flags. A set bit is LAZ.
    const rawFormat = head[H.pointDataFormat];
    if (rawFormat & 0x80) {
      throw new Error(`${path} is LAZ compressed. Expand it with laszip first.`);
    }
    const pointDataFormat = rawFormat & 0x3f;
    if (!(pointDataFormat in FORMATS)) {
      throw new Error(`unsupported LAS point data format ${pointDataFormat}`);
    }
    const pointDataRecordLength = head.readUInt16LE(H.pointDataRecordLength);

    /*
     * 1.4 moved the point count to a 64-bit field and left the old one as a
     * legacy value that is *zero* for a file with more than 4.29 billion points
     * or for formats above 5. Reading only the legacy field would report an
     * empty cloud rather than failing, which is the worst kind of wrong.
     */
    let pointCount = head.readUInt32LE(H.legacyPointCount);
    if (versionMajor === 1 && versionMinor >= 4) {
      const wide = head.readBigUInt64LE(H.pointCount14);
      if (wide > 0n) {
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("point count exceeds what a JavaScript number holds exactly");
        }
        pointCount = Number(wide);
      }
    }

    const scale = {
      x: head.readDoubleLE(H.scale),
      y: head.readDoubleLE(H.scale + 8),
      z: head.readDoubleLE(H.scale + 16),
    };
    const offset = {
      x: head.readDoubleLE(H.offset),
      y: head.readDoubleLE(H.offset + 8),
      z: head.readDoubleLE(H.offset + 16),
    };
    // The header stores the extent as maxX, minX, maxY, minY, maxZ, minZ. That
    // order is not a typo in the specification and has been misread often enough
    // to be worth naming here.
    const bounds = {
      maxX: head.readDoubleLE(H.extent),
      minX: head.readDoubleLE(H.extent + 8),
      maxY: head.readDoubleLE(H.extent + 16),
      minY: head.readDoubleLE(H.extent + 24),
      maxZ: head.readDoubleLE(H.extent + 32),
      minZ: head.readDoubleLE(H.extent + 40),
    };

    const { epsg, crsName } = await readCrs(file, headerSize, variableLengthRecords);

    return {
      versionMajor,
      versionMinor,
      pointDataFormat,
      pointDataRecordLength,
      pointCount,
      offsetToPointData,
      scale,
      offset,
      bounds,
      epsg,
      crsName,
      layout: FORMATS[pointDataFormat],
    };
  } finally {
    await file.close();
  }
}

/**
 * The projected CRS, from the GeoTIFF-style key directory LAS borrowed.
 *
 * Only the projected code (3072) is looked for. A cloud in geographic
 * coordinates would need a different pipeline anyway — the whole point of the
 * quadtree is that a metre is a metre in both directions — so failing to find
 * one is a fact worth returning rather than a default worth inventing.
 */
async function readCrs(file, headerSize, count) {
  let cursor = headerSize;
  let epsg = null;
  let crsName = null;
  for (let i = 0; i < count; i += 1) {
    const head = Buffer.alloc(54);
    const { bytesRead } = await file.read(head, 0, 54, cursor);
    if (bytesRead < 54) break;
    const userId = head.toString("latin1", 2, 18).replace(/\0.*$/, "");
    const recordId = head.readUInt16LE(18);
    const length = head.readUInt16LE(20);
    const body = Buffer.alloc(length);
    if (length > 0) await file.read(body, 0, length, cursor + 54);
    cursor += 54 + length;

    if (userId !== "LASF_Projection") continue;
    if (recordId === 34735) {
      // GeoKeyDirectoryTag: a header of four shorts, then four shorts per key.
      for (let k = 4; k + 3 < length / 2; k += 4) {
        const keyId = body.readUInt16LE(k * 2);
        const value = body.readUInt16LE((k + 3) * 2);
        if (keyId === 3072) epsg = value;
      }
    } else if (recordId === 34737) {
      crsName = body.toString("latin1").replace(/\0.*$/, "").split("|")[0] || null;
    } else if (recordId === 2112) {
      // An OGC WKT string, used by 1.4 files instead of the key directory.
      const wkt = body.toString("latin1").replace(/\0.*$/, "");
      if (epsg === null) {
        const match = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]\s*\]\s*$/);
        if (match) epsg = Number(match[1]);
      }
      if (!crsName) crsName = wkt.match(/^PROJCS\s*\[\s*"([^"]+)"/)?.[1] ?? null;
    }
  }
  return { epsg, crsName };
}

/**
 * Walk every point in the file, in order, calling `onPoint` for each.
 *
 * Streamed in large chunks rather than read whole: these files are gigabytes and
 * the machine that runs the pipeline is a laptop. The callback is given plain
 * numbers rather than an object literal per point, because at fifty million
 * points an allocation per point is the difference between a minute and ten.
 *
 * `onPoint(x, y, z, r, g, b, classification, intensity)` where x, y and z are in
 * the file's own CRS and r, g, b are 0..255. A file with no colour reports r, g
 * and b as -1 rather than as black, so a caller can tell "unlit" from "dark".
 *
 * @param {string} path
 * @param {(x:number,y:number,z:number,r:number,g:number,b:number,classification:number,intensity:number)=>void} onPoint
 * @param {{ chunkBytes?: number, onProgress?: (done:number,total:number)=>void }} [options]
 */
export async function streamLasPoints(path, onPoint, options = {}) {
  const { chunkBytes = 16 * 1024 * 1024, onProgress = null } = options;
  const header = await readLasHeader(path);
  const {
    pointCount,
    pointDataRecordLength: stride,
    offsetToPointData,
    scale,
    offset,
    layout,
  } = header;

  /*
   * Colour in LAS is 16 bit. Most producers write 0..65535, some write 0..255
   * into a 16-bit field, and there is no flag saying which. Guessing per point
   * would band the cloud; guessing per file from a sample is reliable, because a
   * genuinely 16-bit cloud has values above 255 almost immediately.
   */
  let colourShift = 8;
  if (layout.rgb !== null) {
    colourShift = (await sampleColourDepth(path, header)) ? 8 : 0;
  }

  const file = await open(path, "r");
  try {
    // A whole number of records per chunk, so no point straddles a read.
    const perChunk = Math.max(1, Math.floor(chunkBytes / stride));
    const buffer = Buffer.alloc(perChunk * stride);
    let done = 0;
    let cursor = offsetToPointData;

    while (done < pointCount) {
      const want = Math.min(perChunk, pointCount - done);
      const { bytesRead } = await file.read(buffer, 0, want * stride, cursor);
      const got = Math.floor(bytesRead / stride);
      if (got === 0) break;
      cursor += got * stride;

      for (let i = 0; i < got; i += 1) {
        const at = i * stride;
        const x = buffer.readInt32LE(at) * scale.x + offset.x;
        const y = buffer.readInt32LE(at + 4) * scale.y + offset.y;
        const z = buffer.readInt32LE(at + 8) * scale.z + offset.z;
        const intensity = buffer.readUInt16LE(at + 12);
        // Formats 6 and up widened the return byte, moving classification on by
        // one; `layout` carries the right offset rather than assuming 1.2.
        const classification = layout.legacy
          ? buffer[at + layout.classification] & 0x1f
          : buffer[at + layout.classification];
        let r = -1;
        let g = -1;
        let b = -1;
        if (layout.rgb !== null) {
          r = buffer.readUInt16LE(at + layout.rgb) >> colourShift;
          g = buffer.readUInt16LE(at + layout.rgb + 2) >> colourShift;
          b = buffer.readUInt16LE(at + layout.rgb + 4) >> colourShift;
        }
        onPoint(x, y, z, r, g, b, classification, intensity);
      }

      done += got;
      if (onProgress) onProgress(done, pointCount);
    }
    return header;
  } finally {
    await file.close();
  }
}

/** True when the file's colour really uses the full 16-bit range. */
async function sampleColourDepth(path, header) {
  const file = await open(path, "r");
  try {
    const stride = header.pointDataRecordLength;
    const rgbAt = header.layout.rgb;
    const step = Math.max(1, Math.floor(header.pointCount / 5000));
    const buffer = Buffer.alloc(stride);
    for (let i = 0; i < header.pointCount; i += step) {
      const at = header.offsetToPointData + i * stride;
      const { bytesRead } = await file.read(buffer, 0, stride, at);
      if (bytesRead < stride) break;
      for (let c = 0; c < 6; c += 2) {
        if (buffer.readUInt16LE(rgbAt + c) > 255) return true;
      }
    }
    return false;
  } finally {
    await file.close();
  }
}

/**
 * ASPRS classification names, for the classes a survey actually contains.
 *
 * Kept here rather than in the viewer because it is a property of the format,
 * and because the pipeline reports which classes a cloud holds so the panel can
 * offer only those rather than a menu of eighteen mostly empty entries.
 */
export const CLASSIFICATIONS = {
  0: "Never classified",
  1: "Unclassified",
  2: "Ground",
  3: "Low vegetation",
  4: "Medium vegetation",
  5: "High vegetation",
  6: "Building",
  7: "Low point (noise)",
  8: "Model key point",
  9: "Water",
  10: "Rail",
  11: "Road surface",
  12: "Overlap",
  13: "Wire guard",
  14: "Wire conductor",
  15: "Transmission tower",
  16: "Wire connector",
  17: "Bridge deck",
  18: "High noise",
};
