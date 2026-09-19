# Forest: a sixth department, and what the data will actually support

Plan for the Forest Tree Detection, Classification & Inventory dashboard
described in `2. Forest Tree Detection and Inventory Dashboard.pdf`
(Malhar, 19 Sep 2026), built as its own department alongside Universal,
Hydrology, Contractor, Mining and Roads.

Written for Om, to execute, and for Malhar, to argue with before anything is
built. Everything in §1 was measured on this machine on 19 Sep 2026, not
assumed.

---

---

## 0. Addendum, 19 Sep 2026 — Malhar's answers, a pivot, and what was measured

Malhar answered the six questions in §10. Two of the six answers change this
plan's architecture; the rest confirm or delegate. Recorded here per his and
Om's instruction, so nothing is re-derived or re-asked.

### 0.1 His answers, verbatim in substance

| Q | His answer | Effect |
|---|---|---|
| 1. Which survey | **Ektanagar 1.** ("Dang forest" was a mistaken name — no such survey exists here.) | Scope narrows to one 25 ha site. Kiru's 2,605 M cells and its tiling urgency are **out of scope for this delivery** — §2.4's tiling code still gets built (it is cheap and it is the right shape) but nothing forces validating it at Kiru's scale yet. |
| 2. Any field data | **None. Nothing measured on the ground.** | Confirms §8's limit as written: only internal consistency and reference-implementation agreement can be reported. No error bar on a real-world tree height or DBH is possible, ever, for this dataset. |
| 3. Detection method | **Crown diameter from the orthomosaic, by image segmentation** — QGIS DeepForest/GeoAI plugin, or YOLOv8-seg, "whichever is best." | **This replaces the primary detection method.** See §0.2. |
| 4. Who edits | **Both** owner and client roles. | §6.3's open question closes: no new role tier, both existing portal roles get write access, gated only by the existing tenancy check. |
| 5. Expected trees/ha | Not understood as posed; delegated to us. | See §0.3 — decided without an external number. |
| 6. Ship counts before crowns | Not understood as posed; delegated to us. | See §0.3 — the pivot itself answers this. |

### 0.2 The architecture pivot, and what was actually tested before deciding it

§3's plan — CHM local maxima, smoothed, watershed-segmented — is **not** what
was asked for. Malhar wants detection driven by the orthomosaic image, not by
the elevation surface. Three tool families were named; only one is buildable
without data we do not have:

- **YOLOv8-seg** needs labelled crown masks to train or fine-tune on. Per 0.1
  row 2, none exist, and there is no time-boxed way to produce them. A
  YOLOv8-seg model with no forestry-specific weights would detect nothing
  useful. **Ruled out**, not attempted.
- **QGIS DeepForest/GeoAI plugins** are desktop GUI tools. This portal has no
  place to run a GUI plugin from — every other product here is a headless
  batch script or a server route, and a step that requires a person sitting at
  QGIS breaks the one-command publish pipeline that F6.5 exists to protect.
  **The underlying models are used; the GUI is not.**
- **DeepForest**, the Python package the plugin wraps, ships a model
  (`weecology/deepforest-tree`) **pretrained on aerial RGB forest imagery**,
  usable for inference with **no training data of our own** — which is the
  only option compatible with row 2. This is the one actually run.

**What was tested, on this machine, before deciding this, rather than assumed:**

- Python tooling: `uv` installs cleanly via pip (PyPI is reachable; Homebrew's
  own API was not, that afternoon). `uv venv --python 3.12` gets a pinned
  interpreter without touching the system's Python 3.14 — new enough that
  `torch` does not yet reliably ship wheels for it. **This is the environment
  every forest Python script must be built in: `uv venv --python 3.12`, never
  system `python3`.**
- `uv pip install deepforest` resolved and installed cleanly: torch 2.14,
  torchvision, rasterio, transformers, all on Python 3.12, arm64.
- Apple's MPS backend was detected and used automatically —
  `GPU available: True (mps), used: True` — with no configuration. Inference
  is GPU-accelerated on this hardware for free.
- Run against a real 3000×3000 px (55 m × 55 m) crop of the Ektanagar 1
  orthomosaic at its native 1.83 cm/px resolution: model load 30.6 s (one
  time, includes downloading the ResNet-50 backbone), inference 10.3 s,
  **1,038 raw boxes → 717 after NMS.**

**717 boxes in 0.3 ha is roughly 2,370/ha — implausibly dense for any real
canopy, and it is not a defect in the test, it is the honest behaviour of a
model trained on closed-canopy US forest plots pointed at a mixed-use surveyed
site with roofs, parked vehicles and bare ground.** This is not a reason to
abandon the approach. It is confirmation that **§3.5's rejection pipeline —
originally written to filter our own LiDAR-seeded candidates — is not made
redundant by switching to an image model, it becomes load-bearing for it.**
Nothing in this codebase reports a raw model's output as a measurement without
checking it, and DeepForest's boxes are no exception.

### 0.3 Two calls made without an answer from Malhar, recorded so they can be revisited

**On tree density (Q5):** no external calibration figure exists. Rather than
invent one, F6.1's hand-digitised plots become the *only* ground truth used
to judge whether the pipeline's density is plausible, and the report states
plainly that the number is validated against our own digitising, not against
an independent expectation. If Malhar later gives a number for a site he
knows, it becomes the calibration target and this note should be updated.

**On delivery order (Q6):** the pivot answers this by itself. A crown polygon
is DeepForest's direct output, refined by our own CHM-based extraction —
crowns are no longer the *last* thing produced, they are upstream of most
attributes. Counts and heights population the moment F1 lands. The plan's
phase order is kept as written for the same reason it always applied — F2 is
still the first thing worth showing Malhar — but "counts before crowns" is
moot: they now arrive together.

