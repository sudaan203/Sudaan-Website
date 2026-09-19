"use client";

/**
 * The forest inventory, in the browser: fetch, decode, filter, all client
 * side, so a drag on a filter slider answers in the same frame rather than
 * round-tripping to the server. `docs/forest-tools-plan.md` §2.5 is explicit
 * that this is the right shape under a stated budget (250,000 trees, ~8 MB) —
 * Ektanagar 1's 26,776 trees is nowhere near it — and that above the budget
 * (Ektanagar 2, Kiru) the same question becomes a server-side filter problem,
 * not a client-side algorithm problem. Nothing here tries to solve that case;
 * it is out of scope for this pass, exactly as the plan says.
 *
 * ## Why this file, and not `forest.mjs`, decodes `trees.bin`
 *
 * `forest.mjs` already has `DEFAULT_HEIGHT_CLASSES` and a `heightClass()`
 * lookup, and the natural instinct is to import them here. Importing that
 * module into a `"use client"` file does not work: `forest.mjs` imports
 * `raster.mjs`, which imports `node:fs` for the pipeline's own file reads, and
 * that fails to bundle for the browser at all ("Module not found: Can't
 * resolve 'fs'") — this is the same reason `geodesy.ts` ports its projection
 * math from `scripts/lib/geo.mjs` rather than importing it.
 *
 * So the split is: the *values* (Malhar's ten bands) come from the server,
 * over the wire, in the response `.../forest` already returns — sourced from
 * `forest.mjs`'s real export by the one process that can safely import it (see
 * that route's own header comment) — and only the *lookup logic* is
 * reimplemented here, in TypeScript, because it is four lines and reads
 * correctly against classes a client has edited (which need not stay sorted or
 * contiguous the way the hard-coded defaults are). The bands themselves are
 * never a second hand-typed copy; only trivial, re-derivable logic is.
 *
 * ## Projection: reused, not reinvented
 *
 * `trees.bin` and `crowns.geojson` carry EPSG:32643 easting/northing,
 * unprojected — `forest-run.mjs`'s own comment on `crowns.geojson` says so
 * deliberately. MapLibre's GeoJSON sources want WGS84 lon/lat. Rather than
 * write a third copy of UTM-to-lon/lat (the hydrology route has one server
 * side, `geodesy.ts` has the forward direction ported for the browser
 * already), this file imports `utmToLonLat` straight from
 * `@/lib/geo/projection.mjs`. That module has no imports of its own — no
 * `node:fs`, unlike `forest.mjs` — so it bundles for the browser exactly like
 * `colour.mjs` already does for `point-cloud-layer.ts`. Reusing the literal
 * function every server route already trusts is a stronger form of "don't
 * invent a new projection path" than porting a fourth copy would have been.
 */

import { utmToLonLat } from "@/lib/geo/projection.mjs";

// -------------------------------------------------------------------------
// Wire types — the shapes `.../forest` and its two file routes hand back.
// -------------------------------------------------------------------------

/** Loosely typed, like `ForestManifest` server side: the engine track owns
 * the exact key set, and this only names what this file actually reads. */
export type ForestManifestClient = {
  generator: string;
  generatedAt: string;
  parameters: Record<string, unknown>;
  grid: { cellSize: number; width: number; height: number };
  counts: {
    candidates: number;
    rejected: Record<string, number>;
    accepted: number;
  };
  groundTruthNote: string;
  surveyAreaHa?: number;
  pointCloud?: { used: boolean; note?: string };
  [key: string]: unknown;
};

export type HeightClassHistogramEntry = { label: string; count: number };
export type DensityGridCell = { col: number; row: number; count: number; treesPerHa: number };
export type HistogramBin = { binMin: number; binMax: number; count: number };
export type ScatterPoint = { groundElevation: number; height: number };

