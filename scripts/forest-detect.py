#!/usr/bin/env python3
"""
Track A of three: one orthomosaic in, candidate tree-crown boxes out.

    uv run --python <venv> scripts/forest-detect.py \\
      --ortho <Orthomosaic JPG.jpg> --worldfile <Orthomosaic JPG.jgw> \\
      --epsg 32643 --out <candidate-boxes.geojson> \\
      [--patch-size 800] [--patch-overlap 0.25] [--tile 4000]

Why DeepForest, and not the other two tools named for this job (see
`docs/forest-tools-plan.md` §0.2 for the full record): YOLOv8-seg needs
labelled crown masks to train on and none exist for this site, so it would
detect nothing useful. The QGIS DeepForest/GeoAI plugin is a GUI tool, and this
portal has nowhere to run a GUI plugin from -- every product here is a headless
batch script or a server route. DeepForest itself, the Python package the
plugin wraps, ships a model pretrained on aerial RGB forest imagery
(`weecology/deepforest-tree`) that is usable for inference with no training
data of our own. That is the only one of the three compatible with having no
field data and no time to label one, so it is the one this script runs.

Why the raw count looks wrong, and why that is not this script's problem to
fix: a 3000x3000 px test crop of this same orthomosaic produced 717 boxes
after NMS in 0.3 ha -- about 2,370 boxes/ha, which is absurd for real canopy.
That is not a bug, it is a pretrained-on-closed-canopy-US-forest model doing
exactly what it was trained to do when pointed at a mixed-use surveyed site
full of roofs, parked vehicles and bare ground. Rejecting those false
positives is deliberately NOT done here. It belongs to the JS track (plan
§3.5), which has real elevation and point-cloud data to test each box
against -- flatness, rectangularity, apex prominence, radial decay, return
porosity, greenness -- discriminators this script has no access to and no
business approximating. Tuning this script's confidence or NMS thresholds to
make the count "look right" would throw away DeepForest's own per-box `score`,
which the rejection step needs as one of its inputs, and would just be
duplicating, badly, work the other track already owns. So: every candidate
DeepForest proposes, at its own score, unfiltered, is what gets written.

How the whole survey gets covered without blowing an 8 GB machine's memory:
a bare JPEG has no random-access windowed reads -- libjpeg decodes forward
only, so any attempt to read a 4000x4000 crop out of a 27521x27199 baseline
JPEG either decodes the whole file first or (worse) redecodes a prefix of it
on every single window. Neither is acceptable at this image size on this
machine. So the first step converts the JPEG to a *tiled* GeoTIFF once, in a
scratch temp directory, using rasterio's bundled GDAL (`rasterio.shutil.copy`,
~6s, ~85 MB on disk for this survey) -- the same fix DeepForest's own
`TiledRaster` out-of-memory dataset tells you to run by hand if you point it
at a non-tiled raster. After that one conversion, every outer-tile window read
is a real windowed read of a few hundred KB, never the whole raster. The
scratch copy is deleted before this script exits, success or failure.

`predict_tile` itself already tiles internally via `patch_size` -- but its two
memory-bounded strategies ("batch" and "window") both require the *whole*
image, or the whole tile, to fit in memory or GPU memory at once (the "window"
strategy additionally refuses to run on anything that isn't already a tiled
raster). Neither is safe to point at 27521x27199 in one call on this machine,
so this script does the outer tiling itself: a grid of `--tile` px core
regions (default 4000), each read with a halo of `--patch-size` px on every
side (default 800px, i.e. ~14.6 m -- far bigger than any real crown, which is
the whole point of a halo: give every candidate near a tile edge full visual
context before it is scored). `predict_tile` runs once per halo'd window with
`dataloader_strategy="single"` (that window, ~90 MB, comfortably fits in
memory). A detection is kept only if its box centre falls inside the tile's
*core* -- never the halo -- so a tree cannot be double-counted by two
neighbouring tiles both seeing it in their overlap, and a tree sitting exactly
on a core boundary is still whole in whichever tile's core contains its
centre, because that tile saw it with a full halo of surrounding pixels. A
final cross-tile NMS pass (shapely `STRtree`, so it stays fast at tens of
thousands of boxes) is run over everything kept this way as a safety net for
the rare case where a jittered centre lands differently across two
independent halo views of the same tree. This is the tiling-with-halo
principle the plan already uses for crown segmentation (§2.4), applied one
level up, to this script's own outer loop instead of to a raster traversal.

Pixel-to-UTM conversion follows the world file literally, per the plan: the
world file's origin is the UTM coordinate of the *centre* of the top-left
pixel, so `easting = originX + col*pixelSizeX`, `northing = originY +
row*pixelSizeY` (`pixelSizeY` is already negative; it is not negated again).
This script does that conversion itself, by hand, from the six numbers in the
.jgw -- it does not trust GDAL's own (corner-shifted) interpretation of the
world file for anything but fast pixel access to the scratch GeoTIFF.

Environment, exactly as tested on this machine before this script was written
(system Python is 3.14, too new for reliable torch wheels):

    python3 -m pip install --user --break-system-packages uv   # if uv is missing
    uv venv --python 3.12 <path>/.venv
    uv pip install --python <path>/.venv deepforest

That resolves torch 2.14, torchvision 0.29, rasterio 1.5.1, all py3.12 arm64,
and Apple's MPS backend is picked up automatically by pytorch-lightning with
no configuration. See `scripts/forest-detect-requirements.txt` for the exact
frozen set this script was run against.

This script never touches DTM/DSM/point-cloud data and never computes a tree
attribute -- crown geometry, height, DBH and everything downstream belongs to
the JS engine (plan §0.4/§3). The only contract between the two is the
GeoJSON this script writes: a Polygon per candidate box, in the survey's own
projected CRS (not reprojected to lon/lat -- an internal file between two of
our own scripts is not bound by RFC 7946's WGS84 convention the way a served
artifact would be), with a `score` and a stable `box_id`, nothing else.
"""

