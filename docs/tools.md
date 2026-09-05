# Dashboard tools: what was asked for, what was built, and where it stands

Written 23 Aug 2026 for PRs #40 to #45, and kept current since. This revision
covers everything merged up to PR #73 on 5 Sep 2026, and corrects the entries
that had gone stale rather than leaving them to be believed: the profile overlay
was reversed a week after it shipped, the flood no longer coarsens anything, two
rows of the merged table carried the wrong pull-request numbers, and the test
counts were a fortnight out of date.

Companion to two existing documents rather than a replacement for either.
`portal-map-architecture.md` says what the architecture should be.
`dashboard-tools-plan.md` says in what order to build it. This one says what
actually happened, which decisions were taken along the way, and what is
honestly still missing.

---

> **The tool-by-tool table lives in [`tool-catalogue.md`](./tool-catalogue.md)**,
> generated from the same list the dashboard reads so the two cannot disagree.
> This document is the story: what was built, why, and what is still missing.

## 1. The requirement

On 8 Aug 2026 Malhar delivered a numbered 40-tool dashboard specification as
`.docx` files, plus an `Important Notes.txt` roadmap and a Kherwada hydrology
test dataset. Twenty-eight of the forty numbers were actually shared:

| Range | Module |
|---|---|
| 1–10 | Universal |
| 11–14 | Contractor |
| 15–18 | Mining |
| 19–21 | Roads |
| 24–28 | Hydrology, flagged "Most Important" |
| 37 | CAD Export |
| 40 | Dashboard Summary |

The essential reading of that specification, recorded at the time and still the
thing that makes it tractable: **it reads as 28 separate UI features but is
really one dependency**: a queryable DTM with windowed reads, a projected CRS,
cut and fill, profiles and flow routing. Treated as 28 features it would have
produced 28 shallow tools over frozen pixels.

Three requirements from that drop shaped everything below:

- **Accuracy is the sale.** Sudaan advertises ±3–4 cm. A portal that quietly
  degrades that is worse than one that does not measure at all.
- **"DSM/DTM should look like a Global Mapper image"**: a blue-to-red ramp,
  hillshade blended underneath rather than floated over, and a vertical colourbar
  in metres. This was explicitly noted as impossible against pre-baked WebP
  pyramids, and therefore as an argument for a dynamic tiler.
- **Hydrology is the differentiator.** Nobody else in this market offers it, so
  it is led rather than copied.

---

## 2. Where things stood before this work

The geometry engine was already built and validated:

- Tools 1–5, 10, 11–21, 24–28 and 37 computed correctly, covered by known-answer
  tests against analytic surfaces
- The hydrology engine agreed with SAGA at **98.1% and 98.3% catchment IoU**, with
  stream network precision 92.1% and recall 96.2%
- `POST /api/portal/sites/<slug>/analysis` served a subset, tenant-checked

And none of it was reachable by a client. Nothing on the map was clickable, and
the map itself measured using a completely different, much worse code path.

---

## 3. What was built, and why each piece

### 3.1 Measurement severed from display (#40)

**The problem.** The map's measure tools read elevation from Terrain-RGB tiles in
the browser. That is wrong in four compounding ways, none of which look wrong on
screen:

| | Consequence |
|---|---|
| Tiles quantise to 0.1 m | 2.5× coarser than the ±4 cm the survey is sold on |
| `Math.floor`, not interpolation | a click could resolve half a cell away, 13 cm on a 15° slope at Kotba's 24 cm grid |
| Tiles are Web Mercator | every value had already been reprojected and resampled |
| The tile is chosen by map zoom | **the same point answered differently depending on zoom level** |

**What was done.** Every reported number now comes from the analysis API, which
reads the source GeoTIFF bilinearly at native resolution in the survey's own UTM
zone. `DemSampler` is no longer imported by anything; those tiles now feed only
the hillshade, which is the right job for them because 0.1 m quantisation is
invisible in a picture.

This closes phase 0 item 6 of the plan, *"no code path computes a reported
number from a Terrain RGB tile"*, which is now literally true.

**Four tools on the map:**

- **Spot level (tool 1)**: click for X, Y, Z; accumulates as a list rather than
  replacing; grid or lat/lon; CSV export stating its EPSG
- **Distance / profile (tool 3)**: chainage, climb and descent, and end-to-end
  grade and steepest step as *separate* numbers
- **Area**: plan area with min, max, mean
- **Cut and fill (tool 4)**: reference surface is a required choice, with the
  systematic uncertainty printed beside the volume

**The split that keeps it responsive:** geometry (length, area, perimeter) is
exact arithmetic on the drawn vertices and stays in the browser, so it lands on
the same frame as the click. Elevation goes to the server. The panel fills in
twice and says which half it is waiting on.

### 3.2 Windowed byte-range reads (#41)

**The problem.** `PORTAL_TERRAIN_DIR` cannot work in production, and this was a
dead end rather than a configuration gap:

- the tile pyramids under `portal-data/map` are committed and deploy with the site
- the source rasters are gitignored, total **316 MB**, and were read with `readFileSync`
- a serverless function has a read-only filesystem and a bundle limit around 250 MB

So the variable pointed at a directory that could not exist there.

**The insight.** A TIFF does not have to be read whole. Its directory says which
byte ranges hold which tiles, and HTTP has had range requests since 1997. **The
cost of a measurement should scale with the polygon somebody drew, not with the
survey it was drawn on**. A hectare at 24 cm is 170,000 cells whether it sits in
Kotba or in a forest the size of a county.

**Nothing needed converting.** The rasters the pipeline already produces were the
right shape:

```
aektanagar/dtm.tif   BigTIFF, 6409x6678, TILED 256x256, LZW, 6 IFDs (5 overview levels)
kotba/dtm.tif        classic TIFF, stripped   (6 MB, windows by strip)
```

and `raster.mjs` already parsed BigTIFF and tiled layout. Three of the four
pieces existed; the missing one was a single assumption in one line.

**Result: raster size no longer affects response time:**

| | |
|---|---|
| Open Aektanagar's 145 MB DTM (directory only) | 2 ms, 512 KB |
| Spot level | 3–12 ms, 0.72 MB total |
| One hectare (1.7M cells) | 120 ms |
| Route: Kotba 6 MB | 1234 ms |
| Route: Aektanagar 145 MB | 1284 ms |

What remains is a 285 ms round trip to a database in Sydney.

`PORTAL_TERRAIN_URL` points at the tile Worker in front of the private R2 bucket.
The portal authorises itself with the same short-lived, site-scoped grant a
browser gets, minted server-side and refreshed per request. One set of
authorisation rules, not two.

### 3.3 Hydrology served and drawn (#42, #43)

Tools 24–28 as an HTTP route (`layers`, `streams`, `basins`, `inspect`,
`watershed`, `sinks`, `flood`), plus the panel that drives them.

**Two regimes, and the difference is deliberate, not an inconsistency:**

| | Measurement | Hydrology |
|---|---|---|
| Resolution | **native** (7.7–24 cm) | **1 m** |
| Why | resampling before measuring *is* measuring the resampling | routing at native resolution turns every rut into a sink and braids the network into noise |
| Grid size | 42.8M cells | 336×513, ~0.5 MB |
| How read | **windowed** | **whole** |
| Why | cost must scale with the polygon | **flow routing cannot be windowed even in principle**: water arrives from outside any box you draw |

Malhar's own SAGA run used 1 m from a 2.5 cm ortho, a 40× reduction.

Routing is never computed on demand. Filling and accumulation are whole-grid
operations whose answer does not change between requests, so they stay in
`scripts/hydro-run.mjs`, offline. The route walks the precomputed pointer grid,
which finishes in milliseconds.

**Four ways hydrology goes quietly wrong, each answered rather than avoided:**

1. **A cell count is not an area.** Accumulation counts cells; a client reads
   hectares. Every accumulation is multiplied by cell area and reported in m²
   *and* ha, with the count kept beside it.
2. **A pour point 2 m off the channel traces a hillside, not a valley**: an
   answer that is plausible, tidy, and an order of magnitude too small. Points
   are snapped, and the response says *that* it snapped and *how far*. Measured
   on Kotba: the same click gives **0.000 ha unsnapped, 0.725 ha snapped**.
3. **A survey is a rectangle cut out of a landscape**, so contributing area from
   it alone is a lower bound. Every catchment reports edge truncation *in words
   as well as a flag*, because a flag beside a number does not stop the number
   being quoted alone. All 23 of Aektanagar's basins are truncated.
4. **Flooding is a connected fill from a seed, never a threshold.** Colouring
   every cell below a level floods hilltop hollows no water can reach.

### 3.4 Dynamic tiler (#44, #45)

**The scoping that became obsolete.** The tiler was planned as TiTiler in a
Docker image with GDAL, and §5 of the plan listed *"two new services for one
operator"* as a standing risk. That was correct while `readGeoTiff` could only
read whole files.

It is not correct any more. **A tile is a window**, and `raster-window.mjs` reads
arbitrary windows over byte ranges. So the tiler is one route, with no container and no
GDAL, running where everything else runs. **If anyone proposes the container
again, this is the reason not to.**

```
/api/portal/sites/<slug>/render/<layer>/<z>/<x>/<y>.png
  ?min= &max= &ramp= &relief=0 &exaggeration= &opacity= &scale=
```

**This is what finally delivers A3.** All three of its complaints were properties
of baking the picture at ingest, not of the ramp:

| | Before | Now |
|---|---|---|
| Stretch | a percentile frozen weeks ago | the layer's **true** min/max |
| Hillshade | a separate half-transparent layer floated over | **composited into** the colour |
| Resolution | lost to a pre-baked pyramid | reads the **source** raster |

Eight layers are drawable: the two elevation models shaded, and the six grids
`hydro-run.mjs` writes, none of which could be seen at all before, because a
browser cannot draw a GeoTIFF. The vertical colourbar arrives with them: round
ticks, the layer's own unit, built from legend **data** rather than baked as an
image, so it is screen-readable and restylable.

---

### 3.5 The tools grouped the way the client grouped them (#47)

The specification arrived as five Word documents, each a discipline — Universal,
Hydrology, Contractor, Mining, Roads — numbered 1..40 across all of them. The map
presented none of that: a flat row of four measure buttons, with the hydrology
tools pushed into a sidebar panel. That is the right set of tools in the wrong
shape. A mining client should not read past the road tools to reach stockpile
volume.

`src/lib/portal/tool-catalogue.ts` is now the single list. The tool rail on the
map reads it, and so does `docs/tool-catalogue.md`, which is generated from it,
so the document and the dashboard cannot drift.

**Gaps are shown as gaps.** A tool nobody specified, a tool whose engine is
written but has no way to draw its input, and a tool blocked on a second flight
are three different facts. Hiding them would make the dashboard look finished
and leave the client to discover the truth by asking for something. The Roads
group is the honest case: three tools listed, three disabled, with the group
stating that the calculations exist and need an alignment tool.

Two side effects worth naming:

- **Tool 15 stopped being tool 4 wearing another name.** Both draw a ring and
  return a volume, but a stockpile is quoted as volume, base area and height,
  and the server has always had a separate `stockpile` op. The panel now asks
  for the one the client pressed, and reports material below the fitted base
  separately rather than netting it off — so a polygon drawn past the toe is
  visible instead of quietly shrinking the pile.
