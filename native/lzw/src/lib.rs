//! TIFF LZW decompression, as a WASM kernel.
//!
//! ## Why this exists at all
//!
//! Every raster operation in the portal goes through LZW. A map tile, a spot
//! level, an elevation profile, a cut/fill volume, a flood simulation: all of
//! them end up in `openRaster().readWindow()`, and all of them pay for
//! decompressing the TIFF tiles that window touches. Profiling a 1.6 km window
//! on the Kiru DTM (83,979 x 30,046 cells at 0.254 m) put 1,267 ms of a 1,318 ms
//! read inside `lzwDecode` and 51 ms in actual disk I/O. The product is not
//! waiting on storage, it is waiting on this loop.
//!
//! LZW is also close to the worst case for a JavaScript JIT. It is a serial
//! bit-level state machine over typed arrays with an unpredictable branch per
//! code and a pointer chase per emitted string. There is no vectorising it and
//! no restructuring it into something V8 likes better; the only thing left is to
//! run it somewhere with real integer types and no bounds-check tax.
//!
//! ## The contract this file is held to
//!
//! Byte-exact agreement with `lzwDecode` in `src/lib/geo/raster.mjs`, on every
//! input including malformed ones. That is a stronger requirement than "correct
//! LZW", and deliberately so. The JS decoder is the reference the whole pipeline
//! was validated against, so if the two ever disagree, the disagreement itself
//! is the bug — whichever one is "more right" about the spec. A decoder that is
//! fast and subtly different produces terrain that looks plausible and is wrong,
//! which is the exact failure mode the rest of this codebase spends its effort
//! avoiding.
//!
//! So this is a transliteration, not a reimplementation. Several things below
//! are odd, and every one of them is odd in the same way the JS is:
//!
//! - **Dictionary slots 256..4095 start as zero, not as "undefined".** In JS
//!   they are the zero fill of a fresh `Int32Array`/`Uint8Array`. A corrupt
//!   stream that emits an undefined code therefore walks `prefix[c] = 0` down to
//!   code 0 and produces two zero bytes rather than erroring. Matched here by
//!   zeroing the tables, not by treating undefined codes as an error.
//!
//! - **Running out of input returns what was decoded so far.** The JS does
//!   `if (at >= input.length) return out;` mid-stream, with no throw. Truncated
//!   tiles therefore yield a short, zero-padded buffer. Matched. (The binding
//!   still refuses to read outside the buffer — the point is that a truncated
//!   stream is *handled*, not that it is silently believed.)
//!
//! - **A clear code does not clear the dictionary**, only `next`, `width` and
//!   `previous`. Stale entries stay in the table. They turn out to be
//!   unreachable in the normal path, but the behaviour is copied rather than
//!   reasoned away.
//!
//! - **The code width grows at the end of the body only for ordinary codes.**
//!   The first code after a clear takes an early `continue` in the JS and so
//!   skips the width check. Same here.
//!
//! - **Output past `expected` is counted but not written.** The JS emit loop
//!   increments `outAt` unconditionally and guards only the store, which is what
//!   lets the `while (outAt < expectedBytes)` loop terminate on a stream that
//!   overruns. Same here.
//!
//! The one thing left out is the JS `length` array: it is written and never
//! read, so it cannot affect a single output byte.
//!
//! ## The two details that are LZW-in-TIFF rather than LZW
//!
//! Both are silent when wrong, which is why the JS file calls them out too:
//!
//! - Codes are packed most significant bit first.
//! - TIFF uses "early change": the width grows one code sooner than plain LZW,
//!   at 511 rather than 512. Get it wrong and the first few hundred bytes decode
//!   perfectly before the output turns to noise, which reads as a corrupt file
//!   rather than as a decoder bug.
//!
//! ## Why no crates, no `wasm-bindgen`, and `no_std`
//!
//! The kernel is a pure function over bytes and there is a plan to run it inside
//! a Cloudflare Worker later. `wasm-bindgen` would bring a generated JS shim
//! that assumes a bundler and, in some configurations, Node APIs; a hand-written
//! binding of about thirty lines does the same job, produces a smaller artifact,
//! and moves to a Worker unchanged. `#![no_std]` means there is no allocator,
//! no formatting machinery and no panic strings in the module — the dictionary
//! lives in statics and the only heap is the bump arena below.