### 0.4 The revised pipeline

```
DTM + DSM                          CHM at 0.25 m, per §2.3, unchanged
Orthomosaic (native 1.83 cm/px)
  → DeepForest (weecology/deepforest-tree, uv-venv python 3.12)
  → per-tile boxes, tiled + NMS'd across the whole survey
  → pixel boxes reprojected to UTM 43N via the ortho's own world file
                                    (no reprojection step needed: ortho, DSM,
                                     DTM and the archived LAS are all already
                                     EPSG:32643 — confirmed by reading every
                                     .prj file in the delivery folder)
  → candidate boxes handed to the JS engine, which OWNS everything from here:
      - crown polygon: CHM cells above a per-box adaptive threshold,
        connected-component within the box, simplified — tied to real
        elevation data rather than to a purely visual mask
      - attributes: height, ground/top elevation, crown area/perimeter/
        diameters, exactly as §3.4 defined them
      - §3.5's six discriminators, run against DeepForest's boxes instead of
        LiDAR-seeded maxima — same functions, same thresholds, new input
      - confidence: DeepForest's own box score becomes a seventh input,
        folded in beside the six from §3.6, still stored component by
        component
      - DBH attempt (§3.7), point density and porosity: from the point
        cloud. The portal's own quadtree is decimated to ~26% of flown
        points (per the existing point-density trap already on record) and
        must not be used for a density figure. `sites/aektanagar-survey/
        source/` holds the original 1.71 GB LAS, archived to R2 by PR #96
        (`--publish --skip-source` opts out; this is the survey where it was
        kept). R2 credentials are present in `.env.local`; pulling it back
        for a one-time enrichment pass is the documented, endorsed way to
        reuse an archived delivery and costs nothing in egress.
```

### 0.5 What this changes in the task list

- **Phase F0** gains nothing further to measure — the DeepForest feasibility
  test above *is* F0 for the detection question, already run, already
  informing F1.
- **Phase F1** splits along a seam that makes it parallelisable: a Python
  detection script that never touches elevation data, and a JS engine that
  never touches a model, joined by one GeoJSON contract (candidate boxes:
  polygon geometry in EPSG:32643, a `score` property, nothing else). Each side
  can be built and tested without waiting on the other.
- **Everything from F2 onward is unchanged in shape**, because the manifest,
  `trees.bin`, crown pyramid and every served artifact were always designed to
  not care which detector produced the candidates.
- Kiru's scale problem (§2.4, F0.7) is **deferred, not solved**, and should
  stay deferred until Ektanagar 1 is validated and Malhar has seen it.

## Contents

