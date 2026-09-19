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

/** A shape the client drew, as a layer they can name and hide. Item 2. */
export type DrawnLayerView = {
  id: string;
  kind: GeometryKind;
  name: string;
  visible: boolean;
};

/** A file the client brought in to compare against. Item 3. */
export type UploadedLayerView = {
  id: string;
  name: string;
  format: "shapefile" | "kml";
  kind: string;
  count: number;
  crs: { epsg: number; description: string };
  visible: boolean;
};

export type ShapefileUploadState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; data: UploadedShapefile }
  | { state: "error"; message: string };

const GROUP_LABEL: Record<GeometryKind, string> = {
  polygon: "Polygons",
  line: "Polylines",
  point: "Points",
};

/**
 * One layer: an eye, an editable name, and what it is.
 *
 * The name is an input rather than a click-to-edit affordance. Click-to-edit
 * hides the fact that a name *can* be changed behind a discovery step, and this
 * list exists because a client could not name anything; a control nobody finds
 * is the same as no control. It commits on blur and on Enter, so typing and
 * clicking away both work.
 */
function LayerRow({
  name,
  visible,
  detail,
  onRename,
  onToggle,
  onRemove,
}: {
  name: string;
  visible: boolean;
  detail?: string;
  onRename: (name: string) => void;
  onToggle: (visible: boolean) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(name);
  // Follow an external rename, but never while the client is mid-edit.
  const [editing, setEditing] = useState(false);
  if (!editing && draft !== name) setDraft(name);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setDraft(name);
  };

  return (
    <li className="flex items-center gap-1.5 rounded bg-ink/[0.03] px-1.5 py-1">
      <button
        type="button"
        onClick={() => onToggle(!visible)}
        aria-label={visible ? `Hide ${name}` : `Show ${name}`}
        aria-pressed={visible}
        className={`shrink-0 text-[12px] leading-none ${visible ? "text-accent-600" : "text-ink/30"}`}
      >
        {visible ? "\u25c9" : "\u25cb"}
      </button>
      <span className="min-w-0 flex-1">
        <input
          value={draft}
          onChange={(e) => { setEditing(true); setDraft(e.target.value); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { setDraft(name); setEditing(false); e.currentTarget.blur(); }
          }}
          aria-label="Layer name"
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-ink-900 hover:border-ink/15 focus:border-accent-600 focus:bg-paper focus:outline-none"
        />
        {detail ? <span className="block px-1 text-[10px] text-ink/45">{detail}</span> : null}
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="shrink-0 text-[11px] font-semibold text-ink/40 hover:text-signal-600"
        >
          \u00d7
        </button>
      ) : null}
    </li>
  );
}

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
  drawnLayers,
  onRenameDrawn,
  onToggleDrawn,
  uploads,
  onRenameUpload,
  onToggleUpload,
  onRemoveUpload,
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
  /** Item 2: what has been drawn, grouped by geometry, named and switchable. */
  drawnLayers: DrawnLayerView[];
  onRenameDrawn: (id: string, name: string) => void;
  onToggleDrawn: (id: string, visible: boolean) => void;
  /** Item 3: every uploaded file, coexisting and independently switchable. */
  uploads: UploadedLayerView[];
  onRenameUpload: (id: string, name: string) => void;
  onToggleUpload: (id: string, visible: boolean) => void;
  onRemoveUpload: (id: string) => void;
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

      {drawnLayers.length > 0 ? (
        <div className="border-t border-ink/[0.08] pt-3">
          <p className="mb-1.5 text-[11px] font-semibold text-ink/60">Drawn features</p>
          {/*
            Grouped by geometry, which is item 2's first line and is also the
            only grouping that is true without asking: the tool knows a polygon
            is a polygon, and does not know it is a hotel until someone says so.
            So the groups are the geometry and the naming is per feature.
          */}
          {(["polygon", "line", "point"] as GeometryKind[]).map((kind) => {
            const group = drawnLayers.filter((l) => l.kind === kind);
            if (group.length === 0) return null;
            const allOn = group.every((l) => l.visible);
            return (
              <div key={kind} className="mb-2 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink/45">
                    {GROUP_LABEL[kind]} ({group.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => group.forEach((l) => onToggleDrawn(l.id, !allOn))}
                    className="text-[10px] font-semibold text-accent-600 hover:text-accent-700"
                  >
                    {allOn ? "Hide all" : "Show all"}
                  </button>
                </div>
                <ul className="space-y-1">
                  {group.map((l) => (
                    <LayerRow
                      key={l.id}
                      name={l.name}
                      visible={l.visible}
                      onRename={(name) => onRenameDrawn(l.id, name)}
                      onToggle={(v) => onToggleDrawn(l.id, v)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="border-t border-ink/[0.08] pt-3">
        <fieldset className="space-y-1.5">
          <legend className="text-[11px] font-semibold text-ink/60">
            Upload, to compare
          </legend>

          <input
            ref={fileInput}
            type="file"
            accept=".zip,.kml,.kmz"
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
              ? "Reading the file…"
              : "Drop a .zip, .kml or .kmz here, or click to choose one"}
          </div>

          {upload.state === "error" ? (
            <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
              {upload.message}
            </p>
          ) : null}

          {uploads.length > 0 ? (
            <ul className="space-y-1">
              {uploads.map((u) => (
                <LayerRow
                  key={u.id}
                  name={u.name}
                  visible={u.visible}
                  detail={`${u.count} ${u.kind === "polyline" ? "line" : u.kind}${u.count === 1 ? "" : "s"} · ${
                    u.format === "kml" ? "KML" : "Shapefile"
                  } · ${u.crs.description}`}
                  onRename={(name) => onRenameUpload(u.id, name)}
                  onToggle={(v) => onToggleUpload(u.id, v)}
                  onRemove={() => onRemoveUpload(u.id)}
                />
              ))}
            </ul>
          ) : null}

          <p className="text-[10px] leading-snug text-ink/45">
            A shapefile needs its .prj so its projection is known. KML is always
            lon/lat by specification, so there is nothing to state and nothing to
            guess. Uploads sit alongside each other — adding one never removes
            another.
          </p>
        </fieldset>
      </div>
    </div>
  );
}
