/**
 * Merge tree of a terrain model: every connected flood, from every source, at
 * every level, answered from one precomputed structure.
 *
 * ## Why this exists
 *
 * `flood.mjs` runs `connectedFlood` once per water level, and each run is a
 * whole-grid flood fill. Measured on the Kiru DTM at native resolution, a 1.6 km
 * view is 39.7 million cells and twelve levels cost about 15 seconds. The client
 * has refused any loss of resolution and the survey is 2.5 billion cells, so
 * request-time computation is not going to get there by being tuned.
 *
 * ## The identity everything here rests on
 *
 * `connectedFlood(dem, L, [s])` returns the 8-connected component of the sublevel
 * set `{z <= L}` that contains `s`. Two cells are in the same such component
 * exactly when some path between them has every cell at or below `L` — that is,
 * when their *minimax* (bottleneck) distance is at most `L`, where the weight of
 * an edge `(a,b)` is `max(z(a), z(b))`.
 *
 * Bottleneck distances on a graph are carried entirely by its minimum spanning
 * tree, and Kruskal's algorithm builds that tree in ascending edge order. So the
 * hierarchy of components as the water rises — the merge tree — *is* Kruskal's
 * merge history. Precompute it and a flood stops being a computation: it is a
 * lookup of one node, and a subtree aggregate that was summed at build time.
 *
 * The construction never materialises an edge list, which matters because an
 * 8-connected grid has about four edges per cell. Since `w(a,b) = max(z(a),z(b))`,
 * every edge incident on a cell `c` and an already-processed neighbour has weight
 * exactly `z(c)`. So sorting *cells* by elevation and unioning each with its
 * already-processed neighbours visits the edges in Kruskal order for free.
 *
 * ## Runs, and why the tree is not one node per cell
 *
 * The textbook component tree gives one node per merge, which is about one node
 * per cell, and an ancestor walk on a hillside then steps through every cell of
 * the slope. Almost all of those "merges" are not merges at all: the new cell
 * touches exactly one existing component and simply grows it.
 *
 * So a node is created only where the topology changes — at a local minimum, or
 * where two or more components join — and every cell that merely grows a
 * component is appended to that node's **run**. Cells are processed in ascending
 * elevation, so a run is automatically sorted by elevation, and "how much of this
 * component exists at level L" becomes a binary search plus a prefix sum.
 *
 * Laying the runs out in DFS preorder makes each node's whole subtree a
 * contiguous interval of positions, with the node's own run at the front. A
 * query is then: walk up to the topmost ancestor whose level is at or below `L`,
 * take its entire subtree, and trim its own run at `L`.
 *
 * ## What this is not
 *
 * A prototype, phase 4 of the performance plan, deliberately not wired into the
 * portal. It answers "is the structure worth building" and nothing else. The
 * scale it does *not* reach is stated plainly in `scripts/merge-tree-run.mjs`
 * and measured by `scripts/merge-tree-test.mjs`: the resident structure is about
 * 16 bytes per cell, which is fine for a 40 million cell view and is 40 GB for
 * the whole Kiru survey. That is the finding, not a footnote.
 */

import { D8_DCOL, D8_DROW } from "./hydrology.mjs";

/**
 * Valid cell indices, ascending by elevation, exactly and deterministically.
 *
 * A comparator sort of four million indices cost 613 ms in the phase-3
 * prototype, which is more than the flood it was meant to accelerate. This is a
 * two-pass LSD radix sort on the IEEE-754 bit pattern instead, which is linear
 * and — this is the part that matters — *exact*: it orders by the float itself,
 * not by a quantised proxy, so the resulting tree agrees with `connectedFlood`
 * on ties rather than nearly agreeing.
 *
 * The bit trick: for a non-negative float the raw bits already sort correctly as
 * an unsigned integer, so only the sign bit needs flipping; for a negative float
 * the ordering is reversed as well, so every bit is flipped. Terrain is usually
 * positive but a DTM referenced to an ellipsoid is not always, and getting this
 * wrong sorts the below-datum cells to the top of the grid where they are very
 * hard to notice.
 *
 * Radix sort is stable, so equal elevations keep ascending cell order. That is
 * not cosmetic: it is what makes two runs of the build produce the same tree.
 */
