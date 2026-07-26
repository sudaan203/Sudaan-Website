# Portal Map Architecture, Phase 3 onwards

Written 26 Jul 2026, after the owners judged the dashboard well short of the
EnerComp reference. This is a design document, not a description of what exists.

**What it supersedes.** `client-portal-plan.md` section 8.1 says pre cut every
raster into an XYZ pyramid in QGIS and upload the directory. `context.md` section
8j says the same and adds that the portal redirects to a short lived signed URL.
Both are revised here. Section 8.2 of the plan, on the other hand, was right
about the thing that matters most and had already spotted the flaw in the signed
URL idea; it is carried forward and made concrete.

---

## 1. The gap, measured rather than felt

Read off `reference/dashboard/02-orthomaps-ortho.jpg`, their OrthoMaps screen
against ours:

| Their map | Ours |
|---|---|
| `SELECT DATE` per acquisition | nothing, one survey only |
| Layer tree in 4 groups (Drawing, Layers, Drone Imagery, Base layers) | flat list |
| Per layer: checkbox, opacity slider, delete | checkbox, opacity slider |
| Draw and measure toolbar, 9 tools | nothing |
| Live lat/long readout | nothing |
| Page size, Resolution, Export PDF | nothing |
| Save view | nothing |
| OSM and Google base layers | one OSM toggle, off by default |

Left rail entries we do not have at all: **PointClouds (Potree), Comparison,
REPORT_WRITING**, plus their eight per category data tabs collapsed into our one
generic file table.

`MapViewer.tsx` is 472 lines and offers checkboxes, an opacity slider and a
basemap toggle. That is roughly a quarter of their map, and the map is most of
their product.

## 2. Diagnosis: the stack is not the cause

The reference is React plus MongoDB. Rebuilding on that would cost months and
lose the work that is hardest to retrofit, all of which we already have and they
do not: tenant isolation enforced in SQL, view only enforced at the route, 404
rather than 403 so an id is never confirmed, a CSP, sessions re checked per
request, per segment loading states. Their product is single tenant with a
DOWNLOAD button on every row.

MongoDB is also the wrong direction for where this has to go. Measurement,
volumetrics and change detection are PostGIS work, and Supabase can enable
PostGIS with one statement.

**Decision: keep Next.js and Postgres.** The stack is not what is holding the
dashboard back.

## 3. What is actually holding it back

One decision, made in this repo, and it was mine: **pre baking WebP pyramids and
committing them to git.**

The size ceiling is the obvious cost. 1 MB for Kotba is fine, 22 MB for
Aektanagar is awkward, 450 km² of Dang Forest is impossible. But the greater cost
is that a pre baked pyramid is **frozen pixels**:

- No restyling a DEM without re exporting the pyramid
- No NDVI or any band math, because the bands were flattened into RGB
- No comparing two dates without baking a third product
- No hillshade on demand, contour interval change, or ramp adjustment
- Publishing means running a script and committing about 1,700 binary files,
  which can never be self service. This is exactly why they have `ADD MONUMENT`
  and we have nothing like it.

Aektanagar's orthomosaic is served at 4.57 cm instead of the 1.83 cm that was
flown, purely because the pre bake step could not hold a 749 Mpx image in memory.
Every feature the owners want sits downstream of this.

## 4. Target architecture

Two formats, chosen per layer by whether the pixels ever need to change. This is
the part worth getting right, and a single answer would be wrong.

### 4a. PMTiles for imagery and vectors

A PMTiles archive is **one file** containing a whole tile pyramid, readable over
HTTP range requests. No server, no thousands of files.

Use it for layers whose pixels are final:

- Orthomosaic (true colour, never restyled)
- Contours, GCPs, drainage, any vector layer, as vector tiles

What it fixes immediately: 1,714 files become 1, the git problem disappears, the
50 MB trigger disappears, and native resolution comes back because nothing has to
fit in memory at request time.

MapLibre reads PMTiles through the `pmtiles` protocol handler.

### 4b. COG plus a dynamic tiler for elevation and analysis

A Cloud Optimized GeoTIFF keeps internal tiling and overviews in one file and
supports range requests. A tiler reads only the bytes a tile needs and renders on
demand.

Use it for layers whose pixels must stay live:

- DSM and DTM, so ramps, hillshade and contour intervals become request
  parameters instead of baked output
