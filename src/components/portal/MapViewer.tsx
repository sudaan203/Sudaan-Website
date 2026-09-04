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
  type CompareResult,
  type GridLevelsResult,
  type CorridorResult,
  type CrossSectionsResult,
  type Surface,
  type VolumeReference,
  // Aliased: `hydrology-client` already exports a `FloodResult`, tool 28's
  // single seeded flood. This is the simulation's ladder of them, and letting
  // the two share a name in this file would make the next reader guess which
  // tool a variable belongs to.
  type FloodLevel as FloodSimLevel,
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
import { GridLevelsPanel, type GridLevelsState } from "./GridLevelsPanel";
import { SurfacePanel, type SurfaceState } from "./SurfacePanel";
import {
  ShapefilePanel,
  type ShapefileCounts,
  type ShapefileDownloadState,
  type ShapefileUploadState,
} from "./ShapefilePanel";
import {
  ShapefileClient,
  ShapefileError,
  saveShapefileZip,
  type DrawnFeature,
  type GeometryKind,
} from "@/lib/portal/shapefile-client";
import {
  FloodPanel,
  type FloodArea,
  type FloodAreaKind,
  type FloodControls,
  type FloodState,
} from "./FloodPanel";
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
 *   It is one toggle away, labelled with what it does. Two choices once
 *   turned on: OpenStreetMap streets, or Esri World Imagery satellite with
 *   its reference labels overlaid for a hybrid look - not Google's tiles,
 *   which are not licensed for this without the paid Maps Platform API.
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
type MeasureMode =
  | "off"
  | "spot"
  | "distance"
  | "area"
  | "volume"
  | "alignment"
  | "grid"
  | "compare";

/**
 * Which question the volume mode is asking.
 *
 * Tools 4 and 15 share a mode because they share an act — draw a ring, choose a
 * reference — and differ in what the server is asked for and what is worth
 * printing. A stockpile is quoted as volume, base area and height; an earthwork
 * is quoted as cut, fill and net.
 */
type VolumeOp = "volume" | "stockpile";

/**
 * Off by default (see the design note at the top of this file). "satellite"
 * is Esri World Imagery with its reference labels layered on top - a
 * "hybrid" look without Google's tiles, which need the paid Maps Platform
 * API to use legitimately.
 */
type BasemapMode = "off" | "streets" | "satellite";

/** Modes that draw a polygon rather than a path. */
const CLOSES_A_RING = new Set<MeasureMode>(["area", "volume", "grid", "compare"]);

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
 *
 * Only ever the active surface's own numbers - DSM and DTM are never fetched
 * or drawn together. An overlaid chart was tried and reversed: comparing
 * canopy against bare earth on one graph read as a single, ambiguous line to
 * a client unfamiliar with which colour meant what, and "which one am I
 * looking at" is exactly what the surface toggle already answers unambiguously.
 */
type ShapeResponse = AnalysisEnvelope & {
  result: ProfileResult | PolygonStatsResult;
};

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

/**
 * The four corners of a rectangle from two opposite ones, in lon/lat.
 *
 * Sent to the server as four corners rather than two, because a rectangle in
 * lon/lat is not a rectangle in the survey's UTM: grid convergence turns it by
 * up to half a degree here, so a box rebuilt from two opposite corners covers
 * ground the drawn one does not. The server projects all four and uses the
 * shape they make, which is the shape the client saw.
 */
function rectangleRing(
  [ax, ay]: [number, number],
  [bx, by]: [number, number],
): [number, number][] {
  return [
    [ax, ay],
    [bx, ay],
    [bx, by],
    [ax, by],
  ];
}