export function orderByElevation(dem) {
  const data = dem.data;
  if (!(data instanceof Float32Array)) {
    throw new Error(
      `merge tree: expected a Float32 grid, got ${data.constructor.name}. ` +
        `Casting would change the elevations and the tree would then disagree ` +
        `with connectedFlood on the original values.`,
    );
  }
  const N = dem.length;
  const bits = new Uint32Array(data.buffer, data.byteOffset, N);

  let n = 0;
  for (let i = 0; i < N; i += 1) if (!dem.isNoData(data[i])) n += 1;

  let src = new Uint32Array(n);
  let dst = new Uint32Array(n);
  let w = 0;
  for (let i = 0; i < N; i += 1) if (!dem.isNoData(data[i])) src[w++] = i;

  const count = new Uint32Array(65536);
  for (let pass = 0; pass < 2; pass += 1) {
    const shift = pass * 16;
    count.fill(0);
    for (let k = 0; k < n; k += 1) {
      const b = bits[src[k]];
      const key = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
      count[(key >>> shift) & 0xffff] += 1;
    }
    let sum = 0;
    for (let d = 0; d < 65536; d += 1) {
      const c = count[d];
      count[d] = sum;
      sum += c;
    }
    for (let k = 0; k < n; k += 1) {
      const i = src[k];
      const b = bits[i];
      const key = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
      dst[count[(key >>> shift) & 0xffff]++] = i;
    }
    const t = src;
    src = dst;
    dst = t;
  }
  return src;
}

/** Node table, grown by doubling. One entry per topological event, not per cell. */
function makeNodes() {
  return {
    n: 0,
    cap: 1024,
    level: new Float32Array(1024),
    parent: new Int32Array(1024),
    grow() {
      const cap = this.cap * 2;
      const level = new Float32Array(cap);
      level.set(this.level);
      const parent = new Int32Array(cap);
      parent.set(this.parent);
      this.level = level;
      this.parent = parent;
      this.cap = cap;
    },
    add(level) {
      if (this.n === this.cap) this.grow();
      const v = this.n;
      this.level[v] = level;
      this.parent[v] = -1;
      this.n += 1;
      return v;
    },
  };
}

/**
 * Ancestor jump pointers, at three strides.
 *
 * The ancestor walk is the query's only unbounded loop, and on a long even slope
 * the merge tree degenerates into a chain: every cell of the slope is one step
 * up. Without this, a client who drags the water level to the top of the ladder
 * pays for the depth of the tree.
 *
 * Full binary lifting would be `log2(m)` pointers per node, which is 80 bytes a
 * node and is not worth it here. Three fixed strides — 64, 4096, 262144 — bound
 * the walk at `depth / 262144 + 189` steps for twelve bytes a node, and 189
 * steps is not measurable.
 *
 * Descending stride order is safe because levels never decrease going up the
 * tree: if the 262144th ancestor is already above the water, so is every longer
 * jump from anywhere further up, and the stride never has to be retried.
 */
function buildJumps(parent, m) {
  const STRIDES = [64, 4096, 262144];
  const jumps = [];
  let cur = parent;
  let built = 1;
  for (const stride of STRIDES) {
    while (built < stride) {
      const next = new Int32Array(m);
      for (let v = 0; v < m; v += 1) {
        const p = cur[v];
        next[v] = p < 0 ? -1 : cur[p];
      }
      cur = next;
      built *= 2;
    }
    jumps.push(cur);
  }
  return jumps;
}

/**
 * Build the merge tree of a grid.
 *
 * Memory, stated because it is the whole feasibility question. During the build
 * this holds roughly 21 bytes per grid cell plus 8 bytes per valid cell; the
 * structure that survives is 16 bytes per valid cell (32 with extents) plus
 * about 40 bytes per node. Nodes are topological events, so their count depends
 * on how noisy the surface is, not on its size alone — which is why the build
 * reports it.
 *
 * @param {import("./raster.mjs").Grid} dem
 * @param {{ withExtent?: boolean, onProgress?: (stage: string, detail?: string) => void }} [options]
 */
