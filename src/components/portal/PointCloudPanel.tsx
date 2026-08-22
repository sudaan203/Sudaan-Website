"use client";

import type { CloudManifest } from "@/lib/portal/cloud-source";
import { CLASS_COLOURS, elevationRamp, type ColourMode } from "@/lib/portal/point-cloud-layer";

/**
 * The LiDAR cloud's controls.
 *
 * "Point cloud" is one of the layers Malhar lists in Important Notes.txt, and
 * the one thing the portal had nothing for: Aektanagar's 50 million points
 * existed only as a PDF summary describing them.
 *
 * What is offered is what a technician actually changes: how the points are
 * coloured, how big they are, which classes are drawn, and how much detail to
 * pull. Everything else is decided by where the camera is.
 *
 * The counts are shown, and they are not decoration. A viewer that silently
 * draws a twentieth of a cloud looks the same as one drawing all of it until
 * somebody measures something off it, so the panel states how many points are on
 * screen out of how many were flown.
 */

export type CloudControls = {
  visible: boolean;
  colourMode: ColourMode;
  pointSize: number;
  opacity: number;
  classes: Set<number>;
  budget: number;
};

export type CloudStats = { points: number; nodes: number; loading: number };

const BUDGETS: [number, string][] = [
  [500_000, "Light"],
  [2_000_000, "Balanced"],
  [6_000_000, "Full"],
];