import argparse
import gc
import json
import shutil
import sys
import tempfile
import time
import warnings
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil as rshutil
from rasterio.windows import Window
from shapely.geometry import box as shapely_box
from shapely.strtree import STRtree

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", message=".*isinstance.*LeafSpec.*")

MODEL_NAME = "weecology/deepforest-tree"
MODEL_REVISION = "main"


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument("--ortho", required=True, help="path to the orthomosaic JPEG")
    p.add_argument("--worldfile", required=True, help="path to the .jgw world file")
    p.add_argument("--epsg", type=int, required=True, help="EPSG code the world file's coordinates are already in")
    p.add_argument("--out", required=True, help="output GeoJSON path")
    p.add_argument("--patch-size", type=int, default=800, help="DeepForest inner patch size, px (also used as the outer-tile halo)")
    p.add_argument("--patch-overlap", type=float, default=0.25, help="DeepForest inner patch overlap, fraction")
    p.add_argument("--tile", type=int, default=4000, help="outer tile core size, px")
    p.add_argument("--iou-threshold", type=float, default=0.15, help="NMS IoU threshold, within-tile and cross-tile")
    p.add_argument("--survey-area-ha", type=float, default=25.2, help="for the boxes/ha summary line only")
    return p.parse_args(argv)


def read_world_file(path):
    """Six numbers, in ESRI world-file order: pixel size X, rotation, rotation,
    pixel size Y (signed), origin easting, origin northing -- of the CENTRE of
    the top-left pixel. Rotated world files (nonzero terms 2/3) are refused
    rather than silently mishandled; none of this survey's deliverables are
    rotated and a silent wrong answer here would corrupt every box."""
    values = [float(v) for v in Path(path).read_text().split()]
    if len(values) != 6:
        raise ValueError(f"expected 6 values in world file {path}, got {len(values)}")
    pixel_x, rot_row, rot_col, pixel_y, origin_x, origin_y = values
    if rot_row != 0 or rot_col != 0:
        raise ValueError(f"world file {path} is rotated (terms 2/3 nonzero) -- not supported")
    return dict(pixel_x=pixel_x, pixel_y=pixel_y, origin_x=origin_x, origin_y=origin_y)


def pixel_to_world(col, row, wf):
    return wf["origin_x"] + col * wf["pixel_x"], wf["origin_y"] + row * wf["pixel_y"]


