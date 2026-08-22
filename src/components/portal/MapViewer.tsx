"use client";

import { useCallback, useEffect, useRef, useState } from "react";
// Named imports: maplibre-gl v6 removed the default export, and importing it
// as a namespace builds fine but fails at runtime with "not a constructor".
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  FullscreenControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapLayer } from "@/lib/portal/map-data";
import {
  AnalysisClient,
  AnalysisError,
  latest,
  type AnalysisEnvelope,
  type Pair,
  type PolygonStatsResult,
  type ProfileResult,
  type Surface,
  type VolumeReference,
} from "@/lib/portal/analysis-client";
import {
  formatElevation,
  lonLatToUtm,
  pathLength,
  ringArea,
} from "@/lib/portal/geodesy";
import {
  HydrologyClient,
  type FloodResult,
  type InspectResult,
  type SinksResult,
  type WatershedResult,
} from "@/lib/portal/hydrology-client";
import { MeasurePanel, type ElevationState, type Measurement } from "./MeasurePanel";
import { SpotLevelPanel, type SpotReading } from "./SpotLevelPanel";
import { VolumePanel, type VolumeState } from "./VolumePanel";
import {
  HydrologyPanel,
  STREAM_ORDER_COLOURS,
  type HydrologyMode,
  type HydrologyState,
} from "./HydrologyPanel";

/**
 * The survey map: georeferenced deliverables drawn over each other, with the
 * controls a surveyor actually reaches for.
 *
 * Design notes worth keeping:
 *
 * - No basemap by default. Every basemap tile is a request to a third party
 *   carrying the bounding box of a client's site, which is not ours to leak.
 *   It is one toggle away, labelled with what it does.
 * - Contours give up their elevation on hover. Baked labels would need self
 *   hosted glyph fonts, and pointing at a line is less cluttered than the
 *   reference dashboard's permanent labels anyway.
 * - Opacity per layer, because comparing a surface model against terrain is the
 *   whole point of having both.
 * - No download path: MapLibre draws into a canvas from an authorised URL, and
 *   nothing here offers to export the source raster.
 */

type Props = {
  siteSlug: string;
  siteName: string;
  layers: MapLayer[];
};

const RASTER_OPACITY = 0.85;

/**
 * Point MapLibre at a worker we serve ourselves.
 *
 * MapLibre tiles vector data in a web worker, and it locates that worker's
 * script through `new URL(..., import.meta.url)`. Next's bundler does not emit
 * that file, so the worker never starts. Nothing errors: raster image sources
 * keep working because they decode on the main thread, while every GeoJSON
 * source sits at isSourceLoaded false with zero features, which looked exactly
 * like the contours "not being fetched".
 *
 * public/vendor/maplibre-gl-worker.mjs is copied from the package by the
 * postinstall script, so it cannot drift from the installed version.
 */
setWorkerUrl("/vendor/maplibre-gl-worker.mjs");

/**
 * The survey's own stated accuracy, used to qualify every elevation shown.
 *
 * A fallback only. Every analysis response carries the survey's real `rmseZ`
 * from its own checkpoint report, and that is preferred wherever it arrives;
 * this is what the hover readout uses before the first response lands.
 */
const TOLERANCE_M = 0.04;

/**
 * How long the pointer must settle before the map asks the server how high the
 * ground is under it.
 *
 * There is exactly one source of elevation in this component and it is the
 * analysis API, so the hover readout has to go over the network too. Firing per
 * mousemove would be hundreds of requests a drag; firing on settle is one.
 * 140 ms is below the ~200 ms that reads as lag and above the gaps inside a
 * normal drag, so a moving pointer produces no requests at all.
 */
const HOVER_SETTLE_MS = 140;

type Group = "Imagery and models" | "Terrain" | "Vectors";
const GROUPS: readonly Group[] = ["Imagery and models", "Terrain", "Vectors"] as const;

/** Groups mirror how the deliverables are actually discussed. */
function groupOf(layer: MapLayer): Group {
  if (layer.kind === "vector") return "Vectors";
  if (layer.kind === "dem") return "Terrain";
  return "Imagery and models";
}

/**
 * `spot` and `volume` are single-purpose tools rather than variations on
 * measuring: spot accumulates a list of levels and draws no geometry, volume
 * needs a closed ring *and* a reference surface before it can answer at all.
 */
type MeasureMode = "off" | "spot" | "distance" | "area" | "volume";

/** Modes that draw a polygon rather than a path. */
const CLOSES_A_RING = new Set<MeasureMode>(["area", "volume"]);

/**
 * Most samples a single profile may ask for.
 *
 * A 3 km haul road at Kotba's 24 cm cell is 12,500 samples, and the chart it
 * feeds is 240 px wide. Past this the extra points are invisible, the response
 * is megabytes of JSON, and the server walks the raster for no benefit. Below
 * it, native spacing wins, because sampling finer than the grid shows
 * interpolation rather than measurement.
 */
const MAX_PROFILE_SAMPLES = 2000;

/**
 * Sample spacing for a profile, or undefined to let the server use the raster's
 * own cell size, which is what it should do for any ordinary line.
 */
function profileSpacing(
  ring: [number, number][],
  zone: number,
  northern: boolean,
  cellSize: number | null,
): number | undefined {
  if (!cellSize) return undefined;
  const length = pathLength(ring, zone, northern);
  if (length <= 0) return undefined;
  const native = length / cellSize;
  return native > MAX_PROFILE_SAMPLES ? length / MAX_PROFILE_SAMPLES : undefined;
}

/**
 * A closed ring is answered with polygon statistics, an open path with a
 * profile. One lane serves both because they are the same gesture at different
 * stages, and they must cancel each other: a profile still in flight when the
 * client closes the ring describes geometry that no longer exists.
 */
type ShapeResponse = AnalysisEnvelope & { result: ProfileResult | PolygonStatsResult };

/**
 * What to show a client when a measurement fails.
 *
 * `AnalysisError` messages are already written for a client to read, including
 * the API's own refusals, so they pass through. Anything else is a bug on our
 * side and gets wording that does not pretend otherwise.
 */
function messageFor(error: unknown): string {
  if (error instanceof AnalysisError) return error.message;
  return "The measurement could not be computed.";
}