export function PointCloudPanel({
  manifest,
  controls,
  setControls,
  stats,
}: {
  manifest: CloudManifest;
  controls: CloudControls;
  setControls: (fn: (c: CloudControls) => CloudControls) => void;
  stats: CloudStats;
}) {
  const compact = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n.toLocaleString("en-GB");

  const modes: [ColourMode, string, string][] = [
    ["rgb", "Colour", "As the camera saw it"],
    ["elevation", "Height", "Low to high"],
    ["classification", "Class", "Ground, vegetation, buildings"],
  ];

  return (
    /*
     * A named region. It is the landmark a screen reader user jumps to, and the
     * only reliable way for anything reading the page to get *this* panel's text
     * rather than the whole document's. That is not hypothetical: a check for
     * "<number> drawn" against `document.body` matched the page's own intro copy
     * — "every layer we produced for this site, drawn over each other" — and
     * reported a working viewer as drawing nothing.
     */
    <div role="region" aria-label="Point cloud" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          LiDAR point cloud
        </h3>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink/70">
          <input
            type="checkbox"
            checked={controls.visible}
            onChange={(e) => setControls((c) => ({ ...c, visible: e.target.checked }))}
            className="h-3.5 w-3.5 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
          />
          Show
        </label>
      </div>

      <p className="text-[11px] leading-snug text-ink/55">
        {manifest.sourcePointCount.toLocaleString("en-GB")} points flown,{" "}
        {manifest.elevation.min.toFixed(1)}–{manifest.elevation.max.toFixed(1)} m.
      </p>

      {controls.visible ? (
        <>
          {/*
            What is on screen against what exists. A viewer that quietly draws a
            fraction of a cloud looks identical to one drawing all of it, and the
            difference matters the moment anyone reads a height off it.
          */}
          <p className="rounded-md bg-ink/[0.04] px-2 py-1.5 font-mono text-[10px] leading-snug text-ink/60">
            {compact(stats.points)} drawn · {stats.nodes} tiles
            {stats.loading > 0 ? ` · ${stats.loading} loading` : ""}
            <span className="mt-0.5 block font-sans text-ink/45">
              Zoom in for more detail; the cloud thins out to stay drawable.
            </span>
          </p>

          <fieldset className="space-y-1.5">
            <legend className="text-[11px] font-semibold text-ink/60">Colour by</legend>
            <div className="flex flex-wrap gap-1.5">
              {modes.map(([value, label, hint]) => {
                const unavailable = value === "rgb" && !manifest.hasColour;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={controls.colourMode === value}
                    disabled={unavailable}
                    title={unavailable ? "This cloud carries no colour" : hint}
                    onClick={() => setControls((c) => ({ ...c, colourMode: value }))}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      controls.colourMode === value
                        ? "bg-accent-600 text-white"
                        : "border border-ink/15 text-ink/70 hover:border-accent-600"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {controls.colourMode === "elevation" ? (
            <ElevationBar min={manifest.elevation.min} max={manifest.elevation.max} />
          ) : null}

          {controls.colourMode === "classification" ? (
            <Classes
              manifest={manifest}
              chosen={controls.classes}
              setChosen={(next) => setControls((c) => ({ ...c, classes: next }))}
            />
          ) : null}

          <label className="block text-[10px] text-ink/50">
            Point size
            <input
              type="range"
              min={1}
              max={6}
              step={0.5}
              value={controls.pointSize}
              onChange={(e) =>
                setControls((c) => ({ ...c, pointSize: Number(e.target.value) }))
              }
              className="mt-0.5 w-full accent-accent-600"
              aria-label="Point size in pixels"
            />
          </label>

          <label className="block text-[10px] text-ink/50">
            Opacity
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={controls.opacity}
              onChange={(e) => setControls((c) => ({ ...c, opacity: Number(e.target.value) }))}
              className="mt-0.5 w-full accent-accent-600"
              aria-label="Point cloud opacity"
            />
          </label>

          <fieldset className="space-y-1">
            <legend className="text-[11px] font-semibold text-ink/60">Detail</legend>
            <div className="flex gap-1.5">
              {BUDGETS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={controls.budget === value}
                  onClick={() => setControls((c) => ({ ...c, budget: value }))}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    controls.budget === value
                      ? "bg-ink-900 text-white"
                      : "border border-ink/15 text-ink/70 hover:border-accent-600"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[10px] leading-snug text-ink/45">
              How many points to hold at once. More is sharper and slower; a
              laptop with weak graphics should stay on Light.
            </p>
          </fieldset>
        </>
      ) : null}
    </div>
  );
}

function ElevationBar({ min, max }: { min: number; max: number }) {
  const swatches = Array.from({ length: 24 }, (_, i) => elevationRamp(i / 23));
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded" aria-hidden>
        {swatches.map((c, i) => (
          <span
            key={i}
            className="flex-1"
            style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[10px] text-ink/50">
        <span>{min.toFixed(0)} m</span>
        <span>{max.toFixed(0)} m</span>
      </div>
    </div>
  );
}

/**
 * Only the classes this cloud contains.
 *
 * The ASPRS table has eighteen entries and a survey typically uses three. A menu
 * of fifteen empty checkboxes invites a client to tick "bridge deck" and
 * conclude the viewer is broken when nothing changes.
 */
function Classes({
  manifest,
  chosen,
  setChosen,
}: {
  manifest: CloudManifest;
  chosen: Set<number>;
  setChosen: (next: Set<number>) => void;
}) {
  const present = manifest.classifications.filter((c) => c.count > 0);
  const all = chosen.size === 0;

  return (
    <fieldset className="space-y-1">
      <legend className="text-[11px] font-semibold text-ink/60">Classes</legend>
      {present.map((c) => {
        const on = all || chosen.has(c.code);
        const colour = CLASS_COLOURS[c.code] ?? [200, 200, 200];
        return (
          <label
            key={c.code}
            className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-900"
          >
            <input
              type="checkbox"
              checked={on}
              onChange={() => {
                // An empty set means "everything", so the first time a box is
                // unticked the set has to be filled in with what was on.
                const next = new Set(all ? present.map((p) => p.code) : chosen);
                if (on) next.delete(c.code);
                else next.add(c.code);
                setChosen(next.size === present.length ? new Set() : next);
              }}
              className="h-3.5 w-3.5 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
            />
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: `rgb(${colour[0]},${colour[1]},${colour[2]})` }}
            />
            <span className="flex-1">{c.name}</span>
            <span className="font-mono text-[10px] text-ink/45">
              {c.count >= 1_000_000
                ? `${(c.count / 1_000_000).toFixed(1)}M`
                : c.count.toLocaleString("en-GB")}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
