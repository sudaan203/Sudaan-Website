/**
 * What a windowed raster read actually costs, and where the time goes.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/bench-read-path.mjs
 *   node scripts/bench-read-path.mjs --url=https://tiles.example.com
 *   node scripts/bench-read-path.mjs --portal=https://sudaangeo.in --site=kotba-survey
 *
 * ## Why this exists
 *
 * Every read timing this project has was taken on a laptop, off a local SSD,
 * with a warm page cache. On Kotba that is 28 ms of fetching against 51 ms of
 * LZW decoding — the CPU dominates, which is what justified writing the decoder
 * in Rust.
 *
 * Production is not that. The rasters live in Cloudflare R2, the code that
 * reads them runs in a Vercel function, and a windowed read is hundreds of
 * range requests across the internet. If the fetch half stays small, the
 * portal is CPU-bound everywhere and the kernels are the right place to spend
 * effort. If it dominates, then no kernel rewrite matters and the work is to
 * move the compute next to the data.
 *
 * That is a large, expensive fork in the plan resting entirely on a number
 * nobody has measured. This measures it.
 *
 * ## Three ways to run it, in increasing order of honesty
 *
 * 1. **Local file** (default). The baseline, and the only one that runs with
 *    no infrastructure. Tells you the decode cost and nothing about network.
 * 2. **`--url`**, pointed at the tile Worker. Measures range requests from
 *    wherever you happen to be sitting. Useful, but a laptop in Gujarat is not
 *    a Vercel function in Washington, and the difference is not a constant.
 * 3. **`--portal`**, pointed at the deployed portal. This is the real answer:
 *    it asks the production API to measure *itself* and reports the
 *    `Server-Timing` header the analysis route now returns. The read happens
 *    where it really happens, on the machine that really does it.
 *
 * Prefer 3. Use 1 and 2 to understand it.
 */

import { readFileSync } from "node:fs";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.length ? rest.join("=") : "true"];
  }),
);

if (args.has("help")) {
  console.log(`bench-read-path — where a windowed raster read spends its time

  --site=NAME       survey to read (default kotba-survey)
  --url=BASE        read over HTTP from a tile gateway serving <site>/dtm.tif
  --portal=ORIGIN   ask a deployed portal to measure itself, via Server-Timing
  --cells=N         window size in cells (default 4000000)
  --reps=N          repetitions (default 3)
  --terrain-dir=P   local raster directory (default portal-data/terrain)`);
  process.exit(0);
}

const SITE = args.get("site") ?? "kotba-survey";
const CELLS = Number(args.get("cells") ?? 4_000_000);
const REPS = Number(args.get("reps") ?? 3);
const TERRAIN = args.get("terrain-dir") ?? "portal-data/terrain";

const ms = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const pad = (v, n) => String(v).padStart(n);

// ---------------------------------------------------------------------------
// 3. The deployed portal, measuring itself.
// ---------------------------------------------------------------------------

/**
 * `Server-Timing` into an object.
 *
 * The header is a comma separated list of `name;desc="...";dur=N`. Parsed
 * rather than regexed out whole because the order is not guaranteed and a
 * missing entry should read as absent, not as zero.
 */
function parseServerTiming(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const name = part.trim().split(";")[0];
    const dur = part.match(/dur=([\d.]+)/);
    if (name && dur) out[name] = Number(dur[1]);
  }
  return out;
}

