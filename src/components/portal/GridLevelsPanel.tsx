"use client";

import { useState } from "react";
import type { GridLevelsResult } from "@/lib/portal/analysis-client";
import { formatArea } from "@/lib/portal/geodesy";
import {
  pointsToCsv,
  pointsToDxf,
  pointsToLandXml,
  pointsToTxt,
  writePrj,
} from "@/lib/geo/export-formats.mjs";

/**
 * Tool 2: a grid of spot levels inside a polygon, exportable.
 *
 * "Similar to Global Mapper", which is Malhar's own comparison and a fair one:
 * a surveyor picks an area and a spacing and gets levels on a regular grid, in
 * a file their CAD desk opens.
 *
 * ## Why the files are written here rather than by the server
 *
 * `export-formats.mjs` is pure — no imports at all — so the same tested writers
 * run in the browser. The points have already crossed the network to be counted
 * and shown; asking the server to compute them a second time to format them
 * would double the work and introduce a second answer that could differ from
 * the first.
 *
 * ## The rules those writers enforce, which is why they are used rather than a
 * `join(",")`
 *
 * Every format states its coordinate reference system, and the caller cannot
 * opt out. A file of X, Y, Z with no projection is not merely unhelpful: the
 * pair 345308, 2355499 is a valid position in all sixty UTM zones and in none
 * of them by accident. CSV carries a commented header, LandXML records the EPSG
 * code, and DXF gets a `.prj` sidecar because the format has nowhere to put one.
 *
 * LandXML also writes northing *before* easting, per the schema. Getting that
 * backwards transposes the entire survey and still opens without complaint.
 */

export type GridLevelsState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; data: GridLevelsResult; epsg: string }
  | { state: "error"; message: string };

/** The spacings Malhar names, plus 5 m for a coarse setting-out grid. */
const SPACINGS = [0.5, 1, 2, 5];

function save(name: string, body: string, type: string) {
  const blob = new Blob([body], { type: `${type};charset=utf-8` });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(href);
}

export function GridLevelsPanel({
  ready,
  polygonArea,
  spacing,
  setSpacing,
  result,
  onCompute,
  onClear,
}: {
  ready: boolean;
  polygonArea: number;
  spacing: number;
  setSpacing: (v: number) => void;
  result: GridLevelsState;
  onCompute: () => void;
  onClear: () => void;
}) {
  const [saved, setSaved] = useState<string | null>(null);

  // What the request would produce, before it is made. A 0.5 m grid over a
  // hectare is 40,000 points; the server refuses at 250,000 and the client
  // should not have to discover that by being refused.
  const estimate = Math.round(polygonArea / (spacing * spacing));

  return (
    <div role="region" aria-label="Grid levels" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Grid levels
        </h3>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
        >
          Clear
        </button>
      </div>

      {!ready ? (
        <p className="text-[11px] leading-snug text-ink/55">
          Draw the area to grid: click each corner, double click to close it.
        </p>
      ) : (
        <>
          <p className="text-[12px] text-ink/70">
            Polygon <span className="font-mono">{formatArea(polygonArea)}</span>
          </p>

          <fieldset className="space-y-1">
            <legend className="text-[11px] font-semibold text-ink/60">Spacing</legend>
            <div className="flex flex-wrap gap-1">
              {SPACINGS.map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={spacing === v}
                  onClick={() => setSpacing(v)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                    spacing === v
                      ? "bg-ink-900 text-white"
                      : "border border-ink/15 text-ink/70 hover:border-accent-600"
                  }`}
                >
                  {v} m
                </button>
              ))}
            </div>
            <p className="text-[10px] text-ink/50">
              About {estimate.toLocaleString("en-GB")} points over this polygon.
            </p>
          </fieldset>

          {estimate > 250_000 ? (
            <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
              That is past the 250,000 point limit. Use a coarser spacing or a smaller
              area.
            </p>
          ) : null}

          <button
            type="button"
            disabled={result.state === "loading" || estimate > 250_000}
            onClick={onCompute}
            className="w-full rounded-full bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {result.state === "loading" ? "Reading the model…" : "Generate levels"}
          </button>

          {result.state === "error" ? (
            <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
              {result.message}
            </p>
          ) : null}

          {result.state === "done" ? (
            <Levels data={result.data} epsg={result.epsg} saved={saved} setSaved={setSaved} />
          ) : null}
        </>
      )}
    </div>
  );
}

function Levels({
  data,
  epsg,
  saved,
  setSaved,
}: {
  data: GridLevelsResult;
  epsg: string;
  saved: string | null;
  setSaved: (s: string | null) => void;
}) {
  const code = Number(epsg.replace(/[^0-9]/g, ""));
  const points = data.points;
  const stem = `grid-levels-${data.spacing}m-EPSG${code}`;

  const exports: [string, () => void][] = [
    [
      "CSV",
      () => save(`${stem}.csv`, pointsToCsv(points, { epsg: code, label: "Grid levels" }), "text/csv"),
    ],
    ["TXT", () => save(`${stem}.txt`, pointsToTxt(points), "text/plain")],
    [
      "DXF",
      () => {
        save(`${stem}.dxf`, pointsToDxf(points, { layer: "GRID_LEVELS" }), "application/dxf");
        // DXF has nowhere to record a projection, so the sidecar is not optional.
        // Saved alongside rather than offered separately, because a client who
        // takes only the DXF has a file that cannot be placed on the earth.
        save(`${stem}.prj`, writePrj(code), "text/plain");
      },
    ],
    [
      "LandXML",
      () =>
        save(
          `${stem}.xml`,
          pointsToLandXml(points, { epsg: code, name: "Grid levels" }),
          "application/xml",
        ),
    ],
  ];

  return (
    <div className="space-y-2 border-t border-ink/[0.08] pt-2">
      <dl className="space-y-1 text-[12px]">
        <Row label="Levels" value={points.length.toLocaleString("en-GB")} strong />
        <Row label="Spacing" value={`${data.spacing} m`} />
        {data.stats.mean !== null ? (
          <Row label="Mean" value={`${data.stats.mean.toFixed(3)} m`} />
        ) : null}
        {data.stats.min !== null && data.stats.max !== null ? (
          <Row label="Range" value={`${data.stats.min.toFixed(2)} – ${data.stats.max.toFixed(2)} m`} />
        ) : null}
      </dl>

      {data.pointsOutsideSurvey > 0 ? (
        <p className="rounded-md bg-signal/10 px-2 py-1.5 text-[11px] leading-snug text-signal-600">
          {data.pointsOutsideSurvey.toLocaleString("en-GB")} grid nodes inside the polygon
          have no survey underneath them and are not in the export. The grid is complete
          only where the survey is.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {exports.map(([label, run]) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              run();
              setSaved(label);
            }}
            className="rounded-full border border-ink/15 px-2.5 py-1 text-[11px] font-semibold text-ink/70 transition hover:border-accent-600 hover:text-accent-700"
          >
            {saved === label ? "Saved" : label}
          </button>
        ))}
      </div>

      <p className="text-[10px] leading-snug text-ink/50">
        Easting, northing and level in {epsg}, not longitude and latitude, because that
        is what goes into a total station and a CAD drawing. Every file states its
        projection; the DXF gets a <span className="font-mono">.prj</span> beside it,
        because the format has nowhere to put one.
      </p>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-ink/55">{label}</dt>
      <dd className={`font-mono text-[12px] ${strong ? "font-semibold" : ""} text-ink-900`}>
        {value}
      </dd>
    </div>
  );
}