def box_to_polygon(xmin, ymin, xmax, ymax, wf):
    """An axis-aligned pixel bbox to an axis-aligned UTM rectangle. Computed
    from both corners independently and then min/maxed, rather than assumed
    to preserve orientation, because a negative pixelSizeY means row order and
    northing order run opposite -- get that backwards and every box is
    mirrored top-to-bottom in real-world coordinates."""
    e0, n0 = pixel_to_world(xmin, ymin, wf)
    e1, n1 = pixel_to_world(xmax, ymax, wf)
    e_min, e_max = min(e0, e1), max(e0, e1)
    n_min, n_max = min(n0, n1), max(n0, n1)
    ring = [
        [e_min, n_min],
        [e_max, n_min],
        [e_max, n_max],
        [e_min, n_max],
        [e_min, n_min],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


def build_tiled_copy(ortho_path, scratch_dir):
    """A plain baseline JPEG has no random-access reads: libjpeg decodes
    scanlines forward-only, so a naive windowed read either decodes the whole
    image or redecodes a prefix of it every time. One block-tiled GeoTIFF copy
    (rasterio's bundled GDAL, streaming CreateCopy under the hood -- this does
    not buffer the whole 2.2 GB decoded raster in Python) fixes that for every
    subsequent read. JPEG-in-TIFF compression is used so the scratch copy stays
    close to the source file's size, not the ~2.2 GB raw pixel size."""
    tmp_path = str(Path(scratch_dir) / "ortho-tiled.tif")
    with rasterio.open(ortho_path) as src:
        profile = src.profile.copy()
        profile.update(
            driver="GTiff",
            tiled=True,
            blockxsize=512,
            blockysize=512,
            compress="JPEG",
            photometric="YCBCR",
        )
        rshutil.copy(src, tmp_path, **profile)
    return tmp_path


def run_nms(boxes, scores, iou_threshold):
    """Greedy NMS over a shapely STRtree, so this stays fast at tens of
    thousands of boxes -- a naive O(n^2) pass over an outer-tiled survey's
    full candidate set is not viable, even though within a single tile
    DeepForest's own mosaic NMS already is."""
    if not boxes:
        return []
    geoms = [shapely_box(*b) for b in boxes]
    tree = STRtree(geoms)
    order = np.argsort(-np.asarray(scores))
    suppressed = np.zeros(len(boxes), dtype=bool)
    keep = []
    for idx in order:
        idx = int(idx)
        if suppressed[idx]:
            continue
        keep.append(idx)
        for j in tree.query(geoms[idx]):
            j = int(j)
            if j == idx or suppressed[j]:
                continue
            inter = geoms[idx].intersection(geoms[j]).area
            if inter == 0:
                continue
            union = geoms[idx].area + geoms[j].area - inter
            if union > 0 and inter / union > iou_threshold:
                suppressed[j] = True
    return keep


def main():
    args = parse_args(sys.argv[1:])
    t_start = time.time()

    wf = read_world_file(args.worldfile)
    halo = args.patch_size

    scratch_dir = tempfile.mkdtemp(prefix="forest-detect-")
    try:
        print(f"converting orthomosaic to a tiled GeoTIFF for windowed reads ...", flush=True)
        t0 = time.time()
        tiled_path = build_tiled_copy(args.ortho, scratch_dir)
        with rasterio.open(tiled_path) as ds:
            width, height = ds.width, ds.height
        print(f"  done in {time.time() - t0:.1f}s -- {width}x{height} px, tiled at {tiled_path}", flush=True)

        # Import deepforest after argparse/world-file validation, since loading
        # torch is the slow, heavyweight part and should not happen before a
        # bad --worldfile or --ortho path is caught.
        from deepforest import main as deepforest_main

        print("loading weecology/deepforest-tree ...", flush=True)
        t0 = time.time()
        model = deepforest_main.deepforest()
        model.load_model(model_name=MODEL_NAME, revision=MODEL_REVISION)
        print(f"  model ready in {time.time() - t0:.1f}s", flush=True)

        n_tiles_x = (width + args.tile - 1) // args.tile
        n_tiles_y = (height + args.tile - 1) // args.tile
        total_tiles = n_tiles_x * n_tiles_y

        raw_total = 0
        kept_boxes = []  # (xmin, ymin, xmax, ymax) in full-image pixel coords
        kept_scores = []

        tile_idx = 0
        t_detect0 = time.time()
        with rasterio.open(tiled_path) as ds:
            for ty in range(n_tiles_y):
                core_y0 = ty * args.tile
                core_y1 = min(core_y0 + args.tile, height)
                for tx in range(n_tiles_x):
                    tile_idx += 1
                    core_x0 = tx * args.tile
                    core_x1 = min(core_x0 + args.tile, width)

                    halo_x0 = max(0, core_x0 - halo)
                    halo_y0 = max(0, core_y0 - halo)
                    halo_x1 = min(width, core_x1 + halo)
                    halo_y1 = min(height, core_y1 + halo)

                    window = Window(halo_x0, halo_y0, halo_x1 - halo_x0, halo_y1 - halo_y0)
                    crop = ds.read(window=window)  # (C, H, W)
                    crop = np.moveaxis(crop, 0, -1)  # (H, W, C), RGB

                    t0 = time.time()
                    result = model.predict_tile(
                        image=crop,
                        patch_size=args.patch_size,
                        patch_overlap=args.patch_overlap,
                        iou_threshold=args.iou_threshold,
                        dataloader_strategy="single",
                    )
                    del crop
                    gc.collect()

                    n_raw = 0 if result is None else len(result)
                    raw_total += n_raw
                    n_kept = 0
                    if result is not None and n_raw > 0:
                        for row in result.itertuples(index=False):
                            fxmin = halo_x0 + float(row.xmin)
                            fymin = halo_y0 + float(row.ymin)
                            fxmax = halo_x0 + float(row.xmax)
                            fymax = halo_y0 + float(row.ymax)
                            cx = (fxmin + fxmax) / 2
                            cy = (fymin + fymax) / 2
                            if core_x0 <= cx < core_x1 and core_y0 <= cy < core_y1:
                                kept_boxes.append((fxmin, fymin, fxmax, fymax))
                                kept_scores.append(float(row.score))
                                n_kept += 1

                    print(
                        f"  tile {tile_idx}/{total_tiles} "
                        f"core=({core_x0},{core_y0})-({core_x1},{core_y1}) "
                        f"-> {n_raw} raw, {n_kept} kept ({time.time() - t0:.1f}s)",
                        flush=True,
                    )

        print(f"detection over all tiles took {time.time() - t_detect0:.1f}s", flush=True)
        print(f"cross-tile NMS over {len(kept_boxes)} core-kept boxes ...", flush=True)
        t0 = time.time()
        keep_idx = run_nms(kept_boxes, kept_scores, args.iou_threshold)
        print(f"  {len(keep_idx)} boxes survive ({time.time() - t0:.1f}s)", flush=True)

        # Stable, reproducible ordering independent of tile scan order: top to
        # bottom (northing descending), then left to right (easting
        # ascending), matching how a reader would scan the map.
        final = []
        for i in keep_idx:
            xmin, ymin, xmax, ymax = kept_boxes[i]
            geom = box_to_polygon(xmin, ymin, xmax, ymax, wf)
            centroid_e = sum(c[0] for c in geom["coordinates"][0][:-1]) / 4
            centroid_n = sum(c[1] for c in geom["coordinates"][0][:-1]) / 4
            final.append((centroid_n, centroid_e, geom, kept_scores[i]))
        final.sort(key=lambda t: (-t[0], t[1]))

        features = []
        for box_id, (_, _, geom, score) in enumerate(final):
            features.append(
                {
                    "type": "Feature",
                    "properties": {"score": score, "box_id": box_id},
                    "geometry": geom,
                }
            )

        wall_clock = time.time() - t_start
        boxes_per_ha = len(features) / args.survey_area_ha if args.survey_area_ha else float("nan")

        feature_collection = {
            "type": "FeatureCollection",
            "crs": {"epsg": args.epsg},
            "properties": {
                "generator": "sudaan-forest-detect/0.1 (DeepForest weecology/deepforest-tree)",
                "epsg": args.epsg,
                "model": MODEL_NAME,
                "model_revision": MODEL_REVISION,
                "patch_size": args.patch_size,
                "patch_overlap": args.patch_overlap,
                "tile": args.tile,
                "halo": halo,
                "iou_threshold": args.iou_threshold,
                "raw_boxes": raw_total,
                "boxes_after_cross_tile_nms": len(features),
                "survey_area_ha": args.survey_area_ha,
                "boxes_per_ha": boxes_per_ha,
                "wall_clock_seconds": wall_clock,
                "note": (
                    "Unfiltered DeepForest candidates. Rejection of non-tree "
                    "detections (roofs, vehicles, bare ground) is deliberately "
                    "NOT performed here -- see this script's header comment and "
                    "docs/forest-tools-plan.md §0.2/§3.5. `score` is "
                    "DeepForest's own per-box confidence, unmodified."
                ),
            },
            "features": features,
        }

        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(feature_collection))

        print(
            f"raw boxes: {raw_total} | after cross-tile NMS: {len(features)} | "
            f"wall clock: {wall_clock:.1f}s | boxes/ha: {boxes_per_ha:.1f} "
            f"(over {args.survey_area_ha} ha) | wrote {out_path}",
            flush=True,
        )
    finally:
        shutil.rmtree(scratch_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
