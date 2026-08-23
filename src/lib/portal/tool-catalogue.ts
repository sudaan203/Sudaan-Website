/**
 * Malhar's forty tools, as he grouped them, in one list.
 *
 * The specification arrived as five Word documents plus a master prompt, and
 * each document is a *discipline*: Universal, Hydrology, Contractor, Mining,
 * Roads. The numbering runs 1..40 across all of them, with gaps where documents
 * were never sent. Until now the portal had no representation of that grouping
 * at all — the map offered a flat row of four measure buttons and a hydrology
 * panel, which is a different shape from the thing that was asked for.
 *
 * This file is the shape. It exists so that:
 *
 *  - the map can present tools the way the client thinks about them, one group
 *    at a time, instead of as a flat list that grows past the edge of a toolbar;
 *  - the gaps are visible as gaps. A tool nobody specified and a tool specified
 *    but not built are different facts, and quoting a dashboard as "40 tools"
 *    when 12 were never described is how a project loses a client's trust;
 *  - `docs/tool-catalogue.md` is generated from it, so the document and the
 *    dashboard cannot drift apart.
 *
 * `spec` is Malhar's own sentence, trimmed but not reworded. Where a tool is
 * partly built, `gap` says what is missing in the terms a surveyor would use,
 * not in the terms of our file layout.
 */

/** The five documents, in the order they were numbered. */
export type ToolGroupKey = "universal" | "contractor" | "mining" | "roads" | "hydrology";

export type ToolStatus =
  /** Usable on the map today by a client, end to end. */
  | "live"
  /** The engine computes it and is tested, but nothing on the map calls it. */
  | "engine-only"
  /** Part of it works; `gap` says which part does not. */
  | "partial"
  /** Specified by Malhar, nothing built. */
  | "not-built"
  /** Numbered in the sequence, but no document ever described it. */
  | "unspecified"
  /** Cannot be built from the data we hold, whatever we do. `blocked` says why. */
  | "blocked";

export type Tool = {
  /** Malhar's number. Stable, and the only durable identifier he uses. */
  n: number;
  group: ToolGroupKey;
  name: string;
  /** His sentence from the docx, trimmed. Empty for the unspecified numbers. */
  spec: string;
  status: ToolStatus;
  /** What is missing, for anything not `live`. */
  gap?: string;
  /** Why it cannot be built yet, for `blocked`. */
  blocked?: string;
};

export type ToolGroup = {
  key: ToolGroupKey;
  /** What the group is called on screen. */
  name: string;
  /** The file it came from, so a question can be traced back to a document. */
  source: string;
  /** One line, for the client, about who this group is for. */
  blurb: string;
  range: string;
};

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    key: "universal",
    name: "Universal",
    source: "1. Universal Tools.docx",
    blurb: "Measurement and comparison every survey needs, whatever the site is for.",
    /*
     * 37 and 40 come from the master prompt rather than from a numbered
     * document, and both are universal in nature: an export centre and a project
     * summary belong to every survey, not to mining or to roads. They are shown
     * here, and the range says so, because a group labelled 1-10 that lists
     * twelve tools is the kind of small dishonesty that makes a client wonder
     * what else does not add up.
     */
    range: "1–10, 37, 40",
  },
  {
    key: "hydrology",
    name: "Hydrology",
    source: "2. Hydrology Tool.docx",
    blurb: "Where water goes, where it collects, and what it would flood.",
    range: "24–28",
  },
  {
    key: "contractor",
    name: "Contractor",
    source: "3. Contractor Tools.docx",
    blurb: "Earthwork against a design surface, and whether it is within tolerance.",
    range: "11–14",
  },
  {
    key: "mining",
    name: "Mining",
    source: "5. Mining Tool.docx",
    blurb: "Stockpiles, benches, highwalls and haul roads.",
    range: "15–18",
  },
  {
    key: "roads",
    name: "Roads",
    source: "4. Road Tool.docx",
    blurb: "Chainage, corridor geometry and sections along an alignment.",
    range: "19–21",
  },
] as const;

