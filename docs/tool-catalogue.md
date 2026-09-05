# The forty tools, as Malhar grouped them

*Generated from `src/lib/portal/tool-catalogue.ts` by
`scripts/write-tool-catalogue.mjs`. Do not edit by hand: the same list drives
the tool rail on the survey map, and a document that disagrees with the
dashboard is worse than none.*

The specification arrived as five Word documents plus a master prompt. Each
document is a discipline, and the numbering runs 1..40 across all of them with
gaps where documents were never sent. The map now presents them the same way:
one group at a time, every tool shown, and the ones that are not usable shown
disabled with a line saying what they are waiting on.

## Where it stands

| | Tools |
|---|---|
| **Live** | 11 — 1, 2, 5, 16, 18, 19, 25, 26, 27, 28, 40 |
| **Partly built** | 10 — 3, 4, 10, 13, 14, 15, 20, 21, 24, 37 |
| **Engine only** | 2 — 11, 17 |
| **Not built** | 4 — 7, 8, 9, 12 |
| **Blocked** | 1 — 6 |
| **Never specified** | 12 — 22, 23, 29, 30, 31, 32, 33, 34, 35, 36, 38, 39 |

Of the forty numbers Malhar used, **12 were never described**. They are listed rather than quietly dropped, so the count of forty is honest and the question can be asked once with the numbers in hand.

**Live** means a client can use it on the map today. **Engine only** means the
calculation is written and tested and nothing calls it — usually because there
is no way to draw its input yet. **Blocked** means it cannot be built from what
we hold, whatever we do, and says why.

## Universal (1–10, 37, 40)

*1. Universal Tools.docx* — Measurement and comparison every survey needs, whatever the site is for.

| # | Tool | Status | |
|---|---|---|---|
| 1 | **Spot Level** | Live |  |
| 2 | **Grid Spot Levels** | Live |  |
| 3 | **Cross Section** | Partly built | The profile is live and correct. PDF export is not built; CSV is written in the browser rather than by the server. |
| 4 | **Cut & Fill** | Partly built | Volumes against a level, a best-fit plane and the survey's own minimum are live. Comparing against an uploaded design surface is tool 12, and the report export is tool 10. |
| 5 | **Surface Comparison** | Live | Deviation statistics over a drawn polygon, and a colour-coded map layer on a diverging ramp centred on zero. Comparing two *dates* rather than the two models needs tool 6's second flight. |
| 6 | **Timeline Comparison** | Blocked | No site in the portal has been flown twice. This is a data question, not a code question: one repeat flight makes it buildable, and nothing before then does. |
| 7 | **Annotation** | Not built | Malhar contradicts himself: the docx specifies it, and Important Notes.txt lists it under "Not needed for future". Needs one answer before it is worth building, because it is the only tool here that needs a write path and a permissions model. |
| 8 | **Bookmark Locations** | Not built |  |
| 9 | **Share View** | Not built | Needs a decision first: a URL that reproduces a client's site view is a URL that shows their data to whoever holds it. Either it stays inside the session, or it is a signed, expiring link. |
| 10 | **Export Centre** | Partly built | Grid levels export as CSV, TXT, DXF (with a .prj sidecar) and LandXML from the map. Spot levels export as CSV. There is no single download centre, and no PDF, ortho, raster or point cloud export. |
| 37 | **CAD Export** | Partly built | DXF, LandXML, CSV and TXT are written from the map, each stating its projection. SHP and LAS/LAZ are not written at all; GeoJSON exists only for hydrology vectors. Overlaps tool 10. |
| 40 | **Dashboard Summary** | Live | On the site overview, with every figure naming where it came from. Stockpile count and cut/fill volume have no site-wide answer — both depend on an area you draw — so they name the tool that measures them rather than showing a number. |

> **1. Spot Level** — Displays X, Y and Z when the user clicks anywhere on the DTM/DSM, with options to copy coordinates or export the selected points as CSV.
>
> **2. Grid Spot Levels** — Select a polygon and grid spacing (0.5 m, 1 m, 2 m, 5 m), generate spot levels from the DTM, export as CSV, DXF, TXT or LandXML, like Global Mapper.
>
> **3. Cross Section** — Draw a line across the map, get an elevation profile with distance, slope and elevation statistics, plus PDF and CSV export.
>
> **4. Cut & Fill** — Select an area of interest, compare two surfaces (existing vs design, or previous vs current DTM), and calculate cut, fill and net volume with report export.
>
> **5. Surface Comparison** — Highlight elevation differences between two DSM/DTM datasets with a colour-coded deviation map and statistical summary.
>
> **6. Timeline Comparison** — Compare drone surveys captured on different dates using a slider or swipe comparison.
>
> **7. Annotation** — Add pins, notes, arrows and issue markers on the map, save them, and share them with project members.
>
> **8. Bookmark Locations** — Save important map locations with custom names and navigate back to them quickly.
>
> **9. Share View** — Generate a unique URL preserving the current map extent, visible layers, measurements and annotations.
>
> **10. Export Centre** — Export ortho, DSM, DTM, contours, profiles, point clouds, PDFs, CSV, DXF, LAS/LAZ and LandXML.
>
> **37. CAD Export** — Export supporting DXF, LandXML, SHP, GeoJSON, CSV and LAS/LAZ for CAD and GIS workflows.
>
> **40. Dashboard Summary** — A project summary panel showing survey area, highest and lowest elevation, average slope, contour interval, point density, stockpile count, cut/fill volume and survey date.