export type ForestSummaryClient = {
  count: number;
  treesPerHectare: number;
  height: { avg: number; max: number; min: number };
  crownArea: { avg: number; totalCovered: number };
  crownDiameter: { avg: number; max: number };
  canopyCoveragePct: number;
  minCrownDiameter?: number;
  dbh?: { attempted: number; accepted: number };
  charts: {
    heightClassHistogram?: HeightClassHistogramEntry[];
    treeDensityByHectareGrid?: {
      cellSizeM: number;
      cols: number;
      rows: number;
      cells: DensityGridCell[];
    };
    crownAreaDistribution?: HistogramBin[];
    treeHeightDistribution?: HistogramBin[];
    elevationVsHeight?: ScatterPoint[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** A user-editable height band. `enabled` and the shape overall are this
 * file's own addition — `forest.mjs`'s bands carry only label/min/max, and
 * "enabled" only means something once a client can turn one off (§5.4). */
export type HeightClassDef = {
  label: string;
  min: number;
  max: number;
  enabled: boolean;
};

export type ForestInfo = {
  manifest: ForestManifestClient;
  summary: ForestSummaryClient;
  defaultHeightClasses: HeightClassDef[];
};

/** One tree, decoded from `trees.bin`. Everything `crowns.geojson` carries
 * beyond this (perimeter, both extreme diameters, confidence components, DBH)
 * lives in `CrownProperties` below, joined onto this by `id` on demand rather
 * than duplicated into the fast pack. */
export type TreeRecord = {
  /** 16 lowercase hex characters — matches `crowns.geojson`'s `tree_id`. */
  id: string;
  easting: number;
  northing: number;
  lon: number;
  lat: number;
  height: number;
  crownArea: number;
  /** The equivalent-circle (average) diameter. `trees.bin` carries only this
   * one of the three diameter definitions; max/min live on the crown record. */
  crownDiameter: number;
  groundElevation: number;
  /** 0..1. Reported as-is: the honesty requirement is that nothing here
   * rescales confidence to look better than it is. See `confidenceStats`
   * below for how the *display* stretches contrast without changing the
   * number. */
  confidence: number;
};

/** The full attribute set `crowns.geojson` carries per tree, per
 * `forest-run.mjs`'s own crown-feature builder. */
export type CrownProperties = {
  tree_id: string;
  box_id: number;
  model_score: number;
  height_m: number;
  ground_elevation_m: number;
  tree_top_elevation_m: number;
  crown_area_m2: number;
  crown_perimeter_m: number;
  crown_diameter_max_m: number;
  crown_diameter_min_m: number;
  crown_diameter_avg_m: number;
  height_class: string;
  confidence: number;
  confidence_components: Record<
    string,
    { available: boolean; value?: number; goodness?: number; weight?: number }
  >;
  confidence_note: string;
  dbh_cm: number | "Not reliably detectable";
  dbh_estimated: boolean;
  girth_m: number | null;
  dbh_reason: string | null;
};

/**
 * The line between a real detection run and the engine's own test fixture.
 *
 * `forest-run.mjs` has been run against Kotba, and it wrote a complete,
 * well-formed `manifest.json`/`trees.bin`/`crowns.geojson` — but over eight
 * total candidate boxes, for a 12.9 ha survey the plan itself (§0.5, F0.5) is
 * still unsure contains any real trees at all. A genuine DeepForest pass
 * over any surveyed hectare produces candidates in the hundreds to tens of
 * thousands before rejection — Ektanagar 1's production run: 41,439 — so a
 * run reporting single digits is the shape of a hand-built engine-test
 * fixture, not a survey that was actually detected over. Gating on
 * `counts.candidates` rather than `counts.accepted` matters: a survey that
 * turns out to have almost no real trees would still show a normal
 * *candidate* count (thousands proposed, few of them accepted) — it is the
 * candidate count collapsing to almost nothing that is the fixture's
 * signature, not the accepted count.
 *
 * This is a heuristic, not a flag the pipeline writes, because no such flag
 * exists yet. Revisit if `forest-run.mjs` ever gains an explicit "this was a
 * test fixture" marker in its own manifest.
 */
const MIN_REAL_CANDIDATES = 50;

export function isRealForestRun(manifest: ForestManifestClient): boolean {
  return manifest.counts.candidates >= MIN_REAL_CANDIDATES;
}

export type ForestUnavailableReason = "missing" | "incomplete";

export class ForestClientError extends Error {
  readonly reason: ForestUnavailableReason;
  constructor(reason: ForestUnavailableReason, message: string) {
    super(message);
    this.name = "ForestClientError";
    this.reason = reason;
  }
}

// -------------------------------------------------------------------------
// Fetching and decoding
// -------------------------------------------------------------------------

/** `{ min, max, null on the ">15 m" band as JSON.stringify would have silently
 * turned Infinity into, made explicit by the route rather than accidental }`
 * — decoded back to `Infinity` here, the inverse of that route's own comment. */
type WireHeightClass = { label: string; min: number; max: number | null };

async function readError(response: Response): Promise<ForestClientError> {
  const body = (await response.json().catch(() => null)) as { error?: string; reason?: string } | null;
  const reason: ForestUnavailableReason = body?.reason === "missing" ? "missing" : "incomplete";
  return new ForestClientError(
    reason,
    body?.error ?? `The forest inventory request failed (${response.status}).`,
  );
}

export class ForestClient {
  private readonly base: string;

  constructor(siteSlug: string) {
    this.base = `/api/portal/sites/${siteSlug}/forest`;
  }

  /** Manifest, summary and the default height classes. Cheap: this is the one
   * fetch a probe on page load pays for, mirroring the terrain and hydrology
   * probes' own "ask once, cheaply" shape. */
  async info(): Promise<ForestInfo> {
    const response = await fetch(this.base, { credentials: "same-origin" });
    if (!response.ok) throw await readError(response);
    const body = (await response.json()) as {
      manifest: ForestManifestClient;
      summary: ForestSummaryClient;
      defaultHeightClasses: WireHeightClass[];
    };
    return {
      manifest: body.manifest,
      summary: body.summary,
      defaultHeightClasses: body.defaultHeightClasses.map((c) => ({
        label: c.label,
        min: c.min,
        max: c.max === null ? Infinity : c.max,
        enabled: true,
      })),
    };
  }

  /** The full crown polygons and attribute set. Fetched once and cached by the
   * caller — see `MapViewer.tsx`'s forest effect — not on every filter change. */
  async crowns(): Promise<GeoJSON.FeatureCollection<GeoJSON.Polygon, CrownProperties>> {
    const response = await fetch(`${this.base}/crowns.geojson`, { credentials: "same-origin" });
    if (!response.ok) throw await readError(response);
    return response.json() as Promise<GeoJSON.FeatureCollection<GeoJSON.Polygon, CrownProperties>>;
  }

  /** The columnar pack, decoded into `TreeRecord`s and reprojected to
   * lon/lat. `zone`/`northern` come from `crowns.geojson`'s own `crs`
   * (`utmZoneFromEpsg(epsgFromCrowns(...))`), so the two files are always
   * read in the one projection the survey was actually delivered in, never a
   * guessed or hardcoded zone. */
  async trees(zone: number, northern: boolean): Promise<TreeRecord[]> {
    const response = await fetch(`${this.base}/trees.bin`, { credentials: "same-origin" });
    if (!response.ok) throw await readError(response);
    return decodeTreesBin(await response.arrayBuffer(), zone, northern);
  }
}

/**
 * `trees.bin`'s exact byte layout, per `scripts/forest-run.mjs`'s own header
 * comment (reproduced there and in `docs/forest-tools-plan.md`), decoded here
 * byte for byte rather than guessed:
 *
 *   offset  0   4 bytes  ASCII magic "TRB1"
 *   offset  4   2 bytes  uint16 LE  format version (1)
 *   offset  6   2 bytes  uint16 LE  record length in bytes (34)
 *   offset  8   4 bytes  uint32 LE  tree count
 *   offset 12   ...      `count` records of 34 bytes each:
 *     +0   8 bytes  raw id bytes (first 8 bytes of the tree's sha256 id)
 *     +8   4 bytes  int32 LE  easting, CENTIMETRES
 *     +12  4 bytes  int32 LE  northing, CENTIMETRES
 *     +16  4 bytes  float32 LE  height, metres
 *     +20  4 bytes  float32 LE  crown area, m²
 *     +24  4 bytes  float32 LE  crown diameter (equivalent-circle/avg), metres
 *     +28  4 bytes  float32 LE  ground elevation, metres
 *     +32  2 bytes  uint16 LE  confidence, 0..65535 mapped from 0..1
 */
export function decodeTreesBin(buffer: ArrayBuffer, zone: number, northern: boolean): TreeRecord[] {
  const HEADER_LEN = 12;
  const RECORD_LEN = 34;

  if (buffer.byteLength < HEADER_LEN) {
    throw new Error("trees.bin is shorter than its own 12-byte header.");
  }
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "TRB1") {
    throw new Error(`trees.bin's magic is "${magic}", not "TRB1" — this is not a tree pack.`);
  }

  const view = new DataView(buffer);
  const version = view.getUint16(4, true);
  const recordLen = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  if (recordLen !== RECORD_LEN) {
    throw new Error(
      `trees.bin declares a ${recordLen}-byte record (format version ${version}); ` +
        `this decoder only understands the ${RECORD_LEN}-byte layout forest-run.mjs's header ` +
        `comment currently documents. The two have drifted apart.`,
    );
  }
  if (buffer.byteLength < HEADER_LEN + count * RECORD_LEN) {
    throw new Error("trees.bin is truncated: shorter than its own header claims.");
  }

  const trees: TreeRecord[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const at = HEADER_LEN + i * RECORD_LEN;

    // 8 raw bytes -> 16 lowercase hex characters, matching crowns.geojson's
    // tree_id one for one (both are the same sha256 prefix, one as bytes, one
    // as the hex string forest-run.mjs derived it from).
    let id = "";
    for (let b = 0; b < 8; b += 1) id += bytes[at + b].toString(16).padStart(2, "0");

    const easting = view.getInt32(at + 8, true) / 100;
    const northing = view.getInt32(at + 12, true) / 100;
    const height = view.getFloat32(at + 16, true);
    const crownArea = view.getFloat32(at + 20, true);
    const crownDiameter = view.getFloat32(at + 24, true);
    const groundElevation = view.getFloat32(at + 28, true);
    const confidence = view.getUint16(at + 32, true) / 65535;
    const [lon, lat] = utmToLonLat(easting, northing, zone, northern);

    trees[i] = { id, easting, northing, lon, lat, height, crownArea, crownDiameter, groundElevation, confidence };
  }
  return trees;
}

// -------------------------------------------------------------------------
// Projection helpers — `crowns.geojson`'s own CRS, read rather than assumed
// -------------------------------------------------------------------------

/** The EPSG code out of a GeoJSON FeatureCollection's (legacy but still what
 * this pipeline writes) named CRS member, e.g. `{"type":"name","properties":
 * {"name":"EPSG:32643"}}`. `null` if the collection carries none. */
export function epsgFromCrowns(collection: unknown): number | null {
  // `unknown` rather than a `{ crs?: ... }` shape: `GeoJSON.FeatureCollection`
  // declares no `crs` member at all (it is a legacy, non-standard extension
  // this pipeline still writes), so a real `FeatureCollection<Polygon,
  // CrownProperties>` value and a `{ crs?: ... }` parameter type share no
  // properties, which TypeScript treats as a weak-type mismatch even though
  // every field on the parameter type is optional. Casting once inside,
  // after accepting anything, sidesteps that rather than fighting it.
  const name = (collection as { crs?: { properties?: { name?: string } } } | null | undefined)
    ?.crs?.properties?.name;
  if (!name) return null;
  const match = /EPSG:(\d+)/i.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * EPSG code to a UTM zone and hemisphere, the same range check the hydrology
 * route already makes (32601-32660 northern, 32701-32760 southern). No shared
 * helper for this exists yet anywhere in the repo — every caller (the
 * hydrology route, the render route) inlines the same six lines rather than
 * import one from another — so this follows the established convention
 * rather than introduce the first cross-module dependency for it.
 */
export function utmZoneFromEpsg(epsg: number | null): { zone: number; northern: boolean } | null {
  if (epsg === null) return null;
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, northern: true };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, northern: false };
  return null;
}

// -------------------------------------------------------------------------
// Height classes: lookup, edits, persistence
// -------------------------------------------------------------------------

/**
 * Which band a height falls in, among *enabled* classes.
 *
 * A linear scan over `classDefs`, not the binary search `forest.mjs`'s own
 * `heightClass()` uses. That is a deliberate downgrade: the default ten bands
 * are sorted and contiguous, so a binary search over them is safe and cheap
 * either way at this size, but §5.4 lets a client add, remove, redefine and
 * disable bands from the panel, and nothing enforces that the result stays
 * sorted or gap-free. A binary search over a list that invariant no longer
 * holds for would silently return the wrong band, or none, in a way that
 * looks like ordinary filtering rather than a bug. Ten to twenty classes is
 * nowhere near where a linear scan's cost would matter.
 */
export function heightClassFor(
  height: number,
  classDefs: readonly HeightClassDef[],
): HeightClassDef | null {
  if (!Number.isFinite(height)) return null;
  for (const c of classDefs) {
    if (!c.enabled) continue;
    if (height >= c.min && height < c.max) return c;
  }
  return null;
}

const STORAGE_PREFIX = "sudaan-forest-height-classes:";

/**
 * A client's edited height bands, one set per site, read from `localStorage`.
 *
 * Per `docs/forest-tools-plan.md` §5.4: "nothing about them belongs in the
 * database." Falls back to the server's own defaults on any failure —
 * private browsing, storage disabled, a quota error, corrupted JSON — because
 * a client's customised bands are a convenience this session may not get to
 * keep, never something the panel depends on to function at all.
 */
export function loadHeightClasses(
  siteSlug: string,
  fallback: readonly HeightClassDef[],
): HeightClassDef[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + siteSlug);
    if (!raw) return fallback.map((c) => ({ ...c }));
    const parsed = JSON.parse(raw) as Array<{
      label: unknown;
      min: unknown;
      max: unknown;
      enabled: unknown;
    }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback.map((c) => ({ ...c }));
    return parsed
      .map((c) => ({
        label: String(c.label ?? ""),
        min: Number(c.min),
        max: c.max === null ? Infinity : Number(c.max),
        enabled: c.enabled !== false,
      }))
      .filter((c) => c.label && Number.isFinite(c.min));
  } catch {
    return fallback.map((c) => ({ ...c }));
  }
}

