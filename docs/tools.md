# Dashboard tools: what was asked for, what was built, and where it stands

Written 23 Aug 2026, covering the work merged as PRs #40 to #45 on 22 Aug 2026.

Companion to two existing documents rather than a replacement for either.
`portal-map-architecture.md` says what the architecture should be.
`dashboard-tools-plan.md` says in what order to build it. This one says what
actually happened, which decisions were taken along the way, and what is
honestly still missing.

---

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

### Infrastructure

- **Cloudflare R2 + Worker** live, serving both surveys' terrain *and* hydrology
  by byte range, authorised by the same short-lived grant a browser gets
- Verified against a server with **no local data files of any kind**

### Tests: 654 checks

| Suite | Checks | Covers |
|---|---|---|
| `terrain-test` | 59 | measurement arithmetic against analytic surfaces |
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
| `portal-map-browser-test` | 36 | measure tools in a real browser |
| `portal-hydrology-browser-test` | 33 | hydrology panel in a real browser |
| `portal-render-browser-test` | 29 | rendered layers in a real browser |
| `portal-smoke-test` | n/a | every route, every site (no count reported) |

Also: `hydro-validate` still agrees with SAGA at 98.1% / 98.3% catchment IoU.

### Tool coverage against the specification

| Tool | State |
|---|---|
| 1 Spot level | **on the map** |
| 2 Grid spot levels | served (`grid-levels`), no UI |
| 3 Cross section / profile | **on the map** |
| 4 Cut and fill | **on the map** |
| 5 Surface comparison | engine only |
| 6–9 Timeline, annotation, bookmarks, share | not started |
| 10 Export centre | engine only, not wired |
| 11–13 Contractor | engine only |
| 14 Slope | served; **whole-raster, see gaps** |
| 15 Stockpile | served (`stockpile`), no UI |
| 19–21 Roads | served, no UI |
| 24–28 Hydrology | **on the map** |
| 37 CAD export | engine only |

---

## 7. Honest gaps

Stated plainly rather than left to be discovered.

### 7.1 Production is deployed but unconfirmed end to end

All three routes answer 401 rather than 404 in production, which proves the code
shipped and that authorisation works. `PORTAL_TERRAIN_URL` and
`PORTAL_HYDROLOGY_URL` are set on Vercel.

What has **not** been verified is a real measurement in production, because
production uses a different `PORTAL_AUTH_SECRET` than local, which is correct practice,
but it means no session can be minted against it from here. **Someone should sign
in to the live portal, open Kotba's map and click a spot level.** A number
confirms the whole chain; "measurements are not available" means the environment
variables need a redeploy to take effect.

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

## 8. What to do next

In order, and none of it blocked:

1. **Confirm production** with one click, per 7.1.
2. **Tools 6–9**: timeline, bookmarks, share view, and annotation if he resolves
   the contradiction. Share links need signing, expiry, revocation, site scoping
   and an owner kill switch, and belong in `portal-security-test.mjs` before they
   ship.
3. **Wire the export centre (tool 10 / 37).** DXF, LandXML, SHP and GeoJSON
   already exist in `export-formats.mjs` and are unreachable from the UI. GeoTIFF
   export matters more than it looks: it lets a client open the exact grid we
   computed against in Global Mapper and check our numbers, and none of Propeller,
   PIX4Dcloud or DroneDeploy offers it.
4. **Slope from overviews**, closing 7.2.
5. **The weighted overlay engine** for B4, with weights in configuration, ready
   for the day his model arrives.

The thing worth preserving from this round is the testing habit rather than any
particular tool: **assert relationships between independently computed values**,
not shapes. Watershed cells against accumulation. Mean depth against maximum
depth. Lighting against the closed-form equation. Windowed reads against
whole-file reads, cell for cell. Every defect above was found that way, and none
of them looked like an error.