#![no_std]

use core::panic::PanicInfo;

/// Nothing in this crate panics deliberately: every index below is either masked
/// into range or explicitly guarded. A panic reaching here is a bug in the
/// kernel, and trapping is the honest response — it surfaces in JS as a
/// `RuntimeError`, which the binding catches and answers by falling back to the
/// JS decoder for the rest of the process.
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/// Bump arena state. `BASE` of zero means "not yet initialised".
static mut BASE: usize = 0;
static mut CURSOR: usize = 0;

/// One wasm page.
const PAGE: usize = 65536;

/// Start of memory this crate is free to hand out.
///
/// Taken as the *initial* linear memory size, captured before the first
/// `memory_grow`. Everything the linker laid out — static data, and the shadow
/// stack wherever wasm-ld chose to put it — is inside that initial size by
/// construction, so anything above it is unclaimed. That is deliberately not
/// `__heap_base`: reading a linker-provided symbol works, but it is an
/// assumption about lld's output that this crate does not need to make, and the
/// arena has to be correct for the same module to run under a Worker's engine as
/// under Node's.
unsafe fn arena_base() -> usize {
    if BASE == 0 {
        BASE = core::arch::wasm32::memory_size(0) * PAGE;
        CURSOR = BASE;
    }
    BASE
}

/// Drop every allocation made since the last reset.
///
/// The kernel is called once per TIFF tile and its buffers do not outlive the
/// call, so the whole allocator is "reset, take input, take output, decode".
/// Freeing individual blocks would be machinery with no caller.
#[no_mangle]
pub unsafe extern "C" fn lzw_reset() {
    CURSOR = arena_base();
}

/// Reserve `len` bytes and return a pointer into linear memory, or null if the
/// memory cannot be grown.
///
/// Contents are undefined: the arena is reused across calls and is not zeroed
/// here. `lzw_decode` zeroes its own output buffer, which is the only place the
/// difference is observable — a fresh `Uint8Array` in JS reads as zeros, so a
/// tile whose stream ends early has to see zeros here too.
#[no_mangle]
pub unsafe extern "C" fn lzw_alloc(len: usize) -> *mut u8 {
    let base = arena_base();
    let _ = base;

    // Eight-byte alignment costs nothing and keeps any future wider access
    // (a u32 read over the output, say) aligned.
    let start = (CURSOR + 7) & !7;
    let end = match start.checked_add(len) {
        Some(end) => end,
        None => return core::ptr::null_mut(),
    };

    let have = core::arch::wasm32::memory_size(0) * PAGE;
    if end > have {
        let pages = (end - have + PAGE - 1) / PAGE;
        if core::arch::wasm32::memory_grow(0, pages) == usize::MAX {
            return core::ptr::null_mut();
        }
    }

    CURSOR = end;
    start as *mut u8
}

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

// Statics rather than locals. 20 KB of dictionary on the shadow stack would work
// — wasm-ld gives us a megabyte — but the tables are rebuilt per call anyway and
// keeping them at fixed addresses means the hot loop indexes off a constant.
static mut PREFIX: [i32; 4096] = [0; 4096];
static mut SUFFIX: [u8; 4096] = [0; 4096];
static mut STACK: [u8; 4096] = [0; 4096];

