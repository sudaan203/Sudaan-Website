/**
 * TIFF LZW decompression: the JavaScript reference, the WASM kernel, and the
 * switch between them.
 *
 * ## Why this file was worth writing
 *
 * `lzwDecode` is on the path of every raster operation in the product. A map
 * tile, a spot level, an elevation profile, a cut/fill volume, a flood run —
 * they all end up in `openRaster().readWindow()`, and that reads TIFF tiles that
 * have to be decompressed before a single elevation can be looked at.
 *
 * Profiling a 1.6 km window on the Kiru DTM (83,979 x 30,046 cells at 0.254 m,
 * 650 tiles, 45 MB compressed expanding to 170 MB) put 1,267 ms of a 1,318 ms
 * read inside `lzwDecodeJs`, against 51 ms of actual disk I/O. The portal is not
 * waiting on storage. It is waiting on this loop, and it is waiting on it in
 * every feature at once.
 *
 * LZW is also close to the worst case for a JIT: a serial bit-level state
 * machine with an unpredictable branch per code and a pointer chase per emitted
 * string. There is nothing to vectorise and no shape V8 likes better. The only
 * lever left is to run the same algorithm somewhere with real integer types and
 * without a bounds check on every typed-array index, which is what
 * `native/lzw/src/lib.rs` is.
 *
 * ## The JS one is not going anywhere
 *
 * `lzwDecodeJs` below is the original, unchanged, and it stays for three
 * separate reasons:
 *
 * 1. It is the oracle. `scripts/lzw-test.mjs` decodes every tile of every survey
 *    on the machine with both and asserts byte equality. Without a reference to
 *    compare against, "the WASM decoder is correct" is an assertion rather than
 *    a measurement.
 * 2. It is the fallback. If the module fails to instantiate — a stale embed, an
 *    engine without WebAssembly, a memory limit — the request is served slowly
 *    rather than not at all.
 * 3. It is the escape hatch. `PORTAL_LZW=js` in the environment reverts
 *    production to it without a deploy.
 *
 * ## The agreement is byte-exact, including where the JS is odd
 *
 * The Rust is a transliteration, not a reimplementation, and its header
 * enumerates the quirks that are copied on purpose: zero-filled dictionary slots
 * a corrupt stream can reach, a truncated stream returning a short buffer rather
 * than throwing, a clear code that does not clear the table, output counted past
 * the end of the buffer but not written. Those are not spec-correct LZW; they
 * are what this pipeline was validated against, and the moment the two decoders
 * disagree the disagreement is itself the bug.
 *
 * ## Switching
 *
 *   PORTAL_LZW=wasm   the Rust kernel (default)
 *   PORTAL_LZW=js     the reference implementation
 *
 * Unset means wasm, because that is the point of the exercise, and because the
 * failure path is a fallback rather than an error: any problem loading or
 * calling the kernel drops the process back to JS with one warning and keeps
 * serving. The variable exists so that a *wrong answer* — the one failure the
 * fallback cannot detect — can be switched off from a dashboard in seconds.
 */

import { LZW_WASM_BASE64 } from "./lzw-wasm.mjs";

/**
 * TIFF LZW decompression.
 *
 * Needed because it is what real deliverables actually arrive as. The Kherwada
 * fixture happens to be uncompressed, but `DTM/Kotba_DTM.tif`, written by the
 * processing team's own toolchain, is LZW, and so is most GeoTIFF that GDAL,
 * QGIS or Global Mapper produces by default. A reader that refuses it can only
 * open test data.
 *
 * Two details separate this from textbook LZW, and both are silent if wrong:
 *
 * - Codes are packed most significant bit first, not least.
 * - TIFF uses "early change": the code width grows one code sooner than plain
 *   LZW, at 511 rather than 512. Getting this wrong decodes the first few
 *   hundred bytes perfectly and then produces garbage, which looks like corrupt
 *   input rather than a decoder bug.
 *
 * Do not "clean this up". It is the definition the Rust kernel is checked
 * against, so a tidy-up here is a silent change to what the WASM path is
 * allowed to produce.
 */