/** The inverse of `loadHeightClasses`. Silently a no-op on failure, for the
 * same reason `loadHeightClasses` silently falls back — see there. */
export function saveHeightClasses(siteSlug: string, classes: readonly HeightClassDef[]): void {
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + siteSlug,
      JSON.stringify(
        classes.map((c) => ({
          label: c.label,
          min: c.min,
          max: Number.isFinite(c.max) ? c.max : null,
          enabled: c.enabled,
        })),
      ),
    );
  } catch {
    // Storage full, disabled, or a private window. Nothing here is load
    // bearing for the current session, so nothing is surfaced as an error.
  }
}

// -------------------------------------------------------------------------
// Filtering — §9's seven axes, plus the height-class quick filters
// -------------------------------------------------------------------------

/** `null` means "no constraint on this axis," not "zero to zero." */
export type Range = [number, number] | null;

export type TreeFilters = {
  height: Range;
  crownArea: Range;
  crownDiameter: Range;
  elevation: Range;
  confidence: Range;
  /** Matched as a case-insensitive substring of the 16-hex-character id, so a
   * client can paste a partial id copied from an export and still find it. */
  treeId: string;
  /** `null` = every class counts (no class filter armed). An empty set is a
   * real, distinct state — "no class is checked" — and must show zero trees,
   * not fall back to "all of them," which is why this is not simply
   * `Set<string>` defaulting to empty. */
  heightClasses: Set<string> | null;
};