/**
 * Numbers Malhar used but never described.
 *
 * These are not "to do". Nobody has said what they are. They are listed so the
 * count of forty is honest and so the question can be asked once, with the
 * numbers in hand, rather than guessed at tool by tool.
 */
export const UNSPECIFIED = [22, 23, 29, 30, 31, 32, 33, 34, 35, 36, 38, 39] as const;

export const TOOLS: readonly Tool[] = [
  // ---- Universal, 1-10 ---------------------------------------------------
  {
    n: 1,
    group: "universal",
    name: "Spot Level",
    spec: "Displays X, Y and Z when the user clicks anywhere on the DTM/DSM, with options to copy coordinates or export the selected points as CSV.",
    status: "live",
  },
  {
    n: 2,
    group: "universal",
    name: "Grid Spot Levels",
    spec: "Select a polygon and grid spacing (0.5 m, 1 m, 2 m, 5 m), generate spot levels from the DTM, export as CSV, DXF, TXT or LandXML, like Global Mapper.",
    status: "live",
  },
  {
    n: 3,
    group: "universal",
    name: "Cross Section",
    spec: "Draw a line across the map, get an elevation profile with distance, slope and elevation statistics, plus PDF and CSV export.",
    status: "partial",
    gap: "The profile is live and correct. PDF export is not built; CSV is written in the browser rather than by the server.",
  },
  {
    n: 4,
    group: "universal",
    name: "Cut & Fill",
    spec: "Select an area of interest, compare two surfaces (existing vs design, or previous vs current DTM), and calculate cut, fill and net volume with report export.",
    status: "partial",
    gap: "Volumes against a level, a best-fit plane and the survey's own minimum are live. Comparing against an uploaded design surface is tool 12, and the report export is tool 10.",
  },
  {
    n: 5,
    group: "universal",
    name: "Surface Comparison",
    spec: "Highlight elevation differences between two DSM/DTM datasets with a colour-coded deviation map and statistical summary.",
    status: "live",
    gap: "Deviation statistics over a drawn polygon, and a colour-coded map layer on a diverging ramp centred on zero. Comparing two *dates* rather than the two models needs tool 6's second flight.",
  },
  {
    n: 6,
    group: "universal",
    name: "Timeline Comparison",
    spec: "Compare drone surveys captured on different dates using a slider or swipe comparison.",
    status: "blocked",
    blocked: "No site in the portal has been flown twice. This is a data question, not a code question: one repeat flight makes it buildable, and nothing before then does.",
  },
  {
    n: 7,
    group: "universal",
    name: "Annotation",
    spec: "Add pins, notes, arrows and issue markers on the map, save them, and share them with project members.",
    status: "not-built",
    gap: "Malhar contradicts himself: the docx specifies it, and Important Notes.txt lists it under \"Not needed for future\". Needs one answer before it is worth building, because it is the only tool here that needs a write path and a permissions model.",
  },
  {
    n: 8,
    group: "universal",
    name: "Bookmark Locations",
    spec: "Save important map locations with custom names and navigate back to them quickly.",
    status: "not-built",
  },
  {
    n: 9,
    group: "universal",
    name: "Share View",
    spec: "Generate a unique URL preserving the current map extent, visible layers, measurements and annotations.",
    status: "not-built",
    gap: "Needs a decision first: a URL that reproduces a client's site view is a URL that shows their data to whoever holds it. Either it stays inside the session, or it is a signed, expiring link.",
  },
  {
    n: 10,
    group: "universal",
    name: "Export Centre",
    spec: "Export ortho, DSM, DTM, contours, profiles, point clouds, PDFs, CSV, DXF, LAS/LAZ and LandXML.",
    status: "partial",
    gap: "Grid levels export as CSV, TXT, DXF (with a .prj sidecar) and LandXML from the map. Spot levels export as CSV. There is no single download centre, and no PDF, ortho, raster or point cloud export.",
  },

  // ---- Contractor, 11-14 -------------------------------------------------
  {
    n: 11,
    group: "contractor",
    name: "Earthwork Progress",
    spec: "Compare multiple surveys over time, showing excavation, filling and completion percentages.",
    status: "engine-only",
    gap: "`earthworkProgress` takes a list of surfaces and is tested. It has one survey to run on, so it is blocked on the same repeat flight as tool 6.",
  },
  {
    n: 12,
    group: "contractor",
    name: "Design Surface Check",
    spec: "Compare uploaded LandXML/TIN/Civil3D surfaces against the current DTM and highlight deviations.",
    status: "not-built",
    gap: "Cut & fill already accepts a reference surface, so the comparison half exists. Reading a LandXML or TIN upload and turning it into a grid does not.",
  },
  {
    n: 13,
    group: "contractor",
    name: "Tolerance Analysis",
    spec: "Colour-code areas within and outside a user-defined elevation tolerance (e.g. ±20 mm).",
    status: "partial",
    gap: "Checks a drawn area against the other model or a stated design level, and refuses to assess a tolerance finer than the survey's own accuracy. Checking against an *uploaded* design surface is tool 12.",
  },
  {
    n: 14,
    group: "contractor",
    name: "Slope Heatmap",
    spec: "Colour-coded slope map with customisable slope ranges and export options.",
    status: "partial",
    gap: "The slope layer draws on the map and the analysis engine classifies into bands. The three documents give three different band schemes (see the catalogue note), so no one scheme is presented as the answer.",
  },

  // ---- Mining, 15-18 -----------------------------------------------------
  {
    n: 15,
    group: "mining",
    name: "Stockpile Volume",
    spec: "Select or automatically detect stockpiles and instantly calculate volume, base area and height.",
    status: "partial",
    gap: "Selecting a pile and getting its volume, base area and height is live. Automatic detection is not built.",
  },
  {
    n: 16,
    group: "mining",
    name: "Bench Analysis",
    spec: "Measure bench width, bench height and slope angle across mining benches.",
    status: "live",
    gap: "Reads a drawn line as alternating flats and faces. A measurement of the ground, not of the mine plan: pointed at a natural slope it reports terraces as benches, and says so.",
  },
  {
    n: 17,
    group: "mining",
    name: "Highwall Stability",
    spec: "Identify steep slopes exceeding safe design limits and highlight potential instability zones.",
    status: "engine-only",
    gap: "`steepSlopeZones` returns the zones above a limit. The limit itself is a geotechnical number nobody has given us, and defaulting it would be inventing a safety threshold.",
  },
  {
    n: 18,
    group: "mining",
    name: "Haul Road Analysis",
    spec: "Calculate road width, gradient and crossfall, and identify unsafe road sections.",
    status: "live",
    gap: "Delivered by tool 20 on the same drawn line: width, gradient and crossfall, with stations flagged above the grade and crossfall limits you set. Those limits are yours, not a standard.",
  },

  // ---- Roads, 19-21 ------------------------------------------------------
  {
    n: 19,
    group: "roads",
    name: "Chainage",
    spec: "Generate chainage markers along a road alignment with elevation and profile data at each station.",
    status: "live",
  },
  {
    n: 20,
    group: "roads",
    name: "Corridor Analysis",
    spec: "Measure road width, shoulders, median and longitudinal slope along the selected alignment.",
    status: "partial",
    gap: "Width, longitudinal grade and crossfall are live, with stations flagged against limits you set. Shoulders and median are not separated from the carriageway: that needs edge detection, not a terrain model.",
  },
  {
    n: 21,
    group: "roads",
    name: "Automatic Cross Sections",
    spec: "Generate cross-sections at fixed intervals (5 m, 10 m, 20 m) along a selected alignment.",
    status: "partial",
    gap: "Sections are cut at 5, 10, 20 or 25 m and drawn on the map as the ticks they were taken along. The PDF sheet Important Notes.txt asks for (\"cross sections every 10 m, export PDF as AutoCAD\") is tool 10's job and is not built.",
  },

  // ---- Hydrology, 24-28 --------------------------------------------------
  {
    n: 24,
    group: "hydrology",
    name: "Flow Direction",
    spec: "Calculate and visualise water flow direction from the DTM using directional arrows.",
    status: "partial",
    gap: "D8 flow direction is computed, validated against SAGA, and readable by clicking any point. It is drawn as a grid, not yet as arrows.",
  },
  {
    n: 25,
    group: "hydrology",
    name: "Flow Accumulation",
    spec: "Identify natural drainage paths and stream networks from the terrain model.",
    status: "live",
  },
  {
    n: 26,
    group: "hydrology",
    name: "Watershed Delineation",
    spec: "Click any point and generate the upstream catchment boundary.",
    status: "live",
  },
  {
    n: 27,
    group: "hydrology",
    name: "Sink Detection",
    spec: "Automatically identify terrain depressions where water may accumulate.",
    status: "live",
  },
  {
    n: 28,
    group: "hydrology",
    name: "Flood Simulation",
    spec: "Set water levels (+1 m, +2 m, +5 m) and visualise inundation areas and estimated storage volume.",
    status: "live",
  },
] as const;

