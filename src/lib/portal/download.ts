"use client";

/**
 * Handing a file to the client, in one place.
 *
 * There were three copies of this before — `SpotLevelPanel` built its anchor
 * inline, `GridLevelsPanel` had a private `save`, and the shapefile tool went
 * through its own client — and items 5 and 7 of Malhar's list would have added
 * two more. Three copies of six lines is not a crisis, but they had already
 * drifted on the part that matters: one revoked its object URL and one did not,
 * so every export from that panel leaked the whole file for the life of the
 * page.
 *
 * ## The filename is part of the export
 *
 * A client downloads sections from four surveys in an afternoon and ends up
 * with `sections.csv`, `sections (1).csv`, `sections (2).csv`. Which survey
 * each came from is then unrecoverable, and the numbers inside are metres above
 * a datum with nothing to say which site they belong to. So `filename` composes
 * the survey, what the file is, and the parameters that change its contents —
 * an interval, a spacing, a threshold — because those are exactly what a client
 * re-exports to compare.
 */

/**
 * Save a blob to the client's machine.
 *
 * The object URL is revoked on the next frame rather than immediately: Safari
 * cancels a download whose URL is revoked in the same tick as the click, and it
 * fails silently, which is the worst way for a download button to not work.
 */
export function saveBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(href));
}

/** Save text as a file, with the charset stated so a BOM-less CSV opens right. */
export function saveText(text: string, name: string, type = "text/csv") {
  saveBlob(new Blob([text], { type: `${type};charset=utf-8` }), name);
}

/**
 * A filename that says which survey, which tool, and under which settings.
 *
 * `parts` are the settings that change the file's contents. They are joined
 * with hyphens and slugged, so `filename("kotba-survey", "sections", ["10m",
 * "hw15m"])` gives `kotba-survey-sections-10m-hw15m.csv`.
 */
export function filename(
  siteSlug: string,
  what: string,
  parts: (string | number | null | undefined)[] = [],
  extension = "csv",
) {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const tail = parts
    .filter((p) => p !== null && p !== undefined && String(p) !== "")
    .map((p) => slug(String(p)));
  return [slug(siteSlug), slug(what), ...tail].filter(Boolean).join("-") + `.${extension}`;
}

/**
 * One CSV row, with the quoting rules actually applied.
 *
 * A survey name with a comma in it, or a note carrying a quote, silently breaks
 * a naively joined CSV — and it breaks it in a way that shifts every later
 * column, so the file still opens and every number in it is under the wrong
 * heading. RFC 4180: quote when the value holds a comma, a quote or a newline,
 * and double any quote inside.
 */
export function csvRow(values: (string | number | null | undefined)[]) {
  return values
    .map((v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/**
 * A CSV with a header and rows, ending in a newline.
 *
 * `\r\n` line endings, which is what RFC 4180 specifies and what Excel on
 * Windows needs to not run the whole file into one row. Every reader that
 * matters handles them.
 */
export function csv(
  header: string[],
  rows: (string | number | null | undefined)[][],
) {
  return [csvRow(header), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}
