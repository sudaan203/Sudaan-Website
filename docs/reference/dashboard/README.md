# Reference dashboard: the EnerComp "Monuments" portal

Stills from the walkthrough of the portal we are modelling, built by **EnerComp
Solutions Pvt Ltd** for the Directorate of Archaeology and Museums, Pune
Division. Kept here so a fresh session can see the target without needing the
video, which is 424 MB and gitignored.

These are somebody else's product, captured for design reference. The account
email in the top bar is redacted. Do not reuse the teal and green palette: our
theme is warm light, see `context.md` section 3.

Regenerate or extend the set from the video with:

```bash
ffmpeg -i "05. Dashboard_Overview_video.mp4" -vf "fps=1/20,scale=1280:-1" -q:v 4 out/f%03d.jpg
```

| File | What it shows | Why it matters to us |
|---|---|---|
| `01-monuments-list.jpg` | Landing page: cascading Division / District / Name filters, four column card grid, per card dates and actions | Our `/portal` dashboard is this, minus the management buttons |
| `02-orthomaps-ortho.jpg` | Orthomosaic with the layer tree: Drawing, Layers, Drone Imagery, Base layers, each with a checkbox and opacity slider | **The main gap.** This is a real WebGIS, not an image viewer |
| `03-orthomaps-dtm.jpg` | Same view with the DTM raster toggled on over the ortho | Layer switching is the interaction to copy |
| `04-contour-labels.jpg` | Contours drawn over the imagery with elevation labels (777 m, 782 m) | Vector overlays carry labels, not just lines |
| `05-pointcloud-potree.jpg` | Potree: point budget, field of view, Eye-Dome-Lighting, measurement, clipping | Confirms Potree in an iframe for Phase 3 |
| `06-video-embed.jpg` | Drone video behind a SELECT VIDEO dropdown, YouTube player | Matches the plan: unlisted YouTube, no bandwidth cost |
| `07-report-pdf-viewer.jpg` | A 42 page report in a PDF viewer with a page thumbnail rail | Ours does this already, minus the download and print controls |
| `08-file-table.jpg` | `No / File Name / Action` table with DOWNLOAD and VIEW per row; a `.dwg` row offers download only | **Where we deliberately differ: we never offer download** |

See `context.md` section 8f for the full write up and the list of what is still
missing on our side.
