# Dashboard tools: phased implementation plan

Written 8 Aug 2026, after Malhar delivered a 40 tool specification in
`Dashbord Tools_Prompt_Datasets/` and confirmed on a call that Universal tools
and Hydrology are the two priorities.

Builds on `portal-map-architecture.md`, which diagnosed the format problem and
designed the storage and analysis layer. That document says *what* the
architecture should be. This one says *in what order we build it*, and it
resolves the ordering against Malhar's own priorities.

---

## 0. Can we start today?

**Yes. Nothing is blocked.** Worth establishing up front, because the natural
assumption is that we are waiting on the Kherwada DTM.

### The hydrology fixture is already complete

Read out of the sample data on 8 Aug 2026:

| File | What it is |
|---|---|
| `Watershed/fill dem.tif` | 491 x 302, float32, 1.0 m cell, EPSG:32643, nodata -99999, tie point 345308.1866 / 2355499.1039 |
| `Watershed/*.sgrd` | SAGA headers, `CELLSIZE = 1.0`, `POSITION_XMIN = 345308.6866`, same 491 x 302 |
| `Watershed/channel network.shp` | their stream network, with attributes |
| `Watershed/basins.shp`, `catchment area_1.shp`, `catchment area_2.shp` | their delineated basins |
| `Watershed/catchment area.sdat`, `c11.sdat` | their accumulation grids, 593,128 bytes = 491 x 302 x 4, float32, headerless |

SAGA writes its origin at the centre of the first cell, GeoTIFF at the corner.
The 0.5 m difference between 345308.6866 and 345308.1866 is exactly half a cell,
in both axes. **These are the same grid.** `fill dem.tif` is the filled DEM their
routing ran on, and every SAGA product beside it is the answer we should
reproduce.

The elevations in that file read 1.9 to 16.5 m. An earlier draft of this document
called that impossible and concluded the grid must be relative, reasoning from
the Kherwara in Udaipur district, which sits at 250 to 400 m. **That was wrong,
and the georeferencing is the authority, not the place name:** the grid
unprojects to roughly 21.29 N, 73.51 E, which is in Gujarat, where those
elevations are unremarkable. It may well be absolute. Confirm with Malhar rather
than inferring a second time.

**Either way it does not matter for validation.** Flow direction, flow
accumulation, stream network, Strahler order and basin delineation all depend
only on differences between neighbouring cells, so they are invariant to a
constant vertical offset. Our outputs are directly comparable to theirs.

So we can build the hydrology engine and prove it correct against a real,
independently produced GIS result before writing any UI.

### Track A has its own data already on disk

`DTM/Kotba_DTM.tif` with its `.tfw` and `.prj`, `DSM/`, `Contours/`, and the
Aektanagar survey are all here. Phase 0 conversion and the accuracy work need no
new input.

### What we do need from Malhar, and when it actually bites

| Needed | Blocks | Bites at |
|---|---|---|
| Kherwada DTM GeoTIFF, absolute elevation, unfilled | validating the *fill* step and sink depth in real metres | B2, not B0 or B1 |
| Slope classification: degrees or percent, and which of his three schemes | the slope legend only | B3 |
| Suitability criteria and weights, plus land use / soil / rainfall | check dam, farm pond, recharge, reservoir | B4 only, 4 of 16 layers |
| Is the +/- 4 cm or mm, absolute or relative | what we print in the tolerance field, not the schema | A1 |
| Does any site have more than one flight today | whether the time dimension is real or speculative | A5 |

None of these stop Phase 0, A1 to A4, or B0 to B3. That is most of a quarter of
work that is unblocked right now.

---

## 1. Two tracks, because the two modules have different shapes

Malhar's clarification on the call, that Universal tools consume ortho and DTM
and more, while Hydrology consumes only the DTM, is the most useful thing he has
said about sequencing. It means the two modules have opposite dependency
profiles:

