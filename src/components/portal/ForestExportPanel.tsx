"use client";

import { useState } from "react";
import { saveBlob, filename } from "@/lib/portal/download";
import type { HeightClassDef, TreeFilters } from "@/lib/portal/forest-client";

/**
 * Tree point and crown polygon export, `docs/forest-tools-plan.md` §7 / §12.
 *
 * Styled after `ShapefilePanel.tsx` (pill buttons for a small enumerated
 * choice, a single download button whose label states what it is about to
 * download, an inline error banner, a line stating the projection). It
 * differs from that panel in one structural way on purpose: `ShapefilePanel`
 * is purely presentational — its download state and the fetch that produces
 * it live in `MapViewer.tsx` — while this component owns its own fetch and
 * blob handling. It has to: nothing currently wires forest state into
 * `MapViewer.tsx` (that is a separate, in-flight track), and the brief for
 * this component is to be mountable on its own, wherever and whenever that
 * wiring lands, without also having to invent a parent-side download hook
 * for it first.
 *
 * ## What "the client's current filter" means here
 *
 * `docs/forest-tools-plan.md` §7 asks that an export carry "only trees
 * passing the client's current filter, not always all 26,776". This panel is
 * handed the live `TreeFilters` (the exact type `forest-client.ts`'s
 * `TreeFilterPanel` already edits) and `classDefs` (needed only to resolve
 * which height-class labels are currently armed), and translates every
 * numeric range and the height-class set into the export route's own query
 * parameters — never a list of ids, which would grow with the survey instead
 * of staying the size of the filter.
 *
 * One filter axis has no server-side equivalent and is deliberately not
 * forwarded: `filters.treeId` is a client-side *substring* match over a
 * 16-hex-character id (see `forest-client.ts`'s own comment on why it is a
 * linear scan, not an index), and the export route only knows how to filter
 * by an *exact* id list. Re-deriving "every id containing this substring"
 * would mean shipping the whole matched-id list up as a query parameter,
 * which is exactly the unbounded-length request this design avoids elsewhere.
 * When that field is non-empty, the panel says so plainly rather than
 * silently exporting more (or differently filtered) trees than the map is
 * currently showing.
 */

export type ForestLayer = "points" | "crowns";
export type ForestExportFormat = "shp" | "geojson" | "csv" | "kml" | "kmz" | "pdf";

const FORMATS: { value: ForestExportFormat; label: string; ext: string }[] = [
  { value: "shp", label: "Shapefile", ext: "zip" },
  { value: "geojson", label: "GeoJSON", ext: "geojson" },
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "kml", label: "KML", ext: "kml" },
  { value: "kmz", label: "KMZ", ext: "kmz" },
  { value: "pdf", label: "PDF report", ext: "pdf" },
];

const LAYERS: { value: ForestLayer; label: string; hint: string }[] = [
  { value: "points", label: "Tree points", hint: "One point per tree, at its crown's centroid." },
  { value: "crowns", label: "Crown polygons", hint: "The detected crown shape for each tree." },
];

export type ForestExportState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string };

function query(layer: ForestLayer, format: ForestExportFormat, filters: TreeFilters): URLSearchParams {
  const q = new URLSearchParams({ layer, format });
  const range = (key: string, r: TreeFilters[keyof TreeFilters]) => {
    if (!Array.isArray(r)) return;
    q.set(`min${key}`, String(r[0]));
    q.set(`max${key}`, String(r[1]));
  };
  range("Height", filters.height);
  range("CrownArea", filters.crownArea);
  range("CrownDiameter", filters.crownDiameter);
  range("Elevation", filters.elevation);
  range("Confidence", filters.confidence);
  if (filters.heightClasses) {
    q.set("heightClass", [...filters.heightClasses].join(","));
  }
  return q;
}