export const EMPTY_FILTERS: TreeFilters = {
  height: null,
  crownArea: null,
  crownDiameter: null,
  elevation: null,
  confidence: null,
  treeId: "",
  heightClasses: null,
};

/**
 * Confidence 0.40, below which a tree is hidden **by default**, not deleted.
 *
 * This is not tuned against the pipeline in general — there is no ground
 * truth to tune it against, ever, per the manifest's own note — it is one
 * finding from one spot check: `docs/forest-validation-2026-09-19.md`
 * compared the raw output against three hand-picked orthomosaic patches
 * (dense forest, bare ground, a rooftop cluster) and found that filtering
 * the *existing* `confidence` field at this exact value cut Ektanagar 1's
 * 26,776 raw candidates to 3,632, removed roughly 82-86% of the false
 * positives counted by eye on the bare-ground and rooftop patches, and left
 * the dense-forest patch's density sitting almost exactly at the top of a
 * human visual estimate for that patch. Below 0.40 the false-positive rate
 * was still high; at 0.45 real trees started visibly disappearing too. 0.40
 * is where that document's own recommendation lands, not a round number
 * picked without looking.
 *
 * It changes what is *shown first*, never what is *available*: every panel
 * built against this file offers an explicit, clearly labelled "show
 * low-confidence detections" control that reveals the full, untouched
 * inventory down to confidence 0. Nothing here deletes or recomputes
 * anything — see `docs/forest-tools-plan.md`'s own confidence quality
 * requirement, which this default exists to take seriously rather than
 * merely mention.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

/**
 * What a client sees before touching a single control: the honest but noisy
 * full inventory is real, but hidden until asked for. Every other filter
 * panel in this codebase (hydrology's, measure's) opens with nothing hidden,
 * because their raw output has no known false-positive problem. Forest's
 * does, per the validation note above, so this is the one panel whose
 * "cleared" state is not "everything visible."
 */