- Multispectral imagery, so NDVI is computed from the NIR band
- Any layer that feeds measurement, volumetrics or change detection

TiTiler (FastAPI, `rio-tiler`) on Cloud Run or Fly, scaling to zero so idle cost
is near nothing.

### 4c. COPC for point clouds

Store the LiDAR as **COPC** (Cloud Optimized Point Cloud), a LAZ file with an
internal octree, readable by range request. Potree renders it directly. This
avoids PotreeConverter's directory of thousands of files, which is the same
mistake as the WebP pyramid in a different costume.

The Aektanagar cloud is 1.7 GB and 45.2 million classified points, already on
disk and currently represented in the portal by a 159 byte text placeholder.

### 4d. Why not one format for everything

Pre baked (PMTiles) is cheaper to serve and needs no service, but the pixels are
final. Dynamic (COG) costs a running service but keeps the data live. Imagery
never needs restyling; elevation is the input to every analytic we want to sell.
Splitting on that line gets both properties and keeps the service small enough
that one person can operate it.

## 5. Authorising tiles, the genuinely hard part

`client-portal-plan.md` 8.2 already identified this and it is worth restating,
because `context.md` 8j currently contradicts it and 8j is wrong:

**Per object signed URLs do not work for tiles.** One pan fires hundreds of tile
requests. Signing each one, or redirecting each through a Next route, adds
latency and burns serverless invocations. The signed URL redirect is correct for
*assets*, a PDF or a CSV fetched once, and only for those.

The design for tiles:

1. When a client opens the map tab, the portal verifies site access exactly as it
   does now, through `db/queries.ts`, then sets a **short lived HMAC signed
   cookie** scoped to that site.
2. A **Cloudflare Worker** in front of the R2 bucket validates that cookie and
   streams the range request. One authorisation decision covers the whole
   session, no per tile signing, and bytes never touch a Vercel function.
3. The bucket stays private with listing disabled. No `r2.dev` URL, no public
   custom domain. A public bucket would defeat view only and tenant isolation in
   one step, which is precisely the mistake in the `upload.ts` that was deleted
   from this branch.

Range requests make this stricter than the old plan, not looser: one PMTiles or
COG file per layer means one object to authorise instead of an unguessable
prefix over thousands.

## 6. Data model: the missing time dimension

`surveys` already exists with `flown_on`, and `assets.survey_id` already points
at it. Nothing in the map path uses either. The manifest has no date axis, which
is why `SELECT DATE` and Comparison cannot be built.

Changes:

- New table `map_layers`: `id`, `survey_id`, `key`, `title`, `group`
  (drawing / vector / imagery / elevation / base), `format`
  (pmtiles / cog / copc / geojson), `storage_key`, `min_zoom`, `max_zoom`,
  `bounds` (PostGIS `geometry(Polygon, 4326)`), `style` jsonb, `sort_order`,
  `is_published`.
- The manifest stops being a file in the bundle and becomes a query. `store.ts`
  gains `getMapLayers(session, siteSlug, surveyId)`, tenant scoped like
  everything else, so visibility keeps living in one place.
- Enable PostGIS. `bounds` as real geometry makes "which layers intersect this
  view" and later the volumetrics work a query rather than JavaScript.

The layer groups in the reference come straight out of the `group` column, and
`SELECT DATE` is a list of that site's surveys.

## 6b. Computing measurements and volumes

Confirmed scope on 26 Jul 2026: **clients operate the analysis themselves**, they
do not just receive a report. That makes this a tool rather than a viewer and it
is the main thing the reference does not do, so it gets designed rather than
bolted on.

### Where the computation happens

Not in the browser and not in a Vercel function. The same service that tiles the
COGs answers analysis requests, because it already has the one capability that
matters: **a windowed read**. `rio-tiler` and `rasterio` fetch only the byte
ranges of a COG covering a given polygon, so the cost of a volume calculation
scales with the size of the polygon, not the size of the survey. A cut and fill
over two hectares of Dang Forest reads two hectares of DTM.

Endpoints, all tenant checked by the portal before the Worker will pass them:

| Request | Reads | Returns |
|---|---|---|
| Polygon volume | DTM window | cut m³, fill m³, net, area, mean depth |
| Line profile | DTM samples at about one cell spacing | distance and elevation array |
| Point elevation | single DTM pixel | elevation |
| Change detection | two DEM windows | difference raster plus net volume |
| NDVI | red and NIR bands | rendered tile or per polygon statistics |