| | Universal | Hydrology |
|---|---|---|
| Inputs | many layers per survey | one DTM |
| Compute | interactive, windowed, sub second | batch, whole raster, minutes |
| Depends on | storage, tiler, tile auth, map UI, session | a container and a GeoTIFF |
| Can be validated | against Global Mapper, per number | against their SAGA output, wholesale |
| Blocked by | Phase 0 | nothing |

**Flow routing cannot be windowed, even in principle**, because water enters the
window from outside it. That single fact forces hydrology into a batch pipeline,
and having forced it there, it also frees hydrology from the entire portal
stack. It becomes `dtm.tif` in, a directory out.

So the two run in parallel. Track A is plumbing first. Track B is algorithm
first. They converge when hydrology outputs are registered as map layers.

---

## 2. Phase 0: the shared foundation

Both tracks need one container, so it is built once. This phase is also the
answer to Malhar's accuracy question, which makes it sellable rather than
invisible infrastructure.

**Goal.** Stop the portal adding error of its own, and give both tracks a place
to run.

**Work.**

1. **One container image**: GDAL, WhiteboxTools, Python with rasterio, rio-tiler,
   pyogrio, shapely, pyproj, and FastAPI. This retires the "GDAL is not installed
   on the operator machine" blocker from `portal-map-architecture.md` section 7
   without installing anything on the laptop, and it is the same image that will
   later run on a machine with disk when Dang Forest arrives.
2. **Convert Kotba and Aektanagar DSM and DTM to COG**, native resolution, native
   UTM 43N, float32, overviews included, real nodata sentinel.
3. **Stand up TiTiler** in the container, reading COGs over range requests.
4. **R2 bucket, Cloudflare Worker, HMAC signed cookie**, per architecture section
   5. Move the existing Aektanagar pyramid across unchanged first, so the
   authorisation path is proven before the format changes underneath it.
5. **Analysis endpoints, v1**: point elevation, line profile, polygon window
   statistics. All read the source COG in native UTM at native resolution with
   bilinear interpolation.
6. **Sever the measurement path from the display path.** Terrain RGB tiles stay
   for hillshade, where 0.1 m quantisation is invisible. `dem-sampler.ts` stops
   being a measurement tool. Today `elevationAt` uses `Math.floor` on a tile
   quantised to 10 cm at 13.7 cm per pixel, which is 3 to 5 times coarser than
   the survey it is reporting.
7. **Per survey `rmse_z` column** on `surveys`, populated from that survey's
   checkpoint report, replacing the hardcoded tolerance passed into
   `MeasurePanel`.

**Exit criteria.**

- The same point read in Global Mapper and in the portal agree to the
  millimetre, on both Kotba and Aektanagar.
- Aektanagar serves at its flown 1.83 cm, not 4.57 cm.
- A tile request without a valid cookie is refused by the Worker, covered by
  `portal-security-test.mjs`.
- No code path computes a reported number from a Terrain RGB tile.

**Demo for Malhar.** Two screens side by side, Global Mapper and the portal,
same point, same number. This is the direct answer to the accuracy question and
it is worth showing before anything else.

### Phase 0 progress, 8 Aug 2026: the authorisation path

Item 4, the R2 bucket, the Worker and the signed cookie, is built and tested. It
was taken first deliberately: it needs no Docker, no GDAL and no Cloudflare
account to develop against, and it is the piece everything else sits behind.

- `src/lib/portal/tile-grant-core.mjs`, the rules
- `src/lib/portal/tile-grant.ts`, the portal's secret and cookie handling
- `src/app/api/portal/sites/[siteSlug]/tile-grant/route.ts`, the one
  authorisation decision, tenant checked with the same `getSite` as every other
  route and answering 404 for both "no such site" and "not yours"
- `workers/tile-gateway/`, the Worker and its `wrangler.toml`
- `scripts/portal-tile-grant-test.mjs`, 48 checks

**The rules live in one file, imported by all three runtimes.** The first draft
duplicated them into the Worker, which was a bad idea worth naming: an
authorisation rule that exists in two places drifts, and the copy nobody
remembers to update is the one on the edge holding a private bucket open.
Wrangler bundles the shared import, so there is nothing to keep in sync.

