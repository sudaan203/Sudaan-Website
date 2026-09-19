---
name: gis-development
description: Sudaan's actual GIS/geospatial implementation — the engine modules under src/lib/geo, coordinate system and format handling, the storage/tiling pipeline, and the specific bugs this codebase has already found and fixed (nodata sentinels, contour PolyLineZ, sharp's float-GeoTIFF trap, the R2 manifest-namespace collision, elevation colour drift). Load before touching spatial data, the map, or a numbered dashboard tool.
---

# GIS development

No PostGIS, no GDAL, no ImageMagick, no poppler on this machine or in
production. Everything spatial here is hand-rolled against raw GeoTIFF,
Shapefile, GeoJSON, and LAS bytes. That constraint explains most of the
unusual code in `src/lib/geo/`.

## Engine modules (`src/lib/geo/*.mjs` — pure, no framework imports)

`colour.mjs` / `elevation-image.mjs` (the single owner of elevation ramp +
clip + hillshade — see below), `engineering.mjs` (volumes/cut-fill),
`export-formats.mjs`, `flood.mjs` (spill/flood), `forest.mjs` /
`forest-export.mjs` / `forest-report.mjs`, `hydrology.mjs`, `hypsometry.mjs`,
`kml.mjs`, `las.mjs` (point cloud), `lzw.mjs` / `lzw-wasm.mjs` (TIFF
decompression, WASM-backed by `native/lzw/`), `merge-tree.mjs`,
`projection.mjs`, `raster.mjs` / `raster-window.mjs` / `raster-source.mjs`,
`render.mjs`, `shapefile.mjs`, `terrain-analysis.mjs`, `tiles.mjs`,
`vectorise.mjs`, `zip.mjs`. Check here before writing a new primitive.

## Coordinate systems and formats

- Source rasters are **UTM-projected GeoTIFFs**. The map pipeline
  re-projects corners to WGS84 for MapLibre by hand (`projection.mjs`) —
  there's no CRS library.
- **Deliberately unsupported, throw rather than guess**: non-UTM projections
  (geographic, Lambert, Web Mercator), rotated world files, ECW (unreadable
  without GDAL), orthomosaic imagery fed into the elevation path.
- **Shapefile** (`.shp`/`.dbf`/`.prj`) is parsed directly, by hand.
- **Contours**: read `PolyLine` (type 3) *and* `PolyLineZ` (13) — most real
  exports use 13 because it carries height per vertex, and a reader that
  only accepts type 3 produces an empty layer with **no error**.
- **LAS point clouds**: multi-return, no vegetation classification. **LAZ is
  not supported** — it's an arithmetic coder, not a container; expand with
  `laszip` first.

## Storage and tiling

- Every large data class (terrain, map, hydrology, forest, cloud) has a
  `PORTAL_<CLASS>_DIR` (local) / `PORTAL_<CLASS>_URL` (production, HTTP
  range reads) pair, checked by `storage-config.ts`. Production reads are
  always windowed — only the bytes covering the requested polygon/tile,
  never the whole file.
- Production storage is a **private Cloudflare R2 bucket**, reachable only
  through `workers/tile-gateway/`. No listing, no writes from the public
  side, no cross-site reads.
- **The R2 manifest-namespace trap**: the map pyramid owns
  `sites/<slug>/manifest.json`. Hydrology, forest, and cloud each write a
  file of that name too if uploaded to the site root — so they each get
  their own sub-segment (`sites/<slug>/hydrology/`, `.../forest/`,
  `.../cloud/`). Uploading to the wrong level silently overwrites the map's
  manifest; the symptom is the *map* losing its layers, with nothing that
  mentions the actual cause.
- Rendering is either a **baked tile pyramid** (`make-tiles.mjs`,
  `make-terrain-tiles.mjs`, `make-overview.mjs`) or the **dynamic tiler**
  (on-demand — a tile is just a window read, no container needed).

## Elevation colour: one owner

`src/lib/geo/elevation-image.mjs` holds the ramp, clip percentiles, and
hillshade — every renderer must call into it. This used to not be true: five
independent copies existed (baked tiles, dynamic tiler, site previews, the
marketing DEM renderer, both point clouds), two of which were silently
*wrong* — one preview script never negated its north-south gradient, so
every ridge rendered as a valley, and survived review for months because an
inverted hillshade still looks like terrain. `colour-consistency-test.mjs`
greps the tree for a new local ramp definition and fails CI if it finds one,
including a north-south ridge case chosen because the "obvious" version of
that test would have passed on the broken code.

## Bugs already found — don't rediscover these

- **`-9999` (and `-32767`, `-32768`, `-3.4e38`) are nodata sentinels, not
  elevations.** Bound checks by plausible range (~-500 to 9000 m), not a
  loose threshold — a `v < -1e4` check let `-9999` through by a metre.
- **`sharp(...).raw()` silently returns 8-bit RGB for a float GeoTIFF**
  without `{ depth: "float" }` — produces convincing-looking nonsense (one
  early run reported a DSM spanning -24 to 0 m). It also expands one band to
  three; read with the correct stride.
- **A `.dbf` can store elevation as text** (`"338 m"`) — a bare `Number()`
  silently gives `NaN`. Route numeric coercion through
  `src/lib/portal/numbers.ts`.
- **Colour must clip to the 2nd–98th percentile**, not the raw min/max — one
  143 m outlier once flattened an entire survey to a single shade.
- **Reductions tile; traversals need a precompute.** A per-window/per-tile
  computation (slope, local stats, hillshade) scales fine on demand. A
  traversal that needs global connectivity (flood spill, flow accumulation)
  does not — it needs a precomputed structure (coarse connectivity cell +
  level table, as flood spill now uses) rather than being refused as "too
  large" or run tile-by-tile in a way that gives wrong answers at boundaries.

## Testing

`node scripts/<engine>-test.mjs` per engine (terrain, hydro, flood,
engineering, forest, render, shapefile, kml, lzw, merge-tree, hypsometry,
coarsen, reduction, geo-differential, accuracy, colour-consistency). Most are
synthetic/closed-form and need nothing; a few cross-check against a real
survey raster (Kotba is the usual fixture) and skip gracefully when it's
absent locally. `raster-window-test.mjs` specifically needs real DTMs (one
BigTIFF-tiled, one stripped survey) because it proves the windowed reader
against the exact file layouts the portal serves — a synthetic fixture
wouldn't test the thing it exists to test. See the `testing` skill for the
full CI-vs-manual split.