### The correctness detail that separates this from a toy

**Area and volume must be computed in a projected CRS, never in WGS84 degrees.**
A polygon drawn on a MapLibre map arrives as lon/lat. Computing area on those
numbers gives square degrees, which is meaningless and varies with latitude.
Every survey here is UTM 43N, so the polygon is transformed to the site's UTM
zone first, via PostGIS `ST_Transform`, and only then measured.

This is worth stating plainly because it is the most likely place for this feature
to be quietly wrong, in the same way the contour `.dbf` storing `"338 m"` as text
was quietly wrong. A wrong volume looks exactly like a right one.

Two more rules of the same kind:

- **Volume needs a stated reference.** Cut and fill against what: a flat plane at
  a given elevation, the polygon's boundary interpolated as a surface, or a second
  survey's DEM. The answer changes completely and the UI must make the client
  choose rather than defaulting silently.
- **Report uncertainty with the number.** Sudaan advertises plus or minus 3 to 4
  cm. Over a hectare, 4 cm of vertical error is 400 m³, which can dwarf the
  quantity being measured. A volume shown without a tolerance invites a client to
  treat it as exact, and that is a commercial risk, not just an accuracy one.

### What PostGIS holds

Geometry and results, not pixels: drawn features per user and survey, saved
measurements, layer bounds, and the site's UTM zone so transforms do not have to
be guessed. This is also what makes measurements shareable and re openable, which
the reference does not appear to support at all.

## 7. Ingestion, which is what makes it a product

Today: run a script, commit 1,700 files. The reference has `ADD MONUMENT` in the
UI. The target, in order of ambition:

1. **Now:** `prepare-site.mjs` becomes a converter and uploader. It writes
   PMTiles, COG and COPC instead of tile directories, uploads to R2, and inserts
   `map_layers` rows. One command, no git, no repository growth.
2. **Next:** the owner console gains an upload form for a prepared bundle, so a
   site can be published without a terminal.
3. **Later:** direct upload of raw deliverables with conversion running server
   side. This is the only step that needs real compute and it can wait.

GDAL is not installed on the operator machine, which has shaped several
decisions. Conversion to COG, PMTiles and COPC all want it. Installing GDAL, or
running the conversion in a container, is a prerequisite for step 1 and should be
settled before any of this starts.

## 8. Where things run, and cost

| Piece | Runs on | Cost |
|---|---|---|
| App, auth, authorisation | Vercel, unchanged | current plan |
| Postgres plus PostGIS | Supabase, unchanged | current plan |
| PMTiles, COG, COPC objects | Cloudflare R2 | 10 GB free, egress free |
| Tile authorisation | Cloudflare Worker | 100k req/day free |
| Dynamic tiler and analysis | Cloud Run or Fly, scale to zero | about zero idle |

Two new services, both effectively free at today's volume, and neither in the
request path for anything except imagery and analysis.

### The one place cost stops being free

Confirmed 26 Jul 2026: **a site the scale of Dang Forest, 450 km², is expected
within a few months.** That settles the architecture question, the dynamic tiler
is necessary rather than optional, and it introduces the first real bill:

- 450 km² at 5 cm is 180 Gpx, about 540 GB as raw RGB. As a compressed COG,
  realistically 50 to 150 GB.
- R2 past the 10 GB free tier is $0.015/GB/month, so 100 GB is about **$1.50 a
  month**, and egress stays free. This is not the problem.

**The problem is conversion, not storage.** The operator machine has about 28 GB
of free disk and 8.6 GB of RAM. It cannot hold, let alone convert, a 540 GB
deliverable. Nor could it pre bake a pyramid for it, which is a further argument
for dynamic tiling: with COG there is nothing to pre generate.

The way out is to stop converting after the fact:

**Ask the processing team to deliver COG directly.** QGIS bundles GDAL 3.1 or
later, which has a native COG driver, so the workstation that already runs Pix4D,
Agisoft and Global Mapper can export COG as its normal output. This removes the
conversion step from the operator machine entirely and is the same kind of ask as
the existing one in `context.md` 8i (GeoTIFF or PNG/JPG with `.tfw` and `.prj`, in
UTM). Extend that ask to: **COG, in UTM, overviews included.**