The tests are written as attacks rather than as features, because the dangerous
request is the plausible one: a client with a genuine, unexpired, correctly
signed grant for their own site, asking for something else. Covered:

- a valid grant cannot read another client's site, though the object exists
- **a valid grant cannot read a site whose slug merely starts with its own.**
  `kotba-survey` must not reach `sites/kotba-survey-2/`, which a plain
  `startsWith` allows and which is what real slugs in this portal look like
- traversal, including percent encoded, backslashes and leading slashes
- expiry, wrong secret, tampered payload, tampered signature, unsigned token
- writes and deletes refused, cross origin preflight refused
- a missing object and a forbidden one answer **identically**, so the status code
  cannot be used to enumerate the bucket
- a Worker deployed without its secret serves nothing, failing closed

Two properties worth keeping when this is wired up:

- **The grant is not the session.** The payload carries a site and an expiry and
  nothing else: no user id, no email, no role, no client id. Compromising the
  edge yields one site's tiles for half an hour, not an identity.
- **`PORTAL_TILE_SECRET` is not `PORTAL_AUTH_SECRET`**, and the code refuses to
  start if they match. The tile secret is deployed to Cloudflare; the session
  secret mints logins and must never leave our own infrastructure.

Still to do in phase 0: create the bucket and deploy the Worker, move
Aektanagar's existing pyramid across unchanged to prove the path end to end
before any format changes, then COG conversion and the tiler.

---

## Track A: Universal tools

### A1. The DTM query set (tools 1, 3, 2, 4, 5)

Built in that order, because each one reuses the previous one's machinery.

**Tool 1, Spot level.** Click gives X, Y, Z. Coordinates in **UTM 43N easting and
northing by default**, with lat/lon as an option, because that is what their CAD
expects. Copy to clipboard, accumulate a list, export.

**Tool 3, Cross section.** Draw a line, sample server side at roughly one cell
spacing. Returns elevation profile, slope, chainage, cumulative distance,
min/max/mean. Replaces the current client side profile. PDF and CSV export.

**Tool 2, Grid spot levels.** Polygon plus spacing of 0.5, 1, 2 or 5 m. The grid
**snaps to a projected UTM grid, not lat/lon**, or the spacing is not really the
spacing. Scale guardrail: 0.5 m over 100 ha is 4 million points, so this needs a
point cap with a clear warning, and large exports stream server side rather than
building in browser memory.

**Tool 4, Cut and fill.** The important one, and the one most likely to be
quietly wrong. Rules, from architecture section 6b:

- Computed in UTM 43N, never in degrees.
- **The reference surface is a required choice, never a silent default**: flat
  plane at a stated elevation, best fit plane, boundary interpolated surface, a
  second survey's DEM, or an uploaded design surface. The answer changes
  completely between these.
- Every result carries an uncertainty band. Systematic error over area A is
  `bias x A`, so 4 cm over a hectare is 400 m3. Random error over n cells is
  `sigma x A / sqrt(n)`, which at 10 cm cells over a hectare is 0.4 m3 and
  irrelevant. The UI should report the systematic figure, because that is the one
  that can embarrass us.

**Tool 5, Surface comparison.** Two DEMs, difference raster, statistics. Uses a
zero centred diverging ramp, never the rainbow, because the sign of the number
must survive the colour choice.

**Exit criteria.** A known volume test: a synthetic DEM shaped as a cone and a
pyramid, where the analytic volume is exact, matched to within floating point.
Plus a hand check against one of Sudaan's existing Volume Analysis Reports.

### A1 progress, 8 Aug 2026

The computation behind tools 1 to 5 and 10 is built and tested. It needs none of
phase 0: that gates serving these over HTTP and wiring them to the map, not
working out the numbers, and the numbers are the part that can be quietly wrong.

`scripts/lib/terrain-analysis.mjs` and `scripts/lib/export-formats.mjs`, driven by

