"use client";

import { useRef, useState } from "react";
import type { GeometryKind, UploadedShapefile } from "@/lib/portal/shapefile-client";

/**
 * Malhar's shapefile tool, verbatim from his prompt: draw a Point, Line or
 * Polygon on the map, download it as a real `.shp`/`.shx`/`.dbf`/`.prj` zip,
 * or upload one from whatever GIS package he already trusts and see it land on
 * this map.
 *
 * That last half is the actual point of the tool. He is not asking for a
 * drawing feature; he is asking for a way to check our coordinates against
 * something else without taking our word for it. So the upload path shows the
 * detected projection and the point/line/polygon count before anything is
 * drawn — the same numbers a spreadsheet comparison would start from — rather
 * than silently placing a layer and calling that verification.
 */

export type ShapefileCounts = { point: number; line: number; polygon: number };

export type ShapefileDownloadState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string };

export type ShapefileUploadState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; data: UploadedShapefile }
  | { state: "error"; message: string };

const KINDS: { value: GeometryKind; label: string; hint: string }[] = [
  { value: "point", label: "Point", hint: "One click places one point." },
  { value: "line", label: "Line", hint: "Click each vertex, double click to finish." },
  { value: "polygon", label: "Polygon", hint: "Click each corner, double click to close." },
];

export function ShapefilePanel({
  active,
  setActive,
  counts,
  download,
  onDownload,
  onClearDrawn,
  upload,
  onUpload,
  onClearUpload,
}: {
  /** Which geometry the next click on the map will draw, or none. */
  active: GeometryKind | null;
  setActive: (kind: GeometryKind | null) => void;
  counts: ShapefileCounts;
  download: ShapefileDownloadState;
  onDownload: () => void;
  onClearDrawn: () => void;
  upload: ShapefileUploadState;
  onUpload: (file: File) => void;
  onClearUpload: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const activeCount = active ? counts[active] : 0;

  return (
    <div role="region" aria-label="Shapefile" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Shapefile
        </h3>
        {counts.point + counts.line + counts.polygon > 0 ? (
          <button
            type="button"
            onClick={onClearDrawn}
            className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
          >
            Clear drawn
          </button>
        ) : null}
      </div>

      <p className="text-[11px] leading-snug text-ink/55">
        Draw features here and export them as a real shapefile, or bring one in from
        another package to check against this survey.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-semibold text-ink/60">Create</legend>
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={active === value}
              onClick={() => setActive(active === value ? null : value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                active === value
                  ? "bg-accent-600 text-white"
                  : "border border-ink/15 text-ink/70 hover:border-accent-600"
              }`}
            >
              {label}
              {counts[value] > 0 ? (
                <span className="ml-1.5 opacity-70">{counts[value]}</span>
              ) : null}
            </button>
          ))}
        </div>
        {active ? (
          <p className="text-[10px] leading-snug text-ink/50">
            {KINDS.find((k) => k.value === active)?.hint}
          </p>
        ) : null}
      </fieldset>

      <button
        type="button"
        disabled={!active || activeCount === 0 || download.state === "loading"}
        onClick={onDownload}
        className="w-full rounded-full bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {download.state === "loading"
          ? "Building the shapefile…"
          : active
            ? `Download ${activeCount} ${active}${activeCount === 1 ? "" : "s"} as Shapefile`
            : "Download Shapefile"}
      </button>
      {download.state === "error" ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {download.message}
        </p>
      ) : null}
      <p className="text-[10px] leading-snug text-ink/45">
        Written in this survey&apos;s own UTM zone, the same projection every other
        export here uses, with a .prj stating exactly which one.
      </p>

      <div className="border-t border-ink/[0.08] pt-3">
        <fieldset className="space-y-1.5">
          <legend className="text-[11px] font-semibold text-ink/60">
            Upload, to compare
          </legend>

          <input
            ref={fileInput}
            type="file"
            accept=".zip"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = "";
            }}
          />
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) onUpload(file);
            }}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
            }}
            className={`cursor-pointer rounded-lg border border-dashed px-3 py-3 text-center text-[11px] transition ${
              dragOver
                ? "border-accent-600 bg-accent-50 text-accent-700"
                : "border-ink/20 text-ink/55 hover:border-accent-600 hover:text-accent-700"
            }`}
          >
            {upload.state === "loading"
              ? "Reading the shapefile…"
              : "Drop a .zip here, or click to choose one"}
          </div>

          {upload.state === "error" ? (
            <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
              {upload.message}
            </p>
          ) : null}

          {upload.state === "done" ? (
            <div className="space-y-1.5 rounded-md bg-ink/[0.04] px-2 py-2">
              <div className="flex items-baseline justify-between">
                <p className="text-[11px] font-semibold text-ink-900">
                  {upload.data.count} {upload.data.kind === "polyline" ? "line" : upload.data.kind}
                  {upload.data.count === 1 ? "" : "s"}
                </p>
                <button
                  type="button"
                  onClick={onClearUpload}
                  className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
                >
                  Remove
                </button>
              </div>
              <p className="text-[10px] leading-snug text-ink/55">
                Read as {upload.data.crs.description}
                {upload.data.crs.epsg !== 4326 ? ", reprojected to the map." : "."}
              </p>
            </div>
          ) : null}
        </fieldset>
      </div>
    </div>
  );
}