export default function MapViewer({ siteSlug, siteName, layers }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<InstanceType<typeof MapLibreMap> | null>(null);

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [basemap, setBasemap] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>(() => {
    // Open on the orthomosaic, which is the layer a client recognises, rather
    // than whichever raster the pipeline happened to write first. With relief
    // shading on top this is a shaded true colour view, which is the state worth
    // landing on.
    const opening =
      layers.find((l) => l.kind === "tiles" && /ortho|mosaic|rgb/i.test(l.key))?.key ??
      layers.find((l) => l.kind === "tiles" || l.kind === "raster")?.key;
    return Object.fromEntries(
      layers.map((l) => [l.key, l.key === opening || l.kind === "vector"]),
    );
  });
  const [opacity, setOpacity] = useState<Record<string, number>>(() =>
    Object.fromEntries(layers.map((l) => [l.key, RASTER_OPACITY])),
  );
  const [readout, setReadout] = useState<string>("");
  const [vectorError, setVectorError] = useState<string | null>(null);
  const [hillshade, setHillshade] = useState(true);

  // ---- measurement --------------------------------------------------------
  const [mode, setMode] = useState<MeasureMode>("off");
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [elevation, setElevation] = useState<ElevationState>({ state: "idle" });
  const [spots, setSpots] = useState<SpotReading[]>([]);
  const [spotBusy, setSpotBusy] = useState(false);
  const [spotError, setSpotError] = useState<string | null>(null);
  const [volume, setVolume] = useState<VolumeState>({ state: "idle" });
  /**
   * Which model the tools read. A surveyor measuring a stockpile wants the DSM;
   * one setting out formation levels wants bare earth. Getting this wrong is not
   * a rounding error, it is the difference between the top of a tree and the
   * ground under it, so it is a visible control rather than an assumption.
   */
  const [surface, setSurface] = useState<Surface>("dtm");
  /** The accuracy the server last reported for this survey, preferred over the default. */
  const [rmseZ, setRmseZ] = useState<number | null>(null);

  // Points live in a ref as well, because the map's click handler is registered
  // once and would otherwise close over the first render's empty array.
  const drawn = useRef<[number, number][]>([]);
  const modeRef = useRef<MeasureMode>("off");
  modeRef.current = mode;
  const surfaceRef = useRef<Surface>(surface);
  surfaceRef.current = surface;
  // The map's handlers are registered once, so anything they read at event time
  // has to come through a ref rather than a closed-over render value.
  const toleranceRef = useRef<number>(TOLERANCE_M);

  const dem = layers.find((l) => l.kind === "dem");
  const utmZone = dem?.utmZone ?? 43;
  const utmNorthern = dem?.utmNorthern ?? true;

  const tolerance = rmseZ ?? TOLERANCE_M;
  toleranceRef.current = tolerance;

  /**
   * The analysis API, bound to this site, with three independent "latest wins"
   * lanes.
   *
   * Separate lanes because these compete for different panels: a hover readout
   * arriving late must not cancel the profile the client is waiting for, and
   * vice versa. One shared lane would have them abort each other, which shows up
   * as a readout that never fills in while a measurement is in flight.
   */
  const client = useRef<AnalysisClient>(null as unknown as AnalysisClient);
  if (!client.current) client.current = new AnalysisClient(siteSlug);

  const hoverLane = useRef(
    latest((signal: AbortSignal, at: Pair, model: Surface) =>
      client.current.spot(at, { surface: model }, signal),
    ),
  );
  const shapeLane = useRef(
    latest(
      (
        signal: AbortSignal,
        points: Pair[],
        closed: boolean,
        model: Surface,
        spacing: number | undefined,
      ): Promise<ShapeResponse> =>
        closed
          ? client.current.polygonStats(points, { surface: model }, signal)
          : client.current.profile(points, { surface: model, spacing }, signal),
    ),
  );
  const volumeLane = useRef(
    latest((signal: AbortSignal, ring: Pair[], reference: VolumeReference, model: Surface) =>
      client.current.volume(ring, reference, { surface: model }, signal),
    ),
  );

  /**
   * The survey's native cell size, learned from whatever response arrives first.
   *
   * Only used to keep a profile over a very long line from asking for tens of
   * thousands of samples. Until something has answered it stays null and the
   * server picks its own native spacing, which is the right answer anyway.
   */
  const cellSizeRef = useRef<number | null>(null);

  /** Record the accuracy and resolution every response carries. */
  const noteEnvelope = useCallback((response: { cellSize: number; rmseZ: number | null }) => {
    cellSizeRef.current = response.cellSize;
    if (response.rmseZ !== null) setRmseZ((current) => (current === response.rmseZ ? current : response.rmseZ));
  }, []);

  const url = useCallback(
    (file: string) => `/api/portal/sites/${siteSlug}/map/${file}`,
    [siteSlug],
  );

  /**
   * Redraw the measurement and recompute its numbers.
   *
   * The split here is the whole design. **Geometry** — length, area, perimeter —
   * is exact arithmetic on the vertices the client just placed, projected into
   * the survey's UTM zone by `geodesy.ts`. It needs no elevation model, so it
   * lands in the panel on the same frame as the click. **Elevation** goes to the
   * server, because the only way to compute it here would be to decode a
   * Terrain-RGB tile, and that is quantised to 0.1 m, nearest-neighbour sampled,
   * and in the wrong projection (see `analysis-client.ts`).
   *
   * So the panel fills in twice, and says which half it is still waiting on.
   */
  const recompute = useCallback(
    async (instance: InstanceType<typeof MapLibreMap>, closed: boolean) => {
      const points = drawn.current;
      const active = modeRef.current;
      const isRing = CLOSES_A_RING.has(active);
      const source = instance.getSource("measure");

      const ring = isRing && points.length > 2 ? [...points, points[0]] : points;
      const features: GeoJSON.Feature[] = points.map((p) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: p },
      }));
      if (points.length > 1) {
        features.push(
          isRing && closed && points.length > 2
            ? {
                type: "Feature",
                properties: {},
                geometry: { type: "Polygon", coordinates: [ring] },
              }
            : {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: ring },
              },
        );
      }
      if (source && "setData" in source) {
        (source as { setData: (d: unknown) => void }).setData({
          type: "FeatureCollection",
          features,
        });
      }

      if (points.length < 2) {
        setMeasurement(null);
        setElevation({ state: "idle" });
        return;
      }

      // Geometry: instant, and independent of whether the server ever answers.
      setMeasurement({
        mode: isRing ? "area" : "distance",
        points,
        length: pathLength(ring, utmZone, utmNorthern),
        area: isRing && points.length > 2 ? ringArea(points, utmZone, utmNorthern) : 0,
        utmZone,
        closed,
      });

      // Volume draws the same ring but answers a different question, and its
      // panel reads none of this: the client picks a reference surface and asks
      // explicitly. Sampling the polygon on every corner would be work nobody
      // asked for and an answer nobody sees.
      if (active === "volume") return;

      // A ring only means something to the server once it is closed and has
      // three corners; before that it is still a path.
      const askForStats = isRing && closed && points.length > 2;
      if (isRing && !askForStats) {
        setElevation({ state: "idle" });
        return;
      }

      setElevation({ state: "loading" });
      try {
        const response = await shapeLane.current.call(
          (askForStats ? ring : points) as Pair[],
          askForStats,
          surfaceRef.current,
          askForStats ? undefined : profileSpacing(ring, utmZone, utmNorthern, cellSizeRef.current),
        );
        // Superseded by a newer click. The newer call owns the panel now.
        if (response === null) return;

        noteEnvelope(response);
        // `askForStats` chose the op, so it also decides which result came back.
        setElevation(
          askForStats
            ? {
                state: "stats",
                data: response.result as PolygonStatsResult,
                cellSize: response.cellSize,
                computedIn: response.computedIn,
              }
            : {
                state: "profile",
                data: response.result as ProfileResult,
                cellSize: response.cellSize,
                computedIn: response.computedIn,
              },
        );
      } catch (error) {
        setElevation({ state: "error", message: messageFor(error) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [utmZone, utmNorthern],
  );

  const clearMeasurement = useCallback(() => {
    drawn.current = [];
    setMeasurement(null);
    // Cancel rather than merely ignore: a response landing into a cleared panel
    // would repopulate it with numbers for geometry that is no longer drawn.
    shapeLane.current.cancel();
    volumeLane.current.cancel();
    setElevation({ state: "idle" });
    setVolume({ state: "idle" });
    const instance = map.current;
    const source = instance?.getSource("measure");
    if (source && "setData" in source) {
      (source as { setData: (d: unknown) => void }).setData({
        type: "FeatureCollection",
        features: [],
      });
    }
  }, []);

  /** Tool 4. Explicit reference, explicit request: never computed on a whim. */
  const computeVolume = useCallback(
    async (reference: VolumeReference) => {
      const points = drawn.current;
      if (points.length < 3) return;
      const ring = [...points, points[0]] as Pair[];

      setVolume({ state: "loading" });
      try {
        const response = await volumeLane.current.call(ring, reference, surfaceRef.current);
        if (response === null) return;
        noteEnvelope(response);
        setVolume({
          state: "done",
          data: response.result,
          reference,
          surface: response.surface,
        });
      } catch (error) {
        setVolume({ state: "error", message: messageFor(error) });
      }
    },
    [noteEnvelope],
  );

  /**
   * The map's click handler is registered once and must reach a function
   * defined further down this component, so it goes through a ref rather than a
   * closure. Same reason `modeRef` exists: a handler that captured the first
   * render's callback would keep calling it forever.
   */
  const askHydrologyRef = useRef<(lon: number, lat: number) => void>(() => {});

  /** Tool 1. One click, one authoritative level, appended to the list. */
  const takeSpot = useCallback(
    async (lon: number, lat: number) => {
      setSpotBusy(true);
      setSpotError(null);
      try {
        // Deliberately not on a "latest wins" lane: every click is a level the
        // client asked for and expects to keep, so they must not cancel each
        // other the way a hover readout should.
        const response = await client.current.spot([lon, lat], {
          surface: surfaceRef.current,
        });
        noteEnvelope(response);
        setSpots((current) => [
          ...current,
          {
            id: Date.now() + current.length,
            lon,
            lat,
            easting: response.result.easting,
            northing: response.result.northing,
            elevation: response.result.elevation,
            surface: response.surface,
            computedIn: response.computedIn,
          },
        ]);
      } catch (error) {
        setSpotError(messageFor(error));
      } finally {
        setSpotBusy(false);
      }
    },
    [noteEnvelope],
  );

  // ---- build the map once -------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const raster = layers.find((l) => l.kind !== "vector" && l.coordinates);
    const corners = raster?.coordinates;
    if (!corners) {
      setFailed("This site has no georeferenced layers yet.");
      return;
    }

    const lons = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];

    let instance: InstanceType<typeof MapLibreMap>;
    try {
      instance = new MapLibreMap({
        container: container.current,
        // An empty style, so nothing is fetched from anywhere until the person
        // asks for a basemap.
        // No glyphs entry: baked text labels need self hosted glyph PBFs, and
        // the alternative is a font CDN that the site's CSP rightly blocks.
        // Contour heights are surfaced on hover instead, which also avoids the
        // label clutter the reference dashboard has at low zoom.
        style: { version: 8, sources: {}, layers: [] },
        bounds,
        fitBoundsOptions: { padding: 24 },
        attributionControl: false,
        // Respect the same preference the rest of the site does.
        ...(window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? { fadeDuration: 0 }
          : {}),
      });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "The map could not start.");
      return;
    }

    map.current = instance;
    instance.addControl(new NavigationControl({ showCompass: true }), "top-left");
    instance.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    instance.addControl(new FullscreenControl(), "top-left");

    const vectorIds = layers.filter((l) => l.kind === "vector").map((l) => l.key);

    /**
     * The readout the reference dashboard has, plus the two things it does not:
     * the survey's own UTM coordinates, and the elevation under the cursor read
     * from the terrain model rather than from a contour line that happens to be
     * nearby.
     *
     * Throttled to animation frames. A mousemove handler that awaits a tile
     * decode on every pixel would queue hundreds of promises across a single
     * drag.
     */
    let pending = false;
    let lastLngLat: { lng: number; lat: number } | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const refreshReadout = () => {
      pending = false;
      const at = lastLngLat;
      if (!at) return;

      const [easting, northing] = lonLatToUtm(at.lng, at.lat, utmZone, utmNorthern);
      const base =
        `${at.lat.toFixed(6)}, ${at.lng.toFixed(6)}` +
        `  ·  ${easting.toFixed(1)} E ${northing.toFixed(1)} N`;
      // Coordinates are ours to compute and appear on the same frame as the
      // pointer. Only the height has to be asked for.
      setReadout(base);

      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const settled = lastLngLat;
        if (!settled || settled !== at) return;
        void hoverLane.current
          .call([settled.lng, settled.lat] as Pair, surfaceRef.current)
          .then((response) => {
            // Superseded, or the pointer moved on while this was in flight.
            if (response === null || lastLngLat !== settled) return;
            noteEnvelope(response);
            const height = response.result.elevation;
            if (height === null) return;
            setReadout(`${formatElevation(height, toleranceRef.current)}  ·  ${base}`);
          })
          .catch(() => {
            // A hover readout is an aid, not a measurement. If the server cannot
            // answer, the coordinates still stand and nothing should be shouted
            // about it; the measure tools report their own failures properly.
          });
      }, HOVER_SETTLE_MS);
    };

    instance.on("mousemove", (event) => {
      lastLngLat = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      if (!pending) {
        pending = true;
        requestAnimationFrame(refreshReadout);
      }

      // Reading a contour's height by pointing at it, in place of baked labels.
      const vectors = vectorIds.filter((id) => instance.getLayer(id));
      const hit = vectors.length
        ? instance.queryRenderedFeatures(
            [
              [event.point.x - 4, event.point.y - 4],
              [event.point.x + 4, event.point.y + 4],
            ],
            { layers: vectors },
          )[0]
        : undefined;

      instance.getCanvas().style.cursor =
        modeRef.current !== "off" ? "crosshair" : hit ? "help" : "";
    });
    instance.on("mouseout", () => {
      lastLngLat = null;
      clearTimeout(settleTimer);
      setReadout("");
    });

    // ---- measure: click to add a vertex, double click to finish ------------
    instance.on("click", (event) => {
      // Hydrology tools take precedence: they are single-click questions about a
      // point, and they draw their own answer rather than accumulating geometry.
      if (hydroModeRef.current !== "off") {
        askHydrologyRef.current(event.lngLat.lng, event.lngLat.lat);
        return;
      }
      if (modeRef.current === "off") return;
      // Spot levels take a reading and draw nothing: they are a list, not a
      // shape, and a run of them should not turn into a polygon.
      if (modeRef.current === "spot") {
        void takeSpot(event.lngLat.lng, event.lngLat.lat);
        return;
      }
      drawn.current = [...drawn.current, [event.lngLat.lng, event.lngLat.lat]];
      void recompute(instance, false);
    });
    instance.on("dblclick", (event) => {
      if (modeRef.current === "off" || modeRef.current === "spot") return;
      // Stop the default zoom, which would otherwise fire on the gesture that
      // finishes a measurement.
      event.preventDefault();

      // A double click is two clicks first, so the click handler above has
      // already added the same vertex twice. Drop the duplicate rather than
      // leaving a zero length segment in the geometry, which would also put a
      // spurious flat step in the elevation profile.
      const pts = drawn.current;
      if (pts.length >= 2) {
        const [ax, ay] = pts[pts.length - 1];
        const [bx, by] = pts[pts.length - 2];
        if (Math.abs(ax - bx) < 1e-9 && Math.abs(ay - by) < 1e-9) {
          drawn.current = pts.slice(0, -1);
        }
      }
      void recompute(instance, true);
    });
    instance.on("error", (event) => {
      // MapLibre reports missing tiles this way; do not blank the whole map.
      console.error("[portal map]", event.error?.message ?? event);
    });

    instance.on("load", () => {
      for (const layer of layers) {
        if (layer.kind === "dem" && layer.tiles) {
          /**
           * Terrain-RGB, used for relief shading and nothing else.
           *
           * MapLibre renders `hillshade` from this source natively, which gives
           * the client relief they can turn up or down rather than a colour ramp
           * baked at ingest. That is the right job for these tiles: shading is a
           * picture, and Terrain-RGB's 0.1 m quantisation is invisible in one.
           *
           * It is emphatically **not** where any reported number comes from. It
           * used to be, and the measurements were wrong by amounts that looked
           * plausible; see the header of `analysis-client.ts`. Every height on
           * this page is now read server side from the source raster.
           */
          instance.addSource(layer.key, {
            type: "raster-dem",
            tiles: [`${window.location.origin}${url(layer.tiles)}`],
            tileSize: 256,
            minzoom: layer.minZoom ?? 0,
            maxzoom: layer.maxZoom ?? 22,
            encoding: layer.encoding ?? "mapbox",
            ...(layer.bounds ? { bounds: layer.bounds } : {}),
          });
          instance.addLayer({
            id: layer.key,
            type: "hillshade",
            source: layer.key,
            paint: {
              // Warm shadows rather than the default blue grey, to sit with the
              // site's palette instead of fighting it.
              "hillshade-shadow-color": "#4a2a10",
              "hillshade-highlight-color": "#fae2c0",
              "hillshade-accent-color": "#7c2d12",
              "hillshade-exaggeration": 0.55,
            },
            layout: { visibility: "none" },
          });
          continue;
        }

        if (layer.kind === "tiles" && layer.tiles) {
          /**
           * A tile pyramid. The browser asks for the handful of 256 px squares
           * covering the current view, so a 3 GB deliverable costs the same as a
           * 3 MB one: about 70 KB a screen.
           *
           * `bounds` stops MapLibre requesting tiles outside the survey, and
           * `maxzoom` lets it stretch the deepest level rather than asking for
           * tiles that were never generated, so zooming past native resolution
           * degrades smoothly instead of going blank.
           */
          instance.addSource(layer.key, {
            type: "raster",
            tiles: [`${window.location.origin}${url(layer.tiles)}`],
            tileSize: 256,
            minzoom: layer.minZoom ?? 0,
            maxzoom: layer.maxZoom ?? 22,
            ...(layer.bounds ? { bounds: layer.bounds } : {}),
          });
          instance.addLayer({
            id: layer.key,
            type: "raster",
            source: layer.key,
            paint: { "raster-opacity": RASTER_OPACITY, "raster-fade-duration": 0 },
            layout: { visibility: "none" },
          });
        } else if (layer.kind === "raster" && layer.coordinates && layer.file) {
          instance.addSource(layer.key, {
            type: "image",
            url: url(layer.file),
            coordinates: layer.coordinates,
          });
          instance.addLayer({
            id: layer.key,
            type: "raster",
            source: layer.key,
            paint: {
              "raster-opacity": RASTER_OPACITY,
              "raster-fade-duration": 0,
            },
            layout: { visibility: "none" },
          });
        } else if (layer.file) {
          const vectorFile = layer.file;
          /**
           * Start empty and fill it in from a fetch we make ourselves.
           *
           * Handing MapLibre the URL is the obvious way and it silently does
           * nothing here: GeoJSON is loaded inside MapLibre's worker, that
           * request does not carry the session cookie, and our authorised route
           * answers 401. There is no error on screen and no missing tile, the
           * source just sits at isSourceLoaded false forever. Raster image
           * sources work because they load on the main thread through an <img>,
           * which is exactly why the models drew and the contours did not.
           */
          instance.addSource(layer.key, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });

          void (async () => {
            try {
              const response = await fetch(url(vectorFile), { credentials: "same-origin" });
              if (!response.ok) throw new Error(`${response.status} for ${vectorFile}`);
              const data = await response.json();
              const source = instance.getSource(layer.key);
              if (source && "setData" in source) {
                (source as { setData: (d: unknown) => void }).setData(data);
              }
            } catch (err) {
              console.error("[portal map] could not load", layer.key, err);
              setVectorError(layer.title);
            }
          })();
          instance.addLayer({
            id: layer.key,
            type: "line",
            source: layer.key,
            paint: {
              "line-color": "#7c2d12",
              "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 20, 1.6],
              "line-opacity": 0.9,
            },
            layout: { visibility: "none" },
          });
        }
      }

      /*
       * Whatever the hydrology tools last answered: a catchment, a flood, or a
       * set of depressions. Added below the measurement geometry so a drawn
       * polygon is never hidden by a traced one, and in a water blue that does
       * not compete with the warm accent the measure tools use.
       */
      instance.addSource("hydro-result", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "hydro-result-fill",
        type: "fill",
        source: "hydro-result",
        paint: { "fill-color": "#0284c7", "fill-opacity": 0.25 },
      });
      instance.addLayer({
        id: "hydro-result-edge",
        type: "line",
        source: "hydro-result",
        paint: { "line-color": "#075985", "line-width": 1.5, "line-opacity": 0.9 },
      });

      // Measurement geometry, always on top of the deliverables.
      instance.addSource("measure", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "measure-fill",
        type: "fill",
        source: "measure",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#E58E3A", "fill-opacity": 0.18 },
      });
      instance.addLayer({
        id: "measure-line",
        type: "line",
        source: "measure",
        paint: {
          "line-color": "#C2410C",
          "line-width": 2,
          "line-dasharray": [2, 1.5],
        },
      });
      instance.addLayer({
        id: "measure-points",
        type: "circle",
        source: "measure",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#FFFFFF",
          "circle-stroke-color": "#C2410C",
          "circle-stroke-width": 2,
        },
      });

      setReady(true);
    });

    return () => {
      instance.remove();
      map.current = null;
    };
    // Layers are fixed for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Which elevation models can this survey actually be measured against?
   *
   * Asked, never inferred, and this is load bearing rather than fastidious. The
   * obvious source is the layer manifest, but the manifest describes what is
   * *drawn*: the tile pyramids are committed to the repository and deploy with
   * the site, while the source rasters the analysis reads are gitignored and
   * reachable only where `PORTAL_TERRAIN_DIR` points at them. So in production
   * the map renders a terrain layer beautifully and there is nothing behind it
   * to measure. Trusting the manifest there would offer a client four tools that
   * look available and fail on the first click.
   *
   * The analysis API answers the real question precisely: a 409 means that
   * surface is not on disk. One spot request per surface at the survey's centre
   * settles it. A point off the footprint is still a valid answer — `elevation:
   * null` with a 200 proves the raster exists, which is what is being asked.
   */
  type TerrainProbe =
    | { state: "checking" }
    | { state: "ready"; dtm: boolean; dsm: boolean }
    | { state: "unavailable"; message: string };

  const [probe, setProbe] = useState<TerrainProbe>({ state: "checking" });

  useEffect(() => {
    const corners = layers.find((l) => l.kind !== "vector" && l.coordinates)?.coordinates;
    if (!corners) {
      setProbe({ state: "unavailable", message: "This survey has no georeferenced layers yet." });
      return;
    }
    const centre: Pair = [
      corners.reduce((s, c) => s + c[0], 0) / corners.length,
      corners.reduce((s, c) => s + c[1], 0) / corners.length,
    ];

    let live = true;
    void (async () => {
      const ask = (surface: Surface) =>
        client.current
          .spot(centre, { surface })
          .then((response) => {
            noteEnvelope(response);
            return true as const;
          })
          .catch((error: unknown) => error);

      const [dtm, dsm] = await Promise.all([ask("dtm"), ask("dsm")]);
      if (!live) return;

      if (dtm === true || dsm === true) {
        setProbe({ state: "ready", dtm: dtm === true, dsm: dsm === true });
        // A survey published as surface model only should open on the surface
        // model, rather than on a terrain model that is not there.
        if (dtm !== true && dsm === true) setSurface("dsm");
        return;
      }
      // Neither is measurable. The API's own wording is written for a client to
      // read and distinguishes "not published yet" from "too large to measure",
      // so it is passed through rather than replaced with something vaguer.
      setProbe({
        state: "unavailable",
        message:
          dtm instanceof AnalysisError
            ? dtm.message
            : "The measurement tools are unavailable for this survey.",
      });
    })();

    return () => {
      live = false;
    };
  }, [layers, noteEnvelope]);

  /** Both models present, so offering a choice between them means something. */
  const hasBothSurfaces = probe.state === "ready" && probe.dtm && probe.dsm;
  /** Anything at all to measure against. */
  const measurable = probe.state === "ready";

  // ---- hydrology ----------------------------------------------------------
  const hydroClient = useRef<HydrologyClient>(null as unknown as HydrologyClient);
  if (!hydroClient.current) hydroClient.current = new HydrologyClient(siteSlug);

  const [hydro, setHydro] = useState<HydrologyState | null>(null);
  const [hydroMode, setHydroMode] = useState<HydrologyMode>("off");
  const [showStreams, setShowStreams] = useState(false);
  const [showBasins, setShowBasins] = useState(false);
  const [inspected, setInspected] = useState<InspectResult | null>(null);
  const [watershed, setWatershed] = useState<WatershedResult | null>(null);
  const [flood, setFlood] = useState<FloodResult | null>(null);
  const [sinks, setSinks] = useState<SinksResult | null>(null);
  const [floodLevel, setFloodLevel] = useState("");
  const [sinkDepth, setSinkDepth] = useState(0.25);
  const [hydroBusy, setHydroBusy] = useState(false);
  const [hydroError, setHydroError] = useState<string | null>(null);
  const hydroModeRef = useRef<HydrologyMode>("off");
  hydroModeRef.current = hydroMode;
  const floodLevelRef = useRef("");
  floodLevelRef.current = floodLevel;

  /**
   * Has hydrology been computed for this survey?
   *
   * Asked once on load, exactly as the terrain probe is, and for the same
   * reason: hydrology is an operator step (`hydro-run.mjs`) rather than a
   * deliverable, so a site can have a perfectly good terrain model and no
   * hydrology at all. Offering the tools and failing on the first click would
   * be the same mistake in a different module.
   */
  useEffect(() => {
    let live = true;
    void hydroClient.current
      .layers()
      .then((response) => {
        if (!live) return;
        setHydro({
          analysis: response.result.analysis,
          resolutionNote: response.resolutionNote,
          generatedAt: response.generatedAt,
          maxStreamOrder: 0,
        });
      })
      .catch(() => {
        // No hydrology for this site. The section stays hidden rather than
        // showing controls that cannot answer.
      });
    return () => {
      live = false;
    };
  }, [siteSlug]);

  /*
   * There is deliberately no elevation sampler here any more.
   *
   * `DemSampler` used to decode the Terrain-RGB tiles and answer every height
   * question in the browser. It is still what MapLibre renders the hillshade
   * from, and that is the right job for it: relief shading is a picture, and
   * 0.1 m quantisation is invisible in one. It is the wrong thing to *measure*
   * with, and phase 0 of the tools plan asks for exactly this severance — "no
   * code path computes a reported number from a Terrain RGB tile". Every number
   * on this page now comes from the analysis API against the source raster.
   */

  // ---- reflect state into the map ----------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    for (const layer of layers) {
      if (!instance.getLayer(layer.key)) continue;
      const shown = layer.kind === "dem" ? hillshade : visible[layer.key];
      instance.setLayoutProperty(layer.key, "visibility", shown ? "visible" : "none");
      if (layer.kind === "dem") {
        // The slider drives relief strength here, not transparency: a hillshade
        // faded to nothing is just a paler picture, whereas exaggeration is the
        // control a surveyor actually wants.
        instance.setPaintProperty(
          layer.key,
          "hillshade-exaggeration",
          Math.max(0.05, (opacity[layer.key] ?? RASTER_OPACITY) * 0.8),
        );
      } else if (layer.kind === "raster" || layer.kind === "tiles") {
        instance.setPaintProperty(layer.key, "raster-opacity", opacity[layer.key] ?? RASTER_OPACITY);
      } else {
        instance.setPaintProperty(layer.key, "line-opacity", opacity[layer.key] ?? 0.9);
      }
    }
  }, [visible, opacity, ready, layers, hillshade]);

  /**
   * Fetch and draw a hydrology vector layer the first time it is asked for.
   *
   * Fetched here rather than handed to MapLibre as a URL for the same reason the
   * contours are: GeoJSON is loaded inside MapLibre's worker, that request does
   * not carry the session cookie, and the authorised route answers 401 with no
   * error on screen and no missing tile. The source simply never fills.
   */
  const ensureVector = useCallback(
    async (name: "streams" | "basins") => {
      const instance = map.current;
      if (!instance || !ready) return;
      const id = `hydro-${name}`;
      if (instance.getSource(id)) return;

      let data: GeoJSON.FeatureCollection;
      try {
        const response = await hydroClient.current.vector(name);
        data = response.result.geojson;
      } catch (error) {
        setHydroError(messageFor(error));
        return;
      }
      if (!map.current) return;

      instance.addSource(id, { type: "geojson", data });

      if (name === "streams") {
        // Width and colour both carry Strahler order, so the network reads as a
        // system rather than as a mess of identical blue lines. Order is a small
        // integer, so a step expression is exact where an interpolation would
        // imply values between orders that cannot exist.
        // A MapLibre expression is a heterogeneous nested array, which no useful
        // TypeScript type describes; the library's own typings fall back to
        // `unknown[]` for exactly this reason.
        const colour: unknown[] = ["step", ["coalesce", ["get", "strahler_order"], 1]];
        colour.push(STREAM_ORDER_COLOURS[0]);
        for (let order = 2; order <= STREAM_ORDER_COLOURS.length; order += 1) {
          colour.push(order, STREAM_ORDER_COLOURS[order - 1]);
        }
        instance.addLayer({
          id,
          type: "line",
          source: id,
          paint: {
            "line-color": colour as unknown as string,
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              14,
              ["*", 0.4, ["coalesce", ["get", "strahler_order"], 1]],
              20,
              ["*", 1.3, ["coalesce", ["get", "strahler_order"], 1]],
            ],
            "line-opacity": 0.95,
          },
          layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        });

        const orders = data.features.map(
          (f) => Number(f.properties?.strahler_order ?? 0) || 0,
        );
        const max = orders.length ? Math.max(...orders) : 0;
        setHydro((current) => (current ? { ...current, maxStreamOrder: max } : current));
      } else {
        instance.addLayer({
          id,
          type: "fill",
          source: id,
          paint: { "fill-color": "#0ea5e9", "fill-opacity": 0.12 },
          layout: { visibility: "none" },
        });
        instance.addLayer({
          id: `${id}-edge`,
          type: "line",
          source: id,
          paint: { "line-color": "#0369a1", "line-width": 0.8, "line-opacity": 0.5 },
          layout: { visibility: "none" },
        });
      }
    },
    [ready],
  );

  useEffect(() => {
    if (showStreams) void ensureVector("streams");
    const instance = map.current;
    if (instance?.getLayer("hydro-streams")) {
      instance.setLayoutProperty("hydro-streams", "visibility", showStreams ? "visible" : "none");
    }
  }, [showStreams, ensureVector]);

  useEffect(() => {
    if (showBasins) void ensureVector("basins");
    const instance = map.current;
    for (const id of ["hydro-basins", "hydro-basins-edge"]) {
      if (instance?.getLayer(id)) {
        instance.setLayoutProperty(id, "visibility", showBasins ? "visible" : "none");
      }
    }
  }, [showBasins, ensureVector]);

  /** Draw whatever the hydrology tools last returned, as one overlay. */
  const drawHydroResult = useCallback((data: GeoJSON.FeatureCollection | null) => {
    const instance = map.current;
    const source = instance?.getSource("hydro-result");
    if (source && "setData" in source) {
      (source as { setData: (d: unknown) => void }).setData(
        data ?? { type: "FeatureCollection", features: [] },
      );
    }
  }, []);

  const clearHydrology = useCallback(() => {
    setInspected(null);
    setWatershed(null);
    setFlood(null);
    setSinks(null);
    setHydroError(null);
    drawHydroResult(null);
  }, [drawHydroResult]);

  /**
   * Tools 26 to 28: one click, one question about that point.
   *
   * Not on a "latest wins" lane. Each of these is a deliberate question whose
   * answer the client expects to keep, the same reasoning as spot levels, and a
   * watershed trace is fast enough that overlapping requests are not the problem
   * here that a dragged hover readout would be.
   *
   * Only one of the three results is ever on screen: they answer different
   * questions about the same click, and leaving a stale catchment beside a fresh
   * flood would invite reading them as one another.
   */
  const askHydrology = useCallback(
    async (lon: number, lat: number) => {
      const mode = hydroModeRef.current;
      if (mode === "off") return;

      /*
       * `Number("")` is 0, and 0 is finite, so a blank box would sail through a
       * plain isFinite check and ask the server to flood this site to sea level.
       * On a survey sitting at 340 m that comes back as a refusal, which is the
       * right answer arriving from the wrong place: the client should be told
       * what is missing without a round trip.
       */
      const level = floodLevelRef.current.trim() === "" ? NaN : Number(floodLevelRef.current);
      if (mode === "flood" && !Number.isFinite(level)) {
        setHydroError("Enter a water level in metres before clicking the map.");
        return;
      }

      setHydroBusy(true);
      setHydroError(null);
      try {
        if (mode === "inspect") {
          const response = await hydroClient.current.inspect([lon, lat]);
          setInspected(response.result);
          setWatershed(null);
          setFlood(null);
          drawHydroResult(null);
        } else if (mode === "watershed") {
          const response = await hydroClient.current.watershed([lon, lat]);
          setWatershed(response.result);
          setInspected(null);
          setFlood(null);
          drawHydroResult(response.result.geojson);
        } else {
          const response = await hydroClient.current.flood([lon, lat], level);
          setFlood(response.result);
          setInspected(null);
          setWatershed(null);
          drawHydroResult(response.result.geojson);
        }
      } catch (error) {
        setHydroError(messageFor(error));
      } finally {
        setHydroBusy(false);
      }
    },
    [drawHydroResult],
  );
  askHydrologyRef.current = (lon, lat) => void askHydrology(lon, lat);

  const findSinks = useCallback(async () => {
    setHydroBusy(true);
    setHydroError(null);
    try {
      const response = await hydroClient.current.sinks(sinkDepth);
      setSinks(response.result);
      drawHydroResult(response.result.geojson);
    } catch (error) {
      setHydroError(messageFor(error));
    } finally {
      setHydroBusy(false);
    }
  }, [sinkDepth, drawHydroResult]);

  // Switching mode starts a new measurement rather than extending the last one.
  useEffect(() => {
    if (mode === "off") return;
    clearMeasurement();
    setSpotError(null);
  }, [mode, clearMeasurement]);

  /**
   * Switching between the terrain and surface models re-reads whatever is drawn.
   *
   * Leaving the old numbers on screen under a changed label would be the worst
   * of the options available: the panel would say DSM while showing heights read
   * off the DTM, and nothing about it would look wrong. A volume is dropped
   * outright rather than re-run, because it was computed against a reference the
   * client chose for the other surface and re-running it silently would be
   * answering a question they did not ask.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    setVolume({ state: "idle" });
    if (drawn.current.length < 2) return;
    void recompute(instance, measurement?.closed ?? false);
    // Only when the surface changes, not when the measurement does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    if (basemap && !instance.getSource("basemap")) {
      instance.addSource("basemap", {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      });
      // Underneath everything else.
      const first = instance.getStyle().layers?.[0]?.id;
      instance.addLayer(
        { id: "basemap", type: "raster", source: "basemap", paint: { "raster-opacity": 0.9 } },
        first,
      );
    } else if (instance.getLayer("basemap")) {
      instance.setLayoutProperty("basemap", "visibility", basemap ? "visible" : "none");
    }
  }, [basemap, ready]);

  if (failed) {
    return (
      <div className="surface p-6">
        <p className="text-sm text-ink/70">{failed}</p>
      </div>
    );
  }

  /**
   * A terrain layer is *drawn*, which is a weaker claim than measurable and is
   * now only used for the controls that read the tiles: relief shading, and the
   * surface switch that sits beside it. What the tools may measure is `probe`.
   */
  const hasTerrain = Boolean(dem);

  return (
    <div className="surface overflow-hidden">
      {/* Toolbar. The reference dashboard puts its draw and measure tools here;
          ours carries the two that produce a number a client can rely on. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink/[0.08] px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Measure
        </span>
        {(
          [
            ["spot", "Spot level"],
            ["distance", "Distance"],
            ["area", "Area"],
            ["volume", "Volume"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            /*
             * Every one of these reads the elevation model, so without one they
             * are decoration. Gated on the server probe rather than on the
             * presence of a terrain layer in the manifest, because those two
             * disagree exactly where it matters: a deployment that ships the
             * tile pyramids without the source rasters draws terrain it cannot
             * measure. Disabled with a reason beats a tool that answers
             * "unavailable" only after a client has used it.
             */
            disabled={!measurable}
            title={
              probe.state === "checking"
                ? "Checking the elevation model…"
                : probe.state === "unavailable"
                  ? probe.message
                  : undefined
            }
            onClick={() => setMode(mode === value ? "off" : value)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              mode === value
                ? "bg-accent-600 text-white"
                : "border border-ink/15 text-ink/70 hover:border-accent-600 hover:text-accent-700"
            }`}
          >
            {label}
          </button>
        ))}
        {/*
          Say why the tools are off, in the toolbar, rather than only in a title
          attribute nobody hovers. "Not published yet" is a different fact from
          "too large to measure", and the API distinguishes them.
        */}
        {probe.state === "unavailable" ? (
          <span className="text-[11px] text-ink/55">{probe.message}</span>
        ) : probe.state === "checking" ? (
          <span className="text-[11px] text-ink/45">Checking the elevation model…</span>
        ) : mode === "spot" ? (
          <span className="text-[11px] text-ink/55">Click anywhere to take a level.</span>
        ) : mode !== "off" ? (
          <span className="text-[11px] text-ink/55">
            Click to add points, double click to finish.
          </span>
        ) : null}

        {hasTerrain ? (
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {/*
              Which model the numbers come from. Not buried in the layer tree:
              the layer tree controls what is *drawn*, and this controls what is
              *measured*, which are different questions that happen to name the
              same two files.
            */}
            {hasBothSurfaces ? (
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label="Surface the tools measure"
              >
                <span className="text-[11px] text-ink/50">Measure on</span>
                {(
                  [
                    ["dtm", "Terrain"],
                    ["dsm", "Surface"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={surface === value}
                    onClick={() => setSurface(value)}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                      surface === value
                        ? "bg-ink-900 text-white"
                        : "border border-ink/15 text-ink/70 hover:border-accent-600"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="flex min-h-6 cursor-pointer items-center gap-2 py-0.5 text-xs text-ink/70">
              <input
                type="checkbox"
                checked={hillshade}
                onChange={(e) => setHillshade(e.target.checked)}
                className="h-4 w-4 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
              />
              Relief shading
            </label>
          </div>
        ) : null}
      </div>

      <div className="relative">
        <div
          ref={container}
          role="application"
          aria-label={`Survey map of ${siteName}`}
          /**
           * Sized to what is left of the viewport, not to a flat 68vh.
           * At 68vh on a 900px laptop the map ran past the fold, so the bottom of
           * the layer tree and the basemap toggle were only reachable by scrolling
           * the page, which is the one thing you do not want to do while panning a
           * map. clamp keeps it usable on a short window and stops it becoming
           * absurd on a tall one.
           *
           * 26rem is measured, not guessed: the page chrome above the canvas is
           * 389px (header, back link, title, section heading, toolbar), so
           * 100vh-20rem left the card 70px past the fold at every viewport height
           * tested. 26rem leaves it about 25px of clearance.
           */
          className="h-[clamp(360px,calc(100vh-26rem),760px)] w-full bg-mist"
        />

        {!ready ? (
          <div className="absolute inset-0 flex items-center justify-center bg-mist">
            <p className="text-sm text-ink/60">Loading the survey map…</p>
          </div>
        ) : null}

        {/* Layer tree. A panel on desktop, and it collapses under the map on
            small screens rather than covering it. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-72 p-3 lg:block">
          <div className="pointer-events-auto max-h-full overflow-y-auto rounded-xl border border-ink/10 bg-panel/95 p-4 shadow-card backdrop-blur">
            <ToolPanel
              mode={mode}
              measurement={measurement}
              elevation={elevation}
              surface={surface}
              spots={spots}
              spotBusy={spotBusy}
              spotError={spotError}
              volume={volume}
              tolerance={tolerance}
              onClear={clearMeasurement}
              onComputeVolume={computeVolume}
              onRemoveSpot={(id) => setSpots((s) => s.filter((r) => r.id !== id))}
              onClearSpots={() => {
                setSpots([]);
                setSpotError(null);
              }}
            />
            {hydro ? (
              <div className="mb-4 border-b border-ink/[0.08] pb-4">
                <HydrologyPanel
                  state={hydro}
                  mode={hydroMode}
                  setMode={setHydroMode}
                  showStreams={showStreams}
                  setShowStreams={setShowStreams}
                  showBasins={showBasins}
                  setShowBasins={setShowBasins}
                  inspected={inspected}
                  watershed={watershed}
                  flood={flood}
                  sinks={sinks}
                  floodLevel={floodLevel}
                  setFloodLevel={setFloodLevel}
                  sinkDepth={sinkDepth}
                  setSinkDepth={setSinkDepth}
                  onFindSinks={() => void findSinks()}
                  busy={hydroBusy}
                  error={hydroError}
                  onClear={clearHydrology}
                />
              </div>
            ) : null}
            <LayerTree
              groups={GROUPS}
              layers={layers}
              visible={visible}
              opacity={opacity}
              setVisible={setVisible}
              setOpacity={setOpacity}
              basemap={basemap}
              setBasemap={setBasemap}
              hillshade={hillshade}
              setHillshade={setHillshade}
            />
          </div>
        </div>

        {vectorError ? (
          <p
            role="status"
            className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-signal/10 px-3 py-1.5 text-xs font-semibold text-signal-600"
          >
            {vectorError} could not be loaded
          </p>
        ) : null}

        {readout ? (
          <p className="pointer-events-none absolute bottom-2 right-3 rounded bg-panel/90 px-2 py-1 font-mono text-[11px] text-ink/70">
            {readout}
          </p>
        ) : null}
      </div>

      <div className="border-t border-ink/[0.08] p-4 lg:hidden">
        <ToolPanel
          mode={mode}
          measurement={measurement}
          elevation={elevation}
          surface={surface}
          spots={spots}
          spotBusy={spotBusy}
          spotError={spotError}
          volume={volume}
          tolerance={tolerance}
          onClear={clearMeasurement}
          onComputeVolume={computeVolume}
          onRemoveSpot={(id) => setSpots((s) => s.filter((r) => r.id !== id))}
          onClearSpots={() => {
            setSpots([]);
            setSpotError(null);
          }}
        />
        <LayerTree
          groups={GROUPS}
          layers={layers}
          visible={visible}
          opacity={opacity}
          setVisible={setVisible}
          setOpacity={setOpacity}
          basemap={basemap}
          setBasemap={setBasemap}
          hillshade={hillshade}
          setHillshade={setHillshade}
        />
      </div>
    </div>
  );
}

/**
 * Whichever tool is active gets the top of the panel.
 *
 * One component rather than three conditionals at each of the two call sites,
 * because the desktop panel and the mobile stack have to stay identical and
 * they drifted once already.
 */
function ToolPanel({
  mode,
  measurement,
  elevation,
  surface,
  spots,
  spotBusy,
  spotError,
  volume,
  tolerance,
  onClear,
  onComputeVolume,
  onRemoveSpot,
  onClearSpots,
}: {
  mode: MeasureMode;
  measurement: Measurement | null;
  elevation: ElevationState;
  surface: Surface;
  spots: SpotReading[];
  spotBusy: boolean;
  spotError: string | null;
  volume: VolumeState;
  tolerance: number;
  onClear: () => void;
  onComputeVolume: (reference: VolumeReference) => void;
  onRemoveSpot: (id: number) => void;
  onClearSpots: () => void;
}) {
  const body =
    mode === "spot" ? (
      <SpotLevelPanel
        readings={spots}
        toleranceM={tolerance}
        busy={spotBusy}
        error={spotError}
        onRemove={onRemoveSpot}
        onClear={onClearSpots}
      />
    ) : mode === "volume" ? (
      <VolumePanel
        ready={Boolean(measurement?.closed) && (measurement?.points.length ?? 0) > 2}
        polygonArea={measurement?.area ?? 0}
        surface={surface}
        result={volume}
        onCompute={onComputeVolume}
        onClear={onClear}
      />
    ) : measurement ? (
      <MeasurePanel
        measurement={measurement}
        elevation={elevation}
        surface={surface}
        onClear={onClear}
        toleranceM={tolerance}
      />
    ) : null;

  if (!body) return null;
  return <div className="mb-4 border-b border-ink/[0.08] pb-4">{body}</div>;
}

function LayerTree({
  groups,
  layers,
  visible,
  opacity,
  setVisible,
  setOpacity,
  basemap,
  setBasemap,
  hillshade,
  setHillshade,
}: {
  groups: readonly string[];
  layers: MapLayer[];
  visible: Record<string, boolean>;
  opacity: Record<string, number>;
  setVisible: (fn: (v: Record<string, boolean>) => Record<string, boolean>) => void;
  setOpacity: (fn: (v: Record<string, number>) => Record<string, number>) => void;
  basemap: boolean;
  setBasemap: (v: boolean) => void;
  hillshade: boolean;
  setHillshade: (v: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const inGroup = layers.filter((l) => groupOf(l) === group);
        if (inGroup.length === 0) return null;
        return (
          <fieldset key={group}>
            <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink/50">
              {group}
            </legend>
            <div className="space-y-3">
              {inGroup.map((layer) => {
                const isDem = layer.kind === "dem";
                const on = isDem ? hillshade : Boolean(visible[layer.key]);
                return (
                  <div key={layer.key}>
                    {/* min-h-6 so the row itself clears the 24px minimum target
                        size. The visible box stays 16px; the label is what gets
                        clicked, and it spans the full width of the panel. */}
                    <label className="flex min-h-6 cursor-pointer items-center gap-2 py-0.5 text-sm text-ink-900">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          isDem
                            ? setHillshade(e.target.checked)
                            : setVisible((v) => ({ ...v, [layer.key]: e.target.checked }))
                        }
                        className="h-4 w-4 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
                      />
                      <span className="flex-1">{layer.title}</span>
                    </label>

                    {layer.elevation ? (
                      <p className="ml-6 text-[11px] text-ink/50">
                        {Math.round(layer.elevation.min)} to {Math.round(layer.elevation.max)} m
                        {layer.featureCount ? ` · ${layer.featureCount} lines` : ""}
                        {isDem ? " · measurable" : ""}
                      </p>
                    ) : null}

                    {/*
                      The slider carries its own visible label and value.
                      It used to be an unlabelled 1px-high track: a sighted user had
                      no idea what it did, and the accessible name came out as
                      "Orthomosaicopacity" because the sr-only span sat directly
                      against the title with no separating space.
                    */}
                    <div className="ml-6 mt-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <label
                          htmlFor={`op-${layer.key}`}
                          className={`text-[10px] uppercase tracking-wide ${on ? "text-ink/45" : "text-ink/25"}`}
                        >
                          {isDem ? "Relief" : "Opacity"}
                        </label>
                        <span
                          aria-hidden
                          className={`font-mono text-[10px] ${on ? "text-ink/45" : "text-ink/25"}`}
                        >
                          {Math.round((opacity[layer.key] ?? RASTER_OPACITY) * 100)}%
                        </span>
                      </div>
                      <input
                        id={`op-${layer.key}`}
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round((opacity[layer.key] ?? RASTER_OPACITY) * 100)}
                        disabled={!on}
                        onChange={(e) =>
                          setOpacity((o) => ({ ...o, [layer.key]: Number(e.target.value) / 100 }))
                        }
                        // h-6 is the hit area, not the track. A range input renders
                        // its track at the browser default thickness and centres the
                        // thumb, so this is a 24px grab target that still looks like a
                        // hairline. It was 6px, which is fiddly with a mouse and worse
                        // with a thumb.
                        className="h-6 w-full cursor-pointer accent-accent-600 disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </div>

                    {isDem ? (
                      <p className="ml-6 mt-1 text-[11px] leading-snug text-ink/55">
                        Real elevations, not a colour picture of them. This is what the
                        measure tools read.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <fieldset className="border-t border-ink/[0.08] pt-4">
        <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Base map
        </legend>
        {/*
          The explanation is a description, not part of the name.
          Nested inside the label it became part of the accessible name, so a
          screen reader announced "OpenStreetMap Off by default. Turning this on
          requests map tiles from OpenStreetMap, which reveals roughly where this
          site is to a third party, checkbox" every single time. aria-describedby
          keeps the reasoning available without reading an essay on focus.
        */}
        <label className="flex min-h-6 items-center gap-2 py-0.5 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={basemap}
            onChange={(e) => setBasemap(e.target.checked)}
            aria-describedby="basemap-privacy"
            className="h-4 w-4 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
          />
          OpenStreetMap
        </label>
        <p id="basemap-privacy" className="ml-6 mt-0.5 text-[11px] leading-snug text-ink/55">
          Off by default. Turning this on requests map tiles from OpenStreetMap,
          which reveals roughly where this site is to a third party.
        </p>
      </fieldset>
    </div>
  );
}