1. [What the data actually is](#1-what-the-data-actually-is)
2. [The five decisions that shape everything else](#2-the-five-decisions-that-shape-everything-else)
3. [The engine](#3-the-engine)
4. [Serving it](#4-serving-it)
5. [The web layer](#5-the-web-layer)
6. [Manual editing: the first tool that writes](#6-manual-editing-the-first-tool-that-writes)
7. [Export](#7-export)
8. [Validation](#8-validation)
9. [Section-by-section verdict on the specification](#9-section-by-section-verdict-on-the-specification)
10. [Questions for Malhar](#10-questions-for-malhar)
11. [Task list](#11-task-list)

---

## 1. What the data actually is

The specification assumes vegetation-classified LiDAR. We do not have that.
What we have is better than I expected in one way and worse in another, and
both facts change the design.

### 1.1 The point clouds are genuine multi-return LiDAR

Sampled directly from the LAS records, 19 Sep 2026:

| | Ektanagar 1 (`aektanagar-survey`) | Ektanagar 2 (`ektanagar-2-survey`) |
|---|---|---|
| points | 50,183,644 | 328,741,202 |
| LAS | 1.2, format 3 | 1.4, format 7 |
| file | 1.71 GB | 11.83 GB |
| pulses with >1 return | **31.3 %** | **15.1 %** |
| deepest return seen | 7th | 6th |
| classification | 1 Unclassified 49.4 %, 2 Ground 50.6 % | 1 Unclassified 37.2 %, 2 Ground 62.8 % |

**31 % multi-return means the pulse is penetrating the canopy.** That is the
single most important fact in this document. It means:

- under-canopy returns exist, so a stem-band DBH attempt (§6 of the spec) is
  worth making rather than being refused outright;
- canopy porosity is a *measurable* discriminator between a tree and a roof,
  which is what §16 of the spec is really asking for;
- "point density around the tree" is a real quantity, not a fabrication.

A photogrammetric surface would have shown 100 % single returns and half of
this plan would have had to be deleted. It did not.

### 1.2 But nothing is classified as vegetation

Only classes 1 and 2 are present. Class 3/4/5 (low/medium/high vegetation) do
not appear in either file. So the spec's pipeline step "Ground/Non-Ground
Classification" is **half done by the vendor**: ground is classified and
trustworthy, and "non-ground" is an undifferentiated bag holding canopy,
buildings, poles, wires, vehicles and noise. Separating that bag is our job,
not a given. See §3.5.

### 1.3 There is a real forest in Ektanagar 1

Canopy height estimated per 10 m cell as (max non-ground z − min ground z),
from a 604,623-point sample, 1,727 cells carrying both classes:

```
median 8.1 m    p75 11.0 m    p90 13.9 m    p99 19.7 m    max 26.4 m

0–2 m    7.9 %  |  5–8 m   23.1 %  |  10–15 m  24.8 %
2–3 m    6.1 %  |  8–10 m  18.6 %  |  15–20 m   6.1 %
3–5 m   12.4 %  |                  |  >20 m     0.9 %
```

This maps almost exactly onto Malhar's default height classes, including the
sparsely populated `>15 m` tail. **Ektanagar 1 is the development and
validation dataset.** It is 25 ha, it has 50 M points, it is on this disk, and
it is genuinely wooded.

### 1.4 What each survey can support

| survey | DSM | DTM | LiDAR | ortho | forest path |
|---|---|---|---|---|---|
| `kotba-survey` | 0.157 m | 0.241 m | — | yes | CHM only |
| `aektanagar-survey` | 0.077 m | 0.077 m | **yes** | yes | full |
| `ektanagar-2-survey` | 0.074 m | 0.074 m | **yes** | yes | full |
| `kiru-hydroelectric-survey` | 0.254 m | 0.254 m | — | ? | CHM only |
| `suigam-survey` | — | yes | — | yes | **none** |

Two consequences:

- **Suigam has no DSM, so it gets no forest department at all.** A CHM needs
  two surfaces. The department must be absent for that site rather than
  present and empty — the same rule hydrology already follows.
- **Kotba's DSM and DTM are on different grids** (2143 × 2423 at 15.7 cm
  against 1393 × 1575 at 24.1 cm, same extent). CHM is not a subtraction of
  two arrays. The existing `difference` render layer already solves this by
  sampling both rasters independently into the target grid; the forest engine
  must do the same and must not assume aligned grids.

### 1.5 The local disk is nearly full and the rasters are gone

`df` reports 7.3 GB free of 228 GB. Every `portal-data/terrain/*/dsm.tif` and
`dtm.tif` symlink is dangling except Kotba's and Suigam's DTM — the source
rasters were deleted to reclaim space, and the portal reads them from R2 via
`PORTAL_TERRAIN_URL` instead.

So: **the engine must read its terrain through `raster-window.mjs` over an
HTTP source, exactly as the portal does, never by assuming a local file.**
Kotba (24 MB of local GeoTIFF) is the only survey that can be iterated on
offline, which is a second reason it earns a place in the test suite.

---

## 2. The five decisions that shape everything else

### 2.1 Forest gets its own numbering, and does not take the unspecified numbers

Malhar's master sequence runs 1–40, with 22, 23, 29–36, 38 and 39 numbered but
never described. It is tempting to give Forest twelve of those.

Do not. Those numbers belong to documents that may still arrive, and claiming
them would (a) make the "forty tools" count dishonest by counting forest work
against road numbers, and (b) collide the day a sixth master document describes
29. The forest PDF has its own numbering, 1–16, in its own document.

So: group key `forest`, items displayed **F1–F16**, stored internally as
`n: 101…116` because `ACTIONS` and `toolAction(n)` key on a unique number.
`TOOL_GROUPS` gains a `numbering` field, `Tool` gains `ref` for display, and
`countBy` becomes scoped so that `docs/tool-catalogue.md` reports *two*
specifications — forty master tools and sixteen forest sections — instead of
silently becoming "fifty-six tools", which is the kind of arithmetic that makes
a client stop believing the other numbers on the page.

### 2.2 CHM-first, point-cloud-enriched — one inventory schema either way

Two detection paths:

- **Path A — CHM.** `CHM = DSM − DTM`, clipped at zero, on a common analysis
  grid. Runs on any survey with both surfaces. This is what Kotba and Kiru get.
- **Path B — point cloud.** Per-point normalised height `z − DTM`, a pit-free
  CHM from first returns, plus the 2nd..7th returns for porosity, density and
  the stem band. This is what both Ektanagar surveys get.

Path B supersedes Path A's raster where a cloud exists, because a
photogrammetric or smoothed DSM rounds off the apex that local-maximum
detection depends on. But **both paths emit the same artefacts with the same
schema**, and the manifest records which ran. The portal never asks. That is
Malhar's rule — one convention every dataset obeys — and it is the reason the
web layer can be written once.

### 2.3 The analysis cell is 0.25 m, and that is a real decision

Hydrology runs at 1 m because routing water across a 7 cm surface turns every
wheel rut into a sink. Forest cannot use 1 m: a 2 m crown would be four cells
and would have no shape at all. Nor can it use native 7.4 cm: at that scale
every leaf cluster is a local maximum and one tree becomes forty.

0.25 m, default, `--cell` to override:

| survey | extent | area | analysis grid at 0.25 m | cells |
|---|---|---|---|---|
| Kotba | 339 × 379 m | 12.9 ha | 1356 × 1518 | 2.1 M |
| Ektanagar 1 | 508 × 496 m | 25.2 ha | 2031 × 1984 | 4.0 M |
| Ektanagar 2 | 1832 × 2124 m | 389 ha | 7328 × 8496 | 62 M |
| **Kiru** | 21331 × 7632 m | **16,279 ha** | 85323 × 30527 | **2,605 M** |

Kiru is not merely the largest, it is **forty times** Ektanagar 2 and is the
only survey whose analysis grid is the same order as its native grid (its DTM
is already 25.4 cm, so 0.25 m is no reduction at all). Its bounding box is a
gorge and is probably mostly nodata, so the *effective* area may be far
smaller — **measuring the nodata fraction is task F0.7**, and until it is
measured no timeline should include Kiru.

A 2 m crown is 8 cells across; a 25 m² crown is 400 cells. Fine enough for
shape, coarse enough that foliage noise averages out. The first two fit in
memory whole. The last two do not, which brings us to the next decision.

### 2.4 Crown segmentation tiles, because it is a *bounded* traversal

The rule this repository already lives by is "reductions tile, traversals do
not" — it is why flow accumulation has to see the whole grid at once, and why
hydrology became a batch job that cannot be windowed even in principle.

Forest looks like a traversal and therefore looks unscalable. It is not, and
the reason is worth stating precisely:

> **A traversal with a bounded radius tiles, with a halo of that radius.**
> Water arrives from arbitrarily far upstream, so flow routing has no bound.
> A crown is at most a few metres across, so crown segmentation does.

So the engine processes the survey in tiles with a halo of
`maxWindowRadius + maxCrownRadius` (default 15 m → 60 cells at 0.25 m), and
obeys one rule that must be tested rather than believed:

- detect maxima over **core + halo**;
- **keep only seeds whose cell falls inside the core**;
- segment crowns over the **full halo**, so a crown is never clipped by a tile
  edge even when it extends past it.

A tree sitting exactly on a tile boundary must appear exactly once, whole. That
is one test, it is cheap to write, and without it the defect is invisible —
you get a plausible inventory with duplicated or bitten-off trees along a grid
of lines nobody looks for.

This is what makes Kiru's 2,605 M cells and, eventually, Dang Forest tractable
on hardware we own. Nothing else would.

### 2.5 Statistics are precomputed; the browser filters an attribute pack

§9 wants live cross-filtering on height, crown area, crown diameter, elevation,
confidence and tree ID, with the count updating as you drag. §10 wants eleven
summary figures and five charts. Round-tripping each drag to the server is the
wrong shape.

**`trees.bin`** — a columnar pack of every tree: id, easting, northing
(int32), tree height, crown area, crown diameter, ground elevation, confidence
(float32/uint16). About 32 bytes per tree.

| survey | est. trees at ~100/ha | `trees.bin` | within budget? |
|---|---|---|---|
| Ektanagar 1 (25 ha) | ~2.5 k | 80 KB | yes |
| Ektanagar 2 (389 ha) | ~39 k | 1.2 MB | yes |
| Kotba (13 ha) | ~1.3 k | 42 KB | yes |
| **Kiru (16,279 ha)** | **~1.6 M** | **52 MB** | **no** |

The tree counts are estimates at a placeholder 100 trees/ha and are exactly
the figure task F6.3 replaces with a measured one. The conclusion does not
depend on the placeholder, though: **Kiru is an order of magnitude past any
browser budget**, so the server-side filter path is not an optional escape
hatch for it, it is the only path. Build it in Phase F3, not later.

Under a stated budget of **250,000 trees (~8 MB)** the browser loads the pack
and every filter, count, histogram and chart is exact and instant, computed
locally. Above it, filters go to the server and counts come from precomputed
sorted-attribute indices. The budget is written in the manifest and shown in
the panel, because a threshold that silently changes the interface's behaviour
is worse than one a client can see.

Crown *polygons* are the heavy geometry — roughly 40 vertices each, so 40 k
crowns is 1.6 M vertices — and those get a tile pyramid, simplified per zoom.
Tree points do not need one; they come from `trees.bin`.

---

## 3. The engine

`scripts/forest-run.mjs`, modelled on `hydro-run.mjs`: one survey in, a
directory out. No database, no session, no portal. Run offline, once.

```
node scripts/forest-run.mjs --slug aektanagar-survey \
  [--las "Aektanagar/Aektanagar Lidar Point Cloud.las"] \
  --out portal-data/forest/aektanagar-survey \
  [--cell 0.25] [--min-height 2] [--window "1.0+0.10h"] [--tile 512]
```

New module `src/lib/geo/forest.mjs` holds the arithmetic and is pure — grids
in, grids and feature lists out — so it can be tested against fixtures without
a raster on disk, exactly as `hydrology.mjs` is.

### 3.1 The pipeline, following §16

```
DTM + (DSM | LiDAR)
  → normalise            per-point z − DTM, or DSM − DTM resampled
  → CHM at 0.25 m        pit-filled, clipped at 0
  → smooth               variable-width, radius scaling with height
  → local maxima         variable window, seeds = candidate tree tops
  → marker watershed     on inverted CHM, constrained to CHM ≥ minHeight
  → crown extraction     vectorise each segment, simplify
  → reject non-trees     §3.5
  → attributes           §3.4
  → confidence           §3.6
  → height classes       §3.7
  → artefacts            §4
```

### 3.2 Local maxima, and the one parameter that decides the tree count

A fixed-radius window over-segments large crowns and under-segments small ones.
The standard answer is a window whose radius scales with canopy height:

```
r(h) = a + b·h,  clamped to [rMin, rMax]
default a = 1.0 m, b = 0.10, rMin = 1.0 m, rMax = 6.0 m
```

At Ektanagar 1's median 8.1 m canopy that is a 1.8 m radius window; at the
26 m tail it is 3.6 m. **`a` and `b` are the parameters that most determine
how many trees we report, so they are recorded in the manifest, exposed as CLI
flags, and tuned against digitised ground truth in §8 — never guessed once and
forgotten.** A tree count is the first number a forestry client reads, and a
number produced by an untuned constant is a number we cannot defend.

Smoothing before maxima matters as much: §3 of the spec says "avoid detecting
multiple points within the same tree as separate trees", and unsmoothed CHM at
0.25 m will do exactly that.

### 3.3 Crown segmentation

Marker-controlled watershed on the inverted smoothed CHM, seeded by the
maxima, flooding restricted to cells with CHM ≥ `minHeight` (default 2 m, which
is also the top of Malhar's first height class) and to within `rMax` of the
seed. `vectorise.mjs` already has `polygonizeComponents` and `simplifyCollinear`
and both are reused rather than reimplemented.

### 3.4 Attributes, with the definitions written down

Every tree carries what §1 and §5 ask for. Three of them need a stated
definition, because "crown diameter" appearing three times with three silently
different meanings is a trust problem, not a rounding problem:

| attribute | definition |
|---|---|
| crown area | segment cell count × cell area |
| crown perimeter | length of the simplified boundary ring |
| **max crown diameter** | maximum caliper width (rotating calipers over the convex hull) |
| **min crown diameter** | minimum caliper width |
| **avg crown diameter** | equivalent-circle diameter, `2√(A/π)` |
| tree height | apex CHM value = apex elevation − DTM at the apex |
| ground elevation | DTM at the apex cell |
| tree-top elevation | DSM/point elevation at the apex cell |
| point density | pulses per m² within the crown footprint — **Path B only** |

The popup states each definition. Note the last row: point density is
meaningful only where a cloud exists, and it must be computed from the **source
LAS**, not from the portal's quadtree, which is decimated to 26 % of the flown
points. Reporting the quadtree's density as the survey's density would
understate it by a factor of four. That trap is worth a comment in the code.

### 3.5 Rejecting things that are not trees — §16, and the serious part

"Do NOT simply classify every elevated LiDAR point as a tree." Buildings,
vehicles, walls, poles and stockpiles are all elevated. Six discriminators,
each computed per segment, each stored:

1. **Flatness** — fraction of segment cells within ±0.25 m of the segment
   median. A roof is high, a crown is low.
2. **Rectangularity** — segment area ÷ minimum-area bounding rectangle area.
   A building approaches 1.
3. **Apex prominence** — (apex height − boundary median) ÷ apex height. A
   crown has a distinct apex; a roof does not.
4. **Radial decay** — correlation between distance from apex and height drop.
   Strongly positive for a crown, near zero for a flat structure.
5. **Return porosity** *(Path B)* — fraction of pulses in the footprint with
   more than one return, and the count of ground-classified returns beneath the
   crown. A roof is opaque: neither exists under it. At Ektanagar 1's 31 %
   multi-return rate this is the strongest signal we have.
6. **Greenness** *(where ortho exists)* — excess green `2G − R − B` over the
   footprint. RGB only, so **no NDVI** — there is no near-infrared band in any
   of our imagery and anything calling itself NDVI would be a fabrication.

A segment failing hard on flatness *and* rectangularity is **dropped as a
structure**, and the manifest counts the drops. "412 building-like segments
removed" is a number a client should be shown, not a silent filter. Everything
else feeds the confidence score.

### 3.6 Confidence — §13

A 0–1 score from the components in §3.5 plus point density and crown
segmentation quality, **stored component by component** so the popup can say
*why* a tree scored 0.4 rather than only that it did. Trees below a threshold
are flagged for manual review, which is what §13's last line asks for and what
feeds the editing queue in §6.

The score must be honest about missing inputs: a Kotba tree has no porosity and
no point density, so its confidence is computed from a smaller set of evidence
and **says so**, rather than being penalised for the survey lacking a sensor.

### 3.7 DBH and girth — §6, attempted properly and expected to mostly fail

Path B only. Per tree:

1. Take points within the crown footprint with normalised height in
   **[1.0, 2.0] m** — the band around breast height.
2. Require **≥ 12 points** and angular spread **≥ 180°** about the candidate
   stem centre. Without spread, a circle fit to an arc is unconstrained and
   will happily return a confident, wrong radius.
3. Taubin algebraic circle fit; compute RMS residual.
4. Accept only if residual **< 3 cm** and radius in **[2.5, 60] cm**.
5. Otherwise the attribute is **"Not reliably detectable"** — never a number.
6. On acceptance: `Girth = π × DBH`, stored as *estimated*, beside its own
   confidence, labelled distinctly from measured values.

**Expected outcome: most trees fail this, and that is the correct result.** The
spec demands it in bold. Task F0.3 measures how many trees clear the bar
*before* any interface promises the attribute, so we find out from the data
rather than from a client.

---

## 4. Serving it

A batch product, like hydrology. `portal-data/forest/<slug>/`, uploaded to
`sites/<slug>/forest/`, read through `PORTAL_FOREST_URL`.

```
manifest.json      generator, parameters, grid, counts, per-layer provenance
summary.json       every §10 statistic and chart series, precomputed
trees.bin          columnar attribute pack (§2.5)
crowns/z/x/y.json  crown polygons, tile pyramid, simplified per zoom
grid-10.json       §11 grid analysis, also -25 and -50
chm.tif            the analysis CHM, so it opens in Global Mapper
```

Four things this must get right, each a trap the repository has already been
bitten by once:

- **The `/forest` segment is not decoration.** `hydrology-source.ts` documents
  why: everything for a site shares one R2 prefix, and a second `manifest.json`
  at the site root would overwrite the map's. Forest nests the same way, and
  for the same reason.
- **A fifth class in `scripts/lib/site-objects.mjs`.** `upload-site.mjs` and
  `r2-prune.mjs` share one table deliberately; adding a class to only one of
  them means the pruner deletes live forest data. Add it once, in the shared
  table.
- **The CHM ramp belongs in `elevation-image.mjs`.** That module owns what
  height looks like, and CI fails on a new literal ramp defined elsewhere. The
  CHM layer registers its ramp there or it does not ship.
- **`chm` is not the existing `difference` layer.** DSM − DTM is *nearly* a
  CHM, but the forest CHM is clipped at zero, pit-filled and on the 0.25 m
  analysis grid. Two layers, two meanings, and the legend says which.

New: `src/lib/portal/forest-source.ts` (mirroring `hydrology-source.ts`,
including its two-mode local/remote arrangement and its distinction between
"never run" and "run but incomplete"), and
`src/app/api/portal/sites/[siteSlug]/forest/route.ts` for point queries, grid
analysis and server-side filtering above the budget.

---

## 5. The web layer

### 5.1 MapViewer is already 183 KB and 4,500 lines

Six new panels inline would make it worse, and it is already the file nobody
wants to open. The forest work goes into modules beside it, following the
precedent `point-cloud-layer.ts` set for a custom MapLibre layer:

- `src/lib/portal/forest-client.ts` — fetches, decodes `trees.bin`, holds the
  filter predicate and derived counts.
- `src/lib/portal/forest-layer.ts` — the MapLibre sources and layers for tree
  points, crown polygons and height-class styling.
- Panels: `TreeFilterPanel`, `ForestStatsPanel`, `GridAnalysisPanel`,
  `TreeEditPanel`, and the tree popup.

MapViewer gains a mount point and the forest state, not the logic. This is a
cost note as much as a design: it is more files, and it is the only way this
lands without making the monolith untouchable.

The four MapLibre custom-layer traps recorded from the point-cloud work apply
here unchanged and must be re-read before writing `forest-layer.ts` — they all
fail *silently*.

### 5.2 The rail

A sixth tab. `ToolRail` gains `hasForest` alongside `hasHydrology`, and
`reasonUnusable` gains the forest cases, so a Suigam client sees "this survey
has no surface model, so no canopy can be measured" rather than a dead button.

### 5.3 Charts — §10 wants five

There is no chart library in this project and the only precedent is the profile
chart in `MeasurePanel`. Adding Recharts or similar for five charts is a real
dependency decision. **Recommendation: inline SVG, consistent with the existing
panels** — four of the five are histograms and one is a scatter, none needs a
library, and the bundle stays as it is. Follow the project's chart colour and
layout conventions rather than inventing a palette.

### 5.4 Height classes — §4

Defaults are Malhar's ten bands. The user may change intervals, add and remove
classes, define custom ranges, enable and disable each, and draw each
separately. With `trees.bin` in memory, counts for *any* interval are two
binary searches over a sorted column — exact, instant, and no server round
trip. Class definitions persist per user per site in local storage; nothing
about them belongs in the database.

---

## 6. Manual editing: the first tool that writes

§14 asks for add, delete, move, split, merge, edit attributes, edit crown
boundary, recalculate. **Every portal tool built so far is read-only.** This is
new infrastructure, not a panel, and it carries the one design decision in this
document that is expensive to get wrong.

### 6.1 The inventory is immutable; edits are deltas

A new Postgres table `tree_edits` — site, client, tree reference, operation,
payload, author, timestamp — and the served inventory is the precomputed
artefact with the deltas applied on read. Re-running detection then **re-bases**
a client's editing rather than destroying it.

### 6.2 The tree id must be spatial, not ordinal

`T-00001` from a detection run is meaningless after a re-run, which renumbers
everything. If edits key on it, one re-run silently reassigns every correction
a client made to the wrong trees — a failure that produces no error and is
invisible until someone notices the inventory is nonsense.

So the durable reference is **a hash of the apex position quantised to 0.25 m**,
and a re-run re-associates edits by nearest match within a stated tolerance and
**reports how many edits could not be re-associated**. `T-00001` remains as the
display label, derived, never stored in an edit.

This is the most important paragraph in §6 and the easiest one to skip.

### 6.3 Who may edit

Client sessions are read-only today (`isOwnerRole`). Proposal: owner roles edit
by default, client editing enabled per site. **This is a question for Malhar,
not a decision to make quietly** — see §10.

---

## 7. Export

§12 wants Shapefile, GeoJSON, GeoPackage, CSV and KML/KMZ, for both a tree
point layer and a crown polygon layer, plus a PDF inventory report.

| format | status |
|---|---|
| Shapefile | reuse `shapefile.mjs` — geometry, DBF and PRJ writers all exist |
| GeoJSON | trivial, `vectorise.mjs` precedent |
| CSV | reuse `export-formats.mjs` |
| **KML/KMZ** | **new.** `kml.mjs` reads only; a writer is a day's work plus the KMZ zip, which `zip.mjs` already covers |
| **GeoPackage** | **new, and not small.** GPKG is SQLite with a spatial schema; writing one without a SQLite dependency is real work |
| PDF report | reuse `scripts/lib/pdf.mjs`, which already builds the contour and topographic reports |

Recommendation: ship SHP, GeoJSON, CSV and KML/KMZ in the export phase, and
**take GeoPackage to Malhar as a scoped question** — it is one line in his
document and several days of ours, and QGIS and Global Mapper both read
shapefile and GeoJSON perfectly well. See §10.

---

## 8. Validation

Hydrology was validated against SAGA and reported 98 % catchment IoU. Forest
needs the same treatment or the tree count is just an assertion.

- **Reference implementation.** lidR in R — `locate_trees(lmf)` plus
  `segment_trees(dalponte2016)` — on Ektanagar 1, or Global Mapper's own tree
  extraction if Malhar has that module. Report matched trees, precision, recall
  and F1.
- **Ground truth.** Three 1-hectare plots digitised by hand from the
  orthomosaic. Tune `a` and `b` of the window function against these, and
  report the tuned values in the manifest.
- **Height.** Compare each detected apex against the 99th-percentile point
  height within its crown. Be explicit that this validates the detection
  against the *survey*, not against the field: **we have no measured tree
  heights and no measured DBH, so no accuracy claim about the real world can be
  made**, only internal consistency. Saying so in the report is not a caveat,
  it is the difference between a measurement and a guess.
- **Tile-boundary invariant.** A tree straddling a tile edge appears exactly
  once, whole. Asserted in the test suite, not checked by eye.
- **Benchmarks on a quiet machine.** A contended run once reported 984 s for
  work that takes 4.7 s alone. Timing numbers from a busy laptop are not
  numbers.

---

## 9. Section-by-section verdict on the specification

| § | Asks for | Verdict |
|---|---|---|
| 1 | Detect trees, point feature per tree, full attributes, clickable popup | **Buildable.** Crown perimeter included; point density Path B only |
| 2 | Height = top − DTM; CHM = DSM − DTM | **Buildable.** Point-derived CHM preferred where a cloud exists |
| 3 | Local maxima, CHM, watershed, clustering, one point per tree | **Buildable.** Variable window is the whole game (§3.2) |
| 4 | Ten default height classes, fully user-editable | **Buildable, and cheap** — the attribute pack makes it instant |
| 5 | Crown area, perimeter, max/min/avg diameter, crown polygons | **Buildable.** Three diameters get three stated definitions (§3.4) |
| 6 | DBH/girth only where reliable, else "Not reliably detectable" | **Attempt buildable on 2 of 5 surveys.** Expect mostly refusals — which is what the spec demands |
| 7 | Layered map: ortho, DSM, DTM, CHM, cloud, trees, crowns, classes | **Mostly exists.** CHM and the tree/crown layers are new |
| 8 | Tree attribute popup | **Buildable** |
| 9 | Filter panel, seven axes, quick filters | **Buildable, client-side** under the budget (§2.5) |
| 10 | Eleven summary figures, five charts | **Buildable.** Precomputed in `summary.json` |
| 11 | Six analysis maps, grid analysis at 10/25/50 m | **Buildable.** Pure reductions over the inventory |
| 12 | SHP, GeoJSON, GPKG, CSV, KML/KMZ, both layers, PDF report | **Buildable except GeoPackage** — see §7 |
| 13 | Measured vs estimated, confidence from five inputs, flag for review | **Buildable.** Two of the five inputs are Path B only, and the score says so |
| 14 | Add, delete, move, split, merge, edit attributes, edit crowns | **Buildable, but it is the first write path** — new table, new role question (§6) |
| 15 | Optimised for large hilly forest, tiling/chunking | **Buildable** via §2.4. This is what makes Kiru and Dang Forest reachable |
| 16 | Not every elevated point is a tree | **This is the hard part, and §3.5 is the answer** |

Nothing in the document is refused. Two things are scoped down (GeoPackage,
DBH coverage), one is absent for one survey (Suigam), and one needs a decision
before it can be built (who may edit).

---

## 10. Questions for Malhar

Per the standing rule, these are asked before building rather than guessed at,
and each one changes work:

1. **Which surveys is this for?** Ektanagar 1 is the only genuinely wooded
   dataset on this disk, and the PDF mentions no site. If the target is a real
   forest — the Dang dataset that has been referred to before — its LAS should
   be processed on the machine it already lives on, and we need to know its
   size before promising a timeline.
2. **Is there any field data at all?** Any measured tree height, DBH or stem
   position, for any plot, turns §8 from internal consistency into actual
   accuracy. Without it we can validate our detection but cannot claim an error
   figure, and the report has to say so.
3. **GeoPackage: needed, or is shapefile + GeoJSON enough?** One line in the
   document, several days of work, and both target packages read the other two
   formats natively.
4. **Who edits?** Does the client correct the inventory themselves, or does
   Sudaan correct it and the client view the result? This decides whether §14
   needs a client write path, which is a security surface we do not currently
   have.
5. **What tree count is expected?** A per-hectare figure he already believes,
   for any of our sites, is worth more than any parameter default — it is the
   calibration target for §3.2.

Before any of the sixteen items is built, `docs/tools.md` is checked for it.
Several past requests asked to rebuild something removed at his own
instruction, and finding that out after building costs the work twice.

---

## 11. Task list

Phases ship in order. Each produces something demonstrable; nothing is a
six-week branch. Estimates assume one person and a quiet machine.

### Phase F0 — Measure before promising *(1–2 days)*

Cheap experiments whose results change the plan. **Do not skip.**

- [ ] **F0.1** Extend `las.mjs` to expose **return number and number of
      returns** in `streamLasPoints`. It decodes classification and intensity
      but drops the return fields, and they are the most important fields in
      the file for forestry. Legacy formats pack both in byte 14; formats 6+
      widen it. Test against both Ektanagar clouds.
- [ ] **F0.2** Build a point-derived CHM for one 100 m × 100 m patch of
      Ektanagar 1 at 0.25 m. Compare against DSM − DTM over the same patch.
      Quantify how much apex detail the DSM loses — this confirms or refutes
      §2.2.
- [ ] **F0.3** **The DBH feasibility measurement.** Over ten hand-picked
      crowns, count points in the 1.0–2.0 m normalised band and measure their
      angular spread. Report what fraction would clear the §3.7 bar. This
      decides whether §6 gets an interface or a permanent
      "Not reliably detectable".
- [ ] **F0.4** Count multi-return pulses and ground returns *beneath* known
      canopy versus beneath a known building in Ektanagar 1. Confirms
      discriminator 5 of §3.5 separates them before it is built on.
- [ ] **F0.5** Confirm Kiru has an orthomosaic and check whether Kotba's
      survey contains any trees at all. Kotba is the only offline-iterable
      survey and its usefulness as a fixture depends on it.
- [ ] **F0.7** Measure Kiru's nodata fraction. Its bounding box is 16,279 ha
      and 2,605 M cells at 0.25 m — forty times Ektanagar 2 — but it is a
      gorge and may be mostly empty. This decides whether Kiru is a Phase F6
      run or a project of its own, and no timeline should include it until
      the number exists.
- [ ] **F0.6** Grep `docs/tools.md` for every forest-adjacent feature and
      record anything previously built or reversed.

### Phase F1 — The engine, on one survey *(5–7 days)*

- [ ] **F1.1** `src/lib/geo/forest.mjs` — pure functions: `chmFrom`,
      `smoothVariable`, `localMaxima`, `markerWatershed`, `crownMetrics`
      (including rotating-caliper diameters), `rejectNonTrees`, `confidence`.
- [ ] **F1.2** `scripts/forest-test.mjs` — synthetic fixtures with known
      answers: one cone, two overlapping cones, a flat roof, a cone on a
      slope, a tree on a tile boundary. Assert counts, heights and areas
      against hand-computed values, in the style of `hydro-test.mjs`.
- [ ] **F1.3** Tiling with halo, and **the boundary invariant test** from
      §2.4. Written now, before any large survey runs, because retrofitting it
      means re-running everything.
- [ ] **F1.4** `scripts/forest-run.mjs` — Path A (CHM) end to end on Kotba,
      writing `manifest.json`, `summary.json`, `trees.bin`, crowns and
      `chm.tif`. Terrain read through `raster-window.mjs` over HTTP, per §1.5.
- [ ] **F1.5** Path B — point-cloud normalisation, pit-free CHM, porosity,
      density — on Ektanagar 1.
- [ ] **F1.6** Non-tree rejection (§3.5) with all six discriminators, each
      stored, and the drop count in the manifest.
- [ ] **F1.7** DBH attempt (§3.7), gated on F0.3's result.
- [ ] **F1.8** Grid analysis artefacts at 10, 25 and 50 m (§11).

### Phase F2 — The department appears *(4–5 days)*

- [ ] **F2.1** Catalogue: `forest` group, F1–F16, the `numbering`/`ref`/scoped
      `countBy` changes of §2.1, and `write-tool-catalogue.mjs` reporting two
      specifications rather than one sum.
- [ ] **F2.2** `forest-source.ts` — two-mode local/remote, "never run" versus
      "incomplete", mirroring `hydrology-source.ts`.
- [ ] **F2.3** Fifth class in `scripts/lib/site-objects.mjs`;
      `PORTAL_FOREST_URL` in `.env.example`; `upload-site.mjs` and
      `r2-prune.mjs` verified together.
- [ ] **F2.4** `chm` render layer, ramp registered **in
      `elevation-image.mjs`** (§4), legend distinguishing it from `difference`.
- [ ] **F2.5** Sixth rail tab with `hasForest`, and honest per-survey reasons
      — including Suigam's missing DSM.
- [ ] **F2.6** `forest-client.ts` and `forest-layer.ts`: load `trees.bin`,
      draw tree points and crown polygons, height-based styling. Re-read the
      four silent MapLibre traps first.
- [ ] **F2.7** Tree popup (§8) with every attribute, each labelled measured or
      estimated, and the three diameter definitions stated.

### Phase F3 — Filtering and statistics *(3–4 days)*

- [ ] **F3.1** `TreeFilterPanel` — seven axes, quick class filters, live count
      from the attribute pack.
- [ ] **F3.2** Editable height classes (§4): intervals, add/remove, custom
      ranges, per-class visibility, per-class map layers. Persisted locally.
- [ ] **F3.3** `ForestStatsPanel` — eleven summary cards from `summary.json`,
      each naming where its figure came from, as tool 40 already does.
- [ ] **F3.4** Five charts in inline SVG (§5.3).
- [ ] **F3.5** `GridAnalysisPanel` — the §11 maps and the 10/25/50 m grids.

### Phase F4 — Export *(3–4 days)*

- [ ] **F4.1** Tree point layer and crown polygon layer as SHP, GeoJSON and
      CSV, each stating its projection, reusing the existing writers.
- [ ] **F4.2** KML/KMZ **writer** — new, `zip.mjs` covers the container.
- [ ] **F4.3** PDF inventory report via `scripts/lib/pdf.mjs`: map, statistics,
      charts, inventory table.
- [ ] **F4.4** GeoPackage — **only if Malhar confirms it is needed** (§10.3).

### Phase F5 — Manual editing *(4–6 days)*

- [ ] **F5.1** `tree_edits` table, drizzle migration, tenant-scoped.
- [ ] **F5.2** **Spatial tree references and the re-base path** (§6.2),
      including the unmatched-edit report. Built first, not last.
- [ ] **F5.3** Edit operations: add, delete, move, split, merge, edit
      attributes, edit crown boundary, recalculate.
- [ ] **F5.4** The write authorisation decided in §10.4, with tenancy tests
      alongside the existing ones.
- [ ] **F5.5** Review queue for low-confidence trees (§13).

### Phase F6 — Validation and scale *(3–5 days)*

- [ ] **F6.1** Digitise three 1 ha ground-truth plots from the ortho.
- [ ] **F6.2** Validate against lidR or Global Mapper; report precision,
      recall, F1 and height agreement.
- [ ] **F6.3** Tune the window function against F6.1; record the tuned
      parameters in the manifest.
- [ ] **F6.4** Run Ektanagar 2 (62 M cells); record timings on a quiet
      machine. Kiru (2,605 M cells) only after F0.7 has measured how much of
      its gorge is actually data.
- [ ] **F6.5** Fold forest into `publish-site.mjs` with `--skip-forest`,
      keeping the one-command publish intact.
- [ ] **F6.6** Write `docs/forest-tools.md` — what was built, what was
      reversed, what is honestly still missing.

### Running total

Roughly **23–33 working days** for all six phases. F0 through F2 — measured
feasibility, a validated engine and a visible department with clickable trees —
is about **10–14 days**, and is the right first thing to show Malhar.
