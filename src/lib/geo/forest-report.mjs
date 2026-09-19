/**
 * Forest inventory PDF report. `docs/forest-tools-plan.md` §7 / §12.
 *
 * Built with `scripts/lib/pdf.mjs`'s `Pdf`/`PAGE` classes — the same text,
 * line, rectangle and polyline primitives `scripts/make-site-deliverables.mjs`
 * already uses for the contour map and the topographic survey report. No
 * chart or table library is pulled in for this: a bar chart is a loop of
 * `rect()` calls, and a table is a loop of `row()` calls, both of which
 * `Pdf`'s page context already offers.
 *
 * Three sections:
 *
 *  1. **A summary page** — the same figures `summary.json` carries (count,
 *     trees/ha, height, crown area, crown diameter, canopy coverage, DBH
 *     attempt rate), the manifest's own rejection counts (§3.5 — "N segments
 *     removed as buildings" is a number a client should be shown, not a
 *     silent filter), and the manifest's `groundTruthNote` verbatim. Leaving
 *     that last one out would make this report claim more than the pipeline
 *     can back up.
 *  2. **Two histograms**, drawn as bars — the height-class distribution and
 *     the crown-area distribution, the two `summary.json` chart series that
 *     arrive pre-binned and are therefore the cheapest to draw honestly (no
 *     binning decision is made in this file).
 *  3. **A paginated inventory table.**
 *
 * ## Why the table is capped, not simply run to completion
 *
 * Ektanagar 1 alone is 26,776 trees. At a legible row height on A4 portrait
 * that is roughly 45 rows a page — around 600 pages, which is not a report
 * anyone opens, it is a CSV wearing a PDF's clothes, and it costs real
 * generation time on every request for a document nobody reads past page 3.
 *
 * So the table is capped at `maxRows` (default 1,500 — about 33 pages: long
 * enough to be a genuine printed inventory, short enough to build and open in
 * under a second), the rows are sorted by height descending so the trees a
 * forestry client is most likely to ask about ("what are the biggest trees on
 * this site") come first, and the cap and the true total are both printed on
 * the page, so "top 1,500 of 26,776 by height" is what the page says, never
 * silently "the inventory". The CSV and SHP exports (`forest-export.mjs`)
 * carry every row that was asked for; this report is a document, not the data.
 */

import { Pdf, PAGE } from "../../../scripts/lib/pdf.mjs";
import { dbhOrGirthLabel } from "./forest-export.mjs";

const INK = [0.18, 0.18, 0.18];
const MUTED = [0.45, 0.45, 0.45];
const ACCENT = [0.851, 0.467, 0.024]; // accent-600, matching the site's own PDF reports
const SIGNAL = [0.761, 0.255, 0.047];
const HAIRLINE = [0.85, 0.84, 0.82];
const PAPER = [0.98, 0.969, 0.949];

const DEFAULT_MAX_ROWS = 1500;
const M = 44; // page margin

function fmtN(n) {
  return typeof n === "number" ? n.toLocaleString("en-IN") : String(n ?? "");
}
function fmtM(v, dp = 2) {
  return typeof v === "number" ? `${v.toFixed(dp)} m` : "n/a";
}
function fmtPct(v, dp = 1) {
  return typeof v === "number" ? `${v.toFixed(dp)}%` : "n/a";
}

function titleBlock(ctx, siteName, sheet, subtitle) {
  const w = ctx.width;
  ctx.rect(0, ctx.height - 76, w, 76, PAPER);
  ctx.line(M, ctx.height - 76, w - M, ctx.height - 76, HAIRLINE, 0.75);
  ctx.text(M, ctx.height - 40, "SUDAAN GEO-ANALYTICS", { size: 11, bold: true, color: ACCENT });
  ctx.text(M, ctx.height - 56, sheet, { size: 17, bold: true, color: INK });
  ctx.textRight(w - M, ctx.height - 40, siteName, { size: 11, bold: true });
  ctx.textRight(w - M, ctx.height - 56, subtitle, { size: 9, color: MUTED });
  return ctx.height - 100;
}

function footer(ctx, note) {
  const today = new Date().toISOString().slice(0, 10);
  ctx.line(M, 52, ctx.width - M, 52, HAIRLINE, 0.75);
  ctx.text(M, 38, note, { size: 7, color: MUTED });
  ctx.textRight(ctx.width - M, 38, `Generated ${today}`, { size: 7, color: MUTED });
}

