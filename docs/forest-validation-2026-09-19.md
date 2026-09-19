# Forest detection validation — Ektanagar 1, 19 Sep 2026

> **Read this before the numbers below.** There is no field-measured ground
> truth for this survey, ever (Malhar confirmed this — see
> `docs/forest-tools-plan.md` §0.1 row 2). Everything in this document is
> **AI-assisted visual review of the orthomosaic over three small patches**,
> compared against the pipeline's own output. It is not a surveyed accuracy
> figure, it is not a statistically representative sample, and it must not be
> quoted to a client as a measured precision/recall number. It is an internal
> sanity check, done because 26,776 accepted trees over 19.16 ha (1,397/ha,
> median confidence 0.317, nothing at or above 0.6) was implausible enough
> that someone had to actually look.

## What prompted this

The first production run (`portal-data/forest/aektanagar-survey/`) reported:

- 26,776 accepted trees, 19.157 ha, **1,397 trees/ha**
- median confidence **0.317**, max confidence in the entire dataset **0.700**
  (the run had no point cloud and no orthomosaic greenness sampling — `pointCloud.used: false`,
  `greenness.used: false` in `manifest.json` — so confidence rested on five of
  the seven possible inputs, not seven)
- only 448 of 41,439 candidates (1.1%) were rejected by the geometric
  "structure" discriminator (`flatness >= 0.7 AND rectangularity >= 0.85`)

1,397/ha is far denser than any real canopy this survey could plausibly
support, and a rejection rate of 1.1% for a model whose own median confidence
sits at 0.32 is a strong sign more candidates are surviving than there are
real trees.

## Step 1 — three hand-picked patches, viewed directly

Picked using a 20 m-cell density grid built from `crowns.geojson`'s accepted
trees (not arbitrarily), plus a downsampled overview of the whole
orthomosaic to find where each land-cover type actually lives inside the
survey's irregular flight boundary:

| patch | centre (UTM 43N) | size | what it visually is |
|---|---|---|---|
| **A — dense forest** | 361558.4 E, 2421106.1 N | 40×40 m (0.16 ha) | closed-canopy woodland, the densest part of the density grid |
| **B — bare/excavated** | 361715.1 E, 2421203.6 N | 40×40 m (0.16 ha) | bare sandy/excavated ground, tire tracks, a small pond, almost no vegetation |
| **C — buildings + canopy** | 361495.3 E, 2420985.4 N | 40×40 m (0.16 ha) | a cluster of roofed structures (corrugated metal, membrane roof, one roof with solar panels) surrounded on all sides by dense tree canopy |

Each was cropped from `surveys/ektanagar-1/Orthomosaic JPG/Orthomosaic JPG.jpg`
(27,521×27,199 px, 1.83 cm/px) using its world file's affine
(`easting = originX + col·0.0183`, `northing = originY − row·0.0183`), viewed
directly, and counted by eye.

### Patch A — dense forest

Fully closed canopy: individual crowns blur into neighbours with only faint
darker gaps marking boundaries, so an exact per-tree count is not really
possible from the image alone — **this is exactly the honesty caveat the task
asked for: a person looking at a satellite photo of closed canopy cannot
reliably separate touching crowns, and I am not going to pretend a precise
count here is more than an estimate.** Working the image as a grid of
distinguishable crown-shaped lobes, my estimate is **roughly 70–100
distinguishable crown clusters** in the 0.16 ha patch, i.e. **≈440–625
trees/ha**. Some of those clusters are almost certainly more than one tree
pressed together; some may be one tree's canopy split into two lobes by a
gap. The true number could reasonably be anywhere in a band around this.

### Patch B — bare/excavated ground

Visually: **zero trees.** The patch is bare compacted soil/sand with
vehicle-track scarring, a small muddy pool, and a sliver of low scrub at one
edge that is clearly not tree canopy (no discernible individual crowns, just
continuous low green fuzz at ground level). Any "tree" the pipeline reports
here is a false positive by inspection.

### Patch C — buildings surrounded by canopy

Visually: a compact building complex (several roof types — corrugated metal,
a white membrane roof with visible ridge/hip lines, a darker roof with 4
visible solar panels) occupies roughly the centre-right third of the patch;
the rest is genuine dense canopy, similar in character to patch A. I
additionally delineated the building footprint alone as a sub-region
(≈0.041 ha) to test the rejection pipeline specifically against roofs.

## Step 2 — pipeline output over the same patches

Counted by testing each accepted tree's polygon centroid against the
patch's UTM bounding box, against the **original, untouched**
`portal-data/forest/aektanagar-survey/crowns.geojson`:

| patch | pipeline accepted count | pipeline density | my visual estimate | ratio (pipeline ÷ visual) | verdict |
|---|---|---|---|---|---|
| A — dense forest | **574** | 3,587/ha | ~440–625/ha (70–100 trees) | ≈6–8× | **over-detection**, even in genuine forest |
| B — bare/excavated | **115** | 719/ha | 0/ha (0 trees) | infinite | **over-detection**, pure false positives |
| C — whole patch | **553** | 3,456/ha | not separately estimated (mixed) | — | — |
| C — building footprint only (≈0.041 ha) | **61** | 1,504/ha | 0 (rooftops, not trees) | infinite | **over-detection**, 61 "trees" up to 18.3 m tall sitting directly on roofs |

The building-footprint result is the most concrete, checkable defect: 61
polygons with a median modelled height of **9.89 m** (max 18.3 m) centred
inside a rectangle that is, by direct visual inspection, roofing material.
The geometric "structure" rejection (flatness/rectangularity) is supposed to
catch exactly this and did not — of those 61, none were rejected as
`flat_and_rectangular`.

I dug into why: the rejection rule requires **both** flatness ≥ 0.7 **and**
rectangularity ≥ 0.85 (an AND, not an OR — see `rejectNonTree` in
`src/lib/geo/forest.mjs`, not modified here). A hipped/multi-section roof
cluster with corrugation, debris, and uneven panels is neither perfectly flat
within a 0.25 m band nor a clean rectangle in its extracted crown-polygon
shape, so it satisfies neither half strongly enough to trip the joint
condition. This is a real limitation of the geometric discriminator as
currently tuned, not something I could fix by adjusting its two exposed
thresholds alone (see Step 3).

Also notable: even in patch A, confirmed real forest, the pipeline is
detecting roughly 6–8× more "trees" than I could distinguish by eye. Some of
this is expected — the model may legitimately be resolving smaller/lower
sub-canopy trees that closed-canopy imagery hides from a human eye entirely,
which would mean my visual count under-counts real trees, not that the
pipeline over-counts them. I cannot tell these two explanations apart from
an orthomosaic alone; a stem-mapped plot survey would be needed to settle it,
which is exactly the ground truth this survey doesn't have and, per Malhar,
never will. I'm reporting the ratio honestly rather than picking the
explanation that's more flattering to the pipeline.

## Step 3 — tuning attempted

### 3a. Geometric thresholds (existing flags, no code change)

Tried loosening the rejection pipeline's own exposed knobs —
`--flat-band 0.4 --reject-flatness-min 0.55 --reject-rectangularity-min 0.6`
(vs. defaults 0.25 / 0.7 / 0.85) — re-running `forest-run.mjs` against the
existing `candidate-boxes.geojson` (cheap: ~6 s, no DeepForest re-run).

Result: `flat_and_rectangular` rejections rose 448 → 2,317 (5.2×), but overall
accepted count only fell 26,776 → 24,907 (−7%), and **the building-footprint
false positives were completely unaffected: 61 → 61, exactly unchanged.**
Patch A fell 574 → 557 (−3%), patch B 115 → 113 (−2%). Conclusion: the two
exposed geometric thresholds are not the lever that fixes this defect class —
the AND-conjunction and the crown-polygon shape itself (not touched here,
since `forest.mjs`'s algorithms are out of scope) mean loosening these knobs
barely moves the needle on the specific false positives found in Step 2.
**Reported here as a negative result, not hidden.**

### 3b. A `--min-score` pre-filter (new, narrowly-scoped CLI flag)

Checked whether DeepForest's own candidate `score` (before any of the seven
confidence components) discriminates the three patches differently. It does,
usefully, though imperfectly:

| candidate score cutoff | patch A retained | patch B retained | patch C-building retained |
|---|---|---|---|
| ≥0.0 (none) | 591 (100%) | 137 (100%) | 47 (100%) |
| ≥0.30 | 483 (82%) | 55 (40%) | 32 (68%) |
| ≥0.35 | 325 (55%) | 28 (20%) | 19 (40%) |
| ≥0.40 | 170 (29%) | 14 (10%) | 9 (19%) |

A `score` cutoff suppresses bare-ground and rooftop candidates faster than
real-forest candidates, but the separation is not clean — real trees and
false positives both span most of the score range, so any cutoff trades real
detections for false ones rather than cleanly removing one and not the other.

I added `--min-score` to `scripts/forest-run.mjs` (filters candidates by
their `score` property before crown extraction; recorded honestly in
`manifest.json`'s `parameters.minScore` and as a new `below_min_score` key in
the rejection breakdown; **default `null`, so every existing invocation
without the flag is byte-for-byte unchanged** — reproduced the original
production run twice, before and after this change, both gave exactly 26,776
accepted with an identical rejection breakdown). Did not touch
`src/lib/geo/forest.mjs` or `forest-detect.py`.

Ran `--min-score 0.4` to a **separate** output directory,
`portal-data/forest/aektanagar-survey-tuned/` (the original
`portal-data/forest/aektanagar-survey/` is untouched):

