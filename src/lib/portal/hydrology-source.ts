/**
 * The precomputed hydrology for a site, ready to answer questions about.
 *
 * ## Why this is not terrain-source with different filenames
 *
 * Measurement and hydrology pull in opposite directions, and both are right.
 *
 * A spot level has to be read at the survey's **native** resolution, because
 * resampling before measuring is measuring the resampling. Kotba is 24 cm and
 * Aektanagar is 7.7 cm, so those rasters are enormous and the only way to serve
 * them is to read the window a client drew on. That is `terrain-source.ts`.
 *
 * Flow routing has to be run at **1 m**, and coarser is not a compromise, it is
 * the correct answer. Routing water across a 7.7 cm photogrammetric surface
 * turns every wheel rut and vegetation artefact into a sink, and the stream
 * network becomes noise-driven braiding. Malhar's own SAGA run used 1 m from a
 * 2.5 cm ortho, a 40x reduction.
 *
 * That decision is what makes this file simple. At 1 m, Kotba's hydrology grid
 * is 336 x 380 and Aektanagar's is 493 x 513: about half a megabyte each. They
 * are read **whole**, and they have to be, because **flow routing cannot be
 * windowed even in principle** — water arrives from outside whatever box you
 * draw, so a watershed traced from a click may walk anywhere upstream. Windowing
 * that would not be an optimisation, it would be a wrong answer.
 *
 * So: native and windowed for measurement, coarse and whole for hydrology. Two
 * regimes, each because of what the question actually needs.
 *
 * ## Where the layers come from
 *
 * `scripts/hydro-run.mjs`, run once per survey, offline. Nothing here computes
 * routing on demand: filling and accumulation are whole-grid operations that
 * take seconds now and minutes at Dang Forest's size, and they do not change
 * between requests. The interactive tools are graph walks over those
 * precomputed grids, which is why they can answer in milliseconds.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cached, fileSource, httpSource } from "@/lib/geo/raster-source.mjs";
import { openRaster } from "@/lib/geo/raster-window.mjs";
import { fromEsriCodes } from "@/lib/geo/hydrology.mjs";
import { createTileGrant, TILE_GRANT_COOKIE } from "@/lib/portal/tile-grant";

export class HydrologyUnavailable extends Error {
  readonly reason: "missing" | "incomplete";
  constructor(reason: "missing" | "incomplete", message: string) {
    super(message);
    this.reason = reason;
    this.name = "HydrologyUnavailable";
  }
}

/** The rasters `hydro-run.mjs` writes, by the key the manifest uses. */
export type HydrologyLayer =
  | "filled"
  | "sinks"
  | "flow_direction"
  | "flow_accumulation"
  | "slope_degrees"
  | "stream_order";

const FILE_OF: Record<HydrologyLayer, string> = {
  filled: "filled.tif",
  sinks: "sinks.tif",
  flow_direction: "flow_direction.tif",
  flow_accumulation: "flow_accumulation.tif",
  slope_degrees: "slope_degrees.tif",
  stream_order: "stream_order.tif",
};

export type HydrologyManifest = {
  generator: string;
  generatedAt: string;
  source?: Record<string, unknown>;
  analysis: {
    cellSize: number;
    width: number;
    height: number;
    streamThresholdCells: number;
    streamThresholdArea_m2: number;
    filledCells: number;
    maxFillDepth_m: number;
    surveyArea_ha: number;
    [key: string]: unknown;
  };
  measurement?: Record<string, unknown>;
  layers: {
    key: string;
    title: string;
    group: string;
    format: string;
    file: string;
    description: string;
    derivedFrom: string;
    generator: string;
    params: Record<string, unknown>;
    crs: { epsg: number | null };
    stats?: Record<string, unknown>;
    sha256?: string;
    bytes?: number;
  }[];
};

/**
 * Same two-mode arrangement as terrain, and for the same reason: the derived
 * layers are gitignored and a serverless deployment has no disk to keep them on.
 * `PORTAL_HYDROLOGY_URL` wins when set.
 */
function hydrologyLocation(siteSlug: string) {
  const url = process.env.PORTAL_HYDROLOGY_URL;
  if (url) return { remote: true as const, base: `${url.replace(/\/+$/, "")}/${siteSlug}` };
  const dir = process.env.PORTAL_HYDROLOGY_DIR ?? join(process.cwd(), "portal-data", "hydrology");
  return { remote: false as const, base: join(dir, siteSlug) };
}

async function fetchText(siteSlug: string, remote: boolean, ref: string): Promise<string | null> {
  if (!remote) return existsSync(ref) ? readFile(ref, "utf8") : null;
  const response = await fetch(ref, {
    headers: { Cookie: `${TILE_GRANT_COOKIE}=${await createTileGrant(siteSlug)}` },
  });
  if (!response.ok) return null;
  return response.text();
}