export const DEFAULT_FILTERS: TreeFilters = {
  ...EMPTY_FILTERS,
  confidence: [DEFAULT_CONFIDENCE_THRESHOLD, 1],
};

export function isEmptyFilters(f: TreeFilters): boolean {
  return (
    f.height === null &&
    f.crownArea === null &&
    f.crownDiameter === null &&
    f.elevation === null &&
    f.confidence === null &&
    f.treeId.trim() === "" &&
    f.heightClasses === null
  );
}

/** Whether `f` is exactly the safe starting point above — used to decide
 * whether a "clear filters" control has anything left to do, since clearing
 * back to `DEFAULT_FILTERS` (not to fully empty) is the one this panel offers
 * unprompted; see `DEFAULT_FILTERS`'s own comment for why. */
export function isDefaultFilters(f: TreeFilters): boolean {
  return (
    f.height === null &&
    f.crownArea === null &&
    f.crownDiameter === null &&
    f.elevation === null &&
    f.confidence !== null &&
    f.confidence[0] === DEFAULT_CONFIDENCE_THRESHOLD &&
    f.confidence[1] === 1 &&
    f.treeId.trim() === "" &&
    f.heightClasses === null
  );
}

function inRange(v: number, r: Range): boolean {
  return r === null || (v >= r[0] && v <= r[1]);
}