- **Measure mode and hydrology mode became exclusive.** They were two
  independent state machines that both claimed the map's click, and nothing
  stopped both being on. Every activation now goes through one place.

### 3.6 Contours give up their elevation (#47)

Contours arrive with an `elevation` on every line and nothing let a client use
it: the lines were one flat brown, and a height was readable only by pointing at
one and waiting for the hover readout. That is a drawing, not data.

Four controls, each answering a question a surveyor asks of a contour sheet:
**labels** (the number on the line), **index contours** (every fifth heavier, as
a printed sheet is drawn), **colour by height**, and an **elevation band** that
shows only the levels between two elevations.

Three decisions inside that:

- **Labels are HTML, not a symbol layer.** MapLibre renders text from glyph
  PBFs, and the only two sources are a font CDN the site's CSP blocks or a
  self-hosted glyph set larger than the contours themselves. Markers cost
  nothing at this count and rotate with the map for free.
- **One label per level per screen, not per feature.** A single 372 m contour is
  forty LineStrings after clipping, and labelling each turns the map into a wall
  of the same number.
- **Colour is stretched across the band shown, not the survey.** Banding to
  360–380 m while keeping the survey's 338–424 m ramp would paint those twenty
  metres in two indistinguishable shades, which defeats turning colour on.

A band is stated as a filter on the drawing, never as a claim about the ground.
Hiding everything above 380 m does not mean nothing is up there.

### 3.7 The LiDAR point cloud, in the same map (#48)

Aektanagar was flown with LiDAR. The portal's only record of it was a PDF
describing the cloud: 50,183,644 points at 181.7 per m², LAS 1.2, 1.7 GB.
Nothing opened it.

It is now a **quadtree of streamable nodes**, prepared offline by
`scripts/prepare-point-cloud.mjs` and drawn into MapLibre's own GL context.

**Drawn into the survey map, not in a viewer of its own.** Potree and its kind
open a cloud in their own canvas with their own camera, and the client then has
two maps of one site that disagree about where things are. A custom layer puts
the cloud under the contours and over the orthomosaic, in the same projection,
moved by the same pan — and costs no new dependency.

**A quadtree, not an octree.** A survey cloud is a *surface*: the points occupy
a thin shell over 500 m of ground with 74 m of relief. Splitting in Z would give
mostly empty nodes and one crowded one at every level.

**A point is written to the first level whose grid cell is free.** That is
Potree's scheme, and it has the property that matters: a node is a complete
picture of its region on its own, and its children *add* detail rather than
replacing it, so the viewer can stop descending at any depth and still show a
whole cloud. 13,265,886 of the 50 million points survive thinning at 13.6 cm, in
989 nodes and 126 MB.

**Ten bytes a point**, three uint16 quantised into the node's own box plus
colour and classification. That is 8.5 mm at the root node against a survey
accurate to 4 cm; float32 positions would be 60% larger for precision nobody
could measure. Positions are converted to mercator in the *pipeline*, so the
browser projects nothing and the numbers are computed once in double precision
rather than fifty million times in float.

The panel offers colour by RGB, height or ASPRS class, filters by class, and
states how many points are on screen against how many were flown — because a
viewer silently drawing a twentieth of a cloud looks identical to one drawing
all of it until somebody measures off it.

### 3.8 One alignment, four tools (#50)

Nine of the twenty-eight specified tools were **engine only**: written, tested,
and unreachable. Four of them — 19 chainage, 20 corridor, 21 automatic cross
sections and 16 bench analysis — were waiting on exactly the same missing piece,
and it was not a calculation. It was a way to draw a line.

That is now one mode. The client draws a centreline once and asks it four
questions, rather than four modes each demanding the same geometry again. It is
the same shape as cut-and-fill against stockpile: one act, several questions,
and the rail button says which one was pressed.

**What each tool now does on the map:** chainage draws its stations and labels
them 0+000 the way a drawing does; corridor draws the same stations and turns
the ones over your limits red; cross sections draw as the ticks they were
actually cut along, taken from the first and last sample rather than from a
bearing; bench analysis draws nothing, because its answer is a reading of the
line already on screen.

**Tool 18, haul road analysis, came free.** It asks for width, gradient,
crossfall and unsafe sections, which is tool 20 with mining limits. It is marked
live on the same engine rather than duplicated.

Three things this work changed underneath:

- **`corridorAnalysis` now carries coordinates through into its rows.** They
  were computed and dropped. Every other result could be placed on a map and the
  corridor's could not — and its flagged stations are the ones a client most
  wants to point at.
- **The route attaches `lonlat` to every station.** The engines answer in the
  survey's own CRS, which is right, but a browser holding no UTM implementation
  cannot draw that. One extra pair per station beats shipping a projection to
  every page for the sake of four tools.
- **Bench analysis accounts for the whole line.** See §5.

### 3.9 The last three that needed only a panel (#51)

Tools 2, 5 and 13 were engine only for the same reason the road tools were:
finished calculations with nothing to reach them. All three take a polygon,
which the map could already draw, so what was missing was a panel each and one
route op.

**Tool 2, grid spot levels.** A polygon, a spacing of 0.5, 1, 2 or 5 m, and the
levels come back on a regular grid. The panel estimates the point count before
asking, because the server refuses past 250,000 and a client should not discover
that by being refused.

**Tools 5 and 13, surface comparison and tolerance**, are one panel, because
they are one act: how far does this surface sit from that one, over this area. A
tolerance is a reading of the same numbers rather than a second measurement, so
asking for one adds the within/above/below classification and changes nothing
that was measured — asserted, not assumed.

**Exports finally happen** (part of 10 and 37). Grid levels save as CSV, TXT,
DXF and LandXML, written by the same tested writers the server uses. They are
written *in the browser* because `export-formats.mjs` is pure and the points
have already crossed the network to be counted: asking the server to compute
them again to format them would double the work and create a second answer that
could differ from the first. Every file states its projection and the caller
cannot opt out — a DXF gets a `.prj` beside it, because the format has nowhere
to record one, and a client who takes only the DXF has a file that cannot be
placed on the earth.

**A `difference` layer joins the tiler**, which is tool 5's colour-coded
deviation map. It is computed per tile rather than stored, and both models are
sampled into *that tile*, so the tile itself is the common grid. That matters
more here than it sounds: Kotba's DSM is 0.157 m and its DTM is 0.241 m with
different origins, so there is no shared cell to subtract and
`surfaceDifference` correctly refuses such a pair.

Three decisions worth keeping:

- **`compareSurfaces` exists beside the two whole-grid functions**, not instead
  of them. Those require grids that already agree and describe the whole raster;
  this samples the reference by world coordinate and restricts the answer to the
  ring. A grid-wide statistic over a windowed read describes the bounding box,
  which for anything not rectangular is a different area.
- **A tolerance finer than the survey is refused an answer, not given one.** A
  ±20 mm check on a survey good to ±40 mm produces a map of survey noise that
  looks exactly like a map of defects, and that is the reading a contractor
  would act on.
- **Mean and mean-absolute are both shown.** A surface half a metre up over one
  half of a polygon and half a metre down over the other has a mean change of
  zero, and only the second number says the surfaces disagree.

### 3.10 Tool 40, and a design pass (#53)

**Tool 40, the project summary**, turned out to be a panel over figures three
pipelines had already computed and nobody had ever read together: the area from
the hydrology grid, the elevations from the map manifest, mean slope from the
slope raster, point density from the cloud manifest, the contour interval from
the contour file itself.

Two rules give it its shape. **An absent figure is absent, never zero** — "0 ha"
and "we have not computed this" are different statements and rendering them
identically is worse than omitting the row. And **every figure names where it
came from**, on the row it belongs to, so a client asking where 19.2° comes from
gets an answer without anyone opening the code.

Stockpile count and cut/fill volume are the honest cases. Both depend on an area
a client draws, so there is no site-wide answer; they name the tool that measures
them instead of showing a number.

It also surfaced a contradiction worth fixing rather than hiding: the overview
card carried a hand-entered "12.8 ha" while the measured figure is 10.14 ha.
Both are defensible — one is likely the area flown, the other is ground actually
carrying data — but two different numbers under one label on one page is not, and
a client comparing them has no way to tell which to quote. The unsourced one is
gone.

### The design pass

The map page put the product 590 pixels down a 1000-pixel screen. Above it: a
back link, a title block, a 224px column of section links, a section heading, a
paragraph describing controls visible three inches away, a tool rail showing
fourteen buttons of which six worked, a paragraph naming the eight that did not,
and a status bar. The map — the entire reason the page exists — started below the
fold with a sliver showing.

Four changes, in order of how much they gave back:

1. **The site header is one band.** Back link, name and section nav on a line,
   the nav horizontal rather than a left column. Roughly 200px of height and the
   whole left column returned to the content, which every page enjoys as width
   and the map spends as canvas.
2. **The tool rail shows what works.** Tools that cannot be reached collapse
   behind a single count that opens a list naming each and what it is waiting
   on. Identical information, a hundredth of the space. Eight disabled buttons
   is not transparency; it is noise wearing transparency's clothes.
3. **The inspector is segmented, not stacked.** Tool, Layers, Water — three
   segments because there are three kinds of question — instead of six panels in
   a 288px column that overflowed on any survey with all of them. The segment
   follows the tool you pressed, so it is almost never a click you have to make.
4. **The map is fitted to the space it actually has.** `fitBounds` padded for the
   floating inspector, so the survey stops sitting off-centre with dead grey to
   its left. Contour labels are additionally spaced 44 screen pixels apart, which
   thins the crowded side without touching open ground.

Net: the canvas starts at 300px instead of 590, and roughly doubles in area.

One regression was introduced and caught by the suites. Collapsing unreachable
tools is right *once the answer is in* and wrong before it: on first paint every
measure tool vanished into the count and reappeared a second later, which reads
as the page changing its mind. A tool waiting on the terrain probe now stays on
the bar, disabled. "We do not know yet" and "it cannot be done" are different
states and deserve different interfaces.

### 3.11 The elevation models were never colour graded (#55)

Malhar noticed, and he was right. The DSM and DTM a client sees by default were
tiled before the dynamic tiler existed, with the site's own warm brand ramp and
**no relief shading at all**. Two consequences, both bad:

- You could not read a height off either of them. They were sepia washes.
- A DSM and a DTM of the same ground came out **nearly identical**, which
  defeats the point of publishing both.

Worse, the two representations of the same raster disagreed. The layer tree drew
the brown version while the rendered-layers panel drew a properly graded one from
the same file, so what the data looked like depended on which control a client
happened to find. `Important Notes.txt` asks for "a Global Mapper type of image",
and one of the two answers was.

**The fix is to share the palette rather than to invent a second one.**
`prepare-site.mjs` now colours elevation with `rampFor("rainbow")` from
`colour.mjs` and composites `hillshade` from `render.mjs` — the same functions
the tiler uses — so the baked tile and the rendered tile are the same picture.
634 elevation tiles were rebuilt across both surveys; the manifests are byte for
byte identical, because only the pixels changed.

One thing that had to be got right: the hillshade needs **metres per pixel from
the world file**, not a default of 1. Kotba's raster is 24 cm, so a cell size of
1 exaggerates every slope by four — which turns gentle ground into a mountain
range and looks, at a glance, entirely convincing.