If a non COG deliverable does arrive for a large site, conversion has to run
somewhere with disk, which means the container from section 7 on a machine with
space, not this laptop.

## 9. Build order

Each phase is useful on its own and does not depend on the next.

**Phase 3a. Storage and authorisation.** R2 bucket, the Worker and the signed
cookie, the asset route redirecting for single files. Move Aektanagar's existing
pyramid across as it is, before changing formats, so the authorisation path is
proven independently of the format change. Removes the repository as a CDN.

**Phase 3b. Formats.** Ortho and contours to PMTiles, DSM and DTM to COG behind
the tiler. Aektanagar returns to native 1.83 cm. `prepare-site.mjs` becomes the
converter and uploader.

**Phase 3c. The time dimension.** `map_layers`, PostGIS, the store method,
`SELECT DATE` in the UI. Comparison becomes mostly UI work after this, because
`CompareSlider` already exists on the marketing site.

**Phase 3d. A real WebGIS.** Layer groups, measure and draw, live lat/long, base
layer choice, Export PDF, saved views. This is the phase that closes the visible
gap, and it is deliberately after the foundation rather than before it.

**Phase 3e. Point clouds.** COPC plus Potree. The most impressive single item in
the reference, and the data is already here.

## 10. What "better than them" means

Parity is a 2023 single tenant viewer with a download button. The reference is
the floor, not the target. The differentiators all follow from Sudaan selling
analytics rather than hardware, and none of them exist in the reference:

- **Measurement that is correct**, computed against the DTM in PostGIS rather
  than from screen pixels. Real slope, real elevation profile along a line.
- **Volumetrics on demand.** Draw a polygon, get cut and fill against the terrain
  model. Already advertised, already produced by hand as a Volume Analysis
  Report.
- **NDVI and band math live**, from source bands rather than a rendered picture.
- **Change detection between flights**, DSM minus DSM, which is what an
  infrastructure client actually pays for.
- **View only that is real**, enforced at the route and the Worker.

## 11. Risks, and what would change my mind

- **Two new services for one operator.** This is the real cost of the decision and
  it no longer has an escape hatch: with client side analysis confirmed, the tiler
  is load bearing, so falling back to PMTiles only would drop volumetrics and
  NDVI, not merely live styling. Keep the service boring, one container, one
  image, no state.
- **GDAL is not installed on the operator machine.** A hard prerequisite, see
  section 7, and section 8 explains why the better answer is to stop needing it
  locally by having COG delivered.
- **Wrong numbers are worse than missing numbers.** Section 6b exists because a
  volume computed in degrees, or against an unstated reference, or quoted without
  a tolerance, is a commercial risk. Every analysis endpoint needs a test with a
  known answer before a client sees it, in the spirit of the existing cross check
  where the DTM and the contours are read from different files and compared.
- **The Worker is new surface area.** It must be treated as part of the security
  boundary and covered by `portal-security-test.mjs`, not bolted on.
- **Client browsers.** Range requests and WebGL2 are required for COG, PMTiles
  and Potree. Fine on current desktops, worth checking against whatever the
  owners' clients actually use.
- **Dang Forest is the deadline.** The architecture is now sized for it, so the
  schedule risk is that it arrives before 3a and 3b are done and gets published
  the old way, which would mean converting it twice.

## 12. Questions, and the answers so far

**Answered 26 Jul 2026 by the owners:**

1. **Will a site the size of Dang Forest reach the portal, and when?** Yes, within
   a few months. The dynamic tiler is therefore required, not optional, and
   section 8 covers the conversion problem this creates.
2. **Do clients operate the analysis themselves, or receive a report?** They
   operate it themselves. Section 6b is the design, and it moves volumetrics and
   measurement from "differentiator we might build" into core scope.

**Still open:**

3. Does any site have more than one flight today? If not, `SELECT DATE` in 3c is
   speculative and could move after 3d, though the `map_layers` table should carry
   `survey_id` regardless so it does not need migrating later.
4. Can the processing team deliver COG directly (section 8)? This is the highest
   leverage question left, because a yes removes the conversion step from the
   operator machine permanently and a no means standing up a conversion container
   with real disk before Dang Forest arrives.
5. Which of the analysis outputs matters most commercially: volumes, profiles, or
   change detection between flights? All three are in 6b, and the order they ship
   in should follow what clients ask for rather than what is easiest.
