/**
 * Where a raster's bytes come from, abstracted to a single question: give me
 * these bytes at this offset.
 *
 * The whole point of this file is that a GeoTIFF does not have to be on the
 * local disk to be read. `readGeoTiff` calls `readFileSync`, which is correct
 * for a laptop and impossible in production: the survey rasters are gitignored,
 * a serverless function has no writable disk and a deployment bundle caps out
 * around 250 MB, and Aektanagar's DTM and DSM alone are 145 MB and 150 MB.
 *
 * A TIFF is not a format you have to read whole, though. Its directory sits at a
 * known place, the directory says exactly which byte ranges hold which tiles,
 * and HTTP has supported range requests since 1997. So the fix is not a bigger
 * machine, it is reading the fifty kilobytes that answer the question instead of
 * the hundred and fifty megabytes that contain it.
 *
 * Two implementations, one interface:
 *
 *   fileSource(path)   the laptop, and every test
 *   httpSource(url)    R2 through the tile Worker, which already forwards Range
 *                      headers and is covered by portal-tile-grant-test.mjs
 *
 * Both are async even where they need not be, because the caller must be written
 * against the slow one. A reader that works only when reads are instant is a
 * reader that works only on a laptop.
 */

import { open } from "node:fs/promises";

/**
 * Bytes from the local filesystem.
 *
 * Holds one file handle rather than reopening per read: a windowed read of a
 * tiled raster touches dozens of ranges, and reopening for each is the kind of
 * thing that looks fine at fixture scale and shows up as syscall time later.
 * `close()` is the caller's responsibility.
 */
export async function fileSource(path) {
  const handle = await open(path, "r");
  const { size } = await handle.stat();

  return {
    label: path,
    size,
    async read(offset, length) {
      const clamped = Math.max(0, Math.min(length, size - offset));
      if (clamped <= 0) return Buffer.alloc(0);
      const buffer = Buffer.alloc(clamped);
      await handle.read(buffer, 0, clamped, offset);
      return buffer;
    },
    async close() {
      await handle.close();
    },
  };
}

/**
 * Bytes from an HTTP server that honours Range, which R2 does and the tile
 * Worker forwards unchanged.
 *
 * Three things here are not decoration:
 *
 * - **A 200 to a Range request is a failure, not a success.** A server that
 *   ignores the header answers with the whole object, and the caller would then
 *   read the first N bytes of a 150 MB body as though they were the requested
 *   window. That is silent corruption: the numbers stay plausible. So anything
 *   other than 206 is refused.
 * - **Credentials travel.** The Worker authorises by the same short lived cookie
 *   the map uses, so a read without it is a 404 and looks exactly like a missing
 *   raster.
 * - **The size comes from Content-Range**, not from a separate HEAD. One fewer
 *   round trip, and it cannot disagree with the body it arrived with.
 */
export function httpSource(url, { headers = {}, fetchImpl = fetch } = {}) {
  let size = null;

  /**
   * `headers` may be a function, and for the tile Worker it has to be.
   *
   * That Worker authorises with a grant that expires after thirty minutes,
   * while an opened raster is cached for the life of the process so its
   * directory is not re-parsed on every measurement. A header object captured
   * once would therefore work for half an hour and then start returning 404s
   * that look exactly like a survey being unpublished. Asking for the headers
   * per request costs one HMAC and removes the whole failure mode.
   */
  const currentHeaders = async () =>
    typeof headers === "function" ? await headers() : headers;

  async function request(offset, length) {
    const end = offset + length - 1;
    const response = await fetchImpl(url, {
      headers: { ...(await currentHeaders()), Range: `bytes=${offset}-${end}` },
      credentials: "include",
    });

    if (response.status === 206) {
      const range = response.headers.get("Content-Range");
      // "bytes 0-65535/152225265"
      const total = range?.split("/")[1];
      if (total && total !== "*") size = Number(total);
      return Buffer.from(await response.arrayBuffer());
    }

    if (response.status === 200) {
      throw new Error(
        `${url}: answered a Range request with 200 and the whole object. ` +
          "Reading a window out of that would silently return the wrong bytes.",
      );
    }
    if (response.status === 404) {
      throw new Error(`${url}: not found, or not authorised for this session.`);
    }
    throw new Error(`${url}: range request failed with ${response.status}`);
  }

  return {
    label: url,
    get size() {
      return size;
    },
    async read(offset, length) {
      if (length <= 0) return Buffer.alloc(0);
      return request(offset, length);
    },
    async close() {},
  };
}

/**
 * A source that remembers what it has already fetched.
 *
 * A windowed read walks the directory, then the tile offset arrays, then the
 * tiles, and those overlap heavily: the header is consulted repeatedly and
 * neighbouring tiles often share a fetched span. Without this, opening one
 * raster is dozens of requests to the same first kilobyte.
 *
 * Deliberately a span cache rather than an LRU with byte accounting. The spans
 * kept are the header, which is small and read constantly, and whatever tiles
 * the current window needed, which is bounded by the window. Adding eviction
 * would be code with no failure it prevents.
 */
export function cached(source, { prefetch = 512 * 1024 } = {}) {
  /** @type {{start:number, end:number, bytes:Buffer}[]} */
  const spans = [];
  let warmed = false;

  const find = (offset, length) =>
    spans.find((s) => offset >= s.start && offset + length <= s.end);

  return {
    label: source.label,
    get size() {
      return source.size;
    },
    /**
     * The header, the IFD and the tile offset arrays all live near the front of
     * any TIFF a survey pipeline writes, so one read up front replaces a long
     * conversation. 512 KB covers the directory of a raster with thousands of
     * tiles; anything past it is fetched on demand and cached like everything
     * else, so an unusual layout is slower rather than broken.
     */
    async warm() {
      if (warmed) return;
      warmed = true;
      const bytes = await source.read(0, prefetch);
      if (bytes.length) spans.push({ start: 0, end: bytes.length, bytes });
    },
    async read(offset, length) {
      if (length <= 0) return Buffer.alloc(0);
      const hit = find(offset, length);
      if (hit) return hit.bytes.subarray(offset - hit.start, offset - hit.start + length);
      const bytes = await source.read(offset, length);
      spans.push({ start: offset, end: offset + bytes.length, bytes });
      return bytes;
    },
    async close() {
      await source.close();
    },
    /** Test seam: how much was actually pulled, and in how many requests. */
    get stats() {
      return {
        requests: spans.length,
        bytes: spans.reduce((sum, s) => sum + s.bytes.length, 0),
      };
    },
  };
}