The fix then exposed a second problem it had been hiding. Contours defaulted to
**coloured by height**, which was right when the ground beneath them was a flat
wash and the lines were the only thing saying which way was up. Over a graded
surface it is the same information twice, and a rainbow line over a rainbow
surface disappears into it. The default is now one dark line; the control is
still there.

---

### 3.12 A shapefile tool, verified against software we did not write (#56)

Malhar's own prompt, mid-project, outside the original five documents:

> Add a simple Shapefile tool to my existing GIS dashboard. Create: draw Point,
> Line or Polygon on the map and save as a shapefile. Download: a valid .zip
> containing .shp, .shx, .dbf and .prj. Upload: a shapefile .zip, displayed
> automatically on the map. Do not modify the existing dashboard/map design,
> only add these functions.

It arrived in the same conversation as a genuine catch of his — that the DSM
and DTM tiles had never been colour graded (§3.11) — and the two are connected.
He is not asking to see our numbers presented more convincingly; he is asking
for a way to check them against software he already trusts, without taking our
word for either.

**A real ESRI Shapefile, hand-written to the binary spec**, the same way the
LAS reader and the DXF/LandXML writers were: `.shp` geometry, `.shx` index,
`.dbf` attributes, `.prj` projection, in a `.zip` container also written by
hand. Not GeoJSON renamed — a client comparing our output against Global
Mapper or QGIS needs the actual format those tools read, with the actual
binary quirks (the outer ring of a polygon is *clockwise* in a shapefile and
*counter-clockwise* in GeoJSON — the opposite convention — so every polygon
this writes or reads reverses its rings, unconditionally, in both directions).

**Verified against software this project did not write.** Every engine in this
codebase has been tested against itself; this is the first tested against an
independent implementation. `pyshp`, installed fresh, read every point, line,
polygon-with-a-hole and attribute this pipeline wrote, correctly, with no
warning. Python's own `zipfile.testzip()` validated every CRC in an archive
this pipeline produced and found no corruption. And the reverse: a shapefile
written by `pyshp` and compressed with Python's `zipfile.ZIP_DEFLATED` — the
default a real GIS package would produce — was read back correctly by this
pipeline's own parser, hole and all. Self-consistency proves a format is
internally coherent; an independent reader is the only thing that proves it is
actually the format it claims to be.

**Upload accepts whatever UTM zone the file declares, not only the survey's
own.** The tool exists to compare against something else, so a shapefile from
a neighbouring zone is reprojected and placed, not refused for disagreeing.
A shapefile with no `.prj` at all, or one not on the WGS84 datum, is refused
outright — the same rule every export in this portal already follows: a file
whose projection cannot be stated does not get placed on a map by guessing.

**A separate state machine, deliberately, not a fifteenth `MeasureMode`.**
Every numbered tool asks the server one question about one shape in progress.
This tool accumulates any number of separate features per geometry type and
finishes one back into "ready to draw the next", which is a different shape of
interaction from every other tool on the map. Folding it into the shared
click handler would have meant teaching that handler a shape of interaction
none of the other fifteen tools have. A second, independent axis — checked
first, so nothing else runs while it is armed — is smaller and does not risk
the mechanism every other tool depends on. The instruction not to touch the
existing design made this the right call rather than merely the cautious one.

**The route needs `node:zlib`, so it could not stay entirely client-side** the
way the CSV/DXF/LandXML exports do. Those are pure string templating with zero
imports; a zip a client uploads has to tolerate deflate compression, because
that is what QGIS, ArcGIS and Global Mapper write by default, and only Node's
zlib decodes that here. A reader that only accepts the one compression method
its own writer happens to use is not an interchange tool.

### 3.13 The profile chart overlays DTM against DSM (#57, reversed by #62)

Another of Malhar's own prompts: while drawing a cross-section profile, show
both surfaces on the one graph, so the gap between them — canopy, a
stockpile, a structure — is something a client reads off a chart rather than
something they reconstruct by flipping the surface toggle and remembering the
first number.

**Fetched together, not toggled between.** Tool 3's profile request now asks
for both surfaces over the identical line in one round trip — two `profile`
calls sharing the one abort signal `latest()` already hands the lane, so a
third click superseding the pair cancels both together rather than leaving an
orphaned fetch to resolve into a panel that has moved on. This only happens
where the survey actually has both models to measure against, which is the
same `hasBothSurfaces` check the surface toggle itself is built on — a
one-surface survey draws exactly the single line it always has.

**Drawn deliberately asymmetric.** The active surface — whichever the toggle
has selected — keeps its filled silhouette in the same orange it always drew;
the other surface is a thin dashed line laid under it, with a two-line legend
naming both. Recolouring or refilling both equally was the first draft, and it
made the chart *harder* to read, not easier: two solid fills fight for the
same area, and which one is "the real one" became a question the client had to
answer rather than the graph. The primary line stays exactly as it drew before
this change; the second one is new information laid on top of it, not a
replacement for it.

**The vertical scale spans both.** A profile fixes its axis to its own min and
max; drawing a second surface's samples on that axis would clip whichever one
happened to sit outside the first surface's range, and a clipped canopy line
reads as flat ground. The chart's span is now the min and max across whichever
surfaces are actually drawn.

Verified against `kotba-survey`, which has both models: the browser suite now
asserts two `profile` requests go out — one per surface, over the same
line — that the legend names both, and that a dashed line is actually present
in the rendered SVG, not merely that the request was made.

**And it was reversed a week later, on Malhar's own instruction (#62).** He
asked for exactly one surface at a time with a clear way to switch between them,
which the Terrain/Surface toggle already was. The overlay fetch, the dashed
second line, its legend and the `other` field are gone from both `MapViewer` and
`MeasurePanel`; switching the toggle now re-runs the same profile against the
other model. Nothing above is wrong about how the overlay worked, and it is left
standing because the reasoning still holds and because anyone finding the dashed
line in the history should know it was removed by request rather than by defect.
The browser suite asserts the new behaviour — exactly one profile request per
click — rather than the old.

### 3.14 Simulation Water Level Rise (#63, bounded by #64)

Malhar's third self-directed prompt, and by far his longest — nine pages
specifying a flood-inundation tool "similar in concept to the terrain-based
water-level analysis available in tools such as Global Mapper and HEC-RAS".

**Half the engine already existed.** `connectedFlood` was written for tool 28
and has always done the hard part: grow water outward from a seed so a hilltop
hollow at the same elevation stays dry. What this needed on top was the
*simulation* — a ladder of levels rather than one, a polygon and a set of
statistics per level, a drawn starting area rasterised into seed cells, and a
`thresholdFlood` beside the connected one.

**Both modes, and the panel always says which.** His §13 is the crux: a flood
*from a water source* and *every pixel below an elevation* are different
questions with pictures that look equally plausible. Choosing a source on the
map switches to the connected fill; typing only an elevation asks the plain
threshold, which is the honest answer when there is no source for anything to
be connected to. Neither is a degraded version of the other and neither is the
silent default.

**One request, then animate locally.** His "most important requirement" is that
the interval buttons work automatically. The way to make that smooth is not a
fetch per frame: the whole ladder is computed in one request — the DTM is read
once either way — and playback, the slider, step forward and step back all run
on data already in the browser. Dragging the slider issues no request at all,
which the browser suite asserts.

**Native resolution, not the hydrology grid.** Tool 28 runs against the
hydrology bundle, deliberately resampled to 1 m because routing flow across a
photogrammetric surface at native resolution turns every rut into a sink. That
reasoning is about *flow direction*, and a level threshold has none — so this
reads the DTM at the resolution the survey was flown at, which is also what his
§10 asks for and what makes a comparison against Global Mapper meaningful.

**What of the nine pages is not built.** Three things, none of them silently
missing:

- **KML/KMZ export.** His §8 lists it as "if supported". GeoJSON and Shapefile
  are both there; KML would be a fourth writer and nothing else in the portal
  emits it yet.
- **Drawing a starting-area polygon.** §2 offers a click *or* a polygon as the
  water source. The engine takes either — `seedCellsInPolygon` is written and
  tested — but only the click is wired to the map, because the click is what
  his own worked example uses and a second draw mode is a separate piece of
  interaction work.
- **Layer order and visibility controls.** §11 asks for transparency,
  visibility and layer order. Transparency is a slider; the water always draws
  above the rasters and below the measure tools, which is the order that
  question has one right answer to.