/**
 * The second hydrology prompt asks for sixteen named layers, which is a longer
 * list than tools 24-28. Kept separate because it is a different kind of
 * request: not five tools but one module with sixteen outputs, each with its own
 * toggle, transparency and legend.
 */
export type HydrologyLayerSpec = {
  name: string;
  status: ToolStatus;
  note?: string;
};

export const HYDROLOGY_LAYERS: readonly HydrologyLayerSpec[] = [
  { name: "Sink filling", status: "live" },
  { name: "Flow direction", status: "live" },
  { name: "Flow accumulation", status: "live" },
  { name: "Stream network", status: "live" },
  { name: "Stream order", status: "live" },
  { name: "Watershed boundaries", status: "live" },
  { name: "Slope", status: "live" },
  {
    name: "Aspect",
    status: "engine-only",
    note: "Computed for hillshade already; never surfaced as its own layer.",
  },
  {
    name: "Drainage pattern",
    status: "not-built",
    note: "Classifying a network as dendritic, trellis or radial is a shape judgement, not a raster operation.",
  },
  { name: "Water accumulation zones", status: "live", note: "Served as sink detection." },
  { name: "Flood inundation simulation", status: "live" },
  {
    name: "Runoff paths",
    status: "partial",
    note: "The flow network is the runoff path. A per-storm runoff volume needs rainfall, which nobody has supplied.",
  },
  {
    name: "Check dam locations",
    status: "blocked",
    note: "Needs the suitability model: weights, land use, soil, rainfall. Guessing them produces a confident wrong map, which is worse than no map.",
  },
  { name: "Farm pond locations", status: "blocked", note: "Same suitability model." },
  { name: "Recharge structures", status: "blocked", note: "Same suitability model." },
  { name: "Reservoir suitability", status: "blocked", note: "Same suitability model." },
] as const;