export function matchesFilters(
  t: TreeRecord,
  f: TreeFilters,
  classDefs: readonly HeightClassDef[],
): boolean {
  if (!inRange(t.height, f.height)) return false;
  if (!inRange(t.crownArea, f.crownArea)) return false;
  if (!inRange(t.crownDiameter, f.crownDiameter)) return false;
  if (!inRange(t.groundElevation, f.elevation)) return false;
  if (!inRange(t.confidence, f.confidence)) return false;
  const needle = f.treeId.trim().toLowerCase();
  if (needle && !t.id.includes(needle)) return false;
  if (f.heightClasses) {
    const cls = heightClassFor(t.height, classDefs);
    if (!cls || !f.heightClasses.has(cls.label)) return false;
  }
  return true;
}

/**
 * Every tree matching every axis, by linear scan.
 *
 * `docs/forest-tools-plan.md` §2.5 explicitly sanctions this rather than a
 * sort-and-binary-search index per axis: "26,776 trees is small enough that a
 * well-written linear scan is likely fine; don't over-engineer." Measured on
 * this machine: six comparisons per tree, 26,776 trees, is under a
 * millisecond — imperceptible against a UI slider firing on every pointer
 * move. A per-axis sorted index would have to intersect five range results
 * and a set membership test per drag, which is more code answering the same
 * question slower at this size. It stops being the right answer the moment a
 * survey's tree count leaves the browser budget (§2.5's 250,000), and at that
 * point the fix is the server-side filter path the plan already calls for,
 * not a cleverer client-side algorithm.
 */
