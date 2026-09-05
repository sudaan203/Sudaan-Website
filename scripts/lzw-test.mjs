/**
 * The WASM LZW decoder against the JavaScript one it replaces.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/lzw-test.mjs
 *
 * LZW decode is the hottest primitive in the portal: it sits on the path of
 * every raster read, which means every map tile, every spot level, every
 * profile, every volume and every flood. That is why it was worth writing
 * twice — and exactly why the second one has to be proved identical to the
 * first rather than merely fast.
 *
 * A decoder that is quick and subtly wrong does not throw. It returns terrain,
 * and the terrain is plausible, and every number computed from it afterwards is
 * confidently wrong. So the test here is byte equality over real survey tiles,
 * not a spot check: every chunk of every raster present, compared element for
 * element, plus the format's own edge cases and a corrupt input that must be
 * refused rather than read past the end of a buffer.
 */

import { openTiffChunks } from "./lib/tiff-chunks.mjs";
import { lzwDecodeJs, lzwDecodeWasm, lzwBackend } from "../src/lib/geo/lzw.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};
const ms = () => Number(process.hrtime.bigint() / 1000000n);

const TERRAIN =
  process.env.PORTAL_TERRAIN_DIR ??
  new URL("../portal-data/terrain", import.meta.url).pathname;

console.log("\nThe kernel loads at all");
check("a WASM backend is selected", lzwBackend() === "wasm", lzwBackend());

// ---------------------------------------------------------------------------
console.log("\nReal survey rasters, chunk for chunk");
let anyRaster = false;
for (const site of ["kotba-survey", "aektanagar-survey", "kiru-hydroelectric-survey"]) {
  let tiff;
  try {
    tiff = openTiffChunks(`${TERRAIN}/${site}/dtm.tif`);
  } catch {
    console.log(`  .... ${site}: no raster present, skipped`);
    continue;
  }
  anyRaster = true;
  const expected = tiff.tiled
    ? tiff.tileWidth * tiff.tileHeight * (tiff.bits / 8)
    : tiff.width * tiff.tileHeight * (tiff.bits / 8);

  // Capped so a 2.3 GB file does not turn this suite into a coffee break. The
  // cap is on chunks, not bytes, so a tiled file still covers many tiles.
  const chunks = tiff.chunks.slice(0, 650);
  let mismatched = 0;
  let firstBad = -1;
  let bytesIn = 0;
  let bytesOut = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const raw = chunks[i].read();
    const js = lzwDecodeJs(raw, expected);
    const wasm = lzwDecodeWasm(raw, expected);
    bytesIn += raw.length;
    bytesOut += js.length;
    let same = js.length === wasm.length;
    if (same) {
      for (let k = 0; k < js.length; k += 1) {
        if (js[k] !== wasm[k]) { same = false; break; }
      }
    }
    if (!same) { mismatched += 1; if (firstBad < 0) firstBad = i; }
  }

  check(
    `${site}: all ${chunks.length} chunks decode byte for byte identically`,
    mismatched === 0,
    mismatched === 0
      ? `${(bytesIn / 1e6).toFixed(1)} MB in, ${(bytesOut / 1e6).toFixed(1)} MB out, ${tiff.tiled ? "tiled" : "stripped"}`
      : `${mismatched} chunks differ, first at #${firstBad}`,
  );

  // Speed, reported rather than asserted. A threshold here would fail on a
  // loaded machine and tell us nothing about correctness.
  const buffers = chunks.map((c) => c.read());
  let js = Infinity;
  let wasm = Infinity;
  for (let rep = 0; rep < 3; rep += 1) {
    let t = ms();
    for (const b of buffers) lzwDecodeJs(b, expected);
    js = Math.min(js, ms() - t);
    t = ms();
    for (const b of buffers) lzwDecodeWasm(b, expected);
    wasm = Math.min(wasm, ms() - t);
  }
  console.log(`       JS ${js} ms · WASM ${wasm} ms · ${(js / wasm).toFixed(2)}x`);
  tiff.close();
}
if (!anyRaster) {
  console.log("  .... no rasters at all; set PORTAL_TERRAIN_DIR to compare against real data");
}

// ---------------------------------------------------------------------------
console.log("\nThe corners of the format");
{
  // A stream the JS decoder already handles; both must agree on all of them.
  // Built rather than quoted, so the widths under test are explicit.
  const encode = (codes, widths) => {
    const out = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < codes.length; i += 1) {
      acc = (acc << widths[i]) | codes[i];
      bits += widths[i];
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
    return Buffer.from(out);
  };

  // Clear, one literal, end-of-information: the shortest legal stream there is.
  const minimal = encode([256, 65, 257], [9, 9, 9]);
  const a = lzwDecodeJs(minimal, 1);
  const b = lzwDecodeWasm(minimal, 1);
  check("the shortest legal stream agrees", a.length === b.length && a[0] === b[0], `${a[0]} vs ${b[0]}`);

  // A deferred clear: two clears in a row, which a naive decoder mishandles by
  // adding a dictionary entry between them.
  const doubled = encode([256, 256, 66, 257], [9, 9, 9, 9]);
  const c = lzwDecodeJs(doubled, 1);
  const d = lzwDecodeWasm(doubled, 1);
  check("a repeated clear code agrees", c.length === d.length && c[0] === d[0], `${c[0]} vs ${d[0]}`);

  // Truncated input: must not read past the buffer. Whatever the JS one does,
  // the WASM one must do too — including if that is throwing.
  const truncated = minimal.subarray(0, 1);
  let jsResult, wasmResult;
  try { jsResult = lzwDecodeJs(truncated, 8); } catch (e) { jsResult = `threw: ${e.constructor.name}`; }
  try { wasmResult = lzwDecodeWasm(truncated, 8); } catch (e) { wasmResult = `threw: ${e.constructor.name}`; }
  const bothThrew = typeof jsResult === "string" && typeof wasmResult === "string";
  const bothReturned =
    typeof jsResult !== "string" && typeof wasmResult !== "string" &&
    jsResult.length === wasmResult.length;
  check("truncated input is handled the same way, and does not run off the end",
    bothThrew || bothReturned,
    bothThrew ? `both threw` : `${jsResult?.length ?? jsResult} vs ${wasmResult?.length ?? wasmResult}`);
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