export function lzwDecodeJs(input, expectedBytes) {
  const CLEAR = 256;
  const EOI = 257;
  const out = new Uint8Array(expectedBytes);
  let outAt = 0;

  // Dictionary entries as (prefix code, appended byte), walked backwards on
  // emit. Cheaper than materialising a byte array per entry.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Int32Array(4096);
  const stack = new Uint8Array(4096);

  let next = 258;
  let width = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let at = 0;
  let previous = -1;

  const reset = () => {
    next = 258;
    width = 9;
    previous = -1;
  };
  for (let i = 0; i < 256; i += 1) { prefix[i] = -1; suffix[i] = i; length[i] = 1; }

  const emit = (code) => {
    let depth = 0;
    let c = code;
    while (c >= 0 && depth < 4096) {
      stack[depth] = suffix[c];
      depth += 1;
      c = prefix[c];
    }
    for (let i = depth - 1; i >= 0; i -= 1) {
      if (outAt < out.length) out[outAt] = stack[i];
      outAt += 1;
    }
  };

  while (outAt < expectedBytes) {
    while (bitCount < width) {
      if (at >= input.length) return out;
      bitBuffer = (bitBuffer << 8) | input[at];
      at += 1;
      bitCount += 8;
    }
    const code = (bitBuffer >> (bitCount - width)) & ((1 << width) - 1);
    bitCount -= width;

    if (code === EOI) break;
    if (code === CLEAR) { reset(); continue; }

    if (previous === -1) {
      emit(code);
      previous = code;
      continue;
    }

    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = previous;
        // First byte of the code just emitted.
        let first = code;
        while (prefix[first] >= 0) first = prefix[first];
        suffix[next] = suffix[first];
        length[next] = length[previous] + 1;
        next += 1;
      }
    } else {
      // The code is not in the table yet, the KwKwK case: it must expand to the
      // previous string plus its own first byte.
      let first = previous;
      while (prefix[first] >= 0) first = prefix[first];
      if (next < 4096) {
        prefix[next] = previous;
        suffix[next] = suffix[first];
        length[next] = length[previous] + 1;
        next += 1;
      }
      emit(next - 1);
    }
    previous = code;

    // Early change: grow one code before the table is actually full.
    if (next + 1 >= (1 << width) && width < 12) width += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The WASM kernel
// ---------------------------------------------------------------------------

/** null until first use, then the instance, or false if it could not be had. */
let kernel = null;
let warned = false;