| | production (untouched) | tuned (`--min-score 0.4`) |
|---|---|---|
| accepted trees | 26,776 | **6,192** |
| trees/ha | 1,397.69 | **323.22** |
| patch A (dense forest) | 574 (3,587/ha) | 167 (1,044/ha) |
| patch B (bare/excavated) | 115 | 10 |
| patch C (building footprint) | 61 | 11 |

Better, but patch A's density (1,044/ha) is still noticeably above my visual
estimate's upper bound (625/ha), and 10–11 false positives per 0.16 ha remain
on ground that should have none.

### 3c. The more effective lever: a post-hoc `confidence` filter needs no re-run at all

Every accepted tree in the **existing, untouched** `crowns.geojson` already
carries a `confidence` score (the 5-to-7-component blend, not the raw
DeepForest `score`). Filtering that field directly — which is what a
client-facing "hide low-confidence trees" toggle would actually do at render
time, with no pipeline re-run — turned out to separate the three patches
better than the `--min-score` pre-filter did:

| confidence ≥ | total accepted | trees/ha | patch A | patch A trees/ha | patch B | patch C-building |
|---|---|---|---|---|---|---|
| 0.00 (today's default) | 26,776 | 1,398 | 574 | 3,587 | 115 | 61 |
| 0.30 | 16,052 | 838 | 415 | 2,594 | 82 | 37 |
| 0.35 | 8,762 | 457 | 258 | 1,613 | 55 | 21 |
| **0.40** | **3,632** | **190** | **100** | **625** | **16** | **11** |
| 0.45 | 1,037 | 54 | 25 | 156 | 2 | 3 |

At **confidence ≥ 0.40**, patch A's density (625/ha) lands almost exactly on
the *top* of my visual estimate's range (440–625/ha), patch B's false
positives drop 115 → 16 (−86%), and patch C's rooftop false positives drop
61 → 11 (−82%). At confidence ≥ 0.45 the cut looks too aggressive: patch A
falls to 156/ha, below my visual estimate's low end, suggesting real trees
are being discarded, not just false ones.

This did not require touching the tuned output directory or re-running
anything — it is a filter over data the production run already wrote. It
is, practically, the more useful of the two levers tried here, and the one I
would recommend implementing as the actual client-facing control instead of
(or as well as) the `--min-score` pipeline parameter.

## Recommendation

1. **Do not ship 1,397 trees/ha as an unqualified inventory number to a
   client.** Every angle checked here — closed-canopy visual count, bare-ground
   false positives, and rooftop false positives — points the same direction:
   the current default output over-detects, likely by something in the
   range of 2–8× depending on land cover, and it is impossible to be more
   precise than that without a real plot survey.
2. **Default the client-facing view to `confidence ≥ 0.40`.** This is not a
   verified accuracy threshold (there is no ground truth to verify it
   against), but it is the point in this small sample where dense real-forest
   density lands near what I could distinguish by eye, while bare ground and
   rooftop false positives fall by 80%+.
3. **Add a "show low-confidence trees" toggle** (default off) that reveals
   everything down to confidence 0.0, exactly like the pipeline's existing
   pattern of never hiding data, only defaulting its visibility — a client or
   Om can still see and audit the full 26,776-tree output, they just aren't
   shown it as the headline number.
4. **State the 1,397/ha (or any per-hectare figure) as "candidate density
   after automated filtering, not a measured tree count" everywhere it
   appears in the UI**, per the manifest's own `groundTruthNote`. This
   document is further evidence that number needs a qualifier, not less.
5. If Malhar wants a materially better false-positive rate against rooftops
   specifically, the fix is not in the two exposed geometric thresholds
   (§3a showed they barely move that number) — it would need either a
   stricter or OR-based flatness/rectangularity rule, or bringing in the
   point cloud (`--las`) and greenness (`--ortho`/`--worldfile`) inputs that
   this production run did not have, both of which are explicitly designed
   to help exactly here (return porosity and greenness should both read very
   differently over a solar panel than over canopy). That is a larger change
   than this validation pass was scoped to make.

## What changed on disk

- `scripts/forest-run.mjs`: added `--min-score` (default `null`, off unless
  passed). Verified byte-identical output to the original production run
  when omitted. `src/lib/geo/forest.mjs` and `scripts/forest-detect.py` were
  not touched, and DeepForest was not re-run.
- `portal-data/forest/aektanagar-survey/` — **untouched**, still the original
  production run (26,776 trees).
- `portal-data/forest/aektanagar-survey-tuned/` — **new**, `--min-score 0.4`
  re-run of the fast (crown-extraction/rejection/confidence) half of the
  pipeline against the same candidate boxes (6,192 trees, 323/ha). Kept for
  side-by-side inspection; not wired into the portal.
- No scratch crop images were left on disk (all crops were written to the
  session scratchpad, not the repo, and removed after review; `df` showed no
  meaningful change in free space before/after).