export function buildMergeTree(dem, { withExtent = true, onProgress } = {}) {
  const say = onProgress ?? (() => {});
  const W = dem.width;
  const N = dem.length;
  const data = dem.data;

  say("sort");
  const order = orderByElevation(dem);
  const n = order.length;
  if (n === 0) throw new Error("merge tree: the grid has no data cells");

  // --- Kruskal in ascending cell order ------------------------------------
  // `uf` is a union-find over cells. -1 means "not yet processed", which does
  // double duty as the nodata mask: a nodata cell never enters `order`, so it
  // stays -1 forever and is never a neighbour anything can merge through.
  say("union");
  const uf = new Int32Array(N).fill(-1);
  const rank = new Uint8Array(N);
  const active = new Int32Array(N); // only meaningful at a union-find root
  const nodeOf = new Int32Array(N).fill(-1);
  const nodes = makeNodes();

  const find = (start) => {
    let r = start;
    while (uf[r] !== r) r = uf[r];
    let i = start;
    while (uf[i] !== r) {
      const next = uf[i];
      uf[i] = r;
      i = next;
    }
    return r;
  };

  const roots = new Int32Array(8);
  for (let k = 0; k < n; k += 1) {
    const c = order[k];
    const z = data[c];
    const col = c % W;
    const row = (c - col) / W;

    let nRoots = 0;
    for (let d = 0; d < 8; d += 1) {
      const nc = col + D8_DCOL[d];
      const nr = row + D8_DROW[d];
      if (nc < 0 || nr < 0 || nc >= W || nr >= dem.height) continue;
      const j = nr * W + nc;
      if (uf[j] === -1) continue;
      const r = find(j);
      let seen = false;
      for (let q = 0; q < nRoots; q += 1) if (roots[q] === r) { seen = true; break; }
      if (!seen) roots[nRoots++] = r;
    }

    uf[c] = c;
    rank[c] = 0;

    let v;
    if (nRoots === 0) {
      // A local minimum: water can stand here with nowhere lower to run to.
      v = nodes.add(z);
    } else if (nRoots === 1) {
      // The common case, and the reason runs exist. Nothing happened
      // topologically; one component simply reaches one cell further.
      v = active[roots[0]];
    } else {
      // A saddle: two or more components become one, at this cell's elevation.
      v = nodes.add(z);
      for (let q = 0; q < nRoots; q += 1) nodes.parent[active[roots[q]]] = v;
    }
    nodeOf[c] = v;

    let r0 = c;
    for (let q = 0; q < nRoots; q += 1) {
      const a = r0;
      const b = roots[q];
      if (rank[a] < rank[b]) { uf[a] = b; r0 = b; }
      else if (rank[a] > rank[b]) { uf[b] = a; r0 = a; }
      else { uf[b] = a; rank[a] += 1; r0 = a; }
    }
    active[r0] = v;
  }

  const m = nodes.n;
  const level = nodes.level.subarray(0, m);
  const parent = nodes.parent.subarray(0, m);
  say("union", `${m.toLocaleString()} nodes over ${n.toLocaleString()} cells`);

  // --- Lay the runs out in DFS preorder -----------------------------------
  // Preorder is what makes a subtree a contiguous interval, with the node's own
  // run at the front of it. Everything the query does is arithmetic on that
  // interval, so the layout is not a detail — it is the data structure.
  say("layout");
  const runLen = new Int32Array(m);
  for (let k = 0; k < n; k += 1) runLen[nodeOf[order[k]]] += 1;

  const childHead = new Int32Array(m).fill(-1);
  const sibNext = new Int32Array(m).fill(-1);
  // Descending, so that children come out of the linked list in ascending id
  // order and the layout is reproducible.
  for (let v = m - 1; v >= 0; v -= 1) {
    const p = parent[v];
    if (p < 0) continue;
    sibNext[v] = childHead[p];
    childHead[p] = v;
  }

  const runStart = new Int32Array(m);
  // An explicit stack, not recursion: on a smooth surface the tree is shallow,
  // but on a braided channel it is not, and a stack overflow here would look
  // like a corrupt DEM rather than a deep tree.
  const stack = new Int32Array(m);
  let sp = 0;
  for (let v = m - 1; v >= 0; v -= 1) if (parent[v] < 0) stack[sp++] = v;
  let cursor = 0;
  while (sp > 0) {
    const v = stack[--sp];
    runStart[v] = cursor;
    cursor += runLen[v];
    for (let c = childHead[v]; c >= 0; c = sibNext[c]) stack[sp++] = c;
  }
  if (cursor !== n) throw new Error(`merge tree: laid out ${cursor} of ${n} cells`);

  // Subtree sizes come out of a plain ascending pass, no second traversal: a
  // node is always created after its children, so every child's id is smaller
  // than its parent's.
  const subSize = new Int32Array(m);
  for (let v = 0; v < m; v += 1) {
    subSize[v] += runLen[v];
    const p = parent[v];
    if (p >= 0) subSize[p] += subSize[v];
  }

  // --- Fill the run arrays -------------------------------------------------
  say("fill");
  const zRun = new Float32Array(n);
  /**
   * Which grid cell sits at each position of the run layout.
   *
   * Four bytes a cell, and it is what turns a flood *mask* from a scan of the
   * whole grid into a contiguous read. The stats already exploit the layout —
   * a component's cells are its descendants' runs, whole, plus a prefix of its
   * own — so with the cell index recorded the same two intervals hand back the
   * cells themselves rather than only their count. Without it the only honest
   * way to draw the flood is to walk every cell in the survey and ask whether
   * it is in the subtree, which is exactly the cost the tree exists to avoid.
   */
  const cellAt = new Int32Array(n);
  const fill = new Int32Array(m);
  let pMinC = null, pMaxC = null, pMinR = null, pMaxR = null;
  if (withExtent) {
    pMinC = new Int32Array(n);
    pMaxC = new Int32Array(n);
    pMinR = new Int32Array(n);
    pMaxR = new Int32Array(n);
  }
  for (let k = 0; k < n; k += 1) {
    const c = order[k];
    const v = nodeOf[c];
    const f = fill[v];
    fill[v] = f + 1;
    const p = runStart[v] + f;
    zRun[p] = data[c];
    cellAt[p] = c;
    if (withExtent) {
      const col = c % W;
      const row = (c - col) / W;
      if (f === 0) {
        pMinC[p] = col; pMaxC[p] = col; pMinR[p] = row; pMaxR[p] = row;
      } else {
        pMinC[p] = col < pMinC[p - 1] ? col : pMinC[p - 1];
        pMaxC[p] = col > pMaxC[p - 1] ? col : pMaxC[p - 1];
        pMinR[p] = row < pMinR[p - 1] ? row : pMinR[p - 1];
        pMaxR[p] = row > pMaxR[p - 1] ? row : pMaxR[p - 1];
      }
    }
  }

  /*
   * One global prefix sum over the elevations, in run layout.
   *
   * It serves both halves of the query at once — a whole subtree is a range and
   * a partly-flooded run is a range — so there is no separate per-node total to
   * store or keep consistent.
   *
   * Float64, and the precision is worth being explicit about. Forty million
   * elevations of a few hundred metres sum to about 2e10, where a double's
   * spacing is 4e-6 m. A subtree total is a difference of two such numbers, so
   * it carries a few microns of summed-elevation error against volumes of
   * millions of cubic metres: a relative error around 1e-13, which is smaller
   * than the disagreement between two different summation orders of the same
   * numbers. Float32 here would be wrong by metres.
   */
  const cum = new Float64Array(n);
  let running = 0;
  for (let i = 0; i < n; i += 1) {
    running += zRun[i];
    cum[i] = running;
  }

  // --- Subtree extents -----------------------------------------------------
  // `belowBox` is the extent of everything *under* a node, excluding its own
  // run, because the run is the only part a query ever trims. Same ascending
  // pass as subtree sizes, for the same reason.
  let belowMinC = null, belowMaxC = null, belowMinR = null, belowMaxR = null;
  if (withExtent) {
    belowMinC = new Int32Array(m).fill(0x7fffffff);
    belowMaxC = new Int32Array(m).fill(-1);
    belowMinR = new Int32Array(m).fill(0x7fffffff);
    belowMaxR = new Int32Array(m).fill(-1);
    for (let v = 0; v < m; v += 1) {
      const p = parent[v];
      if (p < 0) continue;
      const last = runStart[v] + runLen[v] - 1;
      let minC = belowMinC[v], maxC = belowMaxC[v];
      let minR = belowMinR[v], maxR = belowMaxR[v];
      if (runLen[v] > 0) {
        if (pMinC[last] < minC) minC = pMinC[last];
        if (pMaxC[last] > maxC) maxC = pMaxC[last];
        if (pMinR[last] < minR) minR = pMinR[last];
        if (pMaxR[last] > maxR) maxR = pMaxR[last];
      }
      if (minC < belowMinC[p]) belowMinC[p] = minC;
      if (maxC > belowMaxC[p]) belowMaxC[p] = maxC;
      if (minR < belowMinR[p]) belowMinR[p] = minR;
      if (maxR > belowMaxR[p]) belowMaxR[p] = maxR;
    }
  }

  say("jumps");
  const jumps = buildJumps(parent, m);

  return {
    width: W,
    height: dem.height,
    cellSize: dem.cellSize,
    cellArea: dem.cellArea,
    originX: dem.originX,
    originY: dem.originY,
    epsg: dem.epsg ?? null,
    cells: n,
    nodes: m,
    nodeOf,
    level,
    parent,
    cellAt,
    runStart,
    runLen,
    subSize,
    zRun,
    cum,
    jumps,
    extent: withExtent
      ? { pMinC, pMaxC, pMinR, pMaxR, belowMinC, belowMaxC, belowMinR, belowMaxR }
      : null,
  };
}

