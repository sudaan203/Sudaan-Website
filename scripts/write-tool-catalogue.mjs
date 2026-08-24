/**
 * Write docs/tool-catalogue.md from src/lib/portal/tool-catalogue.ts.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/write-tool-catalogue.mjs
 *
 * Generated rather than written, because the same list drives the tool rail on
 * the map. A document that says a tool is live while the dashboard shows it
 * disabled is worse than no document: it is the kind of thing a client notices
 * in a meeting.
 *
 * Run this after changing the catalogue. It is checked by
 * `--check`, which fails if the file on disk has drifted.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/*
 * The catalogue is TypeScript, and this is a plain Node script. Rather than add
 * a build step, it is transpiled to a temporary module with the TypeScript
 * compiler that is already a dependency — the file is types and data, so nothing
 * survives the transpile but the arrays.
 */
const dir = mkdtempSync(path.join(tmpdir(), "catalogue-"));
execFileSync(
  "npx",
  [
    "tsc",
    "src/lib/portal/tool-catalogue.ts",
    "--outDir", dir,
    "--module", "es2022",
    "--target", "es2022",
    "--moduleResolution", "bundler",
  ],
  { stdio: "inherit" },
);
const {
  TOOL_GROUPS,
  ALL_TOOLS,
  HYDROLOGY_LAYERS,
  UNSPECIFIED,
  toolsIn,
} = await import(path.join(dir, "tool-catalogue.js"));

const STATUS_LABEL = {
  live: "Live",
  partial: "Partly built",
  "engine-only": "Engine only",
  "not-built": "Not built",
  unspecified: "Never specified",
  blocked: "Blocked",
};

const lines = [];
const w = (s = "") => lines.push(s);

w("# The forty tools, as Malhar grouped them");
w();
w("*Generated from `src/lib/portal/tool-catalogue.ts` by");
w("`scripts/write-tool-catalogue.mjs`. Do not edit by hand: the same list drives");
w("the tool rail on the survey map, and a document that disagrees with the");
w("dashboard is worse than none.*");
w();
w("The specification arrived as five Word documents plus a master prompt. Each");
w("document is a discipline, and the numbering runs 1..40 across all of them with");
w("gaps where documents were never sent. The map now presents them the same way:");
w("one group at a time, every tool shown, and the ones that are not usable shown");
w("disabled with a line saying what they are waiting on.");
w();

const count = (s) => ALL_TOOLS.filter((t) => t.status === s).length;
w("## Where it stands");
w();
w("| | Tools |");
w("|---|---|");
for (const key of ["live", "partial", "engine-only", "not-built", "blocked"]) {
  const which = ALL_TOOLS.filter((t) => t.status === key);
  if (which.length === 0) continue;
  w(`| **${STATUS_LABEL[key]}** | ${which.length} — ${which.map((t) => t.n).join(", ")} |`);
}
w(`| **Never specified** | ${UNSPECIFIED.length} — ${UNSPECIFIED.join(", ")} |`);
w();
w(
  `Of the forty numbers Malhar used, **${UNSPECIFIED.length} were never described**. ` +
    "They are listed rather than quietly dropped, so the count of forty is honest " +
    "and the question can be asked once with the numbers in hand.",
);
w();
w("**Live** means a client can use it on the map today. **Engine only** means the");
w("calculation is written and tested and nothing calls it — usually because there");
w("is no way to draw its input yet. **Blocked** means it cannot be built from what");
w("we hold, whatever we do, and says why.");
w();

for (const group of TOOL_GROUPS) {
  w(`## ${group.name} (${group.range})`);
  w();
  w(`*${group.source}* — ${group.blurb}`);
  w();
  w("| # | Tool | Status | |");
  w("|---|---|---|---|");
  for (const tool of toolsIn(group.key)) {
    const note = tool.gap ?? tool.blocked ?? "";
    w(`| ${tool.n} | **${tool.name}** | ${STATUS_LABEL[tool.status]} | ${note} |`);
  }
  w();
  for (const tool of toolsIn(group.key)) {
    w(`> **${tool.n}. ${tool.name}** — ${tool.spec}`);
    w(">");
  }
  lines.pop();
  w();
}