async function measurePortal(origin) {
  const cookie = process.env.PORTAL_SESSION_COOKIE;
  if (!cookie) {
    console.log(`
Measuring a deployed portal needs a session, because the analysis API is
behind one. Sign in to ${origin} in a browser, copy the value of the
\`sga_portal_session\` cookie, and re-run with:

  PORTAL_SESSION_COOKIE=<value> node scripts/bench-read-path.mjs --portal=${origin}

Nothing is read from the raster itself — only the timing header the response
already carries.`);
    process.exit(1);
  }

  const url = `${origin.replace(/\/+$/, "")}/api/portal/sites/${SITE}/analysis`;
  console.log(`\nProduction, measuring itself — ${url}`);
  console.log(`  the read happens on the server, over whatever path it really uses\n`);

  // A spot level: the smallest request that still performs a windowed read, so
  // the fixed cost of the read is not buried under a large computation.
  const body = { op: "spot", at: [[0, 0]], crs: "lonlat" };
  console.log("  rep      io    decode   compute   reads   fetched     total   wall");
  for (let i = 0; i < REPS; i += 1) {
    const t = ms();
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `sga_portal_session=${cookie}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      console.log(`  ${i + 1}  request failed: ${error.message}`);
      continue;
    }
    const wall = ms() - t;
    const st = parseServerTiming(response.headers.get("server-timing"));
    if (response.status !== 200 && !st.total) {
      console.log(`  ${i + 1}  HTTP ${response.status} — ${(await response.text()).slice(0, 90)}`);
      continue;
    }
    console.log(
      `  ${pad(i + 1, 3)} ${pad((st.io ?? 0).toFixed(0), 7)} ${pad((st.decode ?? 0).toFixed(0), 9)}` +
        ` ${pad((st.compute ?? 0).toFixed(0), 9)} ${pad(st.reads ?? "?", 7)}` +
        ` ${pad(st.fetched ? `${st.fetched} KB` : "?", 9)} ${pad((st.total ?? 0).toFixed(0), 9)}` +
        ` ${pad(wall.toFixed(0), 6)} ms`,
    );
  }
  console.log(`
  io      fetching bytes: a range request to the tile Worker, then to R2
  decode  LZW, on the function's own CPU
  wall    includes TLS, auth, the database lookup and the network back to here

If io dwarfs decode, the compute belongs next to the data and no kernel
rewrite changes that. If it does not, the kernels are the right lever.`);
}

// ---------------------------------------------------------------------------
// 1 and 2. Reading directly, from a file or over HTTP.
// ---------------------------------------------------------------------------

async function measureDirect() {
  const { openRaster } = await import("../src/lib/geo/raster-window.mjs");
  const { fileSource, httpSource, cached } = await import("../src/lib/geo/raster-source.mjs");

  const base = args.get("url");
  const where = base ? `${base.replace(/\/+$/, "")}/${SITE}/dtm.tif` : `${TERRAIN}/${SITE}/dtm.tif`;

  if (!base) {
    try {
      readFileSync(where);
    } catch {
      console.log(`No raster at ${where}. Pass --terrain-dir, --url or --portal.`);
      process.exit(1);
    }
  }

  console.log(`\n${base ? "Over HTTP" : "Local file"} — ${where}`);

  let t = ms();
  const raster = await openRaster(
    cached(base ? httpSource(where) : await fileSource(where)),
  );
  const tOpen = ms() - t;
  console.log(
    `  ${raster.width} x ${raster.height} @ ${raster.cellSize.toFixed(3)} m` +
      `, ${raster.tiled ? `tiled ${raster.tileWidth}x${raster.tileHeight}` : "stripped"}`,
  );
  console.log(`  directory parsed in ${tOpen.toFixed(0)} ms — no image data yet\n`);

  const [minX, minY, maxX, maxY] = raster.bounds;
  const half = (Math.sqrt(CELLS) / 2) * raster.cellSize;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const window = raster.windowFor([cx - half, cy - half, cx + half, cy + half]);
  if (!window) {
    console.log("  that window misses the raster");
    process.exit(1);
  }
  console.log(
    `  window ${window.cols} x ${window.rows} = ${((window.cols * window.rows) / 1e6).toFixed(2)}M cells\n`,
  );

  console.log("  rep       io    decode    other     reads   fetched     total");
  const totals = { io: 0, decode: 0, total: 0, requests: 0, bytes: 0 };
  for (let i = 0; i < REPS; i += 1) {
    raster.resetStats();
    t = ms();
    await raster.readWindow(window);
    const total = ms() - t;
    const s = raster.readStats;
    const other = Math.max(0, total - s.ioMs - s.decodeMs);
    console.log(
      `  ${pad(i + 1, 3)} ${pad(s.ioMs.toFixed(0), 8)} ${pad(s.decodeMs.toFixed(0), 9)}` +
        ` ${pad(other.toFixed(0), 8)} ${pad(s.requests, 9)} ${pad(`${(s.bytes / 1024).toFixed(0)} KB`, 9)}` +
        ` ${pad(total.toFixed(0), 9)} ms`,
    );
    totals.io += s.ioMs;
    totals.decode += s.decodeMs;
    totals.total += total;
    totals.requests = s.requests;
    totals.bytes = s.bytes;
  }

  const io = totals.io / REPS;
  const decode = totals.decode / REPS;
  const total = totals.total / REPS;
  console.log(
    `\n  mean: io ${io.toFixed(0)} ms (${((io / total) * 100).toFixed(0)}%),` +
      ` decode ${decode.toFixed(0)} ms (${((decode / total) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  ${totals.requests} range requests, ${(totals.bytes / 1e6).toFixed(1)} MB` +
      `, ${(totals.bytes / 1024 / totals.requests).toFixed(0)} KB each` +
      `, ${(io / totals.requests).toFixed(2)} ms per request`,
  );
  if (!base) {
    console.log(`
  This is a warm local disk. The per-request figure above is the one that
  moves in production: a range request over the internet is milliseconds of
  latency each, and there are ${totals.requests} of them. Re-run with
  --portal to see what that actually costs where it matters.`);
  }
}

if (args.has("portal")) await measurePortal(args.get("portal"));
else await measureDirect();