/** Cross-document tools the master prompt adds outside the five groups. */
export const STANDALONE: readonly Tool[] = [
  {
    n: 37,
    group: "universal",
    name: "CAD Export",
    spec: "Export supporting DXF, LandXML, SHP, GeoJSON, CSV and LAS/LAZ for CAD and GIS workflows.",
    status: "partial",
    gap: "DXF, LandXML, CSV and TXT are written from the map, each stating its projection. SHP and LAS/LAZ are not written at all; GeoJSON exists only for hydrology vectors. Overlaps tool 10.",
  },
  {
    n: 40,
    group: "universal",
    name: "Dashboard Summary",
    spec: "A project summary panel showing survey area, highest and lowest elevation, average slope, contour interval, point density, stockpile count, cut/fill volume and survey date.",
    status: "live",
    gap: "On the site overview, with every figure naming where it came from. Stockpile count and cut/fill volume have no site-wide answer — both depend on an area you draw — so they name the tool that measures them rather than showing a number.",
  },
] as const;

export const ALL_TOOLS: readonly Tool[] = [...TOOLS, ...STANDALONE];

export function toolsIn(group: ToolGroupKey): Tool[] {
  return ALL_TOOLS.filter((t) => t.group === group).sort((a, b) => a.n - b.n);
}

/** Whether a client can actually reach this tool on the map right now. */
export function isUsable(status: ToolStatus): boolean {
  return status === "live" || status === "partial";
}

export function countBy(status: ToolStatus): number {
  return ALL_TOOLS.filter((t) => t.status === status).length;
}
