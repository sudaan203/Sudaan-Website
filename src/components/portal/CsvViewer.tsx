"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Reads a delivered CSV and shows what it contains.
 *
 * Written because the Aektanagar elevation grid, 5,449 real surveyed points, was
 * being shown to the client as "this file type cannot be previewed". It is a
 * three column table of numbers; there was nothing to wait for.
 *
 * Two decisions worth keeping:
 *
 * - **Summarise before tabulating.** Nobody reads 5,449 rows. What a client wants
 *   from a point grid is the count, the spacing, the elevation range, and then the
 *   ability to check a few rows. So the numeric columns are profiled first.
 * - **Render a window, not the whole file.** 5,449 rows is fine; a 500,000 row
 *   grid would lock the tab. Rows are paged, and the parse is capped.
 */

const MAX_ROWS = 50000;
const PAGE = 100;

type Parsed = {
  header: string[];
  rows: string[][];
  truncated: boolean;
};

/** Split a CSV line, honouring quotes, because a description column may contain commas. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): Parsed {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [], truncated: false };
  const header = splitLine(lines[0]);
  const body = lines.slice(1, MAX_ROWS + 1).map(splitLine);
  return { header, rows: body, truncated: lines.length - 1 > MAX_ROWS };
}

/** Column stats, but only for columns that really are numeric. */
function profile(header: string[], rows: string[][]) {
  return header.map((name, i) => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    const distinct = new Set<number>();
    for (const r of rows) {
      const v = Number(r[i]);
      if (!Number.isFinite(v)) continue;
      n += 1;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      if (distinct.size < 4000) distinct.add(v);
    }
    const numeric = n > 0 && n >= rows.length * 0.9;
    // Commonest gap between sorted distinct values, which recovers a grid spacing.
    let spacing: number | null = null;
    if (numeric && distinct.size > 2 && distinct.size < 4000) {
      const v = [...distinct].sort((a, b) => a - b);
      const gaps = new Map<number, number>();
      for (let k = 1; k < v.length; k += 1) {
        const g = Number((v[k] - v[k - 1]).toFixed(4));
        if (g > 0) gaps.set(g, (gaps.get(g) ?? 0) + 1);
      }
      const best = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] > v.length * 0.5) spacing = best[0];
    }
    return { name, numeric, min, max, mean: n ? sum / n : 0, count: n, spacing };
  });
}

export default function CsvViewer({ src, title }: { src: string; title: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let alive = true;
    // credentials so the authorised asset route sees the session; this is the
    // same main thread fetch the map uses for GeoJSON, for the same reason.
    fetch(src, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => { alive = false; };
  }, [src]);

  const parsed = useMemo(() => (text ? parseCsv(text) : null), [text]);
  const stats = useMemo(
    () => (parsed ? profile(parsed.header, parsed.rows) : []),
    [parsed],
  );

  if (error) {
    return (
      <div className="surface p-6">
        <p className="text-sm text-ink/70">This dataset could not be loaded ({error}).</p>
      </div>
    );
  }
  if (!parsed) {
    return (
      <div className="surface p-6">
        <p className="text-sm text-ink/60">Reading the dataset…</p>
      </div>
    );
  }
  if (parsed.header.length === 0) {
    return (
      <div className="surface p-6">
        <p className="text-sm text-ink/70">This dataset is empty.</p>
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(parsed.rows.length / PAGE));
  const start = page * PAGE;
  const window = parsed.rows.slice(start, start + PAGE);

  return (
    <div className="space-y-4">
      {/* What the file is, before any rows. */}
      <div className="surface p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Dataset summary
        </h3>
        <p className="mt-1 text-sm text-ink-900">
          {parsed.rows.length.toLocaleString("en-IN")} rows, {parsed.header.length} columns
          {parsed.truncated ? `, showing the first ${MAX_ROWS.toLocaleString("en-IN")}` : ""}
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((s) => (
            <div key={s.name} className="border-t border-ink/[0.08] pt-2">
              <dt className="font-mono text-[11px] uppercase tracking-wide text-ink/55">
                {s.name}
              </dt>
              <dd className="text-[13px] text-ink-900">
                {s.numeric ? (
                  <>
                    {fmt(s.min)} to {fmt(s.max)}
                    <span className="block text-[11px] text-ink/55">
                      mean {fmt(s.mean)}
                      {s.spacing !== null ? ` · spacing ${fmt(s.spacing)}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="text-ink/55">text</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="surface overflow-hidden">
        <div className="max-h-[55vh] overflow-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <th scope="col" className="border-b border-ink/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink/45">
                  #
                </th>
                {parsed.header.map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="border-b border-ink/10 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-ink/55"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {window.map((r, i) => (
                <tr key={start + i} className={i % 2 ? "bg-paper/60" : undefined}>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-ink/40">
                    {(start + i + 1).toLocaleString("en-IN")}
                  </td>
                  {parsed.header.map((h, c) => (
                    <td key={h} className="whitespace-nowrap px-3 py-1.5 font-mono text-ink-900">
                      {r[c] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pages > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-ink/[0.08] px-4 py-2.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-full border border-ink/15 px-3 py-1 text-xs font-semibold text-ink/70 disabled:opacity-40 hover:border-accent-600 hover:text-accent-700"
            >
              Previous
            </button>
            <p className="text-xs text-ink/55">
              Rows {(start + 1).toLocaleString("en-IN")} to{" "}
              {Math.min(start + PAGE, parsed.rows.length).toLocaleString("en-IN")} of{" "}
              {parsed.rows.length.toLocaleString("en-IN")}
            </p>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="rounded-full border border-ink/15 px-3 py-1 text-xs font-semibold text-ink/70 disabled:opacity-40 hover:border-accent-600 hover:text-accent-700"
            >
              Next
            </button>
          </div>
        ) : null}
      </div>

      <p className="text-[11px] leading-snug text-ink/55">
        {title} is shown as delivered. Coordinates are in the survey&apos;s own
        projection, so they are metres, not degrees.
      </p>
    </div>
  );
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  if (abs >= 100000) return v.toFixed(2);
  if (abs >= 100) return v.toFixed(3);
  return v.toFixed(3);
}
