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
import { DemSampler } from "@/lib/portal/dem-sampler";
import {
  densifyPath,
  formatElevation,
  lonLatToUtm,
  metresPerPixel,
  pathLength,
  ringArea,
} from "@/lib/portal/geodesy";
import { MeasurePanel, type Measurement } from "./MeasurePanel";

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

/** The survey's own stated accuracy, used to qualify every elevation shown. */
const TOLERANCE_M = 0.04;

type Group = "Imagery and models" | "Terrain" | "Vectors";
const GROUPS: readonly Group[] = ["Imagery and models", "Terrain", "Vectors"] as const;

/** Groups mirror how the deliverables are actually discussed. */
function groupOf(layer: MapLayer): Group {
  if (layer.kind === "vector") return "Vectors";
  if (layer.kind === "dem") return "Terrain";
  return "Imagery and models";
}

type MeasureMode = "off" | "distance" | "area";

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
  // Points live in a ref as well, because the map's click handler is registered
  // once and would otherwise close over the first render's empty array.
  const drawn = useRef<[number, number][]>([]);
  const sampler = useRef<DemSampler | null>(null);
  const modeRef = useRef<MeasureMode>("off");
  modeRef.current = mode;

  const dem = layers.find((l) => l.kind === "dem");
  const utmZone = dem?.utmZone ?? 43;
  const utmNorthern = dem?.utmNorthern ?? true;

  const url = useCallback(
    (file: string) => `/api/portal/sites/${siteSlug}/map/${file}`,
    [siteSlug],
  );

  /**
   * Redraw the measurement and recompute its numbers.
   *
   * Geometry goes into a GeoJSON source so MapLibre draws it; the numbers are
   * computed in UTM by geodesy.ts, never from the map's own coordinates. The
   * profile is sampled at roughly one DEM cell, because asking for samples closer
   * together than the data would show interpolation rather than measurement.
   */
  const recompute = useCallback(
    async (instance: InstanceType<typeof MapLibreMap>, closed: boolean) => {
      const points = drawn.current;
      const isArea = modeRef.current === "area";
      const source = instance.getSource("measure");

      const ring = isArea && points.length > 2 ? [...points, points[0]] : points;
      const features: GeoJSON.Feature[] = points.map((p) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: p },
      }));
      if (points.length > 1) {
        features.push(
          isArea && closed && points.length > 2
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
        return;
      }

      const length = pathLength(ring, utmZone, utmNorthern);
      const area = isArea ? ringArea(points, utmZone, utmNorthern) : 0;

      // One DEM cell at the deepest zoom we generated, so the profile is sampled
      // at the resolution the data actually has.
      const spacing = Math.max(
        0.5,
        metresPerPixel(points[0][1], dem?.maxZoom ?? instance.getZoom()),
      );
      const samples = densifyPath(ring, spacing, utmZone, utmNorthern);
      const s = sampler.current;
      const profile = s ? await s.elevations(samples, dem?.maxZoom ?? instance.getZoom()) : [];

      setMeasurement({
        mode: isArea ? "area" : "distance",
        points,
        length,
        area,
        profile,
        utmZone,
        closed,
      });
    },
    [utmZone, utmNorthern, dem?.maxZoom],
  );

  const clearMeasurement = useCallback(() => {
    drawn.current = [];
    setMeasurement(null);
    const instance = map.current;
    const source = instance?.getSource("measure");
    if (source && "setData" in source) {
      (source as { setData: (d: unknown) => void }).setData({
        type: "FeatureCollection",
        features: [],
      });
    }
  }, []);

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

    const refreshReadout = () => {
      pending = false;
      const at = lastLngLat;
      if (!at) return;

      const [easting, northing] = lonLatToUtm(at.lng, at.lat, utmZone, utmNorthern);
      const base =
        `${at.lat.toFixed(6)}, ${at.lng.toFixed(6)}` +
        `  ·  ${easting.toFixed(1)} E ${northing.toFixed(1)} N`;
      setReadout(base);

      const s = sampler.current;
      if (!s) return;
      void s
        .elevationAt(at.lng, at.lat, instance.getZoom())
        .then((elevation) => {
          // Only annotate if the pointer has not moved on since.
          if (lastLngLat !== at || elevation === null) return;
          setReadout(`${formatElevation(elevation, TOLERANCE_M)}  ·  ${base}`);
        })
        .catch(() => {});
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
      setReadout("");
    });

    // ---- measure: click to add a vertex, double click to finish ------------
    instance.on("click", (event) => {
      if (modeRef.current === "off") return;
      drawn.current = [...drawn.current, [event.lngLat.lng, event.lngLat.lat]];
      void recompute(instance, false);
    });
    instance.on("dblclick", (event) => {
      if (modeRef.current === "off") return;
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
           * Terrain-RGB, so the elevation survives into the browser as metres.
           *
           * Two things come off this one source. MapLibre renders `hillshade`
           * from it natively, which is relief the client can turn up or down
           * rather than a colour ramp baked at ingest. And DemSampler decodes
           * the same tiles to answer "how high is this point", which is what
           * makes the measure tool report real heights instead of guesses.
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

  // The elevation sampler needs the same authorised tile URL the map uses.
  useEffect(() => {
    if (!dem?.tiles) return;
    sampler.current = new DemSampler(
      url(dem.tiles),
      dem.minZoom ?? 0,
      dem.maxZoom ?? 20,
      dem.encoding ?? "mapbox",
    );
  }, [dem?.tiles, dem?.minZoom, dem?.maxZoom, dem?.encoding, url]);

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

  // Switching mode starts a new measurement rather than extending the last one.
  useEffect(() => {
    if (mode === "off") return;
    clearMeasurement();
  }, [mode, clearMeasurement]);

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
            ["distance", "Distance"],
            ["area", "Area"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(mode === value ? "off" : value)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              mode === value
                ? "bg-accent-600 text-white"
                : "border border-ink/15 text-ink/70 hover:border-accent-600 hover:text-accent-700"
            }`}
          >
            {label}
          </button>
        ))}
        {mode !== "off" ? (
          <span className="text-[11px] text-ink/55">
            Click to add points, double click to finish.
          </span>
        ) : null}
        {hasTerrain ? (
          <label className="ml-auto flex min-h-6 cursor-pointer items-center gap-2 py-0.5 text-xs text-ink/70">
            <input
              type="checkbox"
              checked={hillshade}
              onChange={(e) => setHillshade(e.target.checked)}
              className="h-4 w-4 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
            />
            Relief shading
          </label>
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
            {measurement ? (
              <div className="mb-4 border-b border-ink/[0.08] pb-4">
                <MeasurePanel
                  measurement={measurement}
                  onClear={clearMeasurement}
                  toleranceM={TOLERANCE_M}
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
        {measurement ? (
          <div className="mb-4 border-b border-ink/[0.08] pb-4">
            <MeasurePanel
              measurement={measurement}
              onClear={clearMeasurement}
              toleranceM={TOLERANCE_M}
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
