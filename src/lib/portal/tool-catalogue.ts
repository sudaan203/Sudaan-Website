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
 *
 * ## Forest is a sixth department with its own numbering
 *
 * `docs/forest-tools-plan.md` §2.1 decided this deliberately: the master
 * sequence runs 1..40 with twelve numbers (22, 23, 29-36, 38, 39) that were
 * never described, reserved for documents that may still arrive. Forest's own
 * PDF numbers its sixteen sections 1..16, and giving Forest a slice of the
 * master's unused numbers would both overstate how much of "forty" is real and
 * collide the day a sixth master document turns up describing 29.
 *
 * So Forest tools are displayed **F1-F16** (`Tool.ref`) and stored internally as
 * `n: 101..116` — a unique integer is still required across `ALL_TOOLS` because
 * `ACTIONS`/`toolAction(n)` in `ToolRail.tsx` key on it — and `countBy` takes an
 * explicit scope so a caller can report "forty master tools" and "sixteen forest
 * tools" as two honest specifications rather than one dishonest fifty-six.
 */

/** The five master documents, in the order they were numbered, plus Forest. */
export type ToolGroupKey =
  | "universal"
  | "contractor"
  | "mining"
  | "roads"
  | "hydrology"
  | "forest";

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
  /**
   * A unique integer across `ALL_TOOLS`, which `ACTIONS`/`toolAction(n)` in
   * `ToolRail.tsx` key on. For the master documents this is Malhar's own number
   * and the only durable identifier he uses. Forest tools are not his — they use
   * `101..116` internally, per `docs/forest-tools-plan.md` §2.1, precisely so
   * they never collide with a master number he might still assign.
   */
  n: number;
  group: ToolGroupKey;
  name: string;
  /**
   * The label shown on screen, when it differs from `n`. Forest tools set this
   * to "F1".."F16" — the sixteen-item numbering their own PDF uses — so a client
   * never sees the internal 101..116 that exists only to keep `n` unique.
   * Unset for every master tool, which displays its own `n` directly.
   */
  ref?: string;
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
  /**
   * How this group's tools are numbered, shown beside its name. For the five
   * master groups this is a slice of Malhar's 1..40 sequence, e.g. "1-10, 37,
   * 40". Forest is not a slice of that sequence at all — it is "F1-F16", its own
   * document's own numbering — and giving the two the same field name here
   * rather than inventing a parallel one is what makes `write-tool-catalogue.mjs`
   * able to print either without a special case.
   */
  numbering: string;
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
    numbering: "1–10, 37, 40",
  },
  {
    key: "hydrology",
    name: "Hydrology",
    source: "2. Hydrology Tool.docx",
    blurb: "Where water goes, where it collects, and what it would flood.",
    numbering: "24–28",
  },
  {
    key: "contractor",
    name: "Contractor",
    source: "3. Contractor Tools.docx",
    blurb: "Earthwork against a design surface, and whether it is within tolerance.",
    numbering: "11–14",
  },
  {
    key: "mining",
    name: "Mining",
    source: "5. Mining Tool.docx",
    blurb: "Stockpiles, benches, highwalls and haul roads.",
    numbering: "15–18",
  },
  {
    key: "roads",
    name: "Roads",
    source: "4. Road Tool.docx",
    blurb: "Chainage, corridor geometry and sections along an alignment.",
    numbering: "19–21",
  },
  {
    key: "forest",
    name: "Forest",
    source: "2. Forest Tree Detection and Inventory Dashboard.pdf",
    blurb:
      "Individual-tree detection, height, crown and inventory statistics, built from " +
      "LiDAR point cloud, DSM, DTM and the orthomosaic.",
    numbering: "F1–F16",
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

/**
 * Forest's sixteen tools, F1-F16, one per section of its PDF.
 *
 * `spec` is trimmed from `reference/2. Forest Tree Detection and Inventory
 * Dashboard.pdf`, read directly rather than paraphrased from memory.
 *
 * Scoped to `aektanagar-survey` ("Ektanagar 1") only, per Malhar's own answer
 * that no other survey was intended (docs/forest-tools-plan.md §0.1). Every
 * status below describes what is true for that one survey, not a general
 * claim about the forest engine — a second survey with its own point cloud
 * could turn several `blocked`/`partial` entries here `live` without a line of
 * code changing, because the gap is the data, not the pipeline.
 *
 * Two things recur across several gaps and are recorded once, here, rather
 * than in each entry:
 *
 *  - Malhar asked for detection from the orthomosaic by image segmentation
 *    (DeepForest) rather than the LiDAR local-maxima/watershed the PDF's own
 *    diagram assumes. That is not a shortfall against the spec, it is what
 *    was asked for instead of it — see §0.2 of the plan for why the other two
 *    named options (YOLOv8-seg, the QGIS plugins) were not the ones actually
 *    used.
 *  - The original 1.71 GB LAS for this survey is unrecoverable — absent from
 *    local disk and from R2's archive prefix, confirmed by a direct signed
 *    listing rather than assumed. Every attribute that can only come from a
 *    point cloud (point density, return porosity, DBH) is honestly blocked by
 *    that, not by anything unbuilt.
 */
export const FOREST_TOOLS: readonly Tool[] = [
  {
    n: 101,
    ref: "F1",
    group: "forest",
    name: "Tree Detection & Point Feature Extraction",
    spec:
      "Automatically detect individual trees from the LiDAR point cloud and elevation " +
      "surfaces. For every tree, create a point feature storing tree ID, latitude, " +
      "longitude, tree-top and ground elevation, tree height, crown diameter, crown " +
      "area, crown perimeter where technically possible, point density and a detection " +
      "confidence score. Display every tree as a clickable point; clicking opens a " +
      "popup with every attribute.",
    status: "partial",
    gap: "Live for every attribute except point density, which needs the source LiDAR point cloud. That file is unrecoverable for this survey (absent from both local disk and R2's archive prefix, confirmed by a direct listing) — the attribute is honestly omitted rather than backfilled from the portal's decimated quadtree, which would understate it.",
  },
  {
    n: 102,
    ref: "F2",
    group: "forest",
    name: "Tree Height Calculation",
    spec:
      "Calculate tree height as tree-top elevation minus DTM ground elevation, using " +
      "the DTM as ground reference and the LiDAR point cloud/DSM to identify the " +
      "canopy — never raw elevation alone. Where possible, generate a Canopy Height " +
      "Model (CHM = DSM − DTM) and use it with the point cloud for detection.",
    status: "live",
  },
  {
    n: 103,
    ref: "F3",
    group: "forest",
    name: "Individual Tree Segmentation",
    spec:
      "Segment individual tree crowns using local maximum/local maxima detection, CHM " +
      "analysis, watershed segmentation, point-cloud clustering and crown boundary " +
      "extraction, adapting to the available point density and forest structure so " +
      "that one tree does not register as several.",
    status: "partial",
    gap: "Segmentation is CHM-threshold-and-connected-component within each detected box, not literally local-maxima/watershed as specified — the seed step is DeepForest's own box detection from the orthomosaic, per Malhar's instruction (docs/forest-tools-plan.md §0.2), not a maxima search over the point cloud. Verified in testing to keep touching, differently-sized crowns separate, but it is a different algorithm from the one named in the spec, not the same one relabeled.",
  },
  {
    n: 104,
    ref: "F4",
    group: "forest",
    name: "Height-Based Tree Classification",
    spec:
      "Interactive filtering and classification by detected tree height, with ten " +
      "default classes from 0–2 m to >15 m. Let the user change class intervals, " +
      "add/remove classes, define custom ranges, enable/disable individual classes and " +
      "display each separately on the map, with the tree count updating live as a " +
      "height filter is applied.",
    status: "live",
  },
  {
    n: 105,
    ref: "F5",
    group: "forest",
    name: "Crown Area & Crown Diameter",
    spec:
      "Estimate the horizontal crown extent from the canopy points/CHM: crown area, " +
      "crown perimeter, maximum crown diameter, minimum crown diameter and average " +
      "crown diameter. Where the boundary is reliable, store an individual crown " +
      "polygon as its own GIS feature.",
    status: "live",
  },
  {
    n: 106,
    ref: "F6",
    group: "forest",
    name: "Tree Girth / DBH",
    spec:
      "Attempt tree girth only where the point cloud gives sufficient information " +
      "around the stem. Where it does not, mark the attribute 'Not reliably " +
      "detectable' rather than generating a false value. Where an estimate is " +
      "possible, store estimated DBH, estimated girth (= π × DBH) and a DBH " +
      "confidence score, clearly labelled as estimated.",
    status: "blocked",
    blocked: "The estimator itself is complete and tested — a Taubin circle fit gated on at least 12 stem-band points spanning at least 180° before it will even attempt a fit, refusing rather than guessing otherwise — but it needs the source LiDAR point cloud, which is unrecoverable for this survey (absent from local disk and from R2's archive prefix, confirmed by a direct listing). Zero attempts were possible in the actual run, not zero successes; it would run today if the original delivery is found.",
  },
  {
    n: 107,
    ref: "F7",
    group: "forest",
    name: "Forest Visualization",
    spec:
      "A GIS map interface showing orthomosaic/RGB imagery, DSM, DTM, CHM, the LiDAR " +
      "point cloud, individual tree points, individual crown polygons and height-class " +
      "layers, each independently switchable, with trees styled by graduated symbols " +
      "or height-based colour.",
    status: "live",
    gap: "The point cloud is viewable through the portal's existing point-cloud tool rather than as a toggle inside the Forest tab specifically.",
  },
  {
    n: 108,
    ref: "F8",
    group: "forest",
    name: "Tree Attribute Popup",
    spec:
      "Clicking a tree opens a panel with tree ID, latitude, longitude, ground " +
      "elevation, tree-top elevation, tree height, crown area, crown diameter, crown " +
      "perimeter, estimated DBH/girth or 'Not Available', height class, point density " +
      "and detection confidence.",
    status: "partial",
    gap: "Live for every attribute except point density, unavailable for the same reason as F1 — the source point cloud is unrecoverable for this survey. Goes beyond spec with a per-component confidence breakdown (see F13) so a low score is explained, not just shown.",
  },
  {
    n: 109,
    ref: "F9",
    group: "forest",
    name: "Interactive Filtering",
    spec:
      "A dedicated tree filter panel: filter by tree height, crown area, crown " +
      "diameter, elevation, detection confidence, tree ID and a custom height range, " +
      "plus quick class filters, with the map immediately showing only the matching " +
      "trees.",
    status: "live",
  },
  {
    n: 110,
    ref: "F10",
    group: "forest",
    name: "Forest Statistics Dashboard",
    spec:
      "Summary cards for total detected trees, trees per hectare, average/maximum/" +
      "minimum tree height, average crown area, total crown-covered area, average and " +
      "maximum crown diameter and percentage of area covered by canopy. Charts for " +
      "trees by height class, tree density by hectare, crown-area distribution, tree-" +
      "height distribution and elevation vs tree height.",
    status: "live",
    gap: "Leads with a confidence callout (median, max, histogram) before the summary cards, and shows the raw candidate count beside the confidence-filtered count rather than only one — neither is in the spec, both exist because the raw count alone would misrepresent this survey's first-pass detections (docs/forest-validation-2026-09-19.md).",
  },
  {
    n: 111,
    ref: "F11",
    group: "forest",
    name: "Spatial Analysis",
    spec:
      "Generate a tree density map, canopy density map, height-class map, crown-area " +
      "map, individual tree inventory and forest structure map. Provide optional grid-" +
      "based analysis at 10 m/25 m/50 m, reporting per cell: number of trees, trees/" +
      "hectare, average and maximum tree height, average crown area and canopy " +
      "coverage %.",
    status: "not-built",
    gap: "The density, canopy, height-class and crown-area maps can all be derived from trees.bin/crowns.geojson, which already carry everything each one needs, but no grid-cell (10/25/50 m) aggregation or a dedicated map-generation surface has been built yet.",
  },
  {
    n: 112,
    ref: "F12",
    group: "forest",
    name: "Export Functions",
    spec:
      "Export detected tree information as Shapefile, GeoJSON, GeoPackage, CSV and " +
      "KML/KMZ, for both a tree point layer (ID, latitude, longitude, elevation, " +
      "height, crown area, crown diameter, DBH/girth where available, height class, " +
      "confidence) and a crown polygon layer (ID, crown area, crown diameter, height, " +
      "height class), plus a PDF forest inventory report with maps, statistics, " +
      "charts and the tree inventory table.",
    status: "partial",
    gap: "Shapefile, GeoJSON, CSV, KML/KMZ and a row-capped PDF inventory report are live for both the tree-point and crown-polygon layers, each stating its own projection. GeoPackage is not built — scoped as a question for Malhar (docs/forest-tools-plan.md §7): it is one line of spec against several days of work for a dependency this codebase does not otherwise need, and QGIS/Global Mapper both already read every format that is live.",
  },
  {
    n: 113,
    ref: "F13",
    group: "forest",
    name: "Data Quality & Confidence",
    spec:
      "Clearly distinguish measured/directly detected values from estimated values; " +
      "never create artificial or unreliable attributes. For every tree, a confidence " +
      "score from LiDAR point density, canopy separation, tree-top prominence, crown " +
      "segmentation quality and availability of RGB/orthomosaic data. Flag low-" +
      "confidence trees for manual review.",
    status: "partial",
    gap: "Live for four of the five named inputs (canopy separation, tree-top prominence, crown segmentation quality and RGB availability) plus a sixth the spec did not name — the detector's own model score — folded in as a component, not collapsed into the total. LiDAR point density is absent for the reason given in F1/F6. \"Flag for manual review\" is honoured by defaulting the whole map to confidence ≥ 0.40 rather than a separate flag field, since every tree in this survey's first pass sits at or below that line (median 0.317, none at or above 0.6) and a flag on almost everything would not read as a flag.",
  },
  {
    n: 114,
    ref: "F14",
    group: "forest",
    name: "Manual Editing",
    spec:
      "Add a tree manually, delete an incorrectly detected tree, move a tree point, " +
      "split incorrectly merged trees, merge duplicate detections, edit tree " +
      "attributes, edit the crown boundary and recalculate crown statistics.",
    status: "partial",
    gap: "The write path is complete and tested: a tree_edits table, a tenancy-scoped API for all eight operations, and re-basing against a re-run by each edit's own stored anchor position rather than by tree id, because the id is a one-way hash and cannot be searched from. No UI exists yet to trigger any of it from the map — it is reachable only by calling the API directly.",
  },
  {
    n: 115,
    ref: "F15",
    group: "forest",
    name: "Forest Area Optimization",
    spec:
      "Optimise the workflow for large, hilly forest datasets. Use the LiDAR point " +
      "cloud as the primary source for individual-tree detection, with DTM as ground " +
      "reference, DSM as surface/canopy reference, CHM for height/canopy analysis and " +
      "the orthomosaic for visual verification. Process large datasets efficiently " +
      "using spatial tiling/chunking where required.",
    status: "partial",
    gap: "The detector tiles the orthomosaic with a halo and cross-tile deduplication, proven on this survey's full 27,521×27,199 px image — a tree on a tile boundary appears exactly once. The JS engine that turns candidates into an inventory does not yet tile: Ektanagar 1's ~4M analysis cells fit in memory whole, so it was never forced to. The same halo principle (docs/forest-tools-plan.md §2.4) is designed to extend to it once a survey needs it.",
  },
  {
    n: 116,
    ref: "F16",
    group: "forest",
    name: "Important Technical Principle",
    spec:
      "Do not classify every elevated LiDAR point as a tree. Run the full pipeline: " +
      "ground/non-ground classification → DSM + DTM → CHM → local tree-top detection " +
      "→ individual tree segmentation → crown extraction → tree attribute calculation " +
      "→ height classification → GIS visualization, ending in an interactive, " +
      "individual-tree forest inventory map.",
    status: "partial",
    gap: "The detection stage in this diagram — ground/non-ground classification into local tree-top detection — was replaced by detecting from the orthomosaic instead, per Malhar's own instruction (docs/forest-tools-plan.md §0.2). The principle the diagram protects — never call every elevated point a tree — is honoured all the same: six rejection discriminators plus the detector's own confidence score sit between every raw candidate and the inventory, and a visual check against the real orthomosaic (docs/forest-validation-2026-09-19.md) confirmed they remove 82–86% of the false positives found on bare ground and rooftops.",
  },
] as const;

/** Every tool from the five master documents — the "forty tools" specification. */
export const MASTER_TOOLS: readonly Tool[] = [...TOOLS, ...STANDALONE];

/** Every tool from every document, master and Forest together. */
export const ALL_TOOLS: readonly Tool[] = [...MASTER_TOOLS, ...FOREST_TOOLS];

export function toolsIn(group: ToolGroupKey): Tool[] {
  return ALL_TOOLS.filter((t) => t.group === group).sort((a, b) => a.n - b.n);
}

/** Whether a client can actually reach this tool on the map right now. */
export function isUsable(status: ToolStatus): boolean {
  return status === "live" || status === "partial";
}

/**
 * How many tools carry a given status, within a chosen scope.
 *
 * Before Forest existed there was one specification, so a plain count over
 * every tool was an honest number. Now there are two — forty master tools and
 * sixteen Forest tools, numbered independently (§2.1) — and a caller has to say
 * which one it means or it gets both, silently combined. Defaulting to
 * `MASTER_TOOLS` rather than `ALL_TOOLS` keeps every call site written before
 * Forest existed answering exactly what it always did; a caller that wants the
 * combined total, or Forest's own sixteen, asks for it by name.
 */
export function countBy(status: ToolStatus, scope: readonly Tool[] = MASTER_TOOLS): number {
  return scope.filter((t) => t.status === status).length;
}