## Hydrology (24–28)

*2. Hydrology Tool.docx* — Where water goes, where it collects, and what it would flood.

| # | Tool | Status | |
|---|---|---|---|
| 24 | **Flow Direction** | Partly built | D8 flow direction is computed, validated against SAGA, and readable by clicking any point. It is drawn as a grid, not yet as arrows. |
| 25 | **Flow Accumulation** | Live |  |
| 26 | **Watershed Delineation** | Live |  |
| 27 | **Sink Detection** | Live |  |
| 28 | **Flood Simulation** | Live |  |

> **24. Flow Direction** — Calculate and visualise water flow direction from the DTM using directional arrows.
>
> **25. Flow Accumulation** — Identify natural drainage paths and stream networks from the terrain model.
>
> **26. Watershed Delineation** — Click any point and generate the upstream catchment boundary.
>
> **27. Sink Detection** — Automatically identify terrain depressions where water may accumulate.
>
> **28. Flood Simulation** — Set water levels (+1 m, +2 m, +5 m) and visualise inundation areas and estimated storage volume.

## Contractor (11–14)

*3. Contractor Tools.docx* — Earthwork against a design surface, and whether it is within tolerance.

| # | Tool | Status | |
|---|---|---|---|
| 11 | **Earthwork Progress** | Engine only | `earthworkProgress` takes a list of surfaces and is tested. It has one survey to run on, so it is blocked on the same repeat flight as tool 6. |
| 12 | **Design Surface Check** | Not built | Cut & fill already accepts a reference surface, so the comparison half exists. Reading a LandXML or TIN upload and turning it into a grid does not. |
| 13 | **Tolerance Analysis** | Partly built | Checks a drawn area against the other model or a stated design level, and refuses to assess a tolerance finer than the survey's own accuracy. Checking against an *uploaded* design surface is tool 12. |
| 14 | **Slope Heatmap** | Partly built | The slope layer draws on the map and the analysis engine classifies into bands. The three documents give three different band schemes (see the catalogue note), so no one scheme is presented as the answer. |

> **11. Earthwork Progress** — Compare multiple surveys over time, showing excavation, filling and completion percentages.
>
> **12. Design Surface Check** — Compare uploaded LandXML/TIN/Civil3D surfaces against the current DTM and highlight deviations.
>
> **13. Tolerance Analysis** — Colour-code areas within and outside a user-defined elevation tolerance (e.g. ±20 mm).
>
> **14. Slope Heatmap** — Colour-coded slope map with customisable slope ranges and export options.

## Mining (15–18)

*5. Mining Tool.docx* — Stockpiles, benches, highwalls and haul roads.

| # | Tool | Status | |
|---|---|---|---|
| 15 | **Stockpile Volume** | Partly built | Selecting a pile and getting its volume, base area and height is live. Automatic detection is not built. |
| 16 | **Bench Analysis** | Live | Reads a drawn line as alternating flats and faces. A measurement of the ground, not of the mine plan: pointed at a natural slope it reports terraces as benches, and says so. |
| 17 | **Highwall Stability** | Engine only | `steepSlopeZones` returns the zones above a limit. The limit itself is a geotechnical number nobody has given us, and defaulting it would be inventing a safety threshold. |
| 18 | **Haul Road Analysis** | Live | Delivered by tool 20 on the same drawn line: width, gradient and crossfall, with stations flagged above the grade and crossfall limits you set. Those limits are yours, not a standard. |

> **15. Stockpile Volume** — Select or automatically detect stockpiles and instantly calculate volume, base area and height.
>
> **16. Bench Analysis** — Measure bench width, bench height and slope angle across mining benches.
>
> **17. Highwall Stability** — Identify steep slopes exceeding safe design limits and highlight potential instability zones.
>
> **18. Haul Road Analysis** — Calculate road width, gradient and crossfall, and identify unsafe road sections.

## Roads (19–21)

*4. Road Tool.docx* — Chainage, corridor geometry and sections along an alignment.

| # | Tool | Status | |
|---|---|---|---|
| 19 | **Chainage** | Live |  |
| 20 | **Corridor Analysis** | Partly built | Width, longitudinal grade and crossfall are live, with stations flagged against limits you set. Shoulders and median are not separated from the carriageway: that needs edge detection, not a terrain model. |
| 21 | **Automatic Cross Sections** | Partly built | Sections are cut at 5, 10, 20 or 25 m and drawn on the map as the ticks they were taken along. The PDF sheet Important Notes.txt asks for ("cross sections every 10 m, export PDF as AutoCAD") is tool 10's job and is not built. |