export function filterTrees(
  trees: readonly TreeRecord[],
  f: TreeFilters,
  classDefs: readonly HeightClassDef[],
): TreeRecord[] {
  if (isEmptyFilters(f)) return trees as TreeRecord[];
  const out: TreeRecord[] = [];
  for (const t of trees) {
    if (matchesFilters(t, f, classDefs)) out.push(t);
  }
  return out;
}

/** The full extent of one numeric axis across every tree, for a filter
 * panel's slider bounds. `[0, 0]` for an empty pack rather than `[Infinity,
 * -Infinity]`, which no `<input type="range">` can be built from. */
export function axisDomain(
  trees: readonly TreeRecord[],
  key: "height" | "crownArea" | "crownDiameter" | "groundElevation" | "confidence",
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const t of trees) {
    const v = t[key];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? [min, max] : [0, 0];
}

// -------------------------------------------------------------------------
// Confidence: the number this pass must not bury
// -------------------------------------------------------------------------

export type ConfidenceStats = {
  min: number;
  max: number;
  median: number;
  mean: number;
  histogram: HistogramBin[];
};

/**
 * Computed client side rather than read off `summary.json`, because
 * `summary.json`'s schema (fixed by the engine track, per its own header
 * comment) does not carry a confidence distribution at all — only the
 * per-tree `confidence` field in `trees.bin` does. Given the standing
 * instruction that confidence must be shown prominently, not buried, this is
 * computed from the pack this file already holds in memory rather than left
 * out because the precomputed summary happens not to carry it.
 */
export function confidenceStats(trees: readonly TreeRecord[]): ConfidenceStats {
  if (trees.length === 0) return { min: 0, max: 0, median: 0, mean: 0, histogram: [] };
  const values = trees.map((t) => t.confidence).sort((a, b) => a - b);
  const min = values[0];
  const max = values[values.length - 1];
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  const binCount = 10;
  const width = (max - min) / binCount || 1;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    binMin: min + i * width,
    binMax: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    const i = Math.min(binCount - 1, Math.floor((v - min) / width));
    bins[i].count += 1;
  }
  return { min, max, median, mean, histogram: bins };
}
