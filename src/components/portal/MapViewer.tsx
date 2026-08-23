"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Named imports: maplibre-gl v6 removed the default export, and importing it
// as a namespace builds fine but fails at runtime with "not a constructor".
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  FullscreenControl,
  Marker,
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
  type AlignmentOp,
  type ChainageResult,
  type CorridorResult,
  type CrossSectionsResult,
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
  type LayerSummary,
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
import { RenderedLayersPanel, type RenderedLayer } from "./RenderedLayers";
import {
  AlignmentPanel,
  type AlignmentControls,
  type AlignmentState,
} from "./AlignmentPanel";
import { ToolRail, type RailAction } from "./ToolRail";
import {
  ContourPanel,
  describeContours,
  type ContourControls,
  type ContourState,
} from "./ContourPanel";
import {
  PointCloudPanel,
  type CloudControls,
  type CloudStats,
} from "./PointCloudPanel";
import type { CloudManifest } from "@/lib/portal/cloud-source";
import { PointCloudLayer } from "@/lib/portal/point-cloud-layer";
import type { ToolGroupKey } from "@/lib/portal/tool-catalogue";

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
type MeasureMode = "off" | "spot" | "distance" | "area" | "volume" | "alignment";

/**
 * Which question the volume mode is asking.
 *
 * Tools 4 and 15 share a mode because they share an act — draw a ring, choose a
 * reference — and differ in what the server is asked for and what is worth
 * printing. A stockpile is quoted as volume, base area and height; an earthwork
 * is quoted as cut, fill and net.
 */