/**
 * A grid that is definitely there.
 *
 * `readWindow` is nullable because a window can miss the raster; these reads are
 * the full extent and `grid()` throws rather than returning null, so callers get
 * a value they do not have to narrow. Without this every use in the route reads
 * `accum!.get(...)`, and a non-null assertion on every line is how a real null
 * eventually walks straight through.
 */
export type HydrologyGrid = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof openRaster>>["readWindow"]>>
>;

type Loaded = {
  manifest: HydrologyManifest;
  /** Read one of the derived rasters, whole. Cached after the first call. */
  grid: (layer: HydrologyLayer) => Promise<HydrologyGrid>;
  vector: (name: "streams" | "basins") => Promise<unknown | null>;
  cellSize: number;
  epsg: number | null;
};

const cache = new Map<string, Promise<Loaded>>();

/**
 * Load a site's hydrology, or explain precisely why there is none.
 *
 * "Not run yet" and "run but missing a layer" are different problems with
 * different fixes, and collapsing them into one message sends whoever operates
 * the pipeline looking in the wrong place.
 */
export async function loadHydrology(siteSlug: string): Promise<Loaded> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteSlug)) {
    throw new HydrologyUnavailable("missing", `"${siteSlug}" is not a valid site slug`);
  }
  const hit = cache.get(siteSlug);
  if (hit) return hit;

  const loading = (async (): Promise<Loaded> => {
    const { remote, base } = hydrologyLocation(siteSlug);
    const ref = (file: string) => (remote ? `${base}/${file}` : join(base, file));

    const text = await fetchText(siteSlug, remote, ref("manifest.json"));
    if (!text) {
      throw new HydrologyUnavailable(
        "missing",
        `No hydrology has been computed for this site. Run: ` +
          `node scripts/hydro-run.mjs --dtm portal-data/terrain/${siteSlug}/dtm.tif ` +
          `--out portal-data/hydrology/${siteSlug}`,
      );
    }

    let manifest: HydrologyManifest;
    try {
      manifest = JSON.parse(text) as HydrologyManifest;
    } catch {
      throw new HydrologyUnavailable("incomplete", "The hydrology manifest could not be read.");
    }
    if (!manifest.analysis?.cellSize) {
      throw new HydrologyUnavailable("incomplete", "The hydrology manifest has no analysis grid.");
    }

    const grids = new Map<HydrologyLayer, Promise<HydrologyGrid>>();

    const grid = (layer: HydrologyLayer) => {
      const already = grids.get(layer);
      if (already) return already;

      const reading = (async () => {
        const file = FILE_OF[layer];
        const at = ref(file);
        if (!remote && !existsSync(at)) {
          throw new HydrologyUnavailable(
            "incomplete",
            `The hydrology for this site is missing ${file}. Re-run hydro-run.mjs.`,
          );
        }
        const raster = await openRaster(
          cached(
            remote
              ? httpSource(at, {
                  headers: async () => ({
                    Cookie: `${TILE_GRANT_COOKIE}=${await createTileGrant(siteSlug)}`,
                  }),
                })
              : await fileSource(at),
          ),
        );
        // Whole, on purpose. These are half a megabyte and routing needs all of
        // it; see the header. `windowFor(bounds, 0)` is the full extent with no
        // margin, which is exactly the whole grid.
        const full = raster.windowFor(raster.bounds, 0);
        const out = await raster.readWindow(full);
        await raster.close();
        if (!out) {
          throw new HydrologyUnavailable("incomplete", `${file} contains no readable grid.`);
        }
        /*
         * Decode the flow directions here, once, rather than at each use.
         *
         * `flow_direction.tif` is written in ESRI codes so a client can open it
         * in their own GIS, but every traversal in `hydrology.mjs` indexes
         * `D8_DCOL` with an internal 0..7 direction. Handing the ESRI grid
         * straight to `watershedFrom` does not throw: `D8_DCOL[16]` is
         * undefined, no neighbour ever matches, and the trace returns the single
         * cell it started from. That is a plausible polygon and a wrong answer,
         * so the conversion belongs at the boundary where the file is read and
         * not in a caller that might forget.
         */
        return layer === "flow_direction" ? fromEsriCodes(out) : out;
      })();

      grids.set(layer, reading);
      reading.catch(() => grids.delete(layer));
      return reading;
    };

    const vector = async (name: "streams" | "basins") => {
      const body = await fetchText(siteSlug, remote, ref(`${name}.geojson`));
      return body ? (JSON.parse(body) as unknown) : null;
    };

    return {
      manifest,
      grid,
      vector,
      cellSize: manifest.analysis.cellSize,
      epsg: manifest.layers[0]?.crs?.epsg ?? null,
    };
  })();

  cache.set(siteSlug, loading);
  loading.catch(() => cache.delete(siteSlug));
  return loading;
}