```
node scripts/terrain-run.mjs --dtm <file.tif> --op spot|profile|grid|cutfill|diff [...]
```

`scripts/terrain-test.mjs` runs 59 checks. The surfaces are linear on purpose:
bilinear interpolation is exact on a plane and the midpoint rule is exact for a
linear integrand, so a volume over a cell aligned rectangle has a closed form
answer to check against rather than a tolerance to hide behind. Cut and fill over
a 20 x 20 m square came back at **480.000 m3 against an analytic 480**.

Run against the real `DTM/Kotba_DTM.tif` at 24 cm, a 1 ha polygon gives cut
18,553 m3, fill 1,459 m3, net 17,095 m3, and at Sudaan's advertised 4 cm the
uncertainty is **plus or minus 399.8 m3, which is 2.3% of the net**. That is the
400 m3 per hectare figure from `portal-map-architecture.md` section 6b, now
computed rather than quoted.

What was built to the rules rather than to the demo:

- **Bilinear, not nearest neighbour.** The browser sampler in `dem-sampler.ts`
  uses `Math.floor`, so a spot level can sit half a cell from where the client
  clicked, which on a 15 degree slope is 13 cm of error the sampler invented.
- **The reference surface is a required argument** with no default, and it is
  echoed back in the result. `plane:<z>`, `boundary` (least squares through the
  polygon rim) and `surface:<file>` are three different questions.
- **Cells on the polygon boundary are subsampled** for partial coverage rather
  than being counted in or out by their centre. A half cell error all the way
  round the edge is most of the cells there are for a road corridor.
- **Every export states its CRS**, and the ones whose format cannot carry it get
  a `.prj` sidecar. `345308, 2355499` is a valid position in all sixty UTM zones.
- **LandXML writes northing before easting**, per the schema. The other order
  produces a perfectly valid file that transposes the survey, so it has a test.

**The reader now decodes LZW**, which turned out to be necessary rather than
nice: the Kherwada fixture is uncompressed but `Kotba_DTM.tif` is not, and nor is
most GeoTIFF that GDAL, QGIS or Global Mapper writes by default. It reads
337.137 to 424.254 m, which is exactly the range `context.md` section 8g recorded
from the entirely separate sharp based pipeline.

Not built yet: tools 6 to 9, and the HTTP and UI layers for all of them.

### A2. Export centre (tool 10, plus tool 37 and Malhar's GeoTIFF addition)

**Formats.** CSV, DXF, LandXML, SHP, GeoJSON, PDF, LAS/LAZ, and **GeoTIFF**,
which Malhar added after the first review.

**Rules that apply to every export.**

- The CRS is always stated. A CSV of X, Y, Z with no projection is worse than
  useless in a CAD workflow. Default UTM 43N, `.prj` sidecar written alongside.
- GeoTIFF exports are **COG, native resolution, native UTM, float32 for
  elevation, real nodata, masked to the drawn polygon** rather than its bounding
  box. Never reprojected to Web Mercator on the way out, which would undo the
  Phase 0 accuracy work.
- Derived rasters export too, not just sources: the cut and fill difference grid,
  the slope raster, every hydrology layer.
- Large exports run as an async job with a download link.

**Why GeoTIFF export matters more than it looks.** It lets a client open the
exact grid we computed against in Global Mapper and check our numbers
themselves. For a client who does not want to compromise on quality,
verifiability beats assurance, and none of Propeller, PIX4Dcloud or DroneDeploy
offers it.

### A3. The Global Mapper render (Malhar's DSM/DTM note)

Our DSM does not show trees for three reasons: a single hue warm ramp stretched
across the 2nd to 98th percentile has almost no local contrast, the hillshade is
a separate toggleable layer at exaggeration 0.55 rather than being composited
under the colour, and resolution is lost to the pre bake.

**The recipe**, applied at the tiler as request parameters, which is only
possible once the DEMs are COG:

| Ingredient | Spec |
|---|---|
| Ramp | classic elevation rainbow, blue to cyan to green to yellow to orange to red, across true min and max |
| Hillshade | Horn's method, azimuth 315, altitude 45, z factor 1 in a projected CRS, exaggeration 1.5 to 2 |
| Composite | multiply or overlay, hillshade normalised to roughly 0.4 to 1.2 gain |
| Legend | vertical colourbar, round interval ticks, labelled in metres, as in his reference image |

Rainbow ramps are perceptually non uniform and create false edges, so we ship
rainbow as the default because he asked for it and surveyors read it, offer
viridis and a terrain ramp alongside, and **never** use rainbow for cut and fill
or surface difference.

**Free win in the same phase:** CHM = DSM minus DTM. His own Kherwada set
contains a Tree Height Map, so it is already wanted, and it is most of the
missing railway vegetation tool.

### A4. Saved objects, bookmarks and sharing (tools 8, 9, and 7 if confirmed)

**Measurements become saved, named, re openable PostGIS objects** with their own
properties panel, not transient overlays. This is the one PIX4Dcloud pattern
worth copying early: it makes measurements shareable and re openable, which the
EnerComp reference does not do at all.

- Tool 8, bookmarks: camera state in the database. Cheap.
- Tool 9, share view: **signed, expiring, revocable, site scoped, view only,
  logged, with an owner kill switch.** A share link that escapes tenant isolation
  would break the one thing we have that the reference does not. Goes through
  `portal-security-test.mjs` before it ships.
- Tool 7, annotations: cheap once PostGIS holds geometry, but `Important
  Notes.txt` lists annotation under "not needed" while the Universal doc
  specifies it. Build only after he resolves that.

### A5. The time dimension (tool 6, and tools 11 and 12 downstream)

Gated on the answer to "does any site have more than one flight today". The
`map_layers` table carries `survey_id` from the start regardless, so this never
needs migrating later.

- `map_layers` and PostGIS per architecture section 6.
- SELECT DATE in the UI, timeline and swipe comparison. `CompareSlider` already
  exists on the marketing site.
- Change detection between flights, which is where the "+/- 1 to 2 percent on
  volume change" claim becomes real, because systematic bias largely cancels
  between two surveys tied to the same control.

---

## Track B: Hydrology

### B0. Validation harness first, before any pipeline

**Goal.** Prove the engine against their SAGA output before building anything on
top of it. Nothing here needs the portal.

**Work.**

1. Read `fill dem.tif` in the container.
2. Run WhiteboxTools: D8 pointer, D8 flow accumulation, stream network at a
   threshold, Strahler order, basins, catchment from their `pour point.shp`.
3. Compare against their outputs on the identical grid:
   - accumulation grids: cell aligned raster difference, plus rank correlation
   - `channel network.shp`: buffered overlap percentage at 1 to 2 cells
   - `basins.shp` and `catchment area_*.shp`: intersection over union
4. Write up every divergence with an explanation. Algorithm differences between
   SAGA and Whitebox are expected at the margins; unexplained differences are
   bugs.

**Why WhiteboxTools.** Single static Rust binary, MIT licensed, no GDAL
dependency chain, and it carries the whole list: Wang and Liu fill, D8 and
D infinity, Strahler order, basins, hillslopes. Their data came from SAGA, which
makes it an independent implementation to check against rather than the same code
twice.

**Exit criteria.** A written agreement report with numbers, checked into the
repo, plus a regression test that fails if agreement degrades.

**Demo for Malhar.** Our channel network drawn over theirs, with the measured
agreement figure. This is the strongest possible opening move on the module he
called most important, and it needs nothing from him.

### B0 result, measured 8 Aug 2026

Built and passing. Full run in `docs/hydrology-validation-report.txt`, regenerate
with `node scripts/hydro-validate.mjs`.