export function ForestExportPanel({
  siteSlug,
  filters,
  matchedCount,
  totalCount,
}: {
  siteSlug: string;
  /** The live filter state — the same `TreeFilters` `TreeFilterPanel` edits. */
  filters: TreeFilters;
  /** How many trees currently match `filters`, for the button's own label. */
  matchedCount: number;
  /** How many trees the survey has in total, so the panel can say "26,776 of
   *  26,776" versus "412 of 26,776" rather than a bare number either way. */
  totalCount: number;
  /** Present only to satisfy callers that already have the default height
   *  classes at hand; this panel does not currently need to resolve a label
   *  back to a range, but keeping it in the prop list means a caller does not
   *  have to change its call site if that becomes necessary later. */
  classDefs?: readonly HeightClassDef[];
}) {
  const [layer, setLayer] = useState<ForestLayer>("points");
  const [format, setFormat] = useState<ForestExportFormat>("shp");
  const [download, setDownload] = useState<ForestExportState>({ state: "idle" });

  const filtered = matchedCount < totalCount;
  const treeIdActive = filters.treeId.trim() !== "";

  async function onDownload() {
    setDownload({ state: "loading" });
    try {
      const q = query(layer, format, filters);
      const response = await fetch(
        `/api/portal/sites/${siteSlug}/forest/export?${q.toString()}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The export failed (${response.status}).`);
      }
      const blob = await response.blob();
      const ext = FORMATS.find((f) => f.value === format)?.ext ?? format;
      saveBlob(blob, filename(siteSlug, `forest-${layer}`, [format], ext));
      setDownload({ state: "idle" });
    } catch (error) {
      setDownload({
        state: "error",
        message: error instanceof Error ? error.message : "The export failed.",
      });
    }
  }

  return (
    <div role="region" aria-label="Forest export" className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
        Export
      </h3>
      <p className="text-[11px] leading-snug text-ink/55">
        Download the tree inventory as a real GIS file, or a PDF report, scoped to whatever
        the filter panel is currently showing.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Layer</legend>
        <div className="flex flex-wrap gap-1.5">
          {LAYERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={layer === value}
              onClick={() => setLayer(value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                layer === value
                  ? "bg-accent-600 text-white"
                  : "border border-ink/15 text-ink/70 hover:border-accent-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[10px] leading-snug text-ink/50">
          {LAYERS.find((l) => l.value === layer)?.hint}
        </p>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Format</legend>
        <div className="flex flex-wrap gap-1.5">
          {FORMATS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={format === value}
              onClick={() => setFormat(value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                format === value
                  ? "bg-accent-600 text-white"
                  : "border border-ink/15 text-ink/70 hover:border-accent-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        disabled={download.state === "loading" || matchedCount === 0}
        onClick={onDownload}
        className="w-full rounded-full bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {download.state === "loading"
          ? "Building the export…"
          : matchedCount === 0
            ? "No trees match the current filter"
            : `Download ${matchedCount.toLocaleString("en-IN")} ${
                layer === "points" ? "tree point" : "crown"
              }${matchedCount === 1 ? "" : "s"}`}
      </button>

      {download.state === "error" ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {download.message}
        </p>
      ) : null}

      {filtered ? (
        <p className="text-[10px] leading-snug text-ink/50">
          {matchedCount.toLocaleString("en-IN")} of {totalCount.toLocaleString("en-IN")} trees match
          the current filter. Clear it to export the whole survey.
        </p>
      ) : null}

      {treeIdActive ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[10px] leading-snug text-signal-600">
          The tree-ID search box is a text match this export cannot repeat server side, so it is
          ignored here — this export uses every other active filter, not the ID search.
        </p>
      ) : null}

      <p className="text-[10px] leading-snug text-ink/45">
        Tree points and crown polygons state their own projection in every format: a real .prj for
        Shapefile, a stated CRS for GeoJSON, longitude/latitude for KML/KMZ (as the format
        requires), and a comment header for CSV.
      </p>
    </div>
  );
}