type VolumeOp = "volume" | "stockpile";

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
  const [volumeOp, setVolumeOp] = useState<VolumeOp>("volume");
  /**
   * Tools 19, 20, 21 and 16, which share a drawn centreline and differ only in
   * what is asked of it. Defaults match the server's, so an untouched panel and
   * an untouched request agree.
   */
  const [alignment, setAlignment] = useState<AlignmentState>({ state: "idle" });
  const [alignmentControls, setAlignmentControls] = useState<AlignmentControls>({
    op: "chainage",
    interval: 10,
    halfWidth: 15,
    maxGradePercent: 10,
    maxCrossfallPercent: 6,
    benchSlopePercent: 10,
  });
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
  const volumeOpRef = useRef<VolumeOp>("volume");
  volumeOpRef.current = volumeOp;
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
  const alignmentLane = useRef(
    latest(
      (
        signal: AbortSignal,
        op: AlignmentOp,
        line: Pair[],
        model: Surface,
        options: Record<string, number>,
      ) => client.current.alignment<unknown>(op, line, { surface: model, ...options }, signal),
    ),
  );
  const volumeLane = useRef(
    latest(
      (
        signal: AbortSignal,
        ring: Pair[],
        reference: VolumeReference,
        model: Surface,
        op: VolumeOp,
      ) =>
        op === "stockpile"
          ? client.current.stockpile(ring, reference, { surface: model }, signal)
          : client.current.volume(ring, reference, { surface: model }, signal),
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

      // Volume and the alignment tools draw the same geometry but answer
      // different questions, and their panels read none of this: the client
      // picks a reference or an interval and asks explicitly. Sampling on every
      // corner would be work nobody asked for and an answer nobody sees — and on
      // a long alignment it would be a profile request per click.
      if (active === "volume" || active === "alignment") return;

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
    alignmentLane.current.cancel();
    setElevation({ state: "idle" });
    setVolume({ state: "idle" });
    setAlignment({ state: "idle" });
    const instance = map.current;
    for (const marker of stationMarkers.current) marker.remove();
    stationMarkers.current = [];
    for (const id of ["measure", "alignment-result"]) {
      const source = instance?.getSource(id);
      if (source && "setData" in source) {
        (source as { setData: (d: unknown) => void }).setData({
          type: "FeatureCollection",
          features: [],
        });
      }
    }
  }, []);

  /** Tools 4 and 15. Explicit reference, explicit request: never on a whim. */
  const computeVolume = useCallback(
    async (reference: VolumeReference) => {
      const points = drawn.current;
      if (points.length < 3) return;
      const ring = [...points, points[0]] as Pair[];

      setVolume({ state: "loading" });
      try {
        const response = await volumeLane.current.call(
          ring,
          reference,
          surfaceRef.current,
          volumeOpRef.current,
        );
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

  const alignmentControlsRef = useRef(alignmentControls);
  alignmentControlsRef.current = alignmentControls;
  /** Labels on the chainage stations, as markers. Same reason as the contours. */
  const stationMarkers = useRef<InstanceType<typeof Marker>[]>([]);

  /**
   * Put an alignment answer on the map.
   *
   * Every station the server returns carries a `lonlat` computed in the survey's
   * own projection, so nothing is reprojected here. That is deliberate: the
   * browser holds no UTM implementation, and the one place that does is the same
   * place that computed the station.
   */
  const drawAlignmentResult = useCallback((op: AlignmentOp, data: unknown) => {
    const instance = map.current;
    for (const marker of stationMarkers.current) marker.remove();
    stationMarkers.current = [];
    if (!instance || !instance.getSource("alignment-result")) return;

    const features: GeoJSON.Feature[] = [];
    const labels: { at: Pair; text: string }[] = [];

    if (op === "chainage") {
      for (const station of (data as ChainageResult).stations) {
        if (!station.lonlat) continue;
        features.push({
          type: "Feature",
          properties: { unsafe: false },
          geometry: { type: "Point", coordinates: station.lonlat },
        });
        labels.push({ at: station.lonlat, text: station.label });
      }
    } else if (op === "corridor") {
      for (const station of (data as CorridorResult).stations) {
        if (!station.lonlat) continue;
        features.push({
          type: "Feature",
          properties: { unsafe: station.unsafe },
          geometry: { type: "Point", coordinates: station.lonlat },
        });
        // Only the flagged ones are labelled. Labelling every station on a
        // corridor buries the four that matter under forty that do not.
        if (station.unsafe) labels.push({ at: station.lonlat, text: station.label });
      }
    } else if (op === "cross-sections") {
      for (const section of (data as CrossSectionsResult).sections) {
        if (section.endsLonLat) {
          features.push({
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: section.endsLonLat },
          });
        }
        if (section.centreLonLat) {
          features.push({
            type: "Feature",
            properties: { unsafe: false },
            geometry: { type: "Point", coordinates: section.centreLonLat },
          });
        }
      }
    }
    // Bench analysis reads the line as a profile and has no geometry of its own
    // to draw: its answer is a table of flats and faces along the line already
    // on the map. Clearing the source says so rather than leaving a stale one.

    const source = instance.getSource("alignment-result");
    if (source && "setData" in source) {
      (source as { setData: (d: unknown) => void }).setData({
        type: "FeatureCollection",
        features,
      });
    }

    /*
     * Labels are capped and thinned rather than dropped wholesale. A 2 km road
     * at 10 m stations is 200 labels, which is unreadable; every nth label is
     * still a usable scale down the alignment.
     */
    const MAX = 40;
    const step = Math.max(1, Math.ceil(labels.length / MAX));
    labels.forEach((label, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      const element = document.createElement("span");
      element.textContent = label.text;
      element.className =
        "portal-station-label pointer-events-none select-none rounded bg-panel/85 px-1 " +
        "font-mono text-[9px] font-semibold leading-tight text-ink-900 shadow-sm";
      stationMarkers.current.push(
        new Marker({ element, anchor: "left", offset: [6, 0] })
          .setLngLat(label.at)
          .addTo(instance),
      );
    });
  }, []);

  /**
   * Tools 19, 20, 21 and 16. Explicit request, like volume: these are slow
   * enough on a long alignment that recomputing on every parameter nudge would
   * make the panel feel broken, and the client changing an interval is usually
   * about to change a half width too.
   */
  const computeAlignment = useCallback(async () => {
    const points = drawn.current;
    if (points.length < 2) return;

    const c = alignmentControlsRef.current;
    /*
     * Only the parameters the chosen op actually reads.
     *
     * Sending a half width with a bench request would be harmless today and
     * wrong the day the server starts validating its inputs, and it would put a
     * number in the request that had no effect on the answer — which is exactly
     * the sort of thing that later gets blamed for a discrepancy.
     */
    const options: Record<string, number> =
      c.op === "bench"
        ? { benchSlopePercent: c.benchSlopePercent }
        : c.op === "chainage"
          ? { interval: c.interval }
          : c.op === "cross-sections"
            ? { interval: c.interval, halfWidth: c.halfWidth }
            : {
                interval: c.interval,
                halfWidth: c.halfWidth,
                maxGradePercent: c.maxGradePercent,
                maxCrossfallPercent: c.maxCrossfallPercent,
              };

    setAlignment({ state: "loading" });
    try {
      const response = await alignmentLane.current.call(
        c.op,
        points as Pair[],
        surfaceRef.current,
        options,
      );
      if (response === null) return;
      noteEnvelope(response);
      setAlignment({ state: "done", op: c.op, data: response.result });
      drawAlignmentResult(c.op, response.result);
    } catch (error) {
      setAlignment({ state: "error", message: messageFor(error) });
    }
  }, [noteEnvelope, drawAlignmentResult]);

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

    /*
     * A handle for the browser tests, and only for them.
     *
     * Asserting that contours are *filtered* rather than merely looking sparse
     * means reading the live style, and the style lives on this object. The
     * alternative was to assert on pixels, which cannot tell a filter from a
     * layer that happens to have drawn nothing at this zoom.
     *
     * Guarded on NODE_ENV so it is absent from the production bundle: a client's
     * map should not expose an object with `setFilter` on it to anything that
     * can run script on the page.
     */
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as Record<string, unknown>).__portalMap = instance;
    }

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
              /*
               * Kept, not just handed to MapLibre. The elevation controls need
               * the levels present in the data — to size the band sliders, to
               * work out the interval, and to place labels — and MapLibre will
               * only answer questions about features it has decided to render,
               * which at low zoom is a fraction of them.
               */
              contourData.current.set(layer.key, data as GeoJSON.FeatureCollection);
              setContours((current) =>
                current ?? describeContours(layer.key, layer.title, data.features ?? []),
              );
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

      /*
       * Whatever the alignment tools last answered: chainage stations, corridor
       * stations, or the ticks a set of cross sections was cut along.
       *
       * Below the measurement geometry so the drawn centreline stays visible on
       * top of its own stations, and in a cool grey-blue that reads as drafting
       * rather than competing with the warm accent the measure tools use or the
       * water blue hydrology uses.
       */
      instance.addSource("alignment-result", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "alignment-ticks",
        type: "line",
        source: "alignment-result",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#475569", "line-width": 1.2, "line-opacity": 0.85 },
      });
      instance.addLayer({
        id: "alignment-stations",
        type: "circle",
        source: "alignment-result",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          // Flagged stations in the signal colour: on a haul road audit the
          // whole point of the layer is which ones are over the limit.
          "circle-color": ["case", ["get", "unsafe"], "#dc2626", "#334155"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2, 20, 4.5],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
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

  /**
   * Declared here rather than beside the rest of the hydrology state, because
   * the rendered-layer list below is assembled from it and a const cannot be
   * read above its own declaration.
   */
  const [hydroLayers, setHydroLayers] = useState<LayerSummary[]>([]);

  // ---- rendered raster layers --------------------------------------------
  const [renderable, setRenderable] = useState<RenderedLayer[]>([]);
  const [activeRender, setActiveRender] = useState<string | null>(null);
  const [renderOpacity, setRenderOpacity] = useState(0.85);
  const [renderExaggeration, setRenderExaggeration] = useState(1.6);
  const [renderRamp, setRenderRamp] = useState<string | null>(null);

  /**
   * Assemble what the tiler can draw for this survey, with an explicit range per
   * layer.
   *
   * The ranges come from statistics the pipeline already recorded — the DEM
   * layer's elevation range in the map manifest, and each hydrology layer's
   * min and max in its own manifest — because the alternative is letting each
   * tile stretch to its own contents, which produces a chessboard where the
   * seams outshine the terrain.
   */
  useEffect(() => {
    const out: RenderedLayer[] = [];

    if (probe.state === "ready") {
      const dem = layers.find((l) => l.kind === "dem" && l.elevation) ?? layers.find((l) => l.elevation);
      const range = dem?.elevation;
      if (range) {
        if (probe.dtm) {
          out.push({
            key: "dtm", title: "Terrain, shaded", unit: "m",
            description: "Bare earth, coloured by height with relief shading composited in.",
            min: range.min, max: range.max, ramp: "rainbow", relief: true, logarithmic: false,
          });
        }
        if (probe.dsm) {
          out.push({
            key: "dsm", title: "Surface, shaded", unit: "m",
            description: "Everything the survey saw, canopy and structures included.",
            min: range.min, max: range.max, ramp: "rainbow", relief: true, logarithmic: false,
          });
        }
      }
    }

    /** Plain-language meaning, which the manifest's own wording does not carry. */
    const MEANING: Record<string, { title: string; description: string; unit: string; ramp: string; log?: boolean }> = {
      slope_degrees: {
        title: "Slope", unit: "°", ramp: "viridis",
        description: "Steepness of the ground. Shown in degrees; 15° is about 27%.",
      },
      flow_accumulation: {
        title: "Flow accumulation", unit: "cells", ramp: "water", log: true,
        description: "How much ground drains through each cell. Channels stand out.",
      },
      sinks: {
        title: "Depression depth", unit: "m", ramp: "water",
        description: "How deep each hollow is before water would spill out of it.",
      },
      filled: {
        title: "Filled terrain", unit: "m", ramp: "rainbow",
        description: "The terrain after depressions are filled, which is what water was routed over.",
      },
    };

    for (const summary of hydroLayers) {
      const meaning = MEANING[summary.key];
      const stats = summary.stats;
      if (!meaning || !stats || !Number.isFinite(stats.min) || !Number.isFinite(stats.max)) continue;
      if (stats.max === stats.min) continue; // nothing to colour
      out.push({
        key: summary.key,
        title: meaning.title,
        description: meaning.description,
        unit: meaning.unit,
        min: stats.min as number,
        max: stats.max as number,
        ramp: meaning.ramp,
        relief: summary.key === "filled",
        logarithmic: Boolean(meaning.log),
      });
    }

    setRenderable(out);
  }, [probe, layers, hydroLayers]);

  /**
   * Point the map at the tiler.
   *
   * The source is torn down and rebuilt whenever the layer or its parameters
   * change, rather than mutated: MapLibre caches tiles by URL, so changing the
   * query string on an existing source leaves the old images on screen until
   * something evicts them, which looks like the control having no effect.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    for (const id of ["rendered-raster"]) {
      if (instance.getLayer(id)) instance.removeLayer(id);
      if (instance.getSource(id)) instance.removeSource(id);
    }
    const spec = renderable.find((l) => l.key === activeRender);
    if (!spec) return;

    const query = new URLSearchParams({
      min: String(spec.min),
      max: String(spec.max),
      opacity: "1",
    });
    if (renderRamp) query.set("ramp", renderRamp);
    if (spec.relief) query.set("exaggeration", String(renderExaggeration));

    instance.addSource("rendered-raster", {
      type: "raster",
      tiles: [
        `${window.location.origin}/api/portal/sites/${siteSlug}` +
          `/render/${spec.key}/{z}/{x}/{y}.png?${query.toString()}`,
      ],
      tileSize: 256,
      // Below the deepest level the survey can honestly answer at, MapLibre will
      // stretch the last real tiles rather than asking for ones that would be
      // interpolation dressed as data.
      maxzoom: 22,
      ...(dem?.bounds ? { bounds: dem.bounds } : {}),
    });

    // Under the measurement and hydrology overlays, over the imagery.
    const firstOverlay = ["hydro-result-fill", "measure-fill", "hydro-streams"].find((id) =>
      instance.getLayer(id),
    );
    instance.addLayer(
      {
        id: "rendered-raster",
        type: "raster",
        source: "rendered-raster",
        paint: { "raster-opacity": renderOpacity, "raster-fade-duration": 0 },
      },
      firstOverlay,
    );
  }, [activeRender, renderable, renderRamp, renderExaggeration, ready, siteSlug, dem?.bounds]);

  // Opacity alone is a paint property, so it does not need the source rebuilt.
  useEffect(() => {
    const instance = map.current;
    if (instance?.getLayer("rendered-raster")) {
      instance.setPaintProperty("rendered-raster", "raster-opacity", renderOpacity);
    }
  }, [renderOpacity]);

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
        setHydroLayers(response.result.layers);
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

  // ---- contours -----------------------------------------------------------

  /**
   * The contour GeoJSON as fetched, keyed by layer.
   *
   * A ref rather than state: nothing renders from it directly, and putting a
   * few hundred LineStrings into React state would re-render the whole viewer
   * every time a label moved.
   */
  const contourData = useRef(new Map<string, GeoJSON.FeatureCollection>());
  const [contours, setContours] = useState<ContourState | null>(null);
  const [contourControls, setContourControls] = useState<ContourControls>({
    labels: true,
    colour: true,
    indexEvery: 5,
    low: -Infinity,
    high: Infinity,
  });
  const [labelCount, setLabelCount] = useState(0);
  const labelMarkers = useRef<InstanceType<typeof Marker>[]>([]);

  /** Open the band to the survey's full range once the levels are known. */
  useEffect(() => {
    if (!contours) return;
    setContourControls((c) =>
      Number.isFinite(c.low) && Number.isFinite(c.high)
        ? c
        : {
            ...c,
            low: contours.levels[0],
            high: contours.levels[contours.levels.length - 1],
          },
    );
  }, [contours]);

  /**
   * Restyle and filter the contour layer from the controls.
   *
   * The filter is a MapLibre expression on the feature's own `elevation`, so
   * hiding a band costs nothing and needs no second copy of the data. The colour
   * ramp is interpolated across the *band shown*, not across the survey: banding
   * to 360-380 m and keeping the survey's 338-424 m ramp would paint those
   * twenty metres in two barely distinguishable shades, which defeats the point
   * of turning colour on.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || !contours) return;
    if (!instance.getLayer(contours.key)) return;

    const { low, high, colour, indexEvery } = contourControls;
    if (!Number.isFinite(low) || !Number.isFinite(high)) return;

    instance.setFilter(contours.key, [
      "all",
      [">=", ["coalesce", ["get", "elevation"], -1e9], low],
      ["<=", ["coalesce", ["get", "elevation"], 1e9], high],
    ] as unknown as never);

    const span = Math.max(high - low, contours.interval);
    instance.setPaintProperty(
      contours.key,
      "line-color",
      colour
        ? ([
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "elevation"], low],
            low,
            "#1d4ed8",
            low + span * 0.35,
            "#15803d",
            low + span * 0.7,
            "#ca8a04",
            high,
            "#b91c1c",
          ] as unknown as string)
        : "#7c2d12",
    );

    /*
     * Index contours as a width expression rather than a second layer.
     *
     * `elevation % (interval * n) == 0` is the printed-sheet rule, and doing it
     * in the style keeps one layer, one filter and one hover target. The modulo
     * is taken on a rounded value because a level of 372.00000000000006 is a
     * perfectly ordinary thing to find in a shapefile and would silently never
     * be an index contour.
     */
    const step = contours.interval * (indexEvery || 1);
    const isIndex = [
      "==",
      ["%", ["round", ["*", ["coalesce", ["get", "elevation"], 0], 1000]], Math.round(step * 1000)],
      0,
    ];
    instance.setPaintProperty(
      contours.key,
      "line-width",
      (indexEvery > 0
        ? [
            "interpolate",
            ["linear"],
            ["zoom"],
            14,
            ["case", isIndex, 1.2, 0.4],
            20,
            ["case", isIndex, 3, 1.1],
          ]
        : ["interpolate", ["linear"], ["zoom"], 14, 0.5, 20, 1.6]) as unknown as never,
    );
  }, [contours, contourControls, ready]);

  /**
   * Elevation labels, as HTML markers.
   *
   * There is no symbol layer here because there are no glyphs: MapLibre renders
   * text from font PBFs, the only convenient source of those is a font CDN that
   * the site's CSP blocks, and self-hosting a glyph set would ship more bytes
   * than the contours themselves. Markers cost nothing at this count and rotate
   * and pitch with the map for free.
   *
   * One label per level per screen, not one per feature. A single 372 m contour
   * can be forty separate LineStrings after clipping, and labelling each of them
   * turns the map into a wall of the same number.
   */
  const placeLabels = useCallback(() => {
    const instance = map.current;
    for (const marker of labelMarkers.current) marker.remove();
    labelMarkers.current = [];

    if (!instance || !contours || !contourControls.labels) {
      setLabelCount(0);
      return;
    }
    if (!visible[contours.key]) {
      setLabelCount(0);
      return;
    }
    const data = contourData.current.get(contours.key);
    if (!data) {
      setLabelCount(0);
      return;
    }

    const bounds = instance.getBounds();
    const { low, high, indexEvery } = contourControls;
    const step = contours.interval * (indexEvery || 1);
    const seen = new Set<number>();
    let placed = 0;
    const MAX = 36;

    /*
     * Index contours first, then the rest. Zooming out drops labels, and the
     * ones worth keeping are the ones a printed sheet would have labelled.
     */
    const priority = (level: number) =>
      indexEvery > 0 && Math.abs((level / step) - Math.round(level / step)) < 1e-6 ? 0 : 1;

    const candidates = (data.features ?? [])
      .map((feature) => {
        const level = feature.properties?.elevation;
        if (typeof level !== "number" || level < low || level > high) return null;
        const line =
          feature.geometry?.type === "LineString"
            ? (feature.geometry.coordinates as [number, number][])
            : feature.geometry?.type === "MultiLineString"
              ? ((feature.geometry.coordinates as [number, number][][])[0] ?? [])
              : [];
        // The vertex nearest the middle of the visible part of the line, so a
        // label sits on the line rather than off the edge of the screen.
        const inside = line.filter((c) => bounds.contains(c));
        if (inside.length === 0) return null;
        return { level, at: inside[Math.floor(inside.length / 2)] };
      })
      .filter((c): c is { level: number; at: [number, number] } => c !== null)
      .sort((a, b) => priority(a.level) - priority(b.level) || a.level - b.level);

    for (const candidate of candidates) {
      if (placed >= MAX) break;
      if (seen.has(candidate.level)) continue;
      seen.add(candidate.level);

      const element = document.createElement("span");
      element.textContent =
        contours.interval % 1 === 0
          ? String(candidate.level)
          : candidate.level.toFixed(1);
      /*
       * `portal-contour-label` is a hook, not a style.
       *
       * MapLibre adds its own `maplibregl-marker` class only to elements it
       * creates itself; a marker given a custom element keeps exactly the
       * classes it arrived with. Anything that needs to find these — a test
       * hiding overlays before comparing what the map painted, or someone
       * debugging in the console — has nothing else to hold on to.
       */
      element.className =
        "portal-contour-label pointer-events-none select-none rounded bg-panel/85 px-1 " +
        "font-mono text-[10px] font-semibold leading-tight text-ink-900 shadow-sm";
      labelMarkers.current.push(
        new Marker({ element, anchor: "center" }).setLngLat(candidate.at).addTo(instance),
      );
      placed += 1;
    }
    setLabelCount(placed);
  }, [contours, contourControls, visible]);

  /** Re-label whenever the view or the controls change. */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    placeLabels();
    instance.on("moveend", placeLabels);
    return () => {
      instance.off("moveend", placeLabels);
      for (const marker of labelMarkers.current) marker.remove();
      labelMarkers.current = [];
    };
  }, [placeLabels, ready]);

  // ---- the LiDAR point cloud ----------------------------------------------

  /**
   * Aektanagar's cloud is 50,183,644 points in a 1.7 GB LAS file, and until now
   * the portal's only record of it was a PDF describing it. It is served as a
   * quadtree of nodes and drawn into MapLibre's own GL context, so it sits in
   * the same map, in the same projection, as everything else — rather than in a
   * second viewer that would disagree with this one about where things are.
   */
  const [cloud, setCloud] = useState<CloudManifest | null>(null);
  const [cloudControls, setCloudControls] = useState<CloudControls>({
    visible: false,
    colourMode: "rgb",
    pointSize: 2,
    opacity: 1,
    classes: new Set<number>(),
    budget: 2_000_000,
  });
  const [cloudStats, setCloudStats] = useState<CloudStats>({
    points: 0,
    nodes: 0,
    loading: 0,
  });
  const cloudLayer = useRef<PointCloudLayer | null>(null);

  /**
   * Ask once whether this survey has a cloud, exactly as the terrain probe does.
   *
   * A 409 here is an ordinary answer, not a failure: most surveys are
   * photogrammetric and have no LiDAR at all. The panel simply does not appear.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/portal/sites/${siteSlug}/cloud`, {
          credentials: "same-origin",
        });
        if (!response.ok || cancelled) return;
        const manifest = (await response.json()) as CloudManifest;
        if (!cancelled) {
          setCloud(manifest);
          // A cloud with no RGB cannot be shown in colour, so the control that
          // would be disabled must not also be the one selected.
          if (!manifest.hasColour) {
            setCloudControls((c) => ({ ...c, colourMode: "elevation" }));
          }
        }
      } catch {
        // No cloud, or the request was abandoned on navigation. Either way the
        // panel stays away and nothing else on the map is affected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteSlug]);

  /** Add and remove the custom layer as the client turns the cloud on and off. */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || !cloud) return;

    if (!cloudControls.visible) {
      if (cloudLayer.current && instance.getLayer("lidar-cloud")) {
        instance.removeLayer("lidar-cloud");
      }
      cloudLayer.current = null;
      setCloudStats({ points: 0, nodes: 0, loading: 0 });
      return;
    }

    if (!cloudLayer.current) {
      const layer = new PointCloudLayer(
        "lidar-cloud",
        cloud,
        async (key) => {
          const response = await fetch(`/api/portal/sites/${siteSlug}/cloud/${key}`, {
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error(`${response.status} for node ${key}`);
          return response.arrayBuffer();
        },
        {
          colourMode: cloudControls.colourMode,
          pointSize: cloudControls.pointSize,
          opacity: cloudControls.opacity,
          classes: cloudControls.classes,
          budget: cloudControls.budget,
        },
        setCloudStats,
      );
      cloudLayer.current = layer;
      try {
        instance.addLayer(layer);
      } catch (error) {
        console.error("[portal map] the point cloud layer would not start", error);
        cloudLayer.current = null;
        setCloudControls((c) => ({ ...c, visible: false }));
      }
    } else {
      cloudLayer.current.setOptions({
        colourMode: cloudControls.colourMode,
        pointSize: cloudControls.pointSize,
        opacity: cloudControls.opacity,
        classes: cloudControls.classes,
        budget: cloudControls.budget,
      });
    }
  }, [cloud, cloudControls, ready, siteSlug]);

  // ---- the tool rail ------------------------------------------------------

  /**
   * Which of Malhar's five documents is on screen.
   *
   * Universal to begin with, because it is the group whose tools work on every
   * survey regardless of what the site is for. A mining client landing on the
   * road tools would be a worse first impression than one extra click.
   */
  const [group, setGroup] = useState<ToolGroupKey>("universal");

  /** The keys of the layers this survey can actually render, for the rail. */
  const renderableKeys = useMemo(() => renderable.map((l) => l.key), [renderable]);

  /**
   * What the rail should show as pressed, derived rather than stored.
   *
   * Storing it as its own state would give two sources of truth for one fact —
   * the mode the map is in, and the button that claims to have set it — and they
   * would drift the first time anything turned a mode off from somewhere else.
   */
  const railAction: RailAction | null = useMemo(
    () =>
      mode !== "off"
        ? mode === "volume"
          ? { kind: "measure", mode: "volume", op: volumeOp }
          : mode === "alignment"
            ? { kind: "measure", mode: "alignment", op: alignmentControls.op }
            : { kind: "measure", mode }
        : hydroMode !== "off"
          ? { kind: "hydrology", mode: hydroMode }
          : sinks
            ? { kind: "sinks" }
            : activeRender
              ? { kind: "layer", layer: activeRender }
              : null,
    [mode, volumeOp, alignmentControls.op, hydroMode, sinks, activeRender],
  );

  /**
   * One place where a tool is switched on, and where every other tool is
   * switched off.
   *
   * Measure mode and hydrology mode used to be two independent state machines
   * that both claimed the map's click. Nothing stopped both being on at once,
   * and when they were, one click asked the server two unrelated questions and
   * filled two panels, only one of which the client had asked for. Routing every
   * activation through here makes them exclusive by construction rather than by
   * everyone remembering to turn the other one off.
   */
  const runAction = useCallback(
    (action: RailAction) => {
      const already =
        railAction !== null &&
        railAction.kind === action.kind &&
        (action.kind !== "measure" ||
          (railAction.kind === "measure" &&
            railAction.mode === action.mode &&
            (railAction.op ?? "volume") === (action.op ?? "volume"))) &&
        (action.kind !== "hydrology" ||
          (railAction.kind === "hydrology" && railAction.mode === action.mode)) &&
        (action.kind !== "layer" ||
          (railAction.kind === "layer" && railAction.layer === action.layer));

      // Pressing the tool that is already on turns it off, which is how the
      // toolbar behaved before and is the only way to get back to plain panning.
      if (already) {
        if (action.kind === "measure") setMode("off");
        else if (action.kind === "hydrology") setHydroMode("off");
        else if (action.kind === "layer") setActiveRender(null);
        else clearHydrology();
        return;
      }

      switch (action.kind) {
        case "measure":
          setHydroMode("off");
          /*
           * The op belongs to whichever mode it names. Volume's two tools and
           * the alignment's four share one field on the action because the rail
           * asks one question — "which tool did they press" — and the answer is
           * routed to the panel that owns it.
           */
          if (action.mode === "alignment") {
            setAlignmentControls((c) => ({
              ...c,
              op: (action.op as AlignmentOp | undefined) ?? c.op,
            }));
          } else if (action.mode === "volume") {
            setVolumeOp(action.op === "stockpile" ? "stockpile" : "volume");
          }
          setMode(action.mode);
          break;
        case "hydrology":
          setMode("off");
          setHydroMode(action.mode);
          break;
        case "sinks":
          setMode("off");
          setHydroMode("off");
          void findSinks();
          break;
        case "layer":
          // A drawn layer is not a mode: it does not take the click, so it does
          // not turn a measurement off. It is here so the rail can offer tools
          // 14 and 25, which are layers rather than actions.
          setActiveRender(action.layer);
          break;
      }
    },
    [railAction, findSinks, clearHydrology],
  );

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
      {/*
        The tool rail: Malhar's five documents as five groups, one visible at a
        time. This replaced a flat row of four measure buttons, which was the
        right set of tools in the wrong shape — the specification is organised by
        discipline, and a client who opens a mining survey should not have to
        read past the road tools to find stockpile volume.
      */}
      <ToolRail
        group={group}
        setGroup={setGroup}
        active={railAction}
        onAction={runAction}
        measurable={measurable}
        unavailable={probe.state === "unavailable" ? probe.message : undefined}
        hasHydrology={Boolean(hydro)}
        renderable={renderableKeys}
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-ink/[0.08] px-4 py-2">
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
        ) : hydroMode !== "off" ? (
          <span className="text-[11px] text-ink/55">
            {hydroMode === "flood"
              ? "Set a water level, then click where the water would stand."
              : hydroMode === "watershed"
                ? "Click a point on a channel to trace everything draining through it."
                : "Click anywhere to read the hydrology under that point."}
          </span>
        ) : (
          <span className="text-[11px] text-ink/45">
            Pick a tool above, or turn on a layer on the right.
          </span>
        )}

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
              volumeOp={volumeOp}
              alignment={alignment}
              alignmentControls={alignmentControls}
              setAlignmentControls={setAlignmentControls}
              onComputeAlignment={() => void computeAlignment()}
              tolerance={tolerance}
              onClear={clearMeasurement}
              onComputeVolume={computeVolume}
              onRemoveSpot={(id) => setSpots((s) => s.filter((r) => r.id !== id))}
              onClearSpots={() => {
                setSpots([]);
                setSpotError(null);
              }}
            />
            {renderable.length > 0 ? (
              <div className="mb-4 border-b border-ink/[0.08] pb-4">
                <RenderedLayersPanel
                  layers={renderable}
                  active={activeRender}
                  setActive={setActiveRender}
                  opacity={renderOpacity}
                  setOpacity={setRenderOpacity}
                  exaggeration={renderExaggeration}
                  setExaggeration={setRenderExaggeration}
                  ramp={renderRamp}
                  setRamp={setRenderRamp}
                />
              </div>
            ) : null}
            {hydro ? (
              <div className="mb-4 border-b border-ink/[0.08] pb-4">
                <HydrologyPanel
                  state={hydro}
                  mode={hydroMode}
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
            {cloud ? (
              <div className="mb-4 border-b border-ink/[0.08] pb-4">
                <PointCloudPanel
                  manifest={cloud}
                  controls={cloudControls}
                  setControls={setCloudControls}
                  stats={cloudStats}
                />
              </div>
            ) : null}
            {contours ? (
              <div className="mb-4 border-b border-ink/[0.08] pb-4">
                <ContourPanel
                  contours={contours}
                  controls={contourControls}
                  setControls={setContourControls}
                  visible={visible[contours.key] ?? false}
                  setVisible={(on) =>
                    setVisible((v) => ({ ...v, [contours.key]: on }))
                  }
                  labelCount={labelCount}
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
          volumeOp={volumeOp}
          alignment={alignment}
          alignmentControls={alignmentControls}
          setAlignmentControls={setAlignmentControls}
          onComputeAlignment={() => void computeAlignment()}
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
  volumeOp,
  alignment,
  alignmentControls,
  setAlignmentControls,
  onComputeAlignment,
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
  volumeOp: VolumeOp;
  alignment: AlignmentState;
  alignmentControls: AlignmentControls;
  setAlignmentControls: (fn: (c: AlignmentControls) => AlignmentControls) => void;
  onComputeAlignment: () => void;
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
    ) : mode === "alignment" ? (
      <AlignmentPanel
        ready={(measurement?.points.length ?? 0) > 1}
        length={measurement?.length ?? 0}
        vertices={measurement?.points.length ?? 0}
        controls={alignmentControls}
        setControls={setAlignmentControls}
        result={alignment}
        onCompute={onComputeAlignment}
        onClear={onClear}
      />
    ) : mode === "volume" ? (
      <VolumePanel
        ready={Boolean(measurement?.closed) && (measurement?.points.length ?? 0) > 2}
        polygonArea={measurement?.area ?? 0}
        surface={surface}
        result={volume}
        pile={volumeOp === "stockpile"}
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
  /*
   * A named region, not just a div.
   *
   * It is the landmark a screen reader user jumps to for the answer they just
   * asked for, and it is the only reliable way for anything driving the page to
   * read *this* panel's text rather than the whole document's. The latter is not
   * hypothetical: a browser test waited for the word "Lowest" to appear anywhere
   * on the page, and the contour panel's "Lowest shown" slider made that wait
   * return before the profile had arrived, turning a real assertion into a
   * silent skip.
   */
  return (
    <div
      role="region"
      aria-label="Measurement"
      className="mb-4 border-b border-ink/[0.08] pb-4"
    >
      {body}
    </div>
  );
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