> **19. Chainage** — Generate chainage markers along a road alignment with elevation and profile data at each station.
>
> **20. Corridor Analysis** — Measure road width, shoulders, median and longitudinal slope along the selected alignment.
>
> **21. Automatic Cross Sections** — Generate cross-sections at fixed intervals (5 m, 10 m, 20 m) along a selected alignment.

## The hydrology module's sixteen layers

The second hydrology prompt asks for a module with sixteen named outputs,
which is a different request from tools 24 to 28: not five tools but one
module, each layer with its own toggle, transparency and legend.

| Layer | Status | |
|---|---|---|
| Sink filling | Live |  |
| Flow direction | Live |  |
| Flow accumulation | Live |  |
| Stream network | Live |  |
| Stream order | Live |  |
| Watershed boundaries | Live |  |
| Slope | Live |  |
| Aspect | Engine only | Computed for hillshade already; never surfaced as its own layer. |
| Drainage pattern | Not built | Classifying a network as dendritic, trellis or radial is a shape judgement, not a raster operation. |
| Water accumulation zones | Live | Served as sink detection. |
| Flood inundation simulation | Live |  |
| Runoff paths | Partly built | The flow network is the runoff path. A per-storm runoff volume needs rainfall, which nobody has supplied. |
| Check dam locations | Blocked | Needs the suitability model: weights, land use, soil, rainfall. Guessing them produces a confident wrong map, which is worse than no map. |
| Farm pond locations | Blocked | Same suitability model. |
| Recharge structures | Blocked | Same suitability model. |
| Reservoir suitability | Blocked | Same suitability model. |

Four of the sixteen — check dams, farm ponds, recharge structures and
reservoir suitability — are one question, not four: they all need the
suitability model. Weights, land use, soil and rainfall have not been
supplied, and inventing them would produce a confident wrong map, which is a
worse outcome for this client than no map.

## What is not in the numbering

Two things Malhar specified in prose rather than as numbered tools, both now
on the map at the end of their group:

- **Area**, item 4 of `Important Notes.txt`: "polygon, rectangle, polyline,
  circle → area and perimeter with avg/max/min elevation".
- **Inspect**, from the hydrology prompt: "clicking any location on the map
  should display detailed statistics such as elevation, slope, flow
  accumulation, watershed area". Deliberately not wired to tool 24: flow
  direction is one of the things it reports, but 24 asks for arrows drawn
  across the terrain, and letting a general point query stand in for that
  would mark a tool delivered that is not.

And one deliverable the numbering never mentions but `Important Notes.txt`
lists under Layers:

- **Point cloud.** Aektanagar's LiDAR — 50,183,644 points in a 1.7 GB LAS —
  is served as a quadtree of streamable nodes and drawn in the survey map
  itself. Colour by RGB, height or ASPRS class; classes filterable; detail
  budgeted so a weak laptop can still pan. See `docs/tools.md`.

And one tool from a request that arrived after the original five documents,
Malhar's own prompt in full:

> Add a simple Shapefile tool to my existing GIS dashboard. Create: draw
> Point, Line or Polygon on the map and save as a shapefile. Download: a
> valid .zip containing .shp, .shx, .dbf and .prj. Upload: a shapefile .zip,
> displayed automatically on the map. Do not modify the existing
> dashboard/map design, only add these functions.

- **Shapefile.** Draw or import Point, Line and Polygon features, export a
  real ESRI Shapefile — hand-written to the binary spec, not GeoJSON with a
  different extension — and import one from another package to compare
  against this survey. Verified against an independent Python library, not
  only against itself. See `docs/tools.md`.

And one more, from a nine-page prompt of his own:

> I want to add a new dashboard tool named "Simulation Water Level Rise"...
> run an interactive flood/water-level rise simulation over the existing
> DTM, similar in concept to the terrain-based water-level analysis
> available in tools such as Global Mapper and HEC-RAS.

- **Simulation Water Level Rise.** Draw a study area, pick a water source on
  the map or type a starting elevation, choose a 2, 5 or 10 m rise interval,
  and watch the flood spread step by step with the inundated area in m²,
  hectares and km² beside it. Two modes, never conflated: a **connected**
  flood from a chosen source, and a plain **elevation threshold**. It is
  computed at the survey's own native resolution and never coarsened to go
  faster: an area too large to simulate at full resolution is refused, with
  the size that would work named in the refusal. Every level exports as a
  polygon carrying its water level, interval and area, as GeoJSON or as a
  real shapefile. See `docs/tools.md`.

## Still on Malhar

- The twelve unspecified numbers above.
- The suitability model, for four of the sixteen hydrology layers.
- Which slope scheme. Three documents give three, one of them in percent:
  `Important Notes.txt` says 0–5 / 5–15 / 15–25 / 25%+, the hydrology legend
  says 0–3° / 3–8° / 8–15° / >15°, and tool 14 says "customisable". No one
  scheme is presented as the answer until someone says which it is.
- The annotation contradiction: tool 7 specifies it, `Important Notes.txt`
  lists it under "Not needed for future".
- Whether "±4" is centimetres or millimetres, and absolute or relative.
- A second flight of any site. Tools 6 and 11 cannot be built without one, and
  no amount of code substitutes for it.