/** Sum of `zRun` over `[a, b)`, from the global prefix. */
function sumRange(tree, a, b) {
  if (b <= a) return 0;
  return tree.cum[b - 1] - (a > 0 ? tree.cum[a - 1] : 0);
}

/**
 * The topmost ancestor of `v` whose level is at or below `L`.
 *
 * `v` itself is assumed to qualify, which the callers guarantee: a cell's own
 * node was born at or below that cell's elevation, and a cell above the water
 * is not flooded at all.
 */
function topAncestor(tree, v, L) {
  const { level, parent, jumps } = tree;
  for (let s = jumps.length - 1; s >= 0; s -= 1) {
    const jump = jumps[s];
    for (;;) {
      const p = jump[v];
      if (p < 0 || level[p] > L) break;
      v = p;
    }
  }
  for (;;) {
    const p = parent[v];
    if (p < 0 || level[p] > L) break;
    v = p;
  }
  return v;
}

/**
 * How many cells of a node's run stand at or below `L`.
 *
 * The run is sorted, because cells were appended in ascending elevation, so this
 * is a binary search for the first cell strictly above the water. `<= L` and not
 * `< L`, to match `connectedFlood`, which counts a cell exactly at the water
 * level as flooded.
 */
function runCountAtOrBelow(tree, v, L) {
  const start = tree.runStart[v];
  let lo = 0;
  let hi = tree.runLen[v];
  const z = tree.zRun;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (z[start + mid] <= L) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The flooded component containing one source cell, at one level.
 *
 * `sourceElevation` is passed in rather than looked up because the structure
 * deliberately does not keep a copy of the DEM: the portal already reads a small
 * window around a clicked point to show its spot elevation, so the number is
 * free there, and requiring it keeps the served structure from carrying a second
 * elevation raster it does not otherwise need.
 *
 * Returns the same quantities `connectedFlood` returns, minus the depth raster.
 * Volume is `(L * cells - sum of ground elevations) * cellArea`, which is the
 * same sum `connectedFlood` accumulates cell by cell, reassociated.
 */
export function floodFrom(tree, cell, level, sourceElevation) {
  const empty = {
    cells: 0, area_m2: 0, volume_m3: 0, sumZ: 0, node: -1, extent: null,
  };
  if (cell < 0 || cell >= tree.nodeOf.length) return empty;
  const leaf = tree.nodeOf[cell];
  if (leaf < 0) return empty;                    // nodata
  if (!(sourceElevation <= level)) return empty; // the source itself is dry

  const u = topAncestor(tree, leaf, level);
  const start = tree.runStart[u];
  const own = tree.runLen[u];
  const end = start + tree.subSize[u];
  const k = runCountAtOrBelow(tree, u, level);

  // Everything strictly below `u` is in, whole: a cell in a descendant's run was
  // added before that descendant merged upwards, so its elevation is at or below
  // `u`'s level, which is at or below `L`. Only `u`'s own run is on the surface
  // of the water and needs trimming.
  const cells = end - start - own + k;
  const sumZ = sumRange(tree, start + own, end) + sumRange(tree, start, start + k);

  return {
    cells,
    area_m2: cells * tree.cellArea,
    volume_m3: (level * cells - sumZ) * tree.cellArea,
    sumZ,
    node: u,
    extent: tree.extent ? extentOf(tree, u, k) : null,
  };
}

/** Projected bounds of a node's subtree with its own run trimmed to `k` cells. */
function extentOf(tree, u, k) {
  const e = tree.extent;
  let minC = e.belowMinC[u], maxC = e.belowMaxC[u];
  let minR = e.belowMinR[u], maxR = e.belowMaxR[u];
  if (k > 0) {
    const p = tree.runStart[u] + k - 1;
    if (e.pMinC[p] < minC) minC = e.pMinC[p];
    if (e.pMaxC[p] > maxC) maxC = e.pMaxC[p];
    if (e.pMinR[p] < minR) minR = e.pMinR[p];
    if (e.pMaxR[p] > maxR) maxR = e.pMaxR[p];
  }
  if (maxC < 0) return null;
  const cs = tree.cellSize;
  return {
    col0: minC, row0: minR, col1: maxC, row1: maxR,
    minX: tree.originX + minC * cs,
    maxX: tree.originX + (maxC + 1) * cs,
    maxY: tree.originY - minR * cs,
    minY: tree.originY - (maxR + 1) * cs,
  };
}

/**
 * The same, from several sources at once, matching `connectedFlood`'s seed list.
 *
 * Deduplicating by node is exactly right and not an approximation: at a fixed
 * level the components are a partition, so two seeds either land on the same
 * node — one component, counted once — or on disjoint ones, which add. Getting
 * this wrong by summing per seed would double-count a lake with two seeds in it.
 */
export function floodFromMany(tree, seeds, level) {
  const seen = new Set();
  let cells = 0;
  let sumZ = 0;
  let box = null;
  for (const { cell, elevation } of seeds) {
    const r = floodFrom(tree, cell, level, elevation);
    if (r.node < 0 || seen.has(r.node)) continue;
    seen.add(r.node);
    cells += r.cells;
    sumZ += r.sumZ;
    if (r.extent) {
      box = box === null ? r.extent : {
        col0: Math.min(box.col0, r.extent.col0),
        row0: Math.min(box.row0, r.extent.row0),
        col1: Math.max(box.col1, r.extent.col1),
        row1: Math.max(box.row1, r.extent.row1),
        minX: Math.min(box.minX, r.extent.minX),
        maxX: Math.max(box.maxX, r.extent.maxX),
        minY: Math.min(box.minY, r.extent.minY),
        maxY: Math.max(box.maxY, r.extent.maxY),
      };
    }
  }
  return {
    cells,
    area_m2: cells * tree.cellArea,
    volume_m3: (level * cells - sumZ) * tree.cellArea,
    sumZ,
    components: seen.size,
    extent: box,
  };
}

/**
 * A whole ladder of levels from one source, which is what the tool actually asks.
 *
 * Levels are sorted before walking so the ancestor search can carry on from
 * where the last one stopped instead of restarting at the leaf. That turns N
 * queries into one walk up the tree, and it is the reason a forty-step ladder
 * costs no more than a four-step one.
 */
export function floodLadder(tree, cell, levels, sourceElevation) {
  const sorted = levels.map((level, i) => ({ level, i })).sort((a, b) => a.level - b.level);
  const out = new Array(levels.length);
  const leaf = tree.nodeOf[cell];
  let v = leaf;
  for (const { level, i } of sorted) {
    if (leaf < 0 || !(sourceElevation <= level)) {
      out[i] = { level_m: level, cells: 0, area_m2: 0, volume_m3: 0, sumZ: 0, node: -1, extent: null };
      continue;
    }
    v = topAncestor(tree, v, level);
    const start = tree.runStart[v];
    const own = tree.runLen[v];
    const end = start + tree.subSize[v];
    const k = runCountAtOrBelow(tree, v, level);
    const cells = end - start - own + k;
    const sumZ = sumRange(tree, start + own, end) + sumRange(tree, start, start + k);
    out[i] = {
      level_m: level,
      cells,
      area_m2: cells * tree.cellArea,
      area_ha: (cells * tree.cellArea) / 10000,
      volume_m3: (level * cells - sumZ) * tree.cellArea,
      sumZ,
      node: v,
      extent: tree.extent ? extentOf(tree, v, k) : null,
    };
  }
  return out;
}

/**
 * The flood mask, as grid indices, checked against the DEM the tree was built
 * from.
 *
 * Separate from `floodFrom` on purpose. The whole claim of this module is that
 * area and volume need no raster; drawing the water still does, and pretending
 * otherwise would hide the one cost that has not gone away. This is the honest,
 * slow version — a scan of the grid — and it exists so the tests can compare
 * cell for cell against `connectedFlood`. The production answer is four more
 * bytes a cell, the cell index at each run position, which turns a flood mask
 * into a contiguous read of one interval; that is costed in the report rather
 * than built here.
 */
export function componentCellsOnGrid(tree, dem, cell, level, sourceElevation) {
  const r = floodFrom(tree, cell, level, sourceElevation);
  const out = new Set();
  if (r.node < 0) return out;
  const inSubtree = new Uint8Array(tree.nodes);
  inSubtree[r.node] = 1;
  // Ascending ids: a parent is always created after its children, so one pass
  // downward from the root of the subtree is enough to mark every descendant.
  for (let v = r.node - 1; v >= 0; v -= 1) {
    const p = tree.parent[v];
    if (p >= 0 && inSubtree[p]) inSubtree[v] = 1;
  }
  for (let i = 0; i < tree.nodeOf.length; i += 1) {
    const v = tree.nodeOf[i];
    if (v < 0 || !inSubtree[v]) continue;
    if (dem.data[i] > level) continue;
    out.add(i);
  }
  return out;
}

/**
 * The flooded cells as a 0/1 mask over the grid, ready for `polygonize`.
 *
 * The fast counterpart to `componentCellsOnGrid`, and the one the portal uses.
 * Both answer the same question and are asserted to agree; the difference is
 * that this one never looks at a cell that is not flooded.
 *
 * The whole trick is the run layout. A component's cells are exactly its
 * descendants' runs — entire, because a cell in a descendant's run joined
 * before that descendant merged upwards, so it is already at or below this
 * level — plus a prefix of the component's own run, which is the part of it
 * standing at or below the water. Both are contiguous intervals of `cellAt`,
 * so the mask is two straight reads and costs what the flood covers rather
 * than what the survey covers.
 *
 * Returns the mask and the count, so a caller that wants both does not walk it
 * twice.
 */
export function floodMask(tree, dem, cell, level, sourceElevation) {
  const mask = dem.like(Uint8Array, 0, 255);
  const r = floodFrom(tree, cell, level, sourceElevation);
  if (r.node < 0 || r.cells === 0) return { mask, cells: 0, indices: new Int32Array(0) };

  const u = r.node;
  const start = tree.runStart[u];
  const own = tree.runLen[u];
  const end = start + tree.subSize[u];
  const k = runCountAtOrBelow(tree, u, level);

  // The flooded cells are handed back as well as marked. A caller computing
  // depth, volume or an edge test then walks the water rather than the survey,
  // which is the difference between a cost that grows with the flood and one
  // that grows with the raster.
  const indices = new Int32Array(r.cells);
  let n = 0;
  // Everything below `u`, whole.
  for (let p = start + own; p < end; p += 1) {
    const c = tree.cellAt[p];
    mask.data[c] = 1;
    indices[n] = c;
    n += 1;
  }
  // Then `u`'s own run, trimmed to the water line.
  for (let p = start; p < start + k; p += 1) {
    const c = tree.cellAt[p];
    mask.data[c] = 1;
    indices[n] = c;
    n += 1;
  }

  return { mask, cells: r.cells, indices };
}

/** Resident bytes of the queryable structure, by part. */
export function structureBytes(tree) {
  const n = tree.cells;
  const m = tree.nodes;
  const perCell = {
    nodeOf: tree.nodeOf.length * 4,
    zRun: n * 4,
    cum: n * 8,
  };
  const perNode = {
    cellAt: n * 4,
    level: m * 4, parent: m * 4, runStart: m * 4, runLen: m * 4, subSize: m * 4,
    jumps: m * 4 * tree.jumps.length,
  };
  const extent = tree.extent
    ? { prefixBox: n * 16, subtreeBox: m * 16 }
    : {};
  const total = [perCell, perNode, extent]
    .flatMap((o) => Object.values(o))
    .reduce((a, b) => a + b, 0);
  return { perCell, perNode, extent, total, bytesPerCell: total / n };
}