| Check | Result |
|---|---|
| Catchment 1 vs SAGA `catchment area` | IoU **98.1%**, recall 100.0% |
| Catchment 2 vs SAGA `c11` | IoU **98.3%**, recall 100.0% |
| Stream network, 2 m tolerance | precision **92.1%**, recall **96.2%** |
| Strahler maximum order | 4, same as SAGA |
| Flow accumulation conservation | exact, 100,477 of 100,477 cells |
| Runtime | 40 ms for 148,282 cells |

Two things in that table are worth more than the headline percentages.

**Recall is 100.0% on both catchments**, meaning SAGA's catchment is a strict
subset of ours: there is no cell they include that we miss. The disagreement is
entirely cells we add. Of those, **66% and 82% respectively touch nodata or the
grid edge, against a 1.6% base rate** across the survey, a 40x and 50x
enrichment. So the residual is boundary handling on a ragged survey footprint,
not a difference in how water is routed. Our fill deliberately treats nodata as
outside the world so a survey with a ragged edge drains through its real
boundary; SAGA evidently clips instead. Both are defensible and ours is the
better choice for drone deliverables, which are never rectangular.

**The accumulation threshold was swept, not assumed**, because SAGA's value was
not supplied with the data. Best agreement lands at 500 cells, 0.05 ha of
contributing area. Recall stays at or above 99.9% from 50 to 300 cells while
precision climbs from 24% to 73%, which is the signature of a correct network
being progressively pruned rather than a wrong one being tuned to fit.

Separately, `node scripts/hydro-test.mjs` runs 36 known-answer checks with no
reference data at all: a tilted plane where the flow direction and accumulation
are arithmetic, a dug pit where fill depth is what was dug, a Strahler network
written out by hand, and a flood where the connected answer and the bathtub
answer differ. Agreement with SAGA shows we match another implementation; those
show the implementation is right.

**Two engine bugs the known-answer tests caught** that the SAGA comparison did
not, both of the silent kind:

- Sink depth was measured against the epsilon-drainage surface, so a perfectly
  flat plane reported 121 filled cells. Fill now carries two surfaces: the
  epsilon one for routing, and the true pond level for measuring.
- The pit test itself was wrong before the code was. On sloping ground a pit
  fills to its spill point, not back to the surface it was cut from, so the
  recovered depth is legitimately less than the depth dug. That is now its own
  test case rather than a misunderstanding waiting to be rediscovered.

### B1. The production pipeline

**Goal.** One command, one DTM, a full product set.

**Work.**

- CLI, in the spirit of the existing one command per site flow:
  `hydro-run --dtm x.tif --cell 1.0 --out dir/`
- **Cell size is an explicit parameter defaulting to 1 m.** Running D8 on a
  native 2.5 cm grid is not higher quality, it is worse: every rut and vegetation
  artefact becomes a spurious sink and the stream network turns into noise driven
  braiding. Their own run used exactly 1 m from a 2.5 cm ortho, a 40x downsample.
  It is also what makes scale possible: Dang Forest at 1 m is 450 million cells,
  heavy but fine, while at 5 cm it is 180 billion and simply impossible.
- Raster outputs as COG: filled DEM, flow direction, flow accumulation, slope,
  aspect, sink depth, stream order.
- Vector outputs as GeoJSON, PMTiles and SHP: streams with order attribute,
  basins, pour points.
- **Boundary handling.** A catchment truncated by the AOI edge is silently wrong.
  Buffer the DTM with Copernicus 30 m outside the AOI so upstream area is at
  least approximated, and flag any basin touching the boundary as having
  incomplete upstream area.
- **Nodata discipline.** Their SAGA headers declare nodata 0, which is ambiguous
  for accumulation, since 0 is a legitimate value on a ridge. We use a real
  sentinel throughout.
- Deterministic: same input and parameters produce a byte identical output hash.
- Unit tests on synthetic DEMs with known answers: an inclined plane for slope
  and aspect, a single pit for fill and sink depth, a simple V valley for
  routing.

### B1 progress, 8 Aug 2026

`scripts/hydro-run.mjs` exists and runs the whole batch from one command:

```
node scripts/hydro-run.mjs --dtm <file.tif> --out <dir> [--cell 1] [--threshold 500]
```

On the Kherwada fixture, 208 ms: six GeoTIFF rasters (filled, sinks, flow
direction as ESRI codes, flow accumulation, slope, Strahler order), `streams.geojson`
at 95 segments and 2.26 km, `basins.geojson` at 6 basins, and `manifest.json`
carrying per layer provenance: `derivedFrom`, `generator`, `params`, `crs`,
`stats` and a sha256. Two consecutive runs produce identical hashes for all eight
layers, so determinism is verified rather than asserted.

**95 segments against SAGA's 87** is a second, structural agreement check on top
of the cell-by-cell one: we split the network at the same kind of node they do
and arrive within 9%.

Three things this surfaced that are worth carrying forward:

- **Every one of the 6 basins is truncated by the survey edge.** The first
  version of the check tested only the raster boundary and reported zero, which
  was wrong: a drone footprint is ragged and sits inset from its own bounding
  box, so water leaves through nodata long before it reaches the edge of the
  file. Any contributing area quoted from this survey alone understates the real
  one, which is exactly what the Copernicus buffering item above is for, and it
  now travels with every basin as `truncated_by_survey_edge`.
- **Resampling refuses to upsample** rather than inventing detail, and excludes
  nodata from the average rather than counting it as zero, which would drag a
  ragged edge downwards and manufacture a slope.
- **GeoJSON export refuses to run on a non UTM grid** instead of guessing a
  zone. 345308 E is a valid easting in all sixty of them.

Still outstanding for B1: COG rather than plain GeoTIFF, and WhiteboxTools as the
production engine. Both need GDAL, so both belong in the container.

### B2. The interactive layer

Cheap, but only because B1 precomputed the grids.

- **Tool 26, watershed on click.** An upstream traversal over the precomputed D8
  pointer grid, which is a graph walk, not a raster analysis. Sub second.
- **Tool 27, sink detection.** Filled minus raw, thresholded. Free once fill has
  run. This is where the unfilled Kherwada DTM is finally needed to validate
  against real metres.
- **Tool 28, flood simulation.** Set a level, get inundation and storage volume.
  **Must be a connected component fill from a water body or pour point, not a
  bathtub threshold.** Colouring every cell below a level is wrong and looks
  right: it floods hilltop depressions no water can reach. This is the same class
  of silent error as computing area in degrees.
- Tools 24 and 25, flow direction and accumulation, are display of B1 output plus
  a click to inspect readout.

**B2 status, 8 Aug 2026.** The algorithms are done and covered by known answer
tests, and exposed on the CLI:

```
node scripts/hydro-run.mjs --dtm x.tif --out d/ --pour-point E,N --flood-level 4.0
```

On Kherwada that returns a 5.304 ha catchment, matching the figure validated
against SAGA, and a 4 m flood standing 942 m3 over 0.126 ha. The flood is a
connected component fill from a seed, so an isolated hollow at the same elevation
stays dry; the test for that builds a DEM where the bathtub answer and the right
answer differ, because on a map they look identical. What remains for B2 is the
HTTP endpoints and the map UI, and that genuinely is gated on phase 0.

### B3. Presentation

- The eight legend specifications from his Hydrology docx, built as data rather
  than hardcoded, with dynamic ranges and plain language engineering meaning so a
  non GIS user can read them.
- Per layer on/off, transparency, and a click anywhere readout: elevation, slope,
  flow accumulation, watershed area, stream order.
- Exports per A2, including GeoTIFF.
- **Slope units.** His three documents give three different classifications, one
  of them in percent, and 15 degrees is 27 percent, so they cannot be reconciled.
  The UI shows the unit explicitly and offers a degrees / percent toggle
  regardless of which scheme he picks.

### B4. Suitability layers

**Blocked on Malhar, and correctly so.** Check dam, farm pond, recharge structure
and reservoir suitability are weighted multi criteria models, not terrain
physics. He supplied the output bands, 80 to 100 high and so on, but not the
criteria or the weights, and the models need land use, soil group, geology and
rainfall, none of which exist in a DTM. Runoff and storage estimates additionally
need rainfall and a curve number.