**Bounded to a study area, after a whole-grid read proved untenable.** This
shipped reading the DTM whole, like tool 14, on the reasoning that a flood's
extent is not known before the read so there is nothing to window to. That is
true of the *flood* and false of the *study area*, and it broke in two ways at
once — see §5, "From the flood simulation". It was bounded first to the map's
own view (#64), coarsening the grid when the view was large and reporting the
cell size it had actually used. That coarsening is now gone entirely and the
bound is an area the client draws: §3.15, "The resolution is not ours to
trade".

### 3.15 A performance round, and twice being wrong about where the time went (#65–#73)

A client watching the flood simulation on Kiru waited fifteen seconds for twelve
levels, and said so. The answer was a four-phase plan: measure first, then
rewrite the LZW decoder in Rust, then move raster compute to the edge beside the
data, then precompute a merge tree so a flood stops being a computation. **Two
of those four projections were wrong**, and in both cases what corrected them
was a measurement that took an afternoon rather than an argument that would have
taken a week.

*Its phases are numbered 0 to 4 and are **not** the phases of
`dashboard-tools-plan.md`, whose phase 0 is the shared foundation of §3.1. Where
this section says "phase", it means the performance plan.*

**Phase 0: a harness, and a seam that can fail (#65).** `scripts/bench-geo.mjs`
times thirteen primitives against the real Kotba raster — the raster read split
into I/O and LZW, `readWindow`, `resample`, `hillshade`, `renderGrid`, both
floods, `polygonize`, `polygonStats` at four and at sixty-four vertices, and a
twelve-level `simulateFlood` — as the median of seven runs after a discarded
warmup, and **skips four of them honestly** when no raster is present rather
than reporting a zero. `scripts/geo-differential-test.mjs` is the seam an
optimisation is checked through: it holds a new implementation against the one
it replaces and compares field for field. Its eighteen checks include **negative
controls that inject a one-ULP change and assert the comparison catches it** —
because a differential test that passes whatever you feed it is worse than no
test at all, and the only way to know the difference is to hand it something
that must fail.

Everything below was found with those two scripts. None of it was found by
reading code.

**Phase 1: LZW in Rust and WebAssembly, and it underdelivered (#66).**
`native/lzw/` compiles to a **2.2 KB `.wasm`**, base64-embedded in
`src/lib/geo/lzw-wasm.mjs` so there is no second artefact to deploy, no fetch at
startup, and nothing to go missing from a serverless bundle. It is
**byte-for-byte identical to the JavaScript decoder on every chunk of all three
surveys**, 650 chunks each, and handles the format's corners the same way: the
shortest legal stream, a repeated clear code, and truncated input that must not
read past the buffer.

The measured speedup is **2.53× on Kotba, 2.14× on Aektanagar and 2.40× on
Kiru**. The plan projected **5–10×**. That gap is the most useful number in this
round. The kernel is a real win and a general one — LZW sits under every raster
read in the product — but on a 15.1 s native flood over Kiru it saves about
600 ms, which is not a headline, and the plan had to be re-read the moment the
figure came in. Recording 2.4× rather than "a Rust kernel, as planned" is the
reason the rest of this section went the way it did.

**The resolution is not ours to trade (#67).** The flood shipped bounded to the
map's view and coarsening the grid to fit a four-million-cell budget, reporting
the cell size it had used beside the answer (§3.14). The client rejected that,
and the reasoning is worth keeping: the point of a 25 cm survey is that it is a
25 cm survey; a shoreline computed on 81 cm cells is a different shoreline, and
it cannot be checked against Global Mapper or HEC-RAS reading the same file —
which is what this tool is *for*. Worse, the degradation was invisible in the
picture.

So **all resampling is gone from the flood path**, and the bound became a study
area the client draws, a rectangle or a polygon, rather than whatever happened
to be on screen — because panning should not change an answer. Ground past the
budget is **refused**, in a message naming the size asked for, the size that
fits, and what to do next. A refusal a client can act on beats a number they
cannot trust.

**Phase 4: a merge tree, and it over-delivered (#68).** `connectedFlood(dem, L,
[s])` returns the component of `{z ≤ L}` containing `s`, and two cells are in
the same component exactly when the minimax path between them is at or below
`L`. Bottleneck distances are carried entirely by a minimum spanning tree, and
Kruskal's algorithm builds that tree in ascending edge order — so the hierarchy
of components as the water rises *is* Kruskal's merge history. Precompute it and
a flood stops being a computation: it is a lookup of one node plus a subtree
aggregate that was summed at build time.

Two things make it practical. No edge list is ever materialised: since
`w(a,b) = max(z(a), z(b))`, sorting *cells* by elevation and unioning each with
its already-processed neighbours visits the edges in Kruskal order for free —
and that sort is an exact two-pass radix sort on the IEEE-754 bit pattern, so
ties agree with `connectedFlood` rather than nearly agreeing. And a node is
created only where the topology changes, with every cell that merely grows a
component appended to that node's run, which is what stops the tree being one
node per cell.

Measured: the **whole Kotba survey**, 1.73 M data cells, builds into 97,112
nodes in **232 ms** — 263 ms re-measured for this document — at 39.8 bytes per
cell, and a **twelve-level ladder answers in 16 µs**, 18 µs re-measured. Exact
against `connectedFlood` on every fixture and on the survey itself.

**The finding that keeps it honest is the memory.** The resident structure is
about 40 bytes per cell, which is fine for a 40-million-cell study area and is
**40 GB for the whole Kiru survey**. So it is a structure built per window and
kept for the next question about the same ground, never a precomputed asset for
a site.

**Wiring it in, and the regression that came with it (#69, fixed in #71).** With
one water source and more than one level, a ladder is now answered from the tree
— `topAncestor` plus two contiguous reads of the run layout — instead of running
`connectedFlood` once per level, and `describeFlood` assembles the result in one
place so the traversal path and the tree path cannot drift in units, rounding or
attribute names. Verified identical to the traversal on every field including
the GeoJSON, twelve of twelve levels on the Kotba DTM. It is a speed change and
never an accuracy one: nothing samples the terrain more coarsely.

Measured on Kiru over a ~400 m study area, warm: twelve levels 2964 → 2401 ms,
twenty-four levels ~5 s → 2711 ms, and **a single level, which builds no tree,
1634 ms**. The last figure is the one that matters. The tree makes level count
nearly free — twenty-four levels cost 300 ms more than twelve — and it cannot
touch a fixed read. That is what turned attention to the read path.

It also shipped with a defect. The tree was used **from two levels upward**, and
it only pays from about sixteen, because the build sorts every cell in the
window:

| cells | levels | traversal | build + query |
|---|---|---|---|
| 4M | 2 | 176 ms | 693 ms |
| 4M | 8 | 693 ms | 1019 ms |
| 4M | 16 | 2302 ms | 1543 ms |
| 10M | 8 | 1812 ms | 2333 ms |
| 10M | 16 | 5185 ms | 3697 ms |

A client checking a handful of levels — the common case — was made **up to four
times slower by an optimisation**, and nothing noticed until it was measured
afterwards. The rule is now asymmetric, and the asymmetry is the point: **a tree
already built for this exact ground is always worth using**, because the query
beats a traversal at every level count, while **building a new one is only worth
it for a long ladder**. The tree pays off across a session, not within one
request. One is cached, keyed by the ground itself — site, surface and the exact
window read — so it can only ever be reused for the raster it was built from.

**A negative result, recorded so nobody retries it expecting a win.**
`polygonize` was handed the flood's own cell list so it could skip its grid
scan. It was **slower**, not faster — run-layout order destroys cache locality
once a flood covers much of the grid — and it reordered the emitted rings, so
the GeoJSON changed textually for identical geometry. Reverted. It is the
obvious optimisation and it does not work.

**The worst latency in the product was not the flood (#70).** Every cell in a
polygon's window asked `pointInPolygon` about its four corners, and
`pointInPolygon` walks the whole ring — so the cost of an area, a volume, a cut
and fill or a surface comparison was vertices × cells, when only the cells the
boundary actually crosses have any business looking at the boundary. On a
1.9 million cell window:

| vertices | before | after | |
|---|---|---|---|
| 4 | 205 ms | 54 ms | 3.8× |
| 16 | 547 ms | 62 ms | 8.8× |
| 64 | 1823 ms | 144 ms | 12.7× |
| 256 | **6809 ms** | **784 ms** | 8.7× |

A 256-vertex ring is an ordinary traced stockpile, not a pathological case, and
**6.8 seconds for one measurement was worse than the flood simulation the client
complained about, on a tool used far more often**. Nothing had noticed, because
nothing measured it until the phase 0 harness existed.

`cornerLattice` computes one scanline per corner row instead of one ray cast per
corner: the ring's crossings with a horizontal line are found once, sorted, and
every corner on that row is then a binary search. The ray-casting rule is
reproduced exactly rather than approximated — same crossing arithmetic, same
strict comparison — so a corner is inside the lattice **if and only if**
`pointInPolygon` says it is, and boundary cells still subsample exactly as
before, so coverage semantics are untouched. It is permanently guarded by a
check that walks 7,626 corners across six ring shapes, including a star, whose
rows have more than two crossings and which a naive "first and last crossing"
version gets wrong, and a concave L whose spans start and stop mid-row. Three
call sites benefit: `polygonStats`, `cutFill` and `compareSurfaces`.

**The budget was calibrated before the last two optimisations (#71).** From a
client screenshot: the tool refused a 493 × 513 m view on Aektanagar and told
him to draw 154 m square or less. The refusal was behaving as designed and the
design was wrong for that survey — four million cells predates both the WASM
kernel and the merge tree, and on a 7.7 cm survey it comes out as a 154 m
square, smaller than anything a client would call a reservoir. Measured end to
end over eight levels:

| budget | Aektanagar, 7.7 cm | Kiru, 25 cm |
|---|---|---|
| 4M | 154 m, 1.0 s | 509 m, 0.5 s |
| 8M | 217 m, 2.2 s | 719 m, 1.1 s |
| **12M** | **266 m, 3.3 s** | **881 m, 1.5 s** |
| 16M | 307 m, 4.3 s | 1017 m, 1.9 s |

Twelve million keeps the worst case near three seconds and nearly doubles the
usable side length on both surveys. Still no coarsening: past the budget the
request is refused, never resampled. Malhar's own settings — start 40 m, maximum
55 m, 2 m interval, eight levels — now answer in 3.2 s at the full 0.0769 m
grid.

**Phase 2 was measured instead of built (#72).** Moving raster compute into the
Worker beside R2 is weeks of work and a monthly bill, and it rested entirely on
a number nobody had: what a windowed read costs *in production*. Every timing
this project holds was taken on a laptop off a warm local disk, where a
full-window read of Kotba is 1 ms of I/O against 57 ms of LZW — CPU-bound, which
is exactly the reading that justified phase 1.

Three things landed, none of which change an answer. `raster-window` counts, per
read, how many chunk fetches were issued, how many bytes they moved and how long
went to I/O against decode. The analysis route returns that as **`Server-Timing`**
— `io`, `decode`, `compute`, the range-request count and the bytes fetched;
durations only, behind the same session check as the measurement itself — so
every production request now measures itself, in the header browsers already
chart and `curl` already prints. And `scripts/bench-read-path.mjs` reads the
path three ways: a local file, an HTTP tile gateway, or a deployed portal
reporting its own `Server-Timing`. The third is the honest one, because the read
happens where it really happens.

**The finding was not what phase 2 assumed.** A full-window read of Kotba issued
**1,575 range requests of about 4 KB each, sequentially, one per strip**.
Locally each costs 0.01 ms and the whole thing hides. Over a network it is 1,575
round trips: at 10 ms each, fifteen seconds to move 7 MB. Sorting the chunks a
read touches by file offset shows they need not be separate requests at all:

| survey | layout | chunks | contiguous runs | gap |
|---|---|---|---|---|
| kotba | strips | 1575 | 1 | 0 MB |
| aektanagar | tiled | 702 | 1 | 0 MB |
| kiru, windowed | tiled | 2000 | 21 | 49 MB |

The bytes are physically adjacent. `cached()` stored spans and never coalesced
them, so the reader asked for one contiguous region in 1,575 pieces.

**Asking for the bytes in one go (#73).** `readWindow` now works out every chunk
it is about to decode, sorts them by file offset, joins neighbours, and pulls
each run in a single fetch; the reads below are unchanged and simply hit the
cache.

| survey | before | after |
|---|---|---|
| kotba, stripped | 1465 | **13** |
| aektanagar, tiled | 63 | **17** |

Bytes moved are essentially unchanged; only the number of requests falls. The
counts move a little with the window — 1,575 for a full-window read, 1,465 for
the one the test uses — and the order of magnitude is the point.

Two bounds keep it honest. Gaps up to 512 KB are bridged, because one round trip
costs more than half a megabyte of unwanted bytes and a tiled window would
otherwise split at every tile row; and no single fetch exceeds 16 MB, so a large
window cannot ask for the file in one go. `cached()` gained `prefetch()` and
`readWindow` only calls it when the source has one: a bare file source would
read the bytes here and read them again below, which is slower rather than
faster, so it stays on the old path — which is also what the new test exercises
as the "before" case. **The data must not change, and is asserted not to**: both
paths read square, wide-and-flat and tall-and-narrow windows on both a stripped
and a tiled raster — shapes that straddle tile rows differently and so coalesce
differently — compared cell for cell across 5.7 M cells, byte identical.

**What this round is evidence for.** Twice, an expensive plan was corrected by a
cheap measurement:

- The portal was assumed to be **I/O-bound**. It was **CPU-bound in our own
  LZW** — which is what phase 1 was for, and phase 1 then returned 2.4× against
  a projected 5–10×.
- The fix for that was assumed to be **moving compute to the edge**, next to the
  data. It was that **we asked for the data in 4 KB pieces**. Coalescing is a
  contained change to one function: no new infrastructure, no Worker deployment,
  no monthly cost.

**Phase 2 should not be started** until the read path has been measured again
from production, with `bench-read-path --portal`, against the coalesced reader.
On this evidence the phase 0 harness — two scripts, no product change, nothing a
client can see — was worth more than any kernel in the plan, and it is the piece
to keep if only one of them survives.

---

## 4. Judgement calls

These were decisions with real alternatives, taken deliberately.

### 4.1 Hand-written PNG encoder instead of `sharp`

`sharp` is present in `node_modules` but **not in `package.json`**: it arrives
transitively through Next's image optimisation. Depending on it means depending
on a package this project never declared and which a different Next release could
stop shipping. Declaring it properly is worse: a native binary of tens of
megabytes, into a deployment whose bundle limit the survey rasters already could
not fit inside.

Sixty lines against `node:zlib` is the same trade this repository already made
three times: LZW decoding, SigV4, and the GeoTIFF writer.

### 4.2 Rainbow is the default, and is refused where it lies

Rainbow ramps are perceptually non-uniform: equal steps in elevation are not
equal steps in apparent brightness, so they manufacture edges where terrain is
smooth. Both that and "surveyors read rainbow, and Malhar asked for it" are true,
so the resolution was to bound it rather than pick a side:

- **rainbow** is the default for elevation
- **viridis** and **terrain** sit beside it
- **rainbow is refused outright for signed quantities.** A difference coloured
  with a rainbow loses the only thing that matters about it, the sign. `rampFor`
  throws rather than documenting this.

### 4.3 Colour stretched across the layer, never per tile

Per-tile stretching makes a chessboard: the same elevation takes a different
colour either side of a tile boundary and the seams become the most prominent
feature on the map. Measured on Kotba, mean seam difference **23 of 765** with a
shared stretch, **97** with per-tile. Every tile request carries an explicit
min/max from recorded statistics, and the browser test asserts this by reading
the URLs the map actually requests.

### 4.4 Flow accumulation drawn logarithmically

On Kotba it runs 1 → 7,246 cells, and a drainage network is always that shape:
nearly every cell drains nearly nothing while a thin thread carries everything.
Linearly, 99% of the map is the bottom colour and the channels are a few bright
pixels, a faithful rendering of the numbers that tells a client nothing.
Measured: **30 distinguishable tones logarithmic against 10 linear.** The panel
states which scale is in use, or the colours read as proportional when they are
not.

### 4.5 Rendered layers are one at a time

A radio group, not checkboxes. These are full-coverage rasters: stacking two
means the upper hides the lower and the client is left adjusting opacity to guess
at what is underneath.

### 4.6 No legends for layers that cannot be drawn

Before the tiler existed, the hydrology panel deliberately carried a legend only
for stream order, the one thing genuinely rendered. Legends for flow
accumulation, slope or sink depth would have been decorating something invisible.
That reasoning expired with #45 and the legends arrived with the layers.

### 4.7 Tiles cache; the rest of the portal does not

`next.config.mjs` sets `no-store` for all of `/api/portal`, which is right for
pages. For a tiler it is not merely wasteful: a map view is ~20 tiles and every
pan would re-render all of them. Tiles are now `private, max-age=86400,
immutable`. `private` keeps survey imagery out of every shared cache, and
`immutable` is honest because a tile is a pure function of the survey, the layer
and the query.

### 4.8 The measure tools ask the server what is measurable

The toolbar used to decide from the layer manifest. The manifest describes what
is **drawn**; the tile pyramids deploy with the site while the source rasters do
not. In production the map therefore drew terrain it could not measure, and the
tools looked available and failed on the first click. They now probe the analysis
API on load and disable themselves with a reason.

### 4.9 Operator messages do not reach clients

A 409 from `terrain-source.ts` reads *"Place the source GeoTIFF at
portal-data/terrain/<slug>/dtm.tif, in UTM, and restart."* That is the right
message for whoever runs the pipeline and the wrong one for a client, who cannot
act on it and should not be shown the server's directory layout. The client
wording is chosen from the machine-readable `reason` instead.

---

## 5. Defects found, and how

Every one of these produced **a plausible number and no error**. None would have
been caught by a test that only checked shapes.

| Defect | Symptom | Caught by |
|---|---|---|
| ESRI direction codes fed to a traversal expecting internal indices | a catchment of **1 cell** where accumulation said **7,246**, a valid polygon, no error | asserting watershed cell count equals accumulation at the pour point |
| `maxDepth_m` computed as `level − groundAtSeed` | "Deepest 1.50 m" where the water was **7.91 m** deep | asserting deepest ≥ depth at seed, and mean ≤ deepest |
| Hillshade aspect used the uphill direction | a NW sun lit NW and SE slopes **identically**; picture still looked like terrain | lighting four planes whose answers are known analytically |
| `Number("")` → `0`, finite | a blank level box asked the server to flood a 340 m site to sea level | browser test clicking with an empty field |
| `Number(null)` → `0`, finite | **every tile rendered fully transparent** (alpha × an opacity nobody set) | decoding the PNG and counting opaque pixels |
| A stretch defaulting to `0..0` | invisible, because a second bug cancelled it | the same |
| `next.config` header overriding the route's | tiles served `no-store`; every pan re-rendered everything | asserting the response header, not the code |
| Hydrology written to the site root | would have **overwritten the map's manifest**, and the symptom would be *the map losing its layers* | noticed before uploading |

The `Number()` coercion trap appeared **three times**. After the third it was
centralised in `src/lib/portal/numbers.ts` (`numberParam`, `finiteOrNull`,
`clampedParam`). **Use those, never bare `Number()`, on anything from a URL or an
input box.**

### From the tool rail, contours and the point cloud

| # | Defect | How it was caught |
|---|---|---|
| 9 | A group labelled "1–10" listing twelve tools | The rail suite counted them |
| 10 | A blocked tool whose reason read "Blocked" rather than naming what it waits for | The rail suite required a reason a client could read |
| 11 | `modelViewProjectionMatrix` takes world pixels, not mercator. Fed mercator, every point landed within a rounding error of the map's origin: the cloud loaded, reported its point count, drew, and was nowhere | Differencing screenshots. Nothing that counts points can find this |
| 12 | MapLibre leaves a stencil mask and its own VAO bound. A custom layer that assumes otherwise is clipped by someone else's tile mask and reads attributes from someone else's buffers | Same |
| 13 | The cloud was drawn at height above **sea level**. MapLibre's camera is perspective even looking straight down, so a cloud floating 30–103 m above the map plane projects 6.5% outward — 50 m on the ground at the survey edge, and it no longer sat on the orthomosaic | Same. Anchored to the survey's own lowest ground instead |
| 14 | Node longitude/latitude boxes built from two corners of a UTM rectangle. Grid convergence turns that rectangle half a degree against true north here, so the box missed ground the other two corners cover, and edge nodes would have been culled while still on screen | The browser suite's containment check, then arithmetic |

### From the alignment tools

| # | Defect | How it was caught |
|---|---|---|
| 15 | `benchAnalysis` silently discarded flats narrower than the minimum bench width. On a natural slope that was a quarter of the line: benches and faces came to 159 m of a 209 m alignment and nothing said where the rest went | Asserting that the classified runs account for the whole line |
| 16 | Even after that, 11 m was still missing — the ends of the line running off the survey. Now counted as `unsurveyed`, computed from where the data starts and stops rather than as the leftover, so the sum is a real check and not an identity | The same assertion, again |

A third finding was **not** a defect, and mattering more for it. The suite first
asserted that every face is steeper than the bench threshold, mirroring the check
for benches. It failed, correctly. A run is classified from the slope of each
*segment*, but the slope reported for the run is its net rise over its length —
so for a bench the guarantee holds (if every segment is within the threshold, the
net cannot exceed it) and for a face it does not (a run of steep segments that
zigzags has a small net slope). The asymmetry is real, and the test now asserts
what is true rather than what looked symmetrical.

### From tools 2, 5 and 13

| # | Defect | How it was caught |
|---|---|---|
| 17 | The tiler asked `rampFor` without saying the quantity was signed, so the difference layer answered **500** on its first request. The guard refuses a diverging ramp for unsigned data *and* a sequential one for signed data, in both directions | Fetching one tile |
| 18 | The same omission in `Colourbar` threw inside React, and the error boundary took the **whole map panel** down with it — every tool after that point in the suite failed for an unrelated reason | Switching the layer on in a browser |
| 19 | A bad `ramp` was a 500. A client asking for the wrong kind of ramp is a bad request, and the message explains precisely what a rainbow loses; it is now a 400 carrying it | The same tile fetch |

Two non-defects worth recording, because both looked like defects at first. The
ramp chooser filtered `difference` out of its list, which was right for every
layer that existed when it was written and wrong the moment a signed one
appeared — it now hides the chooser entirely for a signed layer rather than
offering four buttons of which three produce an error. And the surface panel
correctly **disabled** its compute button when the test picked the DTM as a
reference for a measurement already on the DTM: comparing a surface with itself
is identically zero, and the panel refusing it is the feature.

### From the flood simulation

| # | Defect | How it was caught |
|---|---|---|
| 20 | **Every disconnected patch after the first was written as a *hole* in the first.** `polygonize` returns a mask's rings in one flat list — outers counter-clockwise, holes clockwise — and handing that straight to a GeoJSON `Polygon`'s `coordinates` declares ring 0 the boundary and everything else a hole punched in it. That is correct for a watershed, which is one connected region, and it was written when a watershed was the only caller. A flood is not: on Kotba at its lowest simulated level it is **207 separate ponds and 171 real holes**, and all 377 rings went out as one pond with 376 holes | MapLibre drew **nothing**, which is the lucky failure. Traced from "0 features rendered" in the browser suite rather than assumed to be a viewport problem, then confirmed by counting outer rings against holes directly on the raster |

| 21 | **The flood op read the DTM whole, so it was dead in production for every survey and dead locally for Kiru.** `loadTerrain` reads a local file; `terrain-source.ts`'s own header says there is no value of `PORTAL_TERRAIN_DIR` that can work on a serverless filesystem, which is exactly why `openTerrain`'s windowed byte-range path exists. The flood op used the wrong one. On Vercel it therefore answered `missing` for every site — *"Measurements are not available for this survey yet"*, which is not what was wrong and gives the client nothing to act on. Locally it additionally refused Kiru, whose DTM is **83,979 × 30,046 — 2.5 billion cells, 10 GB as Float32** | A screenshot from the client demo. Not by any suite: every test ran against Kotba, which is small enough to read whole and has local rasters, so the one survey that could not work was the one nothing exercised |

Two things came out of fixing that, both worth keeping:

- **A flood is bounded by a study area, not by the survey.** The client sends
  the map's own view; water reaching the edge of it is flagged `truncated` by
  the same check that flags water reaching the edge of the survey, because for
  that read they are the same edge. A flood across 21 km of gorge was never a
  question anyone was going to ask.
- **Large views were coarsened rather than refused — and that was the wrong
  trade.** Measured on Kiru: a 1.6 km view is 39.7 M cells and costs **~1.1 s
  per level**, so a ten-step ladder is twelve seconds of compute. Resampled to a
  four-million-cell budget the same ladder is about a second, and the areas
  agreed with the full-resolution run to within 0.01 ha (93.45 → 93.45,
  98.81 → 98.82, 104.21 → 104.22). The response reported `computedAtCellSize_m`,
  so the figure was never quietly finer than the work behind it. **The client
  rejected it anyway, and was right to**: the whole reasoning, and what replaced
  it, is §3.15, "The resolution is not ours to trade". The argument recorded
  here — a flood extent is a shoreline on a hillside, not a feature the size of
  a cell — is true about the *picture* and beside the point about the *number*,
  which is what a client checks against Global Mapper.

The reason the ring-grouping one matters more than its one-line fix suggests:
**MapLibre silently dropping the layer was the best possible outcome.** An export would
have opened in QGIS looking like an answer — 206 real flooded ponds described
as voids in a 207th — and nothing anywhere would have said a word. The fix,
`groupRingsIntoPolygons` in `vectorise.mjs`, groups each patch with the holes
it actually contains (smallest containing ring wins, because an island in a
lake is ordinary here) and emits a MultiPolygon.

**The same latent bug was already shipped in the hydrology route.**
`ringsToFeature` there had the identical shape and the identical history: right
for `watershed`, wrong for `sinks`, which returns every depression on the
survey. Fixed at the same call site rather than left because it was
pre-existing. Both now answer MultiPolygon unconditionally, so a client never
branches on how many pieces today's answer happens to have.

### From the shapefile tool

Two test-authoring mistakes worth recording, because both were caught by the
same pattern — the loop closed correctly — before either reached a client:

| # | What happened | How it was caught |
|---|---|---|
| — | A round-trip check compared a coordinate to sub-millimetre (1e-6 m) precision after it had been through two forward UTM projections and one inverse. `projection.mjs` states its own accuracy as "millimetres" — a truncated series expansion, not a closed form — so 0.047 mm of numerical noise is not a defect, and the tolerance was tightened past what the function it is testing actually promises | The test's own comment, written while investigating the failure, corrected the test rather than the library |
| — | A browser test asserted a rail tool was clicked by searching for it inside `[role="region"][aria-label="Universal"]` — a region that does not exist; the tool rail's groups are tab labels, not landmarks. The click silently did nothing, so the shapefile mode it was meant to clear never cleared, and two unrelated-looking assertions failed together | Tracing why *both* failed the same way in the same block, rather than fixing each in isolation |

Neither was a defect in the product. Both are recorded because the pattern —
one silent no-op producing two failures that look unrelated until traced back
to the same missing click — is the kind of thing that costs real time again if
forgotten.

### Traps in the browser suites themselves

These are not product defects, and none of them was. They are ways a browser
suite reports a pass it has not earned, they cost real time, and they will
recur:

- `page.mouse.click(x, y, { clickCount: 2 })` does **not** produce a `dblclick`,
  and nor do two fast `mouse.click` calls. Only `mouse.down/up({clickCount:1})`
  then `mouse.down/up({clickCount:2})` does. Symptom: the polygon draws and
  reports its area but never closes, so nothing is sent to the server.
- Panel headings use `text-transform: uppercase`, so `innerText` returns
  "CUT AND FILL". Match case-insensitively.
- `--use-gl=swiftshader` stops MapLibre creating its canvas at all.
- **A wait condition must require a rendered number.** A wait for "Draining
  through" matched the channel network's own hint text, returned instantly, and
  every later assertion read an unfilled panel, while the suite printed green.

**The same trap, four more times, always from matching `document.body`.** This
is now the single most productive source of false results in this codebase:

- A wait for the word "Lowest" was satisfied by the contour panel's "Lowest
  shown" slider, so a profile assertion ran against an unfilled panel.
- A check that no measurement panel had opened was satisfied by the tool rail's
  own "Grid Spot Levels" entry.
- A check for "&lt;number&gt; drawn" matched the page's intro copy — "every layer we
  produced for this site, drawn over each other" — whose comma satisfied
  `[\d,.]+`, reporting a viewer drawing 53,238 points as drawing none.
- A slope layer's description, "Shown in degrees", was found by a search for a
  checkbox labelled "Show".

**The fix is structural, not another regex.** The measurement, contour and point
cloud panels are now `role="region"` landmarks with names, and the suites read
*that region's* text. It is also the right thing for a screen reader, which is
usually how these coincidences resolve.

Two more, both specific to drawing:

- `getStyle().layers` **omits custom layers** — they cannot be serialised into a
  style document. Looking for the point cloud there reported a perfectly working
  layer as absent. `getLayer(id)` finds it.
- `readPixels` on MapLibre's context **returns nothing**: the map has no
  preserved drawing buffer, and asking for a context with that flag returns the
  existing one. Screenshots are composited by the browser and do not care.
- **Capturing a download needs the Blob, not its text.** Reading `blob.text()`
  inside a patched `createObjectURL` and attaching the file name in the patched
  `click` is a race — `text()` resolves after the click, so names land on the
  wrong entries and a file goes missing. Hold the Blob against its URL and pair
  them at click time; that also survives the `revokeObjectURL` that follows.
- `getSource(id)._data` **is not the public contract and does not hold what a
  `setData` put there.** It reported zero alignment stations while twenty-two
  labels were visibly on the map. `queryRenderedFeatures({ layers: [...] })` is
  both correct and the stronger claim: it proves the features were *drawn*, not
  merely handed to MapLibre.
- A marker given a **custom element keeps only that element's classes**;
  MapLibre adds `maplibregl-marker` only to elements it creates. The contour
  labels survived a sweep meant to hide overlays, then differed against the
  canvas beneath them and were counted as points 14 px west of the survey.

### From the performance round

Optimising a thing that already works has a failure mode of its own: every
defect below was introduced by a change that made something faster, and three of
the five were caught by measuring or testing afterwards rather than by the work
itself.

| # | Defect | How it was caught |
|---|---|---|
| 22 | **`FloodPanel` was changed to require four props `MapViewer` never passed.** The whole state machine — `floodArea`, `floodAreaDrawing`, `startFloodAreaDraw`, `clearFloodArea` and the draw handlers — was built in `MapViewer` and never handed down. **The map page would not have compiled.** `tsc` had not been run on that branch; the API tests do not touch the UI and the browser suite had not been run either, so nothing else could have found it | Running `tsc --noEmit` |
| 23 | **The corner lattice crashed on a polygon drawn entirely off the survey.** `ringWindow` clamps to the grid, so such a polygon comes back with `col1 < col0`. The old walkers coped by never entering their loops; building a lattice for a negative span threw "Invalid typed array length" and took down every measurement of an off-survey polygon. The unit tests missed it entirely | `analysis-contract-test` printing a blank line where a pass belonged. Two checks now assert such a polygon is *measured* — zero covered ground, null minimum — rather than throwing |
| 24 | **The flood API tests sized their boxes in metres**, so every bounded check meant something different on every survey: a 600 m box is 6 M cells on Kotba's 24 cm grid and 60 M on Aektanagar's 7.7 cm one. Five checks failed on Aektanagar by *correctly* refusing an area the test thought was small | Running the suite against a second survey. Boxes are now sized in cells, via `boxOfCells()`, and the whole-survey check is guarded to surveys that fit the budget |
| 25 | **The merge tree was used from two levels upward when it only pays from sixteen** — a regression introduced by the wiring in #69, which made the common case, a short ladder, up to **four times slower** than the traversal it replaced | Measuring after shipping, not before. §3.15 |
| 26 | **The refusal named a size that did not work.** It suggested the arithmetic maximum, and a drawn area lands just over it every time — the window is padded so edge interpolation has neighbours, it rounds outward to whole cells, and a box drawn on a lon/lat map is not square once projected. Asking for exactly the suggested 266 m came back refused at 12.2 M cells | Drawing the size the message named. The suggestion is now four fifths of the budget, and a check draws the suggested size and asserts it is accepted — telling a client a size and then refusing it is worse than refusing plainly |
| 27 | **`readWindow`'s window origin drifts on a cell size with a long mantissa.** The origin is `originX + col0 * cellSize`; on Aektanagar (0.07686839999999892) at `col0 = 2812` the window sits 2811.9999999999786 cells from the raster origin, so **a point near a cell boundary resolves one cell differently through the windowed reader than through the whole-file one** — 7.7 cm of ground, 3 mm of elevation there. It affects every windowed read. **Fixed in #79**: `Grid.cellAt` snaps a coordinate within arithmetic noise of a boundary before flooring, with a tolerance set by the origin's magnitude rather than the cell index — keying it off the index made things worse first, 258 disagreements becoming 348, because the whole-file frame got a tolerance large enough to snap and the window frame did not | Making the flood tests portable across surveys, which put the two readers side by side on a survey whose cell size is not a round number |

Number 22 is the one to learn from, and the lesson is not about types. The
branch had been interrupted mid-change, and the half that had been written was
the half that compiles on its own. A test suite that never loads the page cannot
tell you the page is broken, and `tsc --noEmit` costs seconds.

---

## 6. Where it stands

### Merged

| PR | Date | What |
|---|---|---|
| #40 | 22 Aug 2026 | Measurement severed from display; four tools on the map |
| #41 | 22 Aug 2026 | Windowed byte-range raster reads; `PORTAL_TERRAIN_URL` |
| #42 | 22 Aug 2026 | Hydrology route and map panel (tools 24–28) |
| #43 | 22 Aug 2026 | Hydrology remote prefix, avoiding a manifest collision |
| #44 | 22 Aug 2026 | Dynamic tiler |
| #45 | 22 Aug 2026 | Rendered raster layers and the vertical colourbar |
| #46 | 22 Aug 2026 | This document |
| #47 | 23 Aug 2026 | Tools grouped by discipline; contour elevation controls |
| #48 | 23 Aug 2026 | LiDAR point cloud: pipeline, route and in-map viewer |
| #49 | 23 Aug 2026 | Production confirmed end to end |
| #50 | 23 Aug 2026 | The alignment tool: tools 16, 18, 19, 20, 21 |
| #51 | 23 Aug 2026 | Grid levels, surface comparison, tolerance, and exports |
| #53 | 23 Aug 2026 | Tool 40, and a design pass over the map workspace |
| #54 | 23 Aug 2026 | The database timeout ladder, proved live and fixed |
| #55 | 24 Aug 2026 | DSM/DTM colour grading, shared with the dynamic tiler |
| #56 | 24 Aug 2026 | The shapefile tool: draw, download, upload, compare |
| #57 | 25 Aug 2026 | The profile chart overlays DTM against DSM — reversed by #62 |
| #58 | 27 Aug 2026 | Kiru Hydroelectric added as a third site, contours only at first |
| #59 | 27 Aug 2026 | Kiru: native-resolution DSM/DTM, no downsampling |
| #60 | 27 Aug 2026 | Topology-safe contour simplification; tools-unavailable diagnosed |
| #61 | 28 Aug 2026 | `upload-site.mjs`: symlinks, files over 2 GiB, multipart |
| #62 | 28 Aug 2026 | Profile shows one surface at a time again; satellite/hybrid basemap |
| #63 | 31 Aug 2026 | Simulation Water Level Rise, and a ring-grouping defect it exposed |
| #64 | 1 Sep 2026 | Flood bounded to the view, so it works on Kiru and in production |
| #65 | 5 Sep 2026 | Phase 0: the benchmark harness and the differential-test seam |
| #66 | 5 Sep 2026 | Phase 1: LZW decode in Rust/WASM — 2.4×, not the 5–10× projected |
| #67 | 5 Sep 2026 | Flood: a drawn study area, and no downsampling anywhere |
| #68 | 5 Sep 2026 | Phase 4: the merge tree, engine only |
| #69 | 5 Sep 2026 | Flood ladders answered from the merge tree |
| #70 | 5 Sep 2026 | `polygonStats`: a corner lattice — 6.8 s to 0.78 s |
| #71 | 5 Sep 2026 | Flood cell budget 4M → 12M; the merge tree only when it pays |
| #72 | 5 Sep 2026 | Read-path instrumentation, `Server-Timing`, `bench-read-path.mjs` |
| #73 | 5 Sep 2026 | A window's chunks fetched in contiguous runs — 1,465 to 13 |

Two rows of that table were wrong until this revision, and the correction is
recorded rather than quietly applied: what this document called #58 and #59 were
merged as **#63 and #64**, and **#58 to #62 were missing entirely** — the whole
of the Kiru site's arrival. A table of pull requests that skips five of them is
not a record, and the numbers are how anyone finds the reasoning later.

### Infrastructure

- **Cloudflare R2 + Worker** live, serving Kotba's and Aektanagar's terrain
  *and* hydrology by byte range, authorised by the same short-lived grant a
  browser gets
- Verified against a server with **no local data files of any kind**
- The point cloud is in R2 too, under `sites/<slug>/cloud/`: 990 objects,
  127.0 MB. Verified with `portal-data/cloud/` moved aside, so nothing local
  could have answered.
- The shapefile tool is verified against **software this project did not
  write** — `pyshp` and Python's own `zipfile` — not only against itself. See
  §3.12.

### Reading survey data from R2 rather than from a laptop

`PORTAL_TERRAIN_URL` and `PORTAL_HYDROLOGY_URL` now point at the tile Worker in
`.env.local`, joining `PORTAL_CLOUD_URL`, which had been set all along. The
rasters, the hydrology grids and the point cloud are read from the private R2
bucket, authorised by the same short-lived grant a browser gets, so a
development machine holds no copy of any of them. Kiru's DTM alone is 2.3 GB and
the raw survey folders total about 18 GB.

Verified by moving `portal-data/terrain` and `portal-data/hydrology` out of the
way entirely, so no local file could answer, and asking each survey for a spot
level: Kotba came back **364.864 m**, identical to the value the same point
returns from the local file. Then, with the local files restored — where the URL
takes precedence and the suites still compute their ground truth from disk —
`analysis-api-test` passed 77 checks on Kotba and 74 on Aektanagar, which is the
stronger statement: the bytes R2 serves produce the same measurements as the
originals.

Warm, a spot level costs about 1.3–1.6 s against roughly 0.3 s locally. Only the
first request per survey pays the network; the raster is cached per process
afterwards, which is why later requests report `io 0.0 ms`.

**This is only practical because of the coalescing in #73.** A one-megacell
window is 12 fetches and 5.18 MB, 690 ms end to end from a laptop in India. Sent
as one range request per strip, as the reader did before, the same window would
have been 1,575 sequential round trips at about a second each.

The map tiles and manifests are *not* served this way: they are committed to the
repository because the portal draws the map from them and they have to reach
Vercel. Kiru has no tiles in R2 at all, only its rasters and hydrology.

### Tests: 610 verified here, and 683 more that need something running

The previous revision of this document headlined **1,191 checks**, which had
been true a fortnight earlier and was never re-counted. Counts are now split by
whether they were actually run for this revision, because a number nobody has
re-run is a claim, not a measurement.

**Run on 5 Sep 2026, every count read off the suite's own last line. 610
checks.** These need no server, no database and no browser — only the source
rasters under `portal-data/terrain/`:

| Suite | Checks | Covers |
|---|---|---|
| `terrain-test` | 77 | measurement arithmetic against analytic surfaces, and the corner lattice against `pointInPolygon` |
| `render-test` | 60 | PNG, colour, lighting, tile maths |
| `raster-window-test` | 59 | windowed reads vs whole-file reads, cell for cell, coalesced and not |
| `engineering-test` | 58 | contractor, mining and road tools |
| `hydro-test` | 55 | routing against known answers |
| `analysis-contract-test` | 49 | the pipeline against real Kotba rasters |
| `portal-tile-grant-test` | 48 | the Worker's authorisation, written as attacks |
| `shapefile-test` | 40 | SHP/SHX/DBF/PRJ/ZIP, round-tripped, byte for byte |
| `analysis-core-test` | 38 | request sequencing, written as races |
| `merge-tree-test` | 34 | the merge tree against `connectedFlood`, fixture by fixture and on the whole survey |
| `flood-test` | 30 | the flood engine: ladders, patches, holes, survey edges |
| `portal-map-test` | 19 | manifest handling |
| `geo-differential-test` | 18 | an optimisation against the code it replaces, including one-ULP negative controls |
| `db-timeout-test` | 11 | the timeout ladder, as arithmetic on the constants |
| `lzw-test` | 7 | the WASM decoder against the JavaScript one, all three surveys, and the format's corners |
| `portal-assets-test` | 7 | asset serving |

**Not run here, so the counts below are unverified.** Each is the figure
reported by the pull request that last touched the suite; every one of them
needs a development server, a database or Puppeteer, and this document was
written on a machine already busy with other work. Treat them as the last known
good, not as today's:

| Suite | Checks | Last measured | Covers |
|---|---|---|---|
| `analysis-api-test` | 75 Kotba / 72 Aektanagar | #71 | measurement over HTTP, flood simulation included |
| `hydrology-api-test` | 61 | #73 | hydrology over HTTP |
| `portal-flood-browser-test` | 59 | #63 | the water rises, animates, exports, and yields the click |
| `alignment-api-test` | 47 | #70 | the four alignment tools, as relationships |
| `cloud-api-test` | 43 | #48 | the cloud route, and the quadtree's own invariants |
| `portal-alignment-browser-test` | 42 | #50 | drawing a centreline and asking it four questions |
| `portal-map-browser-test` | 41 | #70 | measure tools in a real browser |
| `portal-surface-browser-test` | 40 | #70 | polygon tools, and the contents of the files they write |
| `surface-api-test` | 35 | #70 | grid levels, deviation, tolerance, and the signed ramp |
| `portal-hydrology-browser-test` | 34 | #42 | hydrology panel in a real browser |
| `portal-tool-rail-test` | 34 | #47 | the tool groups, and that one tool is armed at a time |
| `shapefile-api-test` | 30 | #56 | the shapefile route: projection, refusals, round trip |
| `portal-render-browser-test` | 29 | #45 | rendered layers in a real browser |
| `portal-contours-browser-test` | 27 | #47 | contour labels, bands, index lines, colour |
| `render-api-test` | 26 | #73 | tiles over HTTP, decoded |
| `portal-shapefile-browser-test` | 26 | #56 | draw, download, upload the same file, and see it redrawn |
| `portal-map-no-terrain-test` | 18 | #49 | the production case: tiles without rasters |
| `portal-cloud-browser-test` | 16 | #48 | the cloud draws, and draws where the survey is |
| `portal-ux-test` | n/a | — | navigation feedback (no count reported) |
| `portal-smoke-test` | n/a | — | every route, every site (no count reported) |

Three of those are stale in a way worth naming rather than carrying forward.
`portal-map-browser-test` was 39 when this document last counted it, then 41
after #62 removed the DSM/DTM overlay it used to assert and #70 added to it;
`portal-flood-browser-test`'s 59 predates the study area entirely and will have
moved; `analysis-api-test` now reports a different number per survey by design,
which is the point of `boxOfCells()` (§5, defect 24).

`portal-map-no-terrain-test` needs its own server, started with the terrain
pointed nowhere; the rest of the unverified list runs against an ordinary
`npm run dev`. The nine browser suites additionally need
`npm install --no-save puppeteer` (§7.3).

Two suites fail against a development server and are expected to:
`portal-security-test`'s "no `unsafe-eval` in a production build" check, and
`portal-tracing-test`, which reads a production build's trace files. Both pass
against `npm run build`.

Not a test suite but run for this revision: `bench-geo` measures 13 primitives
and skips 4 for want of a raster, and `bench-read-path` still reports 1,575
range requests for a full-window local read — correctly, because a bare file
source is deliberately left off the coalescing path (§3.15).

Also: `hydro-validate` still agrees with SAGA at 98.1% / 98.3% catchment IoU.
Not re-run here; it needs the Kherwada dataset, which is not on this machine.

### Tool coverage against the specification

The full table, generated from the same list the dashboard reads, is
`docs/tool-catalogue.md`. In summary:

| State | Count | Tools |
|---|---|---|
| **Live** — usable on the map today | 11 | 1, 2, 5, 16, 18, 19, 25, 26, 27, 28, 40 |
| **Partly built** | 10 | 3, 4, 10, 13, 14, 15, 20, 21, 24, 37 |
| **Engine only** — written and tested, nothing calls it | 2 | 11, 17 |
| **Not built** | 4 | 7, 8, 9, 12 |
| **Blocked on data** | 1 | 6 |
| **Never specified by Malhar** | 12 | 22, 23, 29–36, 38, 39 |

**Twenty-one of the twenty-eight specified tools now do something**, up from
thirteen at the start of the day.

Nothing that remains is waiting on us alone. Tool 11 needs a second flight; tool
6 needs the same. Tool 12 needs a design-surface upload format nobody has named.
Tool 17 needs a geotechnical limit a terrain model cannot supply. Tool 7 needs
Malhar to resolve his own contradiction. Tools 8 and 9 are small and unblocked.

Outside the numbering: **the LiDAR point cloud** is live on the map, **Area**
and **Inspect** are offered in prose rather than as numbered tools, and two
tools from Malhar's own later prompts rather than the original five documents —
the **shapefile tool**, which draws, downloads, uploads and compares, and
**Simulation Water Level Rise**, which floods the DTM step by step from a
source or an elevation and exports a polygon per level.

---

## 7. Honest gaps

Stated plainly rather than left to be discovered.

### 7.1 ~~Production is deployed but unconfirmed end to end~~ — confirmed 23 Aug 2026

Om signed in to the live portal and took a spot level, and opened the point
cloud. Both work. The chain is confirmed end to end in production: session,
tenant check, windowed byte-range read from R2 through the Worker, and the
quadtree nodes alongside it.

`PORTAL_TERRAIN_URL`, `PORTAL_HYDROLOGY_URL` and `PORTAL_CLOUD_URL` are all set
on Vercel.

**One transient failure was seen and not explained.** On 23 Aug a portal page
rendered the error boundary with digest 3665730944, and reloading fixed it. What
is known:

- The deployment was current — the `cache-control: private, max-age=300` header
  on the cloud route only exists in this build.
- Vercel's logs for that window show **no 500 and no timeout**. That is not a
  contradiction: an App Router error boundary is rendered on the client from the
  streamed payload, so the request is logged as a 200. Do not go looking for a
  500 next time.
- 156 page loads in a real browser — every portal page, for every account in the
  database, owner and client — against a production build with production's
  environment, produced **zero** error boundaries.

**Later the same day the cause was proved**, and it was the theory below: a
connect timed out against the pooler, the deadline killed it at 7 s, and the
retry got the same budget. See 7.1a, now fixed. The reason the first
investigation found nothing is worth keeping: an App Router error boundary is
logged as a **200**, so looking for a 500 finds nothing however hard you look.

### 7.1a ~~The database deadline is shorter than its own connect timeout~~ — fixed 23 Aug 2026

Found while investigating 7.1's transient failure, recorded as latent, and then
**proved live the same day** by the development log:

```
[portal] session check: session check timed out after 7000ms — reconnecting and retrying once
Failed query: select ... from "sites" <- write CONNECT_TIMEOUT
  aws-0-ap-southeast-2.pooler.supabase.com:6543 [CONNECT_TIMEOUT]
```

That is the line predicted when 7.1 was first diagnosed and then set aside for
want of evidence. It is the evidence.

**What was wrong.** Three timeouts guard a portal query and each has to fire
before the one outside it, so the most specific error is the one that surfaces.
They were inverted: the driver was allowed **10 s** to connect while the request
deadline killed the attempt at **7 s**. A connection needing 7 to 10 seconds —
a cold pooler, a paused free-tier project waking — could therefore never
complete, and `queryDb`'s single retry handed it the same impossible budget. Both
attempts died and the page rendered its error boundary.

**The fix** is the ordering, not a longer wait:

```
connect_timeout (5s)  <  statement_timeout (6s)  <  request deadline (7s)
```

`connect_timeout` is now derived from the deadline rather than written down
separately, so the ladder cannot drift. A connect failure is now reported *as* a
connect failure, which `isConnectionFault` recognises, so the retry gets a fresh
pool and a real budget instead of inheriting a dead socket and a spent clock.

**Guarded by `scripts/db-timeout-test.mjs`**, which reads the constants out of
the source and evaluates the arithmetic. This is invisible to every other suite —
it needs a slow pooler to appear and a fast one hides it completely — so
asserting the relationship between the numbers is the only way it stays true.
Reverting the constant to its old value fails three of its eleven checks.

**Not a cure for a paused project.** Supabase's free tier still pauses after
inactivity and a waking instance takes far longer than any of these numbers. The
root-cause fix is a scheduled ping every few days; this makes an ordinary slow
connection succeed instead of failing twice.

### 7.2 `slope` still reads whole rasters

Tool 14's legend reports the area falling in each band across the **entire**
survey, so there is no window that answers it. It therefore still reads the file
whole and **does not work under `PORTAL_TERRAIN_URL`**. It is documented in the
route and unused by the UI, so nothing is broken, but it is the one piece that
did not move with the rest. The fix is computing the histogram from the overview
levels rather than from a window.

### 7.3 Puppeteer is undeclared

The nine browser suites need `npm install --no-save puppeteer`. It is deliberately
not in `package.json`, to keep it out of the deployment bundle, but that means
those suites cannot run in CI as things stand. If they should, it needs a real
`devDependency` entry and a CI step.

### 7.4 The R2 token has been exposed

A live R2 API token (access key and secret) was pasted into a chat transcript
during setup rather than being kept to a shell. It works and is in use. It should
be rotated in the Cloudflare dashboard, revoking and reissuing, since a copy exists
outside the intended place.

### 7.5 The database will pause again

The portal's Supabase project stopped resolving mid-session on 22 Aug 2026 and
was restored the same day. Free-tier projects pause after about a week of
inactivity and are eventually removed, and this project idles for weeks between
bursts. When it happens **every authenticated route fails at once**, because the
tenant check runs before any raster is opened, so the symptom is "the whole
portal is broken" rather than anything database-shaped.

### 7.6 Latency is dominated by the database, not the geometry

A warm round trip to Supabase in `ap-southeast-2` (Sydney) is 285 ms, and every
analysis request makes one before doing any work. The geometry itself is 3–12 ms.
Moving the database to a Mumbai region is an easy separate win.

### 7.7 Repository still in `~/Documents`

iCloud evicts `node_modules` when the disk fills, which makes every build hang at
0% CPU with no error. This has already cost a full debugging session once. The
real fix is moving the repository out of an iCloud-managed folder.

### 7.8 Still blocked on Malhar

Unchanged from 8 Aug, and none of it blocks current work:

- **12 tool numbers never specified**: 22–23, 29–36, 38–39
- **The suitability model** (weights, land use, soil, rainfall) for 4 of the 16
  hydrology layers. The weighted overlay engine should be built with weights in
  configuration so his hydrogeologist's model is a data change. **Do not invent
  weights:** a confidently wrong suitability map with a beautiful legend is the
  worst outcome available on this project.
- **Which slope scheme.** His three documents give three classifications and one
  is in percent. The UI shows degrees and percent together for exactly this
  reason: 15° is 27%.
- **The annotation contradiction.** `Important Notes.txt` lists annotation under
  "not needed"; Universal Tools #7 specifies it.
- **Whether ±4 is cm or mm, absolute or relative.** If he meant 4 mm, no drone
  workflow of any vendor reaches it, and that needs saying plainly rather than
  being absorbed as a requirement.
- **The unfilled Kherwada DTM**, needed to validate sink depth in real metres.
- **Whether any site has more than one flight**, which decides whether the time
  dimension is real or speculative.

---

### 7.9 ~~The point cloud is not in object storage yet~~ — done 23 Aug 2026

Uploaded: 990 objects, 127.0 MB, under `sites/aektanagar-survey/cloud/`. Verified
by moving `portal-data/cloud/` aside entirely and re-running both suites — 43
route checks and 16 browser checks pass with **no local cloud data on disk**, so
the bytes really are coming from R2 through the Worker.

**`PORTAL_CLOUD_URL` still needs mirroring into Vercel** for production, the
same way `PORTAL_TERRAIN_URL` and `PORTAL_HYDROLOGY_URL` were:

```
PORTAL_CLOUD_URL=https://sga-tile-gateway.sudaan203.workers.dev/sites
```

Set on Vercel on 23 Aug, and confirmed: the cloud opens in the live portal.

### 7.10 The cloud is drawn, not measured

Nothing reads a height off the point cloud. It is a layer, not a tool: the spot
level, profile and volume tools all read the source GeoTIFF, as they should,
because that is the surface with a stated accuracy attached. A client clicking
the cloud gets nothing. That is the honest position rather than an oversight —
quoting a level from a rendered point would be quoting the nearest point within
a pixel, which is not the same measurement and would not carry the survey's
±4 cm.

### 7.11 LAZ is not supported, and is not a small addition

`las.mjs` reads LAS and refuses LAZ with a stated reason. LAZ is an arithmetic
coder with per-field context models, not a container to skip past. A client
sending one has to have it expanded with `laszip` before the pipeline runs. Both
surveys here arrived as LAS, so nothing is blocked today.

### 7.12 Depth 5 is a choice, not a limit

The quadtree is built to 13.6 cm spacing, which keeps 26% of the flown points.
`--max-depth 6` would take it to 6.8 cm — essentially every point — at roughly
four times the storage and a build that holds about a gigabyte. Worth doing if
anyone asks to see the cloud at full density; not worth doing on spec.

### 7.13 A windowed read can resolve a point one cell differently — open

`readWindow` gives its window an origin of `originX + col0 * cellSize`. That is
exact when the cell size is a round number and it is not when the cell size has
a long mantissa. On Aektanagar, whose cell size is 0.07686839999999892, a window
starting at `col0 = 2812` sits **2811.9999999999786 cells** from the raster
origin rather than 2812 — so a point lying near a cell boundary resolves to one
cell through the windowed reader and to its neighbour through the whole-file
one.

Here that is 7.7 cm of ground and about 3 mm of elevation, which is well inside
the survey's stated accuracy, so nothing a client sees is wrong today. It is
recorded as open rather than closed because **it affects every windowed read**,
not only the flood, and because the size of the error is a property of the cell
size rather than of anything we control: a coarser survey with an equally awkward
mantissa moves the boundary further.

The fix is to carry the window's origin as an integer column and row against the
raster's own origin and derive world coordinates from that, rather than
accumulating a float offset. It wants its own change and its own check —
windowed against whole-file, on a survey whose cell size is deliberately not
round — and `raster-window-test` is where that check belongs.

Found while making the flood tests portable across surveys (§5, defect 27),
which put the two readers side by side on a survey nothing had previously
compared them on.

---

## 8. What to do next

1. ~~**Draw an alignment.**~~ Done, PR #50. It moved four tools as predicted.
2. ~~**Wire the three engine-only tools that needed a panel.**~~ Done, PR #51.
3. ~~**Tool 40, the dashboard summary.**~~ Done, PR #53, along with a design pass
   over the map workspace.

4. ~~**Make the flood tool fast enough to use.**~~ Done, PRs #65 to #73, and it
   is §3.15 rather than a line here because two of the four phases planned for
   it were corrected by measurement.

What is left, in order:

1. **Re-measure the read path from production**, with
   `node scripts/bench-read-path.mjs --portal=<origin> --site=<slug>`, now that
   a window's chunks are fetched in contiguous runs. Everything the plan says
   about phase 2 — moving raster compute into the Worker beside R2 — turns on
   that one number, and the only honest place to take it is the machine that
   really does the read. **Phase 2 should not be started before this is done**:
   the last two times a plan was made without it, the plan was wrong (§3.15).
2. **Fix the windowed origin drift**, §7.13. It is small, it is open, and it is
   the only known way this codebase can answer two different elevations for one
   point.
3. **Finish the export centre (tools 10 and 37).** Grid levels already export as
   CSV, TXT, DXF and LandXML from the map. Missing: a single download centre,
   PDF, SHP, LAS/LAZ, and raster export. **GeoTIFF matters more than it looks** —
   it lets a client open the exact grid we computed against in their own software
   and check our numbers, and none of Propeller, PIX4Dcloud or DroneDeploy offers
   it.
4. **Tools 8 and 9**, bookmarks and share view: the only two left that are small
   and unblocked. Share links need signing, expiry, revocation, site scoping and
   an owner kill switch, and belong in `portal-security-test.mjs` before they
   ship.
5. **Slope from overviews**, closing 7.2 — the one operation that still reads
   whole rasters and so does not work from object storage.
6. **The weighted overlay engine** for B4, with weights in configuration, ready
   for the day Malhar's suitability model arrives.

Everything else is blocked on somebody else, and §7.8 says on whom: tools 6 and
11 need a repeat flight, 12 needs a design-surface format, 17 needs a
geotechnical limit, 7 needs Malhar to resolve his own contradiction, and twelve
of the forty numbers were never described at all.

The thing worth preserving is the testing habit rather than any particular tool:
**assert relationships between independently computed values**, not shapes.
Watershed cells against accumulation. Mean depth against maximum depth. Lighting
against the closed-form equation. Windowed reads against whole-file reads, cell
for cell. A merge tree against the traversal it replaces. Every defect above was
found that way, and none of them looked like an error.

The performance round adds one habit to it, and the two are the same idea
pointed at speed instead of correctness: **measure before planning, and measure
again after shipping**. The plan's projected 5–10× kernel returned 2.4×; its
edge-compute phase turned out to be a four-kilobyte read size; and an
optimisation that was right for long ladders shipped making short ones four
times slower. None of those was visible by reasoning about the code, and all
three were visible within an afternoon of running `bench-geo`.