function wrap(s, cols) {
  const words = String(s).split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > cols) {
      out.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

/**
 * A bar chart from pre-binned `{ label, count }` or `{ binMin, binMax, count }`
 * rows, drawn entirely with `rect`/`line`/`text` — no chart primitive `Pdf`
 * does not already have.
 */
function barChart(ctx, { x, y, w, h }, bins, { title, barColor = ACCENT }) {
  ctx.text(x, y + h + 14, title, { size: 9.5, bold: true, color: INK });
  ctx.line(x, y, x + w, y, HAIRLINE, 0.6);
  ctx.line(x, y, x, y + h, HAIRLINE, 0.6);

  const max = Math.max(1, ...bins.map((b) => b.count));
  const gap = 3;
  const barW = (w - gap * (bins.length - 1)) / bins.length;

  bins.forEach((b, i) => {
    const barH = (b.count / max) * (h - 4);
    const bx = x + i * (barW + gap);
    ctx.rect(bx, y, barW, barH, barColor);
    // Every label would overlap at this bar count, so only every Nth is drawn.
    const label = b.label ?? `${b.binMin.toFixed(1)}`;
    const showEvery = Math.ceil(bins.length / 10);
    if (i % showEvery === 0) {
      ctx.text(bx, y - 10, label, { size: 6, color: MUTED });
    }
  });
  ctx.textRight(x + w, y + h + 14, `n = ${fmtN(bins.reduce((s, b) => s + b.count, 0))}`, {
    size: 8,
    color: MUTED,
  });
}

/**
 * Build the full inventory report.
 *
 * @param {object} args
 * @param {string} args.siteName display name
 * @param {string} args.siteSlug
 * @param {string} args.layer "points" | "crowns" — which layer this report describes
 * @param {object} args.manifest `ForestManifest`, as `forest-source.ts` loads it
 * @param {object} args.summary `ForestSummary`, as `forest-source.ts` loads it
 * @param {object[]} args.trees `crowns.geojson` features, already scoped to the
 *   caller's current filter (never assumed to be the whole survey)
 * @param {number} [args.maxRows] cap on the printed table, see the file header
 * @returns {Buffer}
 */
export function buildForestInventoryReport({
  siteName,
  siteSlug,
  layer = "points",
  manifest,
  summary,
  trees,
  maxRows = DEFAULT_MAX_ROWS,
}) {
  const pdf = new Pdf({ title: `${siteName} forest inventory report` });
  const subtitle = `Forest department — ${layer === "crowns" ? "crown polygons" : "tree points"}`;

  // ---- page 1: summary --------------------------------------------------
  {
    const ctx = pdf.page(PAGE.a4);
    let y = titleBlock(ctx, siteName, "Forest Inventory Report", subtitle);
    const right = ctx.width - M;

    const section = (label) => {
      y -= 10;
      ctx.text(M, y, label.toUpperCase(), { size: 8, bold: true, color: ACCENT });
      y -= 4;
      ctx.line(M, y, right, y, HAIRLINE, 0.6);
      y -= 14;
    };
    const para = (s) => {
      for (const line of wrap(s, 100)) {
        ctx.text(M, y, line, { size: 8.5, color: MUTED });
        y -= 11;
      }
      y -= 4;
    };

    section("Inventory summary");
    y = ctx.row(M, y, right, "Trees detected", fmtN(summary.count));
    y = ctx.row(M, y, right, "Trees per hectare", fmtN(Math.round(summary.treesPerHectare)));
    y = ctx.row(M, y, right, "Height, average", fmtM(summary.height?.avg));
    y = ctx.row(M, y, right, "Height, range", `${fmtM(summary.height?.min)} to ${fmtM(summary.height?.max)}`);
    y = ctx.row(M, y, right, "Crown area, average", `${(summary.crownArea?.avg ?? 0).toFixed(1)} m²`);
    y = ctx.row(
      M, y, right, "Crown area, total covered",
      `${((summary.crownArea?.totalCovered ?? 0) / 10000).toFixed(2)} ha`,
    );
    y = ctx.row(M, y, right, "Crown diameter, average", fmtM(summary.crownDiameter?.avg));
    y = ctx.row(M, y, right, "Canopy coverage", fmtPct(summary.canopyCoveragePct));
    y = ctx.row(
      M, y, right, "DBH reliably measured",
      `${fmtN(summary.dbh?.accepted ?? 0)} of ${fmtN(summary.dbh?.attempted ?? 0)} attempted`,
    );

    section("Detection run");
    y = ctx.row(M, y, right, "Generator", manifest.generator ?? "");
    y = ctx.row(M, y, right, "Generated", (manifest.generatedAt ?? "").slice(0, 10));
    y = ctx.row(M, y, right, "Survey area", `${manifest.surveyAreaHa ?? "?"} ha`);
    y = ctx.row(M, y, right, "Candidate boxes", fmtN(manifest.counts?.candidates ?? 0));
    y = ctx.row(M, y, right, "Accepted as trees", fmtN(manifest.counts?.accepted ?? 0));
    const rejected = manifest.counts?.rejected ?? {};
    for (const [reason, count] of Object.entries(rejected)) {
      if (!count) continue;
      y = ctx.row(M, y, right, `  rejected — ${reason.replace(/_/g, " ")}`, fmtN(count));
    }

    if (manifest.pointCloud && manifest.pointCloud.used === false) {
      section("Point cloud");
      para(manifest.pointCloud.note ?? "No point cloud was used for this run.");
    }

    section("What this report does not claim");
    para(
      manifest.groundTruthNote ??
        "No field-measured tree height, DBH or stem position exists for this survey. Every " +
          "figure here is validated against internal consistency, never against a ground " +
          "measurement.",
    );

    footer(
      ctx,
      "Every figure on this page is read from this survey's own manifest.json and summary.json, " +
        "written once by the forest detection run.",
    );
  }

  // ---- page 2: charts ----------------------------------------------------
  {
    const ctx = pdf.page(PAGE.a4l);
    let y = titleBlock(ctx, siteName, "Forest Inventory Report", "Distributions");
    const chartW = (ctx.width - M * 2 - 40) / 2;
    const chartH = y - 140;
    const chartY = 96;

    const heightBins = summary.charts?.heightClassHistogram ?? [];
    if (heightBins.length) {
      barChart(
        ctx,
        { x: M, y: chartY, w: chartW, h: chartH },
        heightBins,
        { title: "Trees by height class" },
      );
    }

    const areaBins = (summary.charts?.crownAreaDistribution ?? []).map((b) => ({
      ...b,
      label: `${b.binMin.toFixed(0)}`,
    }));
    if (areaBins.length) {
      barChart(
        ctx,
        { x: M + chartW + 40, y: chartY, w: chartW, h: chartH },
        areaBins,
        { title: "Crown area distribution (m² per bin, labelled by bin start)", barColor: SIGNAL },
      );
    }
    void y;

    footer(
      ctx,
      "Height classes and crown-area bins are precomputed in summary.json by the detection run, " +
        "not recomputed here.",
    );
  }

  // ---- page 3+: the inventory table ---------------------------------------
  {
    const total = trees.length;
    const rows = [...trees]
      .map((f) => f.properties ?? {})
      .sort((a, b) => (b.height_m ?? 0) - (a.height_m ?? 0))
      .slice(0, maxRows);

    const columns = [
      { key: "tree_id", label: "Tree ID", w: 76 },
      { key: "height_m", label: "Height (m)", w: 58, fmt: (v) => fmtM(v) },
      { key: "ground_elevation_m", label: "Elevation (m)", w: 68, fmt: (v) => fmtM(v) },
      { key: "crown_area_m2", label: "Crown area (m²)", w: 76, fmt: (v) => (typeof v === "number" ? v.toFixed(1) : "n/a") },
      { key: "crown_diameter_avg_m", label: "Crown diam. (m)", w: 72, fmt: (v) => fmtM(v) },
      { key: "dbh", label: "DBH / girth", w: 108, fmt: (_v, row) => dbhOrGirthLabel(row) },
      { key: "height_class", label: "Height class", w: 58 },
      { key: "confidence", label: "Confidence", w: 56, fmt: (v) => (typeof v === "number" ? v.toFixed(2) : "n/a") },
    ];

    const rowHeight = 11.5;
    let ctx = null;
    let y = 0;
    let pageIndex = 0;
    const tableRight = M + columns.reduce((s, c) => s + c.w, 0);

    const drawHeader = () => {
      ctx.rect(M, y - 2, tableRight - M, rowHeight, PAPER);
      let cx = M + 4;
      for (const col of columns) {
        ctx.text(cx, y, col.label, { size: 7, bold: true, color: INK });
        cx += col.w;
      }
      y -= rowHeight;
      ctx.line(M, y + 3, tableRight, y + 3, HAIRLINE, 0.5);
    };

    const newPage = () => {
      pageIndex += 1;
      ctx = pdf.page(PAGE.a4);
      y = titleBlock(
        ctx,
        siteName,
        "Forest Inventory Report",
        `Inventory table, page ${pageIndex} — top ${fmtN(rows.length)} of ${fmtN(total)} trees by height`,
      );
      drawHeader();
    };

    newPage();
    for (const row of rows) {
      if (y < 70) {
        footer(
          ctx,
          `Sorted by height, descending. Showing ${fmtN(rows.length)} of ${fmtN(total)} trees that ` +
            "matched the current filter — use the CSV or SHP export for the complete set.",
        );
        newPage();
      }
      let cx = M + 4;
      for (const col of columns) {
        const raw = row[col.key];
        const text = col.fmt ? col.fmt(raw, row) : String(raw ?? "n/a");
        ctx.text(cx, y, text.length > 22 ? text.slice(0, 21) + "…" : text, { size: 6.8 });
        cx += col.w;
      }
      y -= rowHeight;
    }
    footer(
      ctx,
      `Sorted by height, descending. Showing ${fmtN(rows.length)} of ${fmtN(total)} trees that ` +
        "matched the current filter — use the CSV or SHP export for the complete set.",
    );
  }

  void siteSlug;
  return pdf.toBuffer();
}