w("## The hydrology module's sixteen layers");
w();
w("The second hydrology prompt asks for a module with sixteen named outputs,");
w("which is a different request from tools 24 to 28: not five tools but one");
w("module, each layer with its own toggle, transparency and legend.");
w();
w("| Layer | Status | |");
w("|---|---|---|");
for (const layer of HYDROLOGY_LAYERS) {
  w(`| ${layer.name} | ${STATUS_LABEL[layer.status]} | ${layer.note ?? ""} |`);
}
w();
w("Four of the sixteen — check dams, farm ponds, recharge structures and");
w("reservoir suitability — are one question, not four: they all need the");
w("suitability model. Weights, land use, soil and rainfall have not been");
w("supplied, and inventing them would produce a confident wrong map, which is a");
w("worse outcome for this client than no map.");
w();

w("## What is not in the numbering");
w();
w("Two things Malhar specified in prose rather than as numbered tools, both now");
w("on the map at the end of their group:");
w();
w("- **Area**, item 4 of `Important Notes.txt`: \"polygon, rectangle, polyline,");
w("  circle → area and perimeter with avg/max/min elevation\".");
w("- **Inspect**, from the hydrology prompt: \"clicking any location on the map");
w("  should display detailed statistics such as elevation, slope, flow");
w("  accumulation, watershed area\". Deliberately not wired to tool 24: flow");
w("  direction is one of the things it reports, but 24 asks for arrows drawn");
w("  across the terrain, and letting a general point query stand in for that");
w("  would mark a tool delivered that is not.");
w();
w("And one deliverable the numbering never mentions but `Important Notes.txt`");
w("lists under Layers:");
w();
w("- **Point cloud.** Aektanagar's LiDAR — 50,183,644 points in a 1.7 GB LAS —");
w("  is served as a quadtree of streamable nodes and drawn in the survey map");
w("  itself. Colour by RGB, height or ASPRS class; classes filterable; detail");
w("  budgeted so a weak laptop can still pan. See `docs/tools.md`.");
w();
w("And one tool from a request that arrived after the original five documents,");
w("Malhar's own prompt in full:");
w();
w('> Add a simple Shapefile tool to my existing GIS dashboard. Create: draw');
w('> Point, Line or Polygon on the map and save as a shapefile. Download: a');
w('> valid .zip containing .shp, .shx, .dbf and .prj. Upload: a shapefile .zip,');
w('> displayed automatically on the map. Do not modify the existing');
w('> dashboard/map design, only add these functions.');
w();
w("- **Shapefile.** Draw or import Point, Line and Polygon features, export a");
w("  real ESRI Shapefile — hand-written to the binary spec, not GeoJSON with a");
w("  different extension — and import one from another package to compare");
w("  against this survey. Verified against an independent Python library, not");
w("  only against itself. See `docs/tools.md`.");
w();

w("## Still on Malhar");
w();
w("- The twelve unspecified numbers above.");
w("- The suitability model, for four of the sixteen hydrology layers.");
w("- Which slope scheme. Three documents give three, one of them in percent:");
w("  `Important Notes.txt` says 0–5 / 5–15 / 15–25 / 25%+, the hydrology legend");
w("  says 0–3° / 3–8° / 8–15° / >15°, and tool 14 says \"customisable\". No one");
w("  scheme is presented as the answer until someone says which it is.");
w("- The annotation contradiction: tool 7 specifies it, `Important Notes.txt`");
w("  lists it under \"Not needed for future\".");
w("- Whether \"±4\" is centimetres or millimetres, and absolute or relative.");
w("- A second flight of any site. Tools 6 and 11 cannot be built without one, and");
w("  no amount of code substitutes for it.");
w();

writeFileSync("docs/tool-catalogue.md", lines.join("\n"));

if (process.argv.includes("--check")) {
  const onDisk = readFileSync("docs/tool-catalogue.md", "utf8");
  if (onDisk !== lines.join("\n")) {
    console.error("docs/tool-catalogue.md is out of date; regenerate it");
    process.exit(1);
  }
  console.log("docs/tool-catalogue.md is up to date");
} else {
  console.log(`wrote docs/tool-catalogue.md (${lines.length} lines)`);
}