export default function MapViewer({ siteSlug, siteName, layers }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<InstanceType<typeof MapLibreMap> | null>(null);

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode>("off");
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
  // ---- Malhar's shapefile tool --------------------------------------------
  /**
   * A separate, self-contained state machine, deliberately, rather than a new
   * `MeasureMode` variant.
   *
   * Every numbered tool operates on one shared geometry-in-progress and one
   * shared "recompute" path, because each one asks the server a single
   * question about a single shape. This tool asks nothing of the server until
   * a download is pressed, accumulates any number of separate features per
   * geometry type rather than replacing one on each click, and finishes a
   * feature back into "ready to draw the next one" instead of into a result
   * panel. Folding that into the shared mechanism would mean teaching it a
   * shape of interaction none of the other fourteen tools have, for the sake
   * of one more. A second, independent axis — checked first, so nothing else
   * runs while it is active — is smaller and does not risk the thing every
   * other tool depends on.
   */
  const [shapefileActive, setShapefileActive] = useState<GeometryKind | null>(null);
  const shapefileActiveRef = useRef<GeometryKind | null>(null);
  shapefileActiveRef.current = shapefileActive;

  /** Every completed feature, kept in the map's own lon/lat until a download
   *  actually asks for it projected. */
  const shapefileFeatures = useRef<Record<GeometryKind, DrawnFeature[]>>({
    point: [],
    line: [],
    polygon: [],
  });
  const [shapefileCounts, setShapefileCounts] = useState<ShapefileCounts>({
    point: 0,
    line: 0,
    polygon: 0,
  });
  /** Vertices of the line or polygon currently being clicked out. */
  const shapefileDraw = useRef<[number, number][]>([]);
  const [shapefileDownload, setShapefileDownload] = useState<ShapefileDownloadState>({
    state: "idle",
  });
  const [shapefileUpload, setShapefileUpload] = useState<ShapefileUploadState>({ state: "idle" });

  const redrawShapefileFeatures = useCallback(() => {
    const source = map.current?.getSource("shapefile-features");
    if (!source || !("setData" in source)) return;
    const all = [
      ...shapefileFeatures.current.point,
      ...shapefileFeatures.current.line,
      ...shapefileFeatures.current.polygon,
    ];
    (source as { setData: (d: unknown) => void }).setData({
      type: "FeatureCollection",
      features: all.map((f, i) => ({
        type: "Feature",
        properties: f.properties ?? { id: i + 1 },
        geometry: f.geometry,
      })),
    });
  }, []);

  const redrawShapefileDraw = useCallback(() => {
    const source = map.current?.getSource("shapefile-draw");
    if (!source || !("setData" in source)) return;
    const pts = shapefileDraw.current;
    const features: GeoJSON.Feature[] = [];
    if (pts.length >= 2) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: pts },
      });
    }
    for (const p of pts) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } });
    }
    (source as { setData: (d: unknown) => void }).setData({ type: "FeatureCollection", features });
  }, []);

  /** One click: a point is a complete feature; a line or polygon adds a vertex. */
  const handleShapefileClick = useCallback(
    (lon: number, lat: number) => {
      const kind = shapefileActiveRef.current;
      if (!kind) return;
      if (kind === "point") {
        const feature: DrawnFeature = { geometry: { type: "Point", coordinates: [lon, lat] } };
        shapefileFeatures.current = {
          ...shapefileFeatures.current,
          point: [...shapefileFeatures.current.point, feature],
        };
        setShapefileCounts((c) => ({ ...c, point: c.point + 1 }));
        redrawShapefileFeatures();
        return;
      }
      shapefileDraw.current = [...shapefileDraw.current, [lon, lat]];
      redrawShapefileDraw();
    },
    [redrawShapefileFeatures, redrawShapefileDraw],
  );
  const shapefileClickRef = useRef<(lon: number, lat: number) => void>(() => {});
  shapefileClickRef.current = handleShapefileClick;

  /** A double click: close the line or polygon into a completed feature. */
  const finishShapefileDraw = useCallback(() => {
    const kind = shapefileActiveRef.current;
    if (!kind || kind === "point") return;
    let pts = shapefileDraw.current;
    // A double click is two clicks first, so the click handler above already
    // added the same vertex twice — dropped here exactly as the measure tools
    // drop it, so a shape never carries a zero-length closing segment.
    if (pts.length >= 2) {
      const [ax, ay] = pts[pts.length - 1];
      const [bx, by] = pts[pts.length - 2];
      if (Math.abs(ax - bx) < 1e-9 && Math.abs(ay - by) < 1e-9) pts = pts.slice(0, -1);
    }
    const minimum = kind === "line" ? 2 : 3;
    if (pts.length < minimum) {
      shapefileDraw.current = [];
      redrawShapefileDraw();
      return;
    }
    const geometry: GeoJSON.Geometry =
      kind === "line"
        ? { type: "LineString", coordinates: pts }
        : { type: "Polygon", coordinates: [[...pts, pts[0]]] };
    shapefileFeatures.current = {
      ...shapefileFeatures.current,
      [kind]: [...shapefileFeatures.current[kind], { geometry }],
    };
    setShapefileCounts((c) => ({ ...c, [kind]: c[kind] + 1 }));
    shapefileDraw.current = [];
    redrawShapefileDraw();
    redrawShapefileFeatures();
  }, [redrawShapefileDraw, redrawShapefileFeatures]);
  const shapefileDblClickRef = useRef(() => {});
  shapefileDblClickRef.current = finishShapefileDraw;

  const clearShapefileDrawn = useCallback(() => {
    shapefileFeatures.current = { point: [], line: [], polygon: [] };
    shapefileDraw.current = [];
    setShapefileCounts({ point: 0, line: 0, polygon: 0 });
    setShapefileDownload({ state: "idle" });
    redrawShapefileFeatures();
    redrawShapefileDraw();
  }, [redrawShapefileFeatures, redrawShapefileDraw]);

  /** Tool download: explicit request, like every other export in this portal. */
  const downloadShapefile = useCallback(async () => {
    const kind = shapefileActiveRef.current;
    if (!kind) return;
    const features = shapefileFeatures.current[kind];
    if (features.length === 0) return;
    setShapefileDownload({ state: "loading" });
    try {
      const { blob, filename } = await shapefileClient.current.download(kind, features);
      saveShapefileZip(blob, filename);
      setShapefileDownload({ state: "idle" });
    } catch (error) {
      setShapefileDownload({
        state: "error",
        message:
          error instanceof ShapefileError
            ? error.message
            : "The shapefile could not be built.",
      });
    }
  }, []);

  const uploadShapefile = useCallback(async (file: File) => {
    setShapefileUpload({ state: "loading" });
    try {
      const data = await shapefileClient.current.upload(file);
      setShapefileUpload({ state: "done", data });
      const source = map.current?.getSource("shapefile-uploaded");
      if (source && "setData" in source) {
        (source as { setData: (d: unknown) => void }).setData(data.featureCollection);
      }
    } catch (error) {
      setShapefileUpload({
        state: "error",
        message:
          error instanceof ShapefileError ? error.message : "The shapefile could not be read.",
      });
    }
  }, []);

  const clearShapefileUpload = useCallback(() => {
    setShapefileUpload({ state: "idle" });
    const source = map.current?.getSource("shapefile-uploaded");
    if (source && "setData" in source) {
      (source as { setData: (d: unknown) => void }).setData({ type: "FeatureCollection", features: [] });
    }
  }, []);

  /**
   * Turn a shapefile draw tool on or off from its own panel, clearing whichever
   * numbered tool was active — the same exclusivity `runAction` enforces in the
   * other direction, so the two halves of the map can never both think they own
   * the next click.
   */
  const setShapefileActiveTool = useCallback(
    (kind: GeometryKind | null) => {
      shapefileDraw.current = [];
      redrawShapefileDraw();
      setShapefileActive(kind);
      if (kind) {
        setMode("off");
        setHydroMode("off");
      }
    },
    [redrawShapefileDraw],
  );

  // ---- Malhar's water-level-rise simulation --------------------------------
  /**
   * A third independent axis, for the same reason the shapefile tool is a
   * second one: this tool's interaction is a shape none of the numbered tools
   * have.
   *
   * A numbered tool draws a geometry and asks one question of it. This asks a
   * *ladder* of questions once, up front, and then plays the answers back
   * locally — an animation with its own clock, its own transport controls, and
   * a slider that has to keep working while the animation is paused. The only
   * thing it wants from the map is a single click to place a water source,
   * and only while it is armed for one.
   */
  const [floodControls, setFloodControls] = useState<FloodControls>({
    mode: "elevation",
    startElevation: null,
    maxElevation: null,
    interval: 5,
    speed: "normal",
  });
  const [floodResult, setFloodResult] = useState<FloodState>({ state: "idle" });
  const [floodSource, setFloodSource] = useState<
    { lon: number; lat: number; ground: number | null } | null
  >(null);
  /** True while the next map click will be taken as the water source. */
  const [floodPicking, setFloodPicking] = useState(false);
  const floodPickingRef = useRef(false);
  floodPickingRef.current = floodPicking;

  /**
   * The study area: which ground the simulation is about.
   *
   * Part of the same axis as the water-source pick rather than a fourth one,
   * because they are two steps of setting up one tool and are never wanted at
   * the same instant — arming either disarms the other, exactly as arming
   * either disarms the numbered tools. What it adds over the source pick is
   * that it accumulates geometry: a rectangle takes two clicks and a polygon
   * takes a double click to finish, so the vertices in progress live in a ref
   * for the same reason `shapefileDraw` does — the map's handlers are
   * registered once and would close over the first render's empty array.
   *
   * The finished ring is kept in the map's own lon/lat and projected only to
   * measure it, so nothing here can drift from what is drawn on screen.
   */
  const [floodAreaDrawing, setFloodAreaDrawing] = useState<FloodAreaKind | null>(null);
  const floodAreaDrawingRef = useRef<FloodAreaKind | null>(null);
  floodAreaDrawingRef.current = floodAreaDrawing;
  const [floodArea, setFloodArea] = useState<FloodArea | null>(null);
  const floodAreaRing = useRef<[number, number][] | null>(null);
  const floodAreaDraft = useRef<[number, number][]>([]);
  /** The corner the pointer is dragging a rectangle out to, while it has one. */
  const floodAreaHover = useRef<[number, number] | null>(null);
  const [floodStep, setFloodStep] = useState(0);
  const [floodPlaying, setFloodPlaying] = useState(false);
  const [floodOpacity, setFloodOpacity] = useState(0.55);
  const [floodExporting, setFloodExporting] = useState(false);

  /** Tool 2, and tools 5 and 13: all polygon tools, all explicit requests. */
  const [gridLevels, setGridLevels] = useState<GridLevelsState>({ state: "idle" });
  const [gridSpacing, setGridSpacing] = useState(1);
  const [compare, setCompare] = useState<SurfaceState>({ state: "idle" });
  /** Tool 5 asks for the deviation; tool 13 additionally classifies it. */
  const [compareOp, setCompareOp] = useState<"difference" | "tolerance">("difference");
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

  const shapefileClient = useRef<ShapefileClient>(null as unknown as ShapefileClient);
  if (!shapefileClient.current) shapefileClient.current = new ShapefileClient(siteSlug);

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
  const gridLane = useRef(
    latest((signal: AbortSignal, ring: Pair[], spacing: number, model: Surface) =>
      client.current.gridLevels(ring, spacing, { surface: model }, signal),
    ),
  );
  const compareLane = useRef(
    latest(
      (
        signal: AbortSignal,
        ring: Pair[],
        reference: VolumeReference,
        model: Surface,
        tolerance: number | null,
      ) =>
        client.current.compare(
          ring,
          reference,
          { surface: model, ...(tolerance === null ? {} : { tolerance }) },
          signal,
        ),
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
  const floodLane = useRef(
    latest(
      (
        signal: AbortSignal,
        levels: number[],
        source: { at?: Pair },
        interval: number,
        where: { area?: Pair[]; bounds?: [Pair, Pair] },
      ) => client.current.flood(levels, source, { interval, ...where }, signal),
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

  // ---- the flood simulation, end to end -----------------------------------

  /** Draw one level's flood polygon, or clear the layer when there is none. */
  const drawFlood = useCallback((level: FloodSimLevel | null) => {
    const source = map.current?.getSource("flood");
    if (!source || !("setData" in source)) return;
    (source as { setData: (d: unknown) => void }).setData(
      level?.geojson ?? { type: "FeatureCollection", features: [] },
    );
  }, []);

  /**
   * Draw the study area as it stands: the committed ring, and whatever is
   * being clicked out on top of it.
   *
   * One source for both, filtered by a property rather than split into two
   * sources, because they are never both interesting at once — a draft becomes
   * the ring the moment it is finished — and one source is one `setData` per
   * pointer move while a rectangle is being dragged out.
   */
  const redrawFloodArea = useCallback(() => {
    const source = map.current?.getSource("flood-area");
    if (!source || !("setData" in source)) return;
    const features: GeoJSON.Feature[] = [];

    const ring = floodAreaRing.current;
    if (ring) {
      features.push({
        type: "Feature",
        properties: { draft: false },
        geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
      });
    }

    const draft = floodAreaDraft.current;
    const hover = floodAreaHover.current;
    if (draft.length) {
      const preview =
        floodAreaDrawingRef.current === "rectangle" && draft.length === 1 && hover
          ? rectangleRing(draft[0], hover)
          : null;
      if (preview) {
        features.push({
          type: "Feature",
          properties: { draft: true },
          geometry: { type: "Polygon", coordinates: [[...preview, preview[0]]] },
        });
      } else if (draft.length >= 2) {
        features.push({
          type: "Feature",
          properties: { draft: true },
          geometry: { type: "LineString", coordinates: draft },
        });
      }
      for (const point of draft) {
        features.push({
          type: "Feature",
          properties: { draft: true },
          geometry: { type: "Point", coordinates: point },
        });
      }
    }

    (source as { setData: (d: unknown) => void }).setData({
      type: "FeatureCollection",
      features,
    });
  }, []);

  /**
   * Accept a finished ring, measured in the survey's own metres.
   *
   * Measured rather than reported in degrees because metres are what decides
   * whether the server can run it: the refusal is a cell count, a cell count is
   * metres over the cell size, and "0.005° across" tells a client nothing about
   * either. Projected through the same `geodesy.ts` the measure tools use, so
   * the size shown here and the size the server names in a refusal are the same
   * quantity computed two ways rather than two different quantities.
   */
  const commitFloodArea = useCallback(
    (kind: FloodAreaKind, ring: [number, number][]) => {
      const projected = ring.map(([lon, lat]) => lonLatToUtm(lon, lat, utmZone, utmNorthern));
      const xs = projected.map(([x]) => x);
      const ys = projected.map(([, y]) => y);
      floodAreaRing.current = ring;
      floodAreaDraft.current = [];
      floodAreaHover.current = null;
      setFloodAreaDrawing(null);
      setFloodArea({
        kind,
        width_m: Math.max(...xs) - Math.min(...xs),
        height_m: Math.max(...ys) - Math.min(...ys),
      });
      redrawFloodArea();
    },
    [redrawFloodArea, utmZone, utmNorthern],
  );

  /** Arm the map to draw a study area, replacing whatever was drawn before. */
  const startFloodAreaDraw = useCallback(
    (kind: FloodAreaKind) => {
      floodAreaDraft.current = [];
      floodAreaHover.current = null;
      floodAreaRing.current = null;
      setFloodArea(null);
      setFloodAreaDrawing(kind);
      // The same exclusivity every other axis enforces, including against the
      // water-source pick: two armed tools would both read the next click, and
      // one click would place a source *and* a corner.
      setFloodPicking(false);
      setMode("off");
      setHydroMode("off");
      setShapefileActive(null);
      redrawFloodArea();
    },
    [redrawFloodArea],
  );

  const clearFloodArea = useCallback(() => {
    floodAreaRing.current = null;
    floodAreaDraft.current = [];
    floodAreaHover.current = null;
    setFloodArea(null);
    setFloodAreaDrawing(null);
    redrawFloodArea();
  }, [redrawFloodArea]);

  /** One click while a study area is being drawn. */
  const handleFloodAreaClick = useCallback(
    (lon: number, lat: number) => {
      const kind = floodAreaDrawingRef.current;
      if (!kind) return;
      const draft = floodAreaDraft.current;
      if (kind === "rectangle") {
        // Two clicks, not a drag: the map's own drag is pan, and stealing it
        // for one tool would mean a client who mis-clicks cannot move the map
        // without first turning the tool off.
        if (draft.length === 0) {
          floodAreaDraft.current = [[lon, lat]];
          redrawFloodArea();
          return;
        }
        commitFloodArea("rectangle", rectangleRing(draft[0], [lon, lat]));
        return;
      }
      floodAreaDraft.current = [...draft, [lon, lat]];
      redrawFloodArea();
    },
    [commitFloodArea, redrawFloodArea],
  );
  const floodAreaClickRef = useRef<(lon: number, lat: number) => void>(() => {});
  floodAreaClickRef.current = handleFloodAreaClick;
  const redrawFloodAreaRef = useRef<() => void>(() => {});
  redrawFloodAreaRef.current = redrawFloodArea;

  /** A double click finishes a study-area polygon. */
  const finishFloodAreaDraw = useCallback(() => {
    if (floodAreaDrawingRef.current !== "polygon") return;
    let points = floodAreaDraft.current;
    // A double click is two clicks first, so the click handler has already
    // added the same vertex twice — dropped here exactly as the measure and
    // shapefile tools drop it, so the ring never carries a zero-length side.
    if (points.length >= 2) {
      const [ax, ay] = points[points.length - 1];
      const [bx, by] = points[points.length - 2];
      if (Math.abs(ax - bx) < 1e-9 && Math.abs(ay - by) < 1e-9) points = points.slice(0, -1);
    }
    if (points.length < 3) {
      // Not enough for an area. Left armed rather than cancelled, because a
      // stray double click while placing the second corner should not throw
      // away the work or silently stop listening.
      floodAreaDraft.current = points;
      redrawFloodArea();
      return;
    }
    commitFloodArea("polygon", points);
  }, [commitFloodArea, redrawFloodArea]);
  const floodAreaDblClickRef = useRef(() => {});
  floodAreaDblClickRef.current = finishFloodAreaDraw;

  /** Arm the map to take the next click as the water source. */
  const pickFloodSource = useCallback(() => {
    setFloodPicking(true);
    // The same exclusivity every other axis enforces: while this is armed for
    // its one click, no numbered tool, no shapefile draw and no study-area
    // draw owns the map.
    setFloodAreaDrawing(null);
    floodAreaDraft.current = [];
    floodAreaHover.current = null;
    redrawFloodArea();
    setMode("off");
    setHydroMode("off");
    setShapefileActive(null);
  }, [redrawFloodArea]);

  /**
   * The water source, from a click.
   *
   * The ground elevation is read by the ordinary spot-level path rather than
   * assumed, because the starting elevation the simulation ladder is built
   * from *is* that number — Malhar's §2 example is "user clicks a point at
   * elevation 100 m → simulation starts at approximately 100 m" — and guessing
   * it from a tile would reintroduce the whole Terrain-RGB problem
   * `analysis-client.ts` exists to have solved.
   */
  const handleFloodClick = useCallback(async (lon: number, lat: number) => {
    setFloodPicking(false);
    setFloodSource({ lon, lat, ground: null });
    try {
      const response = await client.current.spot([lon, lat], { surface: "dtm" });
      noteEnvelope(response);
      const ground = response.result.elevation;
      setFloodSource({ lon, lat, ground });
      // Prefill the ladder's start from the ground the client actually
      // pointed at, which is the number his worked example starts from.
      if (ground !== null) {
        setFloodControls((c) => ({ ...c, mode: "source", startElevation: Number(ground.toFixed(2)) }));
      }
    } catch {
      // The point stands even if the level did not arrive: the simulation can
      // still run from a typed elevation, and blanking the source the client
      // just placed would be the more confusing failure.
      setFloodControls((c) => ({ ...c, mode: "source" }));
    }
  }, [noteEnvelope]);
  const floodClickRef = useRef<(lon: number, lat: number) => void>(() => {});
  floodClickRef.current = (lon, lat) => void handleFloodClick(lon, lat);

  const clearFlood = useCallback(() => {
    floodLane.current.cancel();
    setFloodResult({ state: "idle" });
    setFloodSource(null);
    setFloodPicking(false);
    setFloodPlaying(false);
    setFloodStep(0);
    drawFlood(null);
    // The study area goes with it. One "Clear" that left a rectangle drawn on
    // the map would leave the next run silently bounded by ground the client
    // believes they have cleared.
    clearFloodArea();
  }, [drawFlood, clearFloodArea]);

  /**
   * Build the ladder and run the whole thing in one request.
   *
   * The ladder is built here rather than on the server because it is entirely
   * a question of what the client asked for — a start, an interval, a maximum —
   * and sending the explicit list means the response can never be a different
   * set of levels from the one the panel is about to animate.
   */
  const runFlood = useCallback(async () => {
    const start = floodControls.startElevation ?? floodSource?.ground ?? null;
    if (start === null) {
      setFloodResult({
        state: "error",
        message:
          "Choose a water source on the map, or type a starting elevation, before simulating.",
      });
      return;
    }
    const interval = floodControls.interval;
    /*
     * Without a maximum this runs ten steps, not forever and not one. Malhar's
     * spec makes the maximum optional ("if entered, the simulation should
     * stop"), which leaves the unstated case to us: a single level is not a
     * simulation, and an unbounded one is a request nobody can serve. Ten
     * steps at his own intervals is 20, 50 or 100 m of rise, which covers any
     * flood these surveys can show.
     */
    const top = floodControls.maxElevation ?? start + interval * 10;
    if (top < start) {
      setFloodResult({
        state: "error",
        message: `The maximum (${top} m) is below the starting level (${start} m), so the water would never rise.`,
      });
      return;
    }

    const levels: number[] = [];
    for (let level = start; level <= top + 1e-9 && levels.length < 200; level += interval) {
      // Rounded because repeatedly adding 0.1-style intervals accumulates
      // float error, and a level printed as "104.99999999999999 m" beside a
      // table of clean numbers reads as a bug in the survey.
      levels.push(Number(level.toFixed(4)));
    }

    setFloodPlaying(false);
    setFloodStep(0);
    setFloodResult({ state: "loading" });
    try {
      const source =
        floodControls.mode === "source" && floodSource
          ? { at: [floodSource.lon, floodSource.lat] as Pair }
          : {};
      /*
       * The drawn study area if there is one, and the view if there is not.
       *
       * Something has to bound this: Kiru's DTM is 2.5 billion cells and no
       * request reads that whole — before it was bounded at all the tool
       * answered "measurements are not available for this survey", which was
       * both wrong and unactionable. But the view is a guess at what the client
       * meant, and it changes under them every time they pan, so a drawn area
       * takes precedence and the panel says which one it used. Either way the
       * server refuses more ground than it can simulate at full resolution
       * rather than coarsening the DTM, and that refusal arrives here as an
       * ordinary error with the size that would fit in it.
       */
      const ring = floodAreaRing.current;
      const view = map.current?.getBounds();
      const where: { area?: Pair[]; bounds?: [Pair, Pair] } = ring
        ? { area: ring as Pair[] }
        : view
          ? {
              bounds: [
                [view.getWest(), view.getSouth()],
                [view.getEast(), view.getNorth()],
              ],
            }
          : {};
      const response = await floodLane.current.call(levels, source, interval, where);
      if (response === null) return; // superseded by a newer run
      noteEnvelope(response);
      setFloodResult({ state: "done", data: response.result });
      drawFlood(response.result.levels[0] ?? null);
    } catch (error) {
      setFloodResult({ state: "error", message: messageFor(error) });
    }
  }, [floodControls, floodSource, noteEnvelope, drawFlood]);

  /** Move to one step of the simulation, drawing it. */
  const showFloodStep = useCallback(
    (n: number) => {
      setFloodStep(n);
      if (floodResult.state === "done") drawFlood(floodResult.data.levels[n] ?? null);
    },
    [floodResult, drawFlood],
  );

  /**
   * The animation clock.
   *
   * A timer rather than `requestAnimationFrame`: the steps are a second or so
   * apart, not a frame apart, and rAF would burn sixty wakeups to do nothing
   * fifty-nine of them. It stops itself at the last level, which is what
   * "continues until the maximum water level is reached" asks for — the
   * simulation ends rather than looping back to the start, because a flood
   * that silently restarts reads as one that is still rising.
   */
  useEffect(() => {
    if (!floodPlaying || floodResult.state !== "done") return;
    const total = floodResult.data.levels.length;
    if (floodStep >= total - 1) {
      setFloodPlaying(false);
      return;
    }
    const delay = { slow: 1600, normal: 800, fast: 350 }[floodControls.speed];
    const timer = setTimeout(() => {
      const next = floodStep + 1;
      setFloodStep(next);
      drawFlood(floodResult.data.levels[next] ?? null);
    }, delay);
    return () => clearTimeout(timer);
  }, [floodPlaying, floodStep, floodResult, floodControls.speed, drawFlood]);

  /** Keep the drawn water at whatever opacity the panel's slider says. */
  useEffect(() => {
    const instance = map.current;
    if (!instance?.getLayer("flood-fill")) return;
    instance.setPaintProperty("flood-fill", "fill-opacity", floodOpacity);
  }, [floodOpacity]);

  /**
   * Export one level, or every level, as GeoJSON or as a real shapefile.
   *
   * The shapefile path goes through the same route Malhar's shapefile tool
   * already uses, so a flood polygon and a hand-drawn polygon come out of the
   * identical writer in the identical projection. Exporting "all levels" sends
   * them as one multi-feature layer rather than one file per level: a client
   * comparing 100 m against 120 m wants both in one table, and the water level
   * is an attribute on every polygon precisely so that works.
   */
  const exportFlood = useCallback(
    async (what: "current" | "all", format: "geojson" | "shapefile") => {
      if (floodResult.state !== "done") return;
      const chosen =
        what === "current"
          ? [floodResult.data.levels[floodStep]].filter(Boolean)
          : floodResult.data.levels;
      const features = chosen.flatMap((l) => l.geojson.features);
      if (features.length === 0) {
        setFloodResult({
          state: "error",
          message: "There is no flooded ground at this level, so there is nothing to export.",
        });
        return;
      }

      const stem =
        what === "current"
          ? `Flood_${Math.round(floodResult.data.levels[floodStep].level_m)}m`
          : "Flood_all_levels";

      if (format === "geojson") {
        const blob = new Blob(
          [JSON.stringify({ type: "FeatureCollection", features }, null, 2)],
          { type: "application/geo+json;charset=utf-8" },
        );
        saveShapefileZip(blob, `${stem}.geojson`);
        return;
      }

      setFloodExporting(true);
      try {
        const { blob, filename } = await shapefileClient.current.download(
          "polygon",
          features.map((f) => ({
            geometry: f.geometry,
            properties: f.properties as Record<string, unknown>,
          })),
          stem,
        );
        saveShapefileZip(blob, filename);
      } catch (error) {
        setFloodResult({
          state: "error",
          message:
            error instanceof ShapefileError
              ? error.message
              : "The flood shapefile could not be written.",
        });
      } finally {
        setFloodExporting(false);
      }
    },
    [floodResult, floodStep],
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
      if (
        active === "volume" ||
        active === "alignment" ||
        active === "grid" ||
        active === "compare"
      ) {
        return;
      }

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
    gridLane.current.cancel();
    compareLane.current.cancel();
    setElevation({ state: "idle" });
    setVolume({ state: "idle" });
    setAlignment({ state: "idle" });
    setGridLevels({ state: "idle" });
    setCompare({ state: "idle" });
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

  const gridSpacingRef = useRef(gridSpacing);
  gridSpacingRef.current = gridSpacing;
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

  /** Tool 2. A grid of levels over the drawn polygon, then a file. */
  const computeGridLevels = useCallback(async () => {
    const points = drawn.current;
    if (points.length < 3) return;
    const ring = [...points, points[0]] as Pair[];
    setGridLevels({ state: "loading" });
    try {
      const response = await gridLane.current.call(ring, gridSpacingRef.current, surfaceRef.current);
      if (response === null) return;
      noteEnvelope(response);
      setGridLevels({ state: "done", data: response.result, epsg: response.computedIn });
    } catch (error) {
      setGridLevels({ state: "error", message: messageFor(error) });
    }
  }, [noteEnvelope]);

  /** Tools 5 and 13. One request; the tolerance decides which question it is. */
  const computeCompare = useCallback(
    async (reference: VolumeReference, tolerance: number | null) => {
      const points = drawn.current;
      if (points.length < 3) return;
      const ring = [...points, points[0]] as Pair[];
      setCompare({ state: "loading" });
      try {
        const response = await compareLane.current.call(
          ring,
          reference,
          surfaceRef.current,
          tolerance,
        );
        if (response === null) return;
        noteEnvelope(response);
        setCompare({
          state: "done",
          data: response.result,
          reference,
          surface: response.surface,
        });
      } catch (error) {
        setCompare({ state: "error", message: messageFor(error) });
      }
    },
    [noteEnvelope],
  );

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
        /*
         * Padded for the inspector, which floats over the right of the map.
         *
         * With even padding the survey was fitted to the full canvas and then
         * had a 19rem panel laid over its right-hand third, so it sat visibly
         * off-centre with dead grey to its left. Fitting to the space actually
         * visible is the difference between a map that looks placed and one that
         * looks like it missed.
         *
         * Only on wide viewports, because the panel drops below the map under
         * the `lg` breakpoint and the space is the client's again.
         */
        fitBoundsOptions: {
          padding:
            window.innerWidth >= 1024
              ? { top: 28, bottom: 28, left: 28, right: 328 }
              : 24,
        },
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

      // A rectangle in progress follows the pointer. Without the rubber band a
      // client places two corners blind and only learns how big the study area
      // is after the second click, which on a survey this size is the
      // difference between a two-second answer and a refusal.
      if (floodAreaDrawingRef.current === "rectangle" && floodAreaDraft.current.length === 1) {
        floodAreaHover.current = [event.lngLat.lng, event.lngLat.lat];
        redrawFloodAreaRef.current();
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
        modeRef.current !== "off" || floodAreaDrawingRef.current
          ? "crosshair"
          : hit
            ? "help"
            : "";
    });
    instance.on("mouseout", () => {
      lastLngLat = null;
      clearTimeout(settleTimer);
      setReadout("");
    });

    // ---- measure: click to add a vertex, double click to finish ------------
    instance.on("click", (event) => {
      // The flood tool's study area, while it is being drawn, owns the click
      // before anything else does — including the flood tool's own water-source
      // pick, which cannot be armed at the same time but is checked after it
      // anyway so the order of these two is never load bearing.
      if (floodAreaDrawingRef.current) {
        floodAreaClickRef.current(event.lngLat.lng, event.lngLat.lat);
        return;
      }
      // The flood tool, while it is armed for its one water-source click, takes
      // precedence over everything else: it is a third independent mode axis
      // (see the comment where its state is declared) and it disarms itself the
      // moment it has what it asked for.
      if (floodPickingRef.current) {
        floodClickRef.current(event.lngLat.lng, event.lngLat.lat);
        return;
      }
      // The shapefile tool takes precedence over everything: it is a wholly
      // separate mode axis (see the comment where its state is declared), and
      // nothing else should read this click while it owns one.
      if (shapefileActiveRef.current) {
        shapefileClickRef.current(event.lngLat.lng, event.lngLat.lat);
        return;
      }
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
      // Finishing a study-area polygon, and never zooming instead: the gesture
      // that closes the ring is the same gesture MapLibre zooms on.
      if (floodAreaDrawingRef.current) {
        event.preventDefault();
        floodAreaDblClickRef.current();
        return;
      }
      if (shapefileActiveRef.current) {
        event.preventDefault();
        shapefileDblClickRef.current();
        return;
      }
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

      /*
       * The flood simulation's water, in a blue nothing else on this map uses.
       *
       * Added before the shapefile and measure layers so those draw *over* the
       * water rather than under it: a measurement or a drawn feature is the
       * thing a client is working on, and water is the ground condition they
       * are working against. It sits above every raster for the same reason —
       * §11 asks for the inundation layer above the DTM.
       *
       * Fill opacity is a paint property rather than baked into the colour so
       * the panel's transparency slider can change it without rebuilding the
       * layer, and the outline stays fully opaque at every opacity: the edge of
       * a flood is the part a client traces against a contour, and fading it
       * with the fill makes the extent unreadable exactly when it matters.
       */
      instance.addSource("flood", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "flood-fill",
        type: "fill",
        source: "flood",
        paint: { "fill-color": "#0ea5e9", "fill-opacity": 0.55 },
      });
      instance.addLayer({
        id: "flood-outline",
        type: "line",
        source: "flood",
        paint: { "line-color": "#0369a1", "line-width": 1.4 },
      });

      /*
       * The flood study area: the boundary of the simulation, drawn above the
       * water it bounds.
       *
       * Indigo, which nothing else on this map uses — the measure tools are
       * accent orange, the shapefile tool teal, an imported shapefile violet,
       * the alignment tools slate, hydrology and the flood itself blue. A study
       * area that could be mistaken for a drawn polygon would be worse than no
       * outline at all, because the one thing it has to communicate is that
       * everything outside it was not simulated.
       *
       * No fill: it is a boundary, not a feature, and a tint over the water
       * inside it would change the colour of the answer. Dashed while it is
       * being clicked out, solid once it is committed, so the two states are
       * distinguishable at a glance rather than by counting clicks — as two
       * layers rather than one expression, because `line-dasharray` is a paint
       * property MapLibre does not evaluate per feature and a `["case", …]` in
       * it fails the whole style rather than that one line.
       */
      instance.addSource("flood-area", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "flood-area-draft",
        type: "line",
        source: "flood-area",
        filter: ["all", ["!=", ["geometry-type"], "Point"], ["get", "draft"]],
        paint: { "line-color": "#4338ca", "line-width": 2, "line-dasharray": [2, 1.5] },
      });
      instance.addLayer({
        id: "flood-area-outline",
        type: "line",
        source: "flood-area",
        filter: ["all", ["!=", ["geometry-type"], "Point"], ["!", ["get", "draft"]]],
        paint: { "line-color": "#4338ca", "line-width": 2 },
      });
      instance.addLayer({
        id: "flood-area-points",
        type: "circle",
        source: "flood-area",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 3.5,
          "circle-color": "#4338ca",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });

      /*
       * Malhar's shapefile tool: three sources, because a real shapefile is
       * three sources too — one geometry type per file — and this mirrors that
       * rather than hiding it. `shapefile-draw` is the in-progress line or
       * polygon while it is being clicked out; `shapefile-features` is every
       * completed Point/Line/Polygon feature drawn so far, ready to download;
       * `shapefile-uploaded` is a file brought in to compare against, kept
       * entirely separate so nothing drawn here can be mistaken for it. Teal
       * for ours, violet for an import — both well clear of the accent orange
       * the measure tools use, the slate the alignment tools use, and the blue
       * hydrology uses.
       */
      instance.addSource("shapefile-draw", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "shapefile-draw-line",
        type: "line",
        source: "shapefile-draw",
        paint: { "line-color": "#0d9488", "line-width": 2, "line-dasharray": [1.5, 1.5] },
      });
      instance.addLayer({
        id: "shapefile-draw-points",
        type: "circle",
        source: "shapefile-draw",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 3.5,
          "circle-color": "#0d9488",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });

      instance.addSource("shapefile-features", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "shapefile-features-fill",
        type: "fill",
        source: "shapefile-features",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#0d9488", "fill-opacity": 0.16 },
      });
      instance.addLayer({
        id: "shapefile-features-line",
        type: "line",
        source: "shapefile-features",
        paint: { "line-color": "#0f766e", "line-width": 2 },
      });
      instance.addLayer({
        id: "shapefile-features-points",
        type: "circle",
        source: "shapefile-features",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4.5,
          "circle-color": "#0f766e",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

      instance.addSource("shapefile-uploaded", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "shapefile-uploaded-fill",
        type: "fill",
        source: "shapefile-uploaded",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#7c3aed", "fill-opacity": 0.12 },
      });
      instance.addLayer({
        id: "shapefile-uploaded-line",
        type: "line",
        source: "shapefile-uploaded",
        paint: { "line-color": "#6d28d9", "line-width": 1.8, "line-dasharray": [3, 1.5] },
      });
      instance.addLayer({
        id: "shapefile-uploaded-points",
        type: "circle",
        source: "shapefile-uploaded",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4.5,
          "circle-color": "#7c3aed",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
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

      /*
       * Tool 5's colour-coded deviation map, offered only when both models
       * exist, because a difference needs two surfaces.
       *
       * The range is not the survey's elevation range: it is how far apart the
       * two surfaces get, which is canopy height here. Asked for symmetrically
       * about zero and the tiler enforces that anyway, because a diverging ramp
       * whose midpoint is not zero paints "no change" somewhere there is change.
       */
      if (probe.dtm && probe.dsm) {
        const reach = Math.max(4, Math.round(((range?.max ?? 40) - (range?.min ?? 0)) / 4));
        out.push({
          key: "difference",
          title: "Surface minus terrain",
          unit: "m",
          description:
            "How far the surface model stands above bare earth: canopy, stockpiles and structures.",
          min: -reach, max: reach, ramp: "difference", relief: false, logarithmic: false,
          signed: true,
        });
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
    /*
     * Off by default, now that the terrain underneath carries the colour.
     *
     * Colouring contours by height was right when the elevation tiles were a
     * flat brand wash: the lines were the only thing saying which way was up.
     * With the models properly graded, a rainbow line over a rainbow surface is
     * the same information twice and the contours disappear into the ground they
     * are drawn on. One dark line reads over any of it. Still one click away for
     * anyone who wants it.
     */
    colour: false,
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

    /*
     * Labels are also spaced apart on screen, not only one per level.
     *
     * One per level already stops the same number appearing forty times, but on
     * steep ground forty *different* levels crowd into a hand's width and the
     * map reads as a pile of numbers. Rejecting any label within 44 screen
     * pixels of one already placed thins the dense side without touching the
     * open ground, which is where a reader actually wants them.
     */
    const taken: { x: number; y: number }[] = [];
    const CLEARANCE = 44;

    for (const candidate of candidates) {
      if (placed >= MAX) break;
      if (seen.has(candidate.level)) continue;

      const at = instance.project(candidate.at);
      if (taken.some((p) => Math.abs(p.x - at.x) < CLEARANCE && Math.abs(p.y - at.y) < CLEARANCE)) {
        continue;
      }
      taken.push({ x: at.x, y: at.y });
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

  /**
   * Which of the three inspector segments is showing.
   *
   * It follows the tool you pressed rather than waiting to be told: pressing a
   * measure tool and then hunting for the panel that reports its answer is a
   * click nobody should have to make, and the panel appearing where you are
   * already looking is most of what makes an interface feel like it is paying
   * attention.
   */
  const [inspector, setInspector] = useState<
    "tool" | "layers" | "water" | "shapefile" | "flood"
  >("layers");

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
            : mode === "compare"
              ? { kind: "measure", mode: "compare", op: compareOp }
              : { kind: "measure", mode }
        : hydroMode !== "off"
          ? { kind: "hydrology", mode: hydroMode }
          : sinks
            ? { kind: "sinks" }
            : activeRender
              ? { kind: "layer", layer: activeRender }
              : null,
    [mode, volumeOp, alignmentControls.op, compareOp, hydroMode, sinks, activeRender],
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
      // A numbered tool, the shapefile tool and the flood tool's water-source
      // pick are mutually exclusive, same as every pair of numbered tools
      // already are: pressing one clears the others, so a click is never
      // ambiguous about which is answering it. Any in-progress line or polygon
      // is dropped too, rather than left drawn on the map with nothing able to
      // finish or clear it.
      setShapefileActive(null);
      shapefileDraw.current = [];
      redrawShapefileDraw();
      // Only the *arming* is cleared, not the simulation and not a finished
      // study area. A finished flood is a result the client can still read and
      // export while they measure something else on top of it, exactly as a
      // finished measurement stays in its own panel, and the area it was
      // computed over is part of reading it. A half-drawn one goes, because
      // nothing is left able to finish it.
      setFloodPicking(false);
      setFloodAreaDrawing(null);
      floodAreaDraft.current = [];
      floodAreaHover.current = null;
      redrawFloodArea();

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
          setInspector("tool");
          setHydroMode("off");
          /*
           * The op belongs to whichever mode it names. Volume's two tools and
           * the alignment's four share one field on the action because the rail
           * asks one question — "which tool did they press" — and the answer is
           * routed to the panel that owns it.
           */
          if (action.mode === "compare") {
            setCompareOp(action.op === "tolerance" ? "tolerance" : "difference");
          } else if (action.mode === "alignment") {
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
          setInspector("water");
          setMode("off");
          setHydroMode(action.mode);
          break;
        case "sinks":
          setInspector("water");
          setMode("off");
          setHydroMode("off");
          void findSinks();
          break;
        case "layer":
          setInspector("layers");
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

  /**
   * Both basemaps are added once, lazily, and left in the style thereafter -
   * only their visibility toggles. MapLibre raster sources can't have their
   * tile URL swapped in place, so switching mode by mutating one shared
   * source would mean tearing it down and rebuilding it every click; two
   * sources that just show/hide is simpler and doesn't re-fetch tiles
   * already in the browser's cache when a client flips back and forth.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const first = instance.getStyle().layers?.[0]?.id;

    if (basemap === "streets" && !instance.getSource("basemap-streets")) {
      instance.addSource("basemap-streets", {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      });
      instance.addLayer(
        { id: "basemap-streets", type: "raster", source: "basemap-streets", paint: { "raster-opacity": 0.9 } },
        first,
      );
    } else if (instance.getLayer("basemap-streets")) {
      instance.setLayoutProperty("basemap-streets", "visibility", basemap === "streets" ? "visible" : "none");
    }

    if (basemap === "satellite" && !instance.getSource("basemap-satellite")) {
      instance.addSource("basemap-satellite", {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Esri, Maxar, Earthstar Geographics",
      });
      instance.addLayer({ id: "basemap-satellite", type: "raster", source: "basemap-satellite" }, first);
      // Boundaries, roads and place names over the imagery - what makes it
      // "hybrid" rather than a plain satellite photo. A separate source
      // because it is semi-transparent by design, drawn straight on top.
      instance.addSource("basemap-satellite-labels", {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Esri",
      });
      instance.addLayer(
        { id: "basemap-satellite-labels", type: "raster", source: "basemap-satellite-labels" },
        first,
      );
    } else if (instance.getLayer("basemap-satellite")) {
      const visibility = basemap === "satellite" ? "visible" : "none";
      instance.setLayoutProperty("basemap-satellite", "visibility", visibility);
      instance.setLayoutProperty("basemap-satellite-labels", "visibility", visibility);
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
      {/*
        The tool rail: Malhar's five documents as five groups, one visible at a
        time, with the surface switch and relief toggle folded into the same band
        rather than given a row of their own.
      */}
      <ToolRail
        group={group}
        setGroup={setGroup}
        active={railAction}
        onAction={runAction}
        measurable={measurable}
        probing={probe.state === "checking"}
        unavailable={probe.state === "unavailable" ? probe.message : undefined}
        hasHydrology={Boolean(hydro)}
        renderable={renderableKeys}
        hint={
          floodPicking ? (
            "Click where the water starts. The simulation will rise from the ground there."
          ) : shapefileActive ? (
            shapefileActive === "point"
              ? "Click anywhere to place a point."
              : `Click each ${shapefileActive === "line" ? "vertex" : "corner"}, double click to finish.`
          ) : probe.state === "unavailable" ? (
            <span className="text-signal-600">{probe.message}</span>
          ) : probe.state === "checking" ? (
            "Checking the elevation model…"
          ) : mode === "spot" ? (
            "Click anywhere to take a level."
          ) : mode !== "off" ? (
            "Click to add points, double click to finish."
          ) : hydroMode !== "off" ? (
            hydroMode === "flood"
              ? "Set a water level, then click where the water would stand."
              : hydroMode === "watershed"
                ? "Click a channel to trace everything draining through it."
                : "Click anywhere to read the hydrology under that point."
          ) : null
        }
      >
        {hasTerrain ? (
          <>
            {/*
              Which model the numbers come from. Not in the layer tree: that
              controls what is *drawn*, and this controls what is *measured*,
              which are different questions that happen to name the same two
              files.
            */}
            {hasBothSurfaces ? (
              <div
                className="flex items-center gap-0.5 rounded-full bg-ink/[0.045] p-0.5"
                role="group"
                aria-label="Surface the tools measure"
              >
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
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-200 ${
                      surface === value
                        ? "bg-panel text-ink-900 shadow-sm"
                        : "text-ink/55 hover:text-ink-900"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink/60">
              <input
                type="checkbox"
                checked={hillshade}
                onChange={(e) => setHillshade(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
              />
              Relief
            </label>
          </>
        ) : null}
      </ToolRail>

      <div className="relative">
        <div
          ref={container}
          role="application"
          aria-label={`Survey map of ${siteName}`}
          /**
           * Sized to what is left of the viewport rather than to a fixed height.
           *
           * The chrome above it is now a single band — back link, site name and
           * the section nav on one line — instead of the three stacked blocks
           * that used to push the canvas 590px down a 1000px screen. 15rem is
           * measured against that band plus the tool rail and the view-only note
           * below; the clamp keeps it usable on a short window and stops it
           * becoming absurd on a tall one.
           */
          className="h-[clamp(420px,calc(100vh-15rem),1100px)] w-full bg-mist"
        />

        {!ready ? (
          <div className="absolute inset-0 flex items-center justify-center bg-mist">
            <p className="text-sm text-ink/60">Loading the survey map…</p>
          </div>
        ) : null}

        {/*
          The inspector: one panel, segmented, instead of six stacked.
          
          It used to render the tool panel, the point cloud, the contours, the
          rendered layers, the hydrology and the layer tree one under another in
          a 288px column, which overflowed the map on every survey that had all
          of them and put the layer tree — the thing a client reaches for first —
          below three screens of scrolling.
          
          Three segments, because there are three kinds of question: what is this
          tool telling me, what is drawn, and what is the water doing. Each fits
          without scrolling on a normal screen, and the segment follows the tool
          you pressed so it is almost never a click you have to make.
        */}
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[19rem] p-3 lg:block">
          <div className="pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-2xl border border-ink/[0.08] bg-panel/92 shadow-card backdrop-blur-md">
            <div className="flex shrink-0 items-center gap-0.5 border-b border-ink/[0.07] p-1.5">
              {(
                [
                  ["tool", "Tool"],
                  ["layers", "Layers"],
                  ...(hydro ? ([["water", "Water"]] as const) : []),
                  ["shapefile", "Shapefile"],
                  ["flood", "Flood"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={inspector === key}
                  onClick={() => setInspector(key)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-all duration-200 ${
                    inspector === key
                      ? "bg-ink/[0.06] text-ink-900"
                      : "text-ink/50 hover:text-ink-900"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {inspector === "tool" ? (
                <>
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
                    gridLevels={gridLevels}
                    gridSpacing={gridSpacing}
                    setGridSpacing={setGridSpacing}
                    onComputeGridLevels={() => void computeGridLevels()}
                    compare={compare}
                    compareOp={compareOp}
                    onComputeCompare={(r, t) => void computeCompare(r, t)}
                    tolerance={tolerance}
                    onClear={clearMeasurement}
                    onComputeVolume={computeVolume}
                    onRemoveSpot={(id) => setSpots((s) => s.filter((r) => r.id !== id))}
                    onClearSpots={() => {
                      setSpots([]);
                      setSpotError(null);
                    }}
                  />
                  {mode === "off" ? (
                    <p className="text-[12px] leading-relaxed text-ink/50">
                      Pick a tool above and the map will tell you what it
                      measures. Every number comes from the survey&apos;s own
                      raster, in its own projection — never from the picture on
                      screen.
                    </p>
                  ) : null}
                </>
              ) : null}

              {inspector === "layers" ? (
                <>
                  {renderable.length > 0 ? (
                    <div className="mb-4 border-b border-ink/[0.07] pb-4">
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
                  {cloud ? (
                    <div className="mb-4 border-b border-ink/[0.07] pb-4">
                      <PointCloudPanel
                        manifest={cloud}
                        controls={cloudControls}
                        setControls={setCloudControls}
                        stats={cloudStats}
                      />
                    </div>
                  ) : null}
                  {contours ? (
                    <div className="mb-4 border-b border-ink/[0.07] pb-4">
                      <ContourPanel
                        contours={contours}
                        controls={contourControls}
                        setControls={setContourControls}
                        visible={visible[contours.key] ?? false}
                        setVisible={(on) => setVisible((v) => ({ ...v, [contours.key]: on }))}
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
                </>
              ) : null}

              {inspector === "water" && hydro ? (
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
              ) : null}

              {inspector === "shapefile" ? (
                <ShapefilePanel
                  active={shapefileActive}
                  setActive={setShapefileActiveTool}
                  counts={shapefileCounts}
                  download={shapefileDownload}
                  onDownload={() => void downloadShapefile()}
                  onClearDrawn={clearShapefileDrawn}
                  upload={shapefileUpload}
                  onUpload={(file) => void uploadShapefile(file)}
                  onClearUpload={clearShapefileUpload}
                />
              ) : null}

              {inspector === "flood" ? (
                <FloodPanel
                  controls={floodControls}
                  setControls={setFloodControls}
                  source={floodSource}
                  onPickSource={pickFloodSource}
                  onClearSource={pickFloodSource}
                  result={floodResult}
                  onRun={() => void runFlood()}
                  onClear={clearFlood}
                  step={floodStep}
                  setStep={showFloodStep}
                  playing={floodPlaying}
                  onPlay={() => setFloodPlaying(true)}
                  onPause={() => setFloodPlaying(false)}
                  onReset={() => {
                    setFloodPlaying(false);
                    showFloodStep(0);
                  }}
                  opacity={floodOpacity}
                  setOpacity={setFloodOpacity}
                  onExport={(what, format) => void exportFlood(what, format)}
                  exporting={floodExporting}
                />
              ) : null}
            </div>
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
          gridLevels={gridLevels}
          gridSpacing={gridSpacing}
          setGridSpacing={setGridSpacing}
          onComputeGridLevels={() => void computeGridLevels()}
          compare={compare}
          compareOp={compareOp}
          onComputeCompare={(r, t) => void computeCompare(r, t)}
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
  gridLevels,
  gridSpacing,
  setGridSpacing,
  onComputeGridLevels,
  compare,
  compareOp,
  onComputeCompare,
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
  gridLevels: GridLevelsState;
  gridSpacing: number;
  setGridSpacing: (v: number) => void;
  onComputeGridLevels: () => void;
  compare: SurfaceState;
  compareOp: "difference" | "tolerance";
  onComputeCompare: (reference: VolumeReference, tolerance: number | null) => void;
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
    ) : mode === "grid" ? (
      <GridLevelsPanel
        ready={Boolean(measurement?.closed) && (measurement?.points.length ?? 0) > 2}
        polygonArea={measurement?.area ?? 0}
        spacing={gridSpacing}
        setSpacing={setGridSpacing}
        result={gridLevels}
        onCompute={onComputeGridLevels}
        onClear={onClear}
      />
    ) : mode === "compare" ? (
      <SurfacePanel
        ready={Boolean(measurement?.closed) && (measurement?.points.length ?? 0) > 2}
        polygonArea={measurement?.area ?? 0}
        surface={surface}
        result={compare}
        tolerance={compareOp === "tolerance"}
        onCompute={onComputeCompare}
        onClear={onClear}
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
  basemap: BasemapMode;
  setBasemap: (v: BasemapMode) => void;
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
          The explanation is a description, not part of any one button's name.
          Read once via aria-describedby on the group rather than repeated on
          each option, for the same reason the old checkbox used it: a screen
          reader reading a privacy justification on every button in the row
          would be worse than reading it once.
        */}
        <div
          className="flex items-center gap-0.5 rounded-full bg-ink/[0.045] p-0.5"
          role="group"
          aria-label="Base map"
          aria-describedby="basemap-privacy"
        >
          {(
            [
              ["off", "Off"],
              ["streets", "Streets"],
              ["satellite", "Satellite"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={basemap === value}
              onClick={() => setBasemap(value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-200 ${
                basemap === value
                  ? "bg-panel text-ink-900 shadow-sm"
                  : "text-ink/55 hover:text-ink-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p id="basemap-privacy" className="ml-1 mt-1 text-[11px] leading-snug text-ink/55">
          Off by default. Streets requests tiles from OpenStreetMap; Satellite
          from Esri. Either reveals roughly where this site is to that
          provider.
        </p>
      </fieldset>
    </div>
  );
}
