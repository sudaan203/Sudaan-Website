"use client";

import { useState } from "react";
import type { Surface } from "@/lib/portal/analysis-client";
import { formatElevation } from "@/lib/portal/geodesy";

/**
 * Tool 1, spot levels.
 *
 * Click the map, get X, Y and Z. The specification asks for eastings and
 * northings by default "because that is what their CAD expects", for lat/lon as
 * an option, for copy to clipboard, and for a list that accumulates rather than
 * a single reading that is replaced on the next click. All four are here, and
 * the last is the one that turns this from a toy into something a surveyor uses:
 * checking a level means taking a dozen of them and comparing.
 *
 * Every Z on this panel came from the server, read bilinearly from the source
 * raster. Nothing here is derived from a map tile.
 */

export type SpotReading = {
  id: number;
  /** Where the client clicked, in degrees. */
  lon: number;
  lat: number;
  /** The survey's own grid, which is what gets exported. */
  easting: number;
  northing: number;
  elevation: number | null;
  surface: Surface;
  computedIn: string;
};

type Format = "utm" | "lonlat";

export function SpotLevelPanel({
  readings,
  toleranceM,
  busy,
  error,
  onRemove,
  onClear,
}: {
  readings: SpotReading[];
  toleranceM: number;
  busy: boolean;
  error: string | null;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  const [format, setFormat] = useState<Format>("utm");
  const [copied, setCopied] = useState<string | null>(null);

  const epsg = readings[0]?.computedIn ?? "the survey grid";

  /**
   * Clipboard writes can reject: an insecure origin, a browser that gates the
   * permission, or a window that lost focus between the click and the promise.
   * Swallowing that would leave the client believing they had copied a level
   * they had not, so the button says what actually happened.
   */
  const copy = async (text: string, token: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1600);
    } catch {
      setCopied(`failed:${token}`);
      setTimeout(() => setCopied((c) => (c === `failed:${token}` ? null : c)), 2400);
    }
  };

  const lineFor = (r: SpotReading) =>
    format === "utm"
      ? `${r.easting.toFixed(3)}, ${r.northing.toFixed(3)}, ${r.elevation === null ? "" : r.elevation.toFixed(3)}`
      : `${r.lat.toFixed(7)}, ${r.lon.toFixed(7)}, ${r.elevation === null ? "" : r.elevation.toFixed(3)}`;

  /**
   * A survey point file with no projection on it is worse than useless in a CAD
   * workflow: 345308 E is a valid easting in all sixty UTM zones. The CRS goes
   * in a comment line at the top, which QGIS, Global Mapper and Civil 3D all
   * skip, and in the filename, which survives being emailed on.
   */
  const csv = () => {
    const header =
      format === "utm"
        ? `# Spot levels, ${epsg}. Elevations in metres.\npoint,easting,northing,elevation\n`
        : `# Spot levels, WGS84 geographic (EPSG:4326). Elevations in metres above the survey datum.\npoint,latitude,longitude,elevation\n`;
    const rows = readings
      .map((r, i) =>
        format === "utm"
          ? `${i + 1},${r.easting.toFixed(3)},${r.northing.toFixed(3)},${r.elevation === null ? "" : r.elevation.toFixed(3)}`
          : `${i + 1},${r.lat.toFixed(7)},${r.lon.toFixed(7)},${r.elevation === null ? "" : r.elevation.toFixed(3)}`,
      )
      .join("\n");
    return header + rows + "\n";
  };

  const download = () => {
    const blob = new Blob([csv()], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download =
      format === "utm"
        ? `spot-levels-${epsg.replace(/[^A-Za-z0-9]+/g, "")}.csv`
        : "spot-levels-EPSG4326.csv";
    anchor.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Spot levels
        </h3>
        {readings.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
          >
            Clear all
          </button>
        ) : null}
      </div>

      {readings.length === 0 && !busy ? (
        <p className="text-[11px] leading-snug text-ink/55">
          Click anywhere on the survey to take a level. Points accumulate here, so you
          can take a run of them and compare.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {error}
        </p>
      ) : null}

      {readings.length > 0 ? (
        <>
          <div className="flex items-center gap-1" role="group" aria-label="Coordinate format">
            {(
              [
                ["utm", "Grid"],
                ["lonlat", "Lat / lon"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={format === value}
                onClick={() => setFormat(value)}
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition ${
                  format === value
                    ? "bg-accent-600 text-white"
                    : "border border-ink/15 text-ink/70 hover:border-accent-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <ol className="max-h-52 space-y-1 overflow-y-auto">
            {readings.map((r, index) => (
              <li
                key={r.id}
                className="group flex items-baseline gap-2 rounded px-1 py-0.5 text-[12px] hover:bg-ink/[0.04]"
              >
                <span className="w-4 shrink-0 font-mono text-[10px] text-ink/40">
                  {index + 1}
                </span>
                <span className="flex-1 font-mono leading-snug text-ink-900">
                  {r.elevation === null ? (
                    <span className="text-ink/45">no data at this point</span>
                  ) : (
                    <>
                      <span className="font-semibold">{r.elevation.toFixed(3)} m</span>
                      <br />
                      <span className="text-[10px] text-ink/55">
                        {format === "utm"
                          ? `${r.easting.toFixed(2)} E  ${r.northing.toFixed(2)} N`
                          : `${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}`}
                      </span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void copy(lineFor(r), `row-${r.id}`)}
                  className="shrink-0 text-[10px] font-semibold text-accent-600 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                >
                  {copied === `row-${r.id}`
                    ? "copied"
                    : copied === `failed:row-${r.id}`
                      ? "blocked"
                      : "copy"}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(r.id)}
                  aria-label={`Remove point ${index + 1}`}
                  className="shrink-0 text-[10px] font-semibold text-ink/40 opacity-0 transition hover:text-signal-600 group-hover:opacity-100 focus:opacity-100"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copy(readings.map(lineFor).join("\n"), "all")}
              className="rounded-full border border-ink/15 px-2.5 py-1 text-[11px] font-semibold text-ink/70 transition hover:border-accent-600 hover:text-accent-700"
            >
              {copied === "all"
                ? "Copied"
                : copied === "failed:all"
                  ? "Clipboard blocked"
                  : `Copy ${readings.length}`}
            </button>
            <button
              type="button"
              onClick={download}
              className="rounded-full border border-ink/15 px-2.5 py-1 text-[11px] font-semibold text-ink/70 transition hover:border-accent-600 hover:text-accent-700"
            >
              Download CSV
            </button>
          </div>

          <p className="border-t border-ink/[0.08] pt-2 text-[11px] leading-snug text-ink/55">
            {format === "utm"
              ? `Eastings and northings in ${epsg}, the survey's own grid, which is what the CSV states. `
              : "Latitude and longitude on WGS84. "}
            Levels are read from the {readings[0].surface === "dsm" ? "surface model" : "terrain model"} at
            full resolution, ±{(toleranceM * 100).toFixed(0)} cm.
          </p>
        </>
      ) : null}

      {busy ? <p className="text-[11px] text-ink/45">Reading the model…</p> : null}
    </div>
  );
}

/** Shared by the panel and by MapViewer's hover readout. */
export function formatSpot(elevation: number | null, toleranceM: number): string {
  return elevation === null ? "no data" : formatElevation(elevation, toleranceM);
}
