# Dashboard tools: what was asked for, what was built, and where it stands

Written 23 Aug 2026, covering the work merged as PRs #40 to #45 on 22 Aug 2026.

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

### 3.10 Tool 40, and a design pass (#52)

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

### Test-harness traps worth remembering

These cost real time and will recur:

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
| #52 | 23 Aug 2026 | Tool 40, and a design pass over the map workspace |

### Infrastructure

- **Cloudflare R2 + Worker** live, serving both surveys' terrain *and* hydrology
  by byte range, authorised by the same short-lived grant a browser gets
- Verified against a server with **no local data files of any kind**
- The point cloud is in R2 too, under `sites/<slug>/cloud/`: 990 objects,
  127.0 MB. Verified with `portal-data/cloud/` moved aside, so nothing local
  could have answered.

### Tests: 997 checks

| Suite | Checks | Covers |
|---|---|---|
| `terrain-test` | 74 | measurement arithmetic against analytic surfaces |
| `engineering-test` | 58 | contractor, mining and road tools |
| `hydro-test` | 55 | routing against known answers |
| `portal-tile-grant-test` | 48 | the Worker's authorisation, written as attacks |
| `analysis-core-test` | 38 | request sequencing, written as races |
| `analysis-contract-test` | 49 | the pipeline against real Kotba rasters |
| `raster-window-test` | 55 | windowed reads vs whole-file reads, cell for cell |
| `render-test` | 60 | PNG, colour, lighting, tile maths |
| `analysis-api-test` | 47 | measurement over HTTP |
| `hydrology-api-test` | 61 | hydrology over HTTP |
| `render-api-test` | 26 | tiles over HTTP, decoded |
| `cloud-api-test` | 43 | the cloud route, and the quadtree's own invariants |
| `alignment-api-test` | 47 | the four alignment tools, as relationships |
| `surface-api-test` | 35 | grid levels, deviation, tolerance, and the signed ramp |
| `portal-map-browser-test` | 36 | measure tools in a real browser |
| `portal-hydrology-browser-test` | 34 | hydrology panel in a real browser |
| `portal-render-browser-test` | 29 | rendered layers in a real browser |
| `portal-tool-rail-test` | 34 | the tool groups, and that one tool is armed at a time |
| `portal-contours-browser-test` | 27 | contour labels, bands, index lines, colour |
| `portal-cloud-browser-test` | 16 | the cloud draws, and draws where the survey is |
| `portal-alignment-browser-test` | 42 | drawing a centreline and asking it four questions |
| `portal-surface-browser-test` | 40 | polygon tools, and the contents of the files they write |
| `portal-map-no-terrain-test` | 18 | the production case: tiles without rasters |
| `portal-assets-test` | 7 | asset serving |
| `portal-map-test` | 19 | manifest handling |
| `portal-ux-test` | n/a | navigation feedback (no count reported) |
| `portal-smoke-test` | n/a | every route, every site (no count reported) |

`portal-map-no-terrain-test` needs its own server, started with the terrain
pointed nowhere; the rest run against an ordinary `npm run dev`.

Two suites fail against a development server and are expected to:
`portal-security-test`'s "no `unsafe-eval` in a production build" check, and
`portal-tracing-test`, which reads a production build's trace files. Both pass
against `npm run build`.

Also: `hydro-validate` still agrees with SAGA at 98.1% / 98.3% catchment IoU.

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

Outside the numbering: **the LiDAR point cloud** is live on the map, and
**Area** and **Inspect** — both specified in prose rather than as numbered
tools — are offered at the end of their groups.

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

So the cause is unproven and the leading theory (a cold connection killed by the
deadline below) was **not** supported by the logs. If it recurs, the thing worth
capturing is the URL and the log entry carrying the digest, not the status code.

### 7.1a The database deadline is shorter than its own connect timeout

Found while investigating the above, and real whether or not it caused it.
`QUERY_TIMEOUT_MS` is 7,000 ms (`src/lib/portal/db/client.ts`) while the pool's
`connect_timeout` is 10 seconds. The deadline therefore fires first, so a
connection that would have completed between 7 and 10 seconds is killed — and
`queryDb`'s single retry kills it again at 7. Any cold connect in that band fails
both attempts and throws.

Measured from this machine: first query **1,914 ms**, every one after **275 ms**.
That is comfortably inside the budget today, which is why this is a latent
ordering bug rather than a live fault. Supabase's free tier also pauses projects
after inactivity, and a waking instance takes far longer than ten seconds; a
scheduled ping every few days is the root-cause fix, not a longer timeout.

### 7.2 `slope` still reads whole rasters

Tool 14's legend reports the area falling in each band across the **entire**
survey, so there is no window that answers it. It therefore still reads the file
whole and **does not work under `PORTAL_TERRAIN_URL`**. It is documented in the
route and unused by the UI, so nothing is broken, but it is the one piece that
did not move with the rest. The fix is computing the histogram from the overview
levels rather than from a window.

### 7.3 Puppeteer is undeclared

The four browser suites need `npm install --no-save puppeteer`. It is deliberately
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

---

## 8. What to do next

1. ~~**Draw an alignment.**~~ Done, PR #50. It moved four tools as predicted.
2. ~~**Wire the three engine-only tools that needed a panel.**~~ Done, PR #51.
3. ~~**Tool 40, the dashboard summary.**~~ Done, PR #52, along with a design pass
   over the map workspace.

What is left, in order:

1. **Finish the export centre (tools 10 and 37).** Grid levels already export as
   CSV, TXT, DXF and LandXML from the map. Missing: a single download centre,
   PDF, SHP, LAS/LAZ, and raster export. **GeoTIFF matters more than it looks** —
   it lets a client open the exact grid we computed against in their own software
   and check our numbers, and none of Propeller, PIX4Dcloud or DroneDeploy offers
   it.
2. **Tools 8 and 9**, bookmarks and share view: the only two left that are small
   and unblocked. Share links need signing, expiry, revocation, site scoping and
   an owner kill switch, and belong in `portal-security-test.mjs` before they
   ship.
3. **Slope from overviews**, closing 7.2 — the one operation that still reads
   whole rasters and so does not work from object storage.
4. **The weighted overlay engine** for B4, with weights in configuration, ready
   for the day Malhar's suitability model arrives.

Everything else is blocked on somebody else, and §7.8 says on whom: tools 6 and
11 need a repeat flight, 12 needs a design-surface format, 17 needs a
geotechnical limit, 7 needs Malhar to resolve his own contradiction, and twelve
of the forty numbers were never described at all.

The thing worth preserving from this round is the testing habit rather than any
particular tool: **assert relationships between independently computed values**,
not shapes. Watershed cells against accumulation. Mean depth against maximum
depth. Lighting against the closed-form equation. Windowed reads against
whole-file reads, cell for cell. Every defect above was found that way, and none
of them looked like an error.