/**
 * Warn once per process, never per tile.
 *
 * A window over Kiru decodes 650 tiles. If the kernel is unavailable, warning
 * per call turns one configuration problem into 650 lines of log per request,
 * which is how a fallback that works ends up looking like an outage.
 */
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[lzw] ${message}`);
}

/** base64 to bytes, without assuming Node. */
function decodeBase64(text) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Instantiate the kernel, or decide once that we cannot.
 *
 * Synchronous instantiation, which is what lets `lzwDecode` keep the signature
 * every existing caller uses. `readGeoTiff` is synchronous top to bottom and
 * `readWindow` calls the decoder inside an already-async loop; making the
 * decoder itself async would push `await` through both and buy nothing. Node
 * places no size limit on synchronous compilation, and 1.4 KB is far below the
 * 4 KB ceiling browsers and Workers apply to the synchronous constructors, so
 * the same code path works in all three.
 *
 * Every failure is answered with `false` rather than a throw. There is no
 * failure mode here that is better served by a 500 than by a slower correct
 * answer.
 */
function loadKernel() {
  if (kernel !== null) return kernel;
  try {
    if (typeof WebAssembly === "undefined") throw new Error("no WebAssembly in this runtime");
    const module = new WebAssembly.Module(decodeBase64(LZW_WASM_BASE64));
    const instance = new WebAssembly.Instance(module, {});
    const { memory, lzw_alloc, lzw_reset, lzw_decode } = instance.exports;
    if (!memory || !lzw_alloc || !lzw_reset || !lzw_decode) {
      throw new Error("compiled kernel is missing an export; rebuild with scripts/build-lzw-wasm.mjs");
    }
    kernel = { memory, alloc: lzw_alloc, reset: lzw_reset, decode: lzw_decode };
  } catch (error) {
    kernel = false;
    warnOnce(`WASM kernel unavailable, falling back to JavaScript: ${error.message}`);
  }
  return kernel;
}

/**
 * Decode with the Rust kernel. Throws if it is unavailable, unlike `lzwDecode`.
 *
 * Three traps live in these twenty lines, and all three fail quietly rather than
 * loudly, which is why they are spelled out:
 *
 * 1. **`memory.buffer` is invalidated by growth.** `lzw_alloc` calls
 *    `memory.grow` when the arena runs short, and that detaches every existing
 *    ArrayBuffer view. So both allocations happen first and the views are taken
 *    afterwards. Taking a view of the input, writing it, and then allocating the
 *    output would produce an empty input on exactly the calls that needed more
 *    memory — that is, on the big tiles, intermittently.
 *
 * 2. **A failed grow returns a null pointer, not an exception.** WASM has no way
 *    to throw. Address zero is a perfectly writable address in linear memory, so
 *    an unchecked null would corrupt the module's own statics and decode
 *    garbage rather than crash.
 *
 * 3. **The result has to be copied out.** A `Uint8Array` over `memory.buffer`
 *    would be a view into an arena that the next tile reuses, so the caller
 *    would watch its data change under it. `slice` copies.
 */
export function lzwDecodeWasm(input, expectedBytes) {
  const k = loadKernel();
  if (!k) throw new Error("lzw: WASM kernel is not available");

  k.reset();
  const inPtr = k.alloc(input.length);
  const outPtr = k.alloc(expectedBytes);
  // Both may legitimately be zero when the length is zero, hence the length test
  // rather than a bare truthiness test on the pointer.
  if ((input.length > 0 && inPtr === 0) || (expectedBytes > 0 && outPtr === 0)) {
    throw new Error(
      `lzw: could not reserve ${input.length + expectedBytes} bytes of WASM memory`,
    );
  }

  const heap = new Uint8Array(k.memory.buffer);
  heap.set(input, inPtr);
  k.decode(inPtr, input.length, outPtr, expectedBytes);
  return heap.slice(outPtr, outPtr + expectedBytes);
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** Resolved once. Reading process.env per tile is not free at 650 tiles a request. */
let chosen = null;

/**
 * Which implementation is in use, and why. For tests and for a status endpoint.
 *
 * @returns {"js"|"wasm"}
 */
export function lzwBackend() {
  if (chosen !== null) return chosen;
  const requested =
    typeof process !== "undefined" && process.env ? process.env.PORTAL_LZW : undefined;

  if (requested === "js") {
    chosen = "js";
  } else if (requested === undefined || requested === "" || requested === "wasm") {
    chosen = loadKernel() ? "wasm" : "js";
  } else {
    warnOnce(`PORTAL_LZW=${requested} is not one of js|wasm; using wasm`);
    chosen = loadKernel() ? "wasm" : "js";
  }
  return chosen;
}

/**
 * Decode a TIFF LZW stream into `expectedBytes` bytes.
 *
 * The signature every caller already used, so switching implementations is a
 * change of import and nothing else.
 *
 * The `catch` is not belt and braces. A kernel that instantiates can still fail
 * later — a grow that cannot be satisfied under memory pressure, a trap from a
 * bug in the Rust — and the cost of being wrong about that is a failed client
 * request against a survey that was fine a minute ago. Degrading to the slow
 * decoder for the rest of the process is strictly better, and the process is
 * told once which decoder it ended up on.
 *
 * Note what this does *not* catch: a wrong answer. Nothing at runtime can tell
 * plausible terrain from correct terrain, which is why the differential test
 * over real tiles in `scripts/lzw-test.mjs` is where the confidence actually
 * comes from, and why `PORTAL_LZW=js` exists.
 */
export function lzwDecode(input, expectedBytes) {
  if (lzwBackend() === "js") return lzwDecodeJs(input, expectedBytes);
  try {
    return lzwDecodeWasm(input, expectedBytes);
  } catch (error) {
    chosen = "js";
    warnOnce(`WASM decode failed, falling back to JavaScript for this process: ${error.message}`);
    return lzwDecodeJs(input, expectedBytes);
  }
}
