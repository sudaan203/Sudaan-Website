/**
 * Reads real elevations out of Terrain-RGB tiles, in the browser.
 *
 * Why not MapLibre's `queryTerrainElevation`: that requires `setTerrain`, which
 * turns on 3D terrain and moves the camera, and it returns elevation with the
 * terrain exaggeration already applied. Both are wrong for a measurement tool.
 * Decoding the tile ourselves is a page of code, has no side effect on the view,
 * lets us treat a nodata hole as "no answer" instead of a number, and can be
 * tested without a GPU.
 *
 * Tiles are fetched through the authorised portal route on the main thread, so
 * they carry the session cookie. Decoded tiles are cached, because a profile
 * along a line hits the same handful of tiles hundreds of times.
 */

const TILE = 256;

/** Mapbox Terrain-RGB, the encoding scripts/make-terrain-tiles.mjs writes. */
function decodeMapbox(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

/** The other common packing, supported so a future export is not stuck. */
function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export type DemEncoding = "mapbox" | "terrarium";

/** Slippy tile containing a coordinate, plus where inside it the point falls. */
export function tileFor(lon: number, lat: number, zoom: number) {
  const n = 2 ** zoom;
  const fx = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  return {
    z: zoom,
    x,
    y,
    px: Math.min(TILE - 1, Math.max(0, Math.floor((fx - x) * TILE))),
    py: Math.min(TILE - 1, Math.max(0, Math.floor((fy - y) * TILE))),
  };
}

type Decoded = { data: Uint8ClampedArray; width: number; height: number } | null;

export class DemSampler {
  private cache = new Map<string, Promise<Decoded>>();
  private readonly decode: (r: number, g: number, b: number) => number;

  constructor(
    /** Tile template with {z}/{x}/{y}, already pointed at the authorised route. */
    private readonly template: string,
    private readonly minZoom: number,
    private readonly maxZoom: number,
    encoding: DemEncoding = "mapbox",
  ) {
    this.decode = encoding === "terrarium" ? decodeTerrarium : decodeMapbox;
  }

  /** Sample the deepest zoom we actually generated, so values are never interpolated up. */
  private clampZoom(zoom: number): number {
    return Math.max(this.minZoom, Math.min(this.maxZoom, Math.round(zoom)));
  }

  private load(z: number, x: number, y: number): Promise<Decoded> {
    const key = `${z}/${x}/${y}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const url = this.template
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));

    const promise = (async (): Promise<Decoded> => {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        // 204 is a tile inside the bounding box but off the survey footprint.
        if (response.status === 204 || !response.ok) return null;
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0);
        const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        const { width, height } = bitmap;
        bitmap.close();
        // A zero size decode would make every pixel index negative, and the
        // arithmetic downstream would quietly produce NaN rather than fail.
        if (width < 1 || height < 1) return null;
        return { data, width, height };
      } catch {
        return null;
      }
    })();

    this.cache.set(key, promise);
    return promise;
  }

  /** Elevation in metres, or null where the survey has no data. */
  async elevationAt(lon: number, lat: number, zoom: number): Promise<number | null> {
    const t = tileFor(lon, lat, this.clampZoom(zoom));
    const tile = await this.load(t.z, t.x, t.y);
    if (!tile) return null;

    const scale = tile.width / TILE;
    const px = Math.min(tile.width - 1, Math.floor(t.px * scale));
    const py = Math.min(tile.height - 1, Math.floor(t.py * scale));
    const i = (py * tile.width + px) * 4;

    // alpha 0 marks a hole the pipeline filled to keep the hillshade intact.
    // Returning a number there would be inventing ground.
    if (tile.data[i + 3] === 0) return null;

    const elevation = this.decode(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
    // Never hand back a NaN. It would pass a `!== null` check, reach the profile
    // chart, and render as an SVG path full of NaN coordinates: a broken graph
    // rather than an honest "no data here".
    return Number.isFinite(elevation) ? elevation : null;
  }

  /** Elevations for many points, sharing tile fetches. */
  async elevations(
    points: { point: [number, number]; distance: number }[],
    zoom: number,
  ): Promise<{ distance: number; elevation: number | null }[]> {
    const z = this.clampZoom(zoom);
    // Warm the cache once per distinct tile rather than once per sample.
    const needed = new Set(
      points.map((p) => {
        const t = tileFor(p.point[0], p.point[1], z);
        return `${t.z}/${t.x}/${t.y}`;
      }),
    );
    await Promise.all(
      [...needed].map((k) => {
        const [tz, tx, ty] = k.split("/").map(Number);
        return this.load(tz, tx, ty);
      }),
    );

    return Promise.all(
      points.map(async (p) => ({
        distance: p.distance,
        elevation: await this.elevationAt(p.point[0], p.point[1], z),
      })),
    );
  }
}