Build the **weighted overlay engine** in B3, with weights and thresholds in
configuration rather than code, so that when his hydrogeologist supplies the
model it is a data change. Do not invent weights. A confidently wrong suitability
map with a beautiful legend is the worst outcome available to us on this project.

---

## 3. Cross cutting work

**Schema.** `map_layers` per architecture section 6, extended to distinguish
delivered from computed layers, because hydrology alone adds roughly 16 derived
layers per survey:

- `source` layers: ortho, DSM, DTM, contours, point cloud.
- `derived` layers, with provenance: `derived_from`, `generator`
  (`whitebox:D8FlowAccumulation`), `params` jsonb (cell size, fill method,
  threshold), `computed_at`.

When a client asks where a stream network came from, the answer should be a
database row. It is also what lets a layer be re run when a parameter changes.

**Security.** The Worker is new attack surface and belongs inside
`portal-security-test.mjs`, not bolted on afterwards. Share links get their own
test cases. Tenant isolation must hold for tiles, analysis endpoints and exports,
not only pages.

**Testing, the rule that matters.** Every analysis endpoint needs a test with a
known answer before a client sees it. A wrong volume looks exactly like a right
one. Three tiers: synthetic geometry with analytic answers, the Kherwada SAGA
cross check, and the existing style of independent cross check where the DTM and
the contours are read from different files and compared.

---

## 4. What we are copying, and what we are not

Malhar suggested PIX4Dcloud as the model. Right on the shell, worth splitting on
the substance.

| Product | Take | Leave |
|---|---|---|
| PIX4Dcloud | project and dataset structure, map plus right side analysis panel, simple layer list, design overlay, measurements as saved named objects | its ingestion half, see below |
| Propeller | the analysis semantics: explicit reference surface on every volume, published accuracy method, stated tolerance per measurement, progress timeline | hardware and pricing coupling |
| DroneDeploy | sharing and annotation patterns | depth of analysis, thinner than it looks |
| Hydrology | nobody has it, so lead rather than copy | |

**The scope boundary worth writing down.** PIX4Dcloud is built around its own
photogrammetry pipeline: you upload images and it processes them. **We are not
doing processing.** Sudaan already processes in Pix4D, Agisoft and Global Mapper
and delivers rasters. We copy the viewer and analysis half and explicitly not the
ingestion half. If "similar to PIX4Dcloud" is left unqualified it eventually
implies building a photogrammetry pipeline, which would be a serious misreading
of scope.

PIX4Dcloud is also weakest exactly where Malhar is strictest. Its volume tool
does not foreground reference surface or uncertainty. Propeller does, because its
customers get audited on quantities. Given the accuracy conversation, Propeller's
framing is the one to copy.

---

## 5. Risks

- **Two new services for one operator.** Unchanged from architecture section 11,
  and now load bearing: the container runs both the tiler and the hydrology
  engine, so there is no fallback that keeps volumetrics.
- **Hydrology cell size is a judgement call we are making on his behalf.** 1 m is
  defensible and matches his own run, but it should be surfaced in the UI rather
  than hidden, so nobody is surprised that the hydrology grid is coarser than the
  survey.
- **The suitability layers are the reputational risk on this module**, not the
  routing. Routing we can validate. Suitability we cannot, without his model.
- **Dang Forest remains the deadline.** 450 km2 within months. Phase 0 and B1
  both need to be done before it lands, or it gets published the old way and
  converted twice.
- **Photogrammetric DTM under canopy is interpolated guesswork.** For a 450 km2
  forest this is not academic, and LiDAR is the only real answer. Worth raising
  with the field team now rather than after delivery.
- **The +/- question is still unresolved.** If Malhar meant 4 mm, no drone
  workflow of any vendor reaches it, and that needs saying plainly rather than
  being absorbed as a requirement.