/// First byte of the string each code expands to.
///
/// The one place this file computes something the JS computes differently, and
/// the only optimisation in it that is not free by construction, so here is the
/// argument.
///
/// The JS finds the first byte of a code by walking the prefix chain to its root
/// (`while (prefix[first] >= 0) first = prefix[first]`) and reading that root's
/// suffix. It does that once per input code, on top of the walk `emit` already
/// does — so it roughly doubles the dependent-load chain, which is the dominant
/// cost of the whole loop. This table caches the same answer.
///
/// It is equal to the walk on every input, including malformed ones:
///
/// - Roots 0..255 walk to themselves, and `suffix[i] == i`. Seeded to `i`.
/// - A slot written as `(prefix = p, suffix = s)` represents string(p) + s, so
///   its first byte is the first byte of string(p). Seeded from `p`'s entry at
///   the moment the slot is written, which is when the JS's walk would have
///   reached the same root.
/// - A slot 256..4095 that was never written has `prefix = 0` in the JS's
///   zero-filled `Int32Array`, so the walk goes to code 0 and yields
///   `suffix[0] == 0`. Seeded to 0, which is the same answer.
/// - A clear code does not clear the table in the JS, so stale entries survive
///   it. Stale entries survive here too, for the same reason: nothing resets
///   this table on clear either.
///
/// The fuzz stage of `scripts/lzw-test.mjs` exercises the malformed cases
/// heavily — random bytes reach undefined codes within a few hundred codes — so
/// this reasoning is checked rather than merely written down.
static mut FIRST: [u8; 4096] = [0; 4096];

const CLEAR: u32 = 256;
const EOI: u32 = 257;

/// Decode one LZW stream.
///
/// `out_ptr` must point at `out_len` writable bytes, `in_ptr` at `in_len`
/// readable ones; the binding is what guarantees that, because it is what
/// allocated both. Returns the number of bytes the stream produced, saturated at
/// `out_len` — the caller reads the whole `out_len` buffer regardless (as the JS
/// caller reads the whole `Uint8Array`), so the count is for diagnostics, not
/// for slicing.
///
/// # Safety
///
/// Called across the WASM boundary with pointers this module handed out.
#[no_mangle]
pub unsafe extern "C" fn lzw_decode(
    in_ptr: *const u8,
    in_len: usize,
    out_ptr: *mut u8,
    out_len: usize,
) -> usize {
    let input = core::slice::from_raw_parts(in_ptr, in_len);
    let out = core::slice::from_raw_parts_mut(out_ptr, out_len);

    let prefix = &mut *core::ptr::addr_of_mut!(PREFIX);
    let suffix = &mut *core::ptr::addr_of_mut!(SUFFIX);
    let stack = &mut *core::ptr::addr_of_mut!(STACK);
    let first_of = &mut *core::ptr::addr_of_mut!(FIRST);

    // Slots 256..4095 are zeroed, not left over from the previous tile: that is
    // what the JS's fresh typed arrays give, and a corrupt stream can reach
    // them. Slots 0..255 are the single-byte roots, prefix -1 meaning "end of
    // chain". Two loops rather than one with a branch, so the tail compiles to
    // a memset.
    for i in 0..256 {
        prefix[i] = -1;
        suffix[i] = i as u8;
        first_of[i] = i as u8;
    }
    for i in 256..4096 {
        prefix[i] = 0;
        suffix[i] = 0;
        first_of[i] = 0;
    }

    let mut out_at: usize = 0;
    let mut next: u32 = 258;
    let mut width: u32 = 9;
    let mut bit_buffer: u32 = 0;
    let mut bit_count: u32 = 0;
    let mut at: usize = 0;
    let mut previous: i32 = -1;

    // Walk a dictionary chain backwards onto `stack`, then replay it forwards.
    // Cheaper than materialising a byte array per dictionary entry, and it is
    // what the JS does. The 4096 depth cap is not decoration: a corrupt table
    // can contain a cycle, and without it this loop never returns.
    macro_rules! emit {
        ($code:expr) => {{
            let mut depth: usize = 0;
            let mut c: i32 = $code;
            while c >= 0 && depth < 4096 {
                stack[depth] = suffix[(c as usize) & 0xfff];
                depth += 1;
                c = prefix[(c as usize) & 0xfff];
            }
            if out_at + depth <= out_len {
                // The overwhelmingly common case: the whole string fits. Hoist
                // the per-byte bounds test out of the loop, which matters
                // because this is the one loop that runs once per output byte.
                let mut i = depth;
                let mut w = out_at;
                while i > 0 {
                    i -= 1;
                    *out.get_unchecked_mut(w) = *stack.get_unchecked(i);
                    w += 1;
                }
                out_at = w;
            } else {
                let mut i = depth;
                while i > 0 {
                    i -= 1;
                    // Count past the end without writing past it. This is what
                    // lets the outer loop terminate on a stream that overruns
                    // `out_len`.
                    if out_at < out_len {
                        *out.get_unchecked_mut(out_at) = *stack.get_unchecked(i);
                    }
                    out_at += 1;
                }
            }
        }};
    }

    // Zero whatever the stream never reached, and only that.
    //
    // In JS the output is a fresh `Uint8Array`, so an unfilled tail reads as
    // zeros. Here the arena is recycled between tiles and still holds the last
    // one. Zeroing the whole buffer up front would match, but it is a second
    // pass over every byte of every tile to serve the rare short stream; the
    // buffer is written strictly left to right, so zeroing from the final write
    // position is exactly equivalent and costs nothing on a stream that fills
    // its tile.
    macro_rules! finish {
        () => {{
            if out_at < out_len {
                core::ptr::write_bytes(out_ptr.add(out_at), 0, out_len - out_at);
                return out_at;
            }
            return out_len;
        }};
    }

    while out_at < out_len {
        // Refill. `bit_count` never exceeds 19 here (at most 11 left over, plus
        // one byte), so the shift below stays well inside 32 bits and a u32
        // logical shift is bit-for-bit what JS's sign-extending `>>` produces
        // once the mask has been applied.
        while bit_count < width {
            if at >= input.len() {
                // Out of input mid-code. The JS returns the partial buffer here
                // rather than throwing, and callers depend on that.
                finish!();
            }
            bit_buffer = bit_buffer.wrapping_shl(8) | *input.get_unchecked(at) as u32;
            at += 1;
            bit_count += 8;
        }
        let code = (bit_buffer >> (bit_count - width)) & ((1u32 << width) - 1);
        bit_count -= width;

        if code == EOI {
            break;
        }
        if code == CLEAR {
            next = 258;
            width = 9;
            previous = -1;
            continue;
        }

        if previous == -1 {
            emit!(code as i32);
            previous = code as i32;
            continue;
        }

        if code < next {
            emit!(code as i32);
            if next < 4096 {
                let slot = next as usize;
                prefix[slot] = previous;
                // The new entry is string(previous) + first-byte-of(code).
                suffix[slot] = first_of[(code as usize) & 0xfff];
                first_of[slot] = first_of[(previous as usize) & 0xfff];
                next += 1;
            }
        } else {
            // The KwKwK case: the code is not in the table yet, which is only
            // possible when it expands to the previous string plus that
            // string's own first byte. Note that when the table is full the
            // entry is not written and `emit(next - 1)` replays slot 4095 —
            // stale, and matched on purpose.
            if next < 4096 {
                let slot = next as usize;
                let head = first_of[(previous as usize) & 0xfff];
                prefix[slot] = previous;
                suffix[slot] = head;
                first_of[slot] = head;
                next += 1;
            }
            emit!((next - 1) as i32);
        }
        previous = code as i32;

        // Early change: grow one code before the table is actually full, which
        // is the TIFF variant. Reached only for ordinary codes, because the
        // clear and first-code paths above take an early continue.
        if next + 1 >= (1u32 << width) && width < 12 {
            width += 1;
        }
    }

    finish!();
}
