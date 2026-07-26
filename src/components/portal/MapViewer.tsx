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

/** Groups mirror how the deliverables are actually discussed. */
function groupOf(layer: MapLayer): "Imagery and models" | "Vectors" {
  return layer.kind === "raster" ? "Imagery and models" : "Vectors";
}

export default function MapViewer({ siteSlug, siteName, layers }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<InstanceType<typeof MapLibreMap> | null>(null);

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [basemap, setBasemap] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(layers.map((l, i) => [l.key, i === 0 || l.kind === "vector"])),
  );
  const [opacity, setOpacity] = useState<Record<string, number>>(() =>
    Object.fromEntries(layers.map((l) => [l.key, RASTER_OPACITY])),
  );
  const [readout, setReadout] = useState<string>("");
  const [vectorError, setVectorError] = useState<string | null>(null);

  const url = useCallback(
    (file: string) => `/api/portal/sites/${siteSlug}/map/${file}`,
    [siteSlug],
  );

  // ---- build the map once -------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const raster = layers.find((l) => l.kind === "raster" && l.coordinates);
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

    instance.on("mousemove", (event) => {
      const position = `${event.lngLat.lat.toFixed(6)}, ${event.lngLat.lng.toFixed(6)}`;

      // Reading a contour's height by pointing at it, in place of baked labels.
      const drawn = vectorIds.filter((id) => instance.getLayer(id));
      const hit = drawn.length
        ? instance.queryRenderedFeatures(
            [
              [event.point.x - 4, event.point.y - 4],
              [event.point.x + 4, event.point.y + 4],
            ],
            { layers: drawn },
          )[0]
        : undefined;

      const elevation = hit?.properties?.elevation;
      setReadout(
        Number.isFinite(Number(elevation))
          ? `${Number(elevation)} m  ·  ${position}`
          : position,
      );
      instance.getCanvas().style.cursor = hit ? "crosshair" : "";
    });
    instance.on("mouseout", () => setReadout(""));
    instance.on("error", (event) => {
      // MapLibre reports missing tiles this way; do not blank the whole map.
      console.error("[portal map]", event.error?.message ?? event);
    });

    instance.on("load", () => {
      for (const layer of layers) {
        if (layer.kind === "raster" && layer.coordinates) {
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
        } else {
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
              const response = await fetch(url(layer.file), { credentials: "same-origin" });
              if (!response.ok) throw new Error(`${response.status} for ${layer.file}`);
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
      setReady(true);
    });

    return () => {
      instance.remove();
      map.current = null;
    };
    // Layers are fixed for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- reflect state into the map ----------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    for (const layer of layers) {
      if (!instance.getLayer(layer.key)) continue;
      instance.setLayoutProperty(
        layer.key,
        "visibility",
        visible[layer.key] ? "visible" : "none",
      );
      if (layer.kind === "raster") {
        instance.setPaintProperty(layer.key, "raster-opacity", opacity[layer.key] ?? RASTER_OPACITY);
      } else {
        instance.setPaintProperty(layer.key, "line-opacity", opacity[layer.key] ?? 0.9);
      }
    }
  }, [visible, opacity, ready, layers]);

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

  const groups = ["Imagery and models", "Vectors"] as const;

  return (
    <div className="surface overflow-hidden">
      <div className="relative">
        <div
          ref={container}
          role="application"
          aria-label={`Survey map of ${siteName}`}
          className="h-[68vh] min-h-[420px] w-full bg-mist"
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
            <LayerTree
              groups={groups}
              layers={layers}
              visible={visible}
              opacity={opacity}
              setVisible={setVisible}
              setOpacity={setOpacity}
              basemap={basemap}
              setBasemap={setBasemap}
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
        <LayerTree
          groups={groups}
          layers={layers}
          visible={visible}
          opacity={opacity}
          setVisible={setVisible}
          setOpacity={setOpacity}
          basemap={basemap}
          setBasemap={setBasemap}
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
}: {
  groups: readonly string[];
  layers: MapLayer[];
  visible: Record<string, boolean>;
  opacity: Record<string, number>;
  setVisible: (fn: (v: Record<string, boolean>) => Record<string, boolean>) => void;
  setOpacity: (fn: (v: Record<string, number>) => Record<string, number>) => void;
  basemap: boolean;
  setBasemap: (v: boolean) => void;
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
              {inGroup.map((layer) => (
                <div key={layer.key}>
                  <label className="flex items-center gap-2 text-sm text-ink-900">
                    <input
                      type="checkbox"
                      checked={Boolean(visible[layer.key])}
                      onChange={(e) =>
                        setVisible((v) => ({ ...v, [layer.key]: e.target.checked }))
                      }
                      className="h-4 w-4 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
                    />
                    <span className="flex-1">{layer.title}</span>
                  </label>

                  {layer.elevation ? (
                    <p className="ml-6 text-[11px] text-ink/50">
                      {Math.round(layer.elevation.min)} to {Math.round(layer.elevation.max)} m
                      {layer.featureCount ? ` · ${layer.featureCount} lines` : ""}
                    </p>
                  ) : null}

                  <label className="ml-6 mt-1.5 flex items-center gap-2">
                    <span className="sr-only">{layer.title} opacity</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((opacity[layer.key] ?? RASTER_OPACITY) * 100)}
                      disabled={!visible[layer.key]}
                      onChange={(e) =>
                        setOpacity((o) => ({ ...o, [layer.key]: Number(e.target.value) / 100 }))
                      }
                      className="h-1 w-full accent-accent-600 disabled:opacity-40"
                    />
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
        );
      })}

      <fieldset className="border-t border-ink/[0.08] pt-4">
        <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Base map
        </legend>
        <label className="flex items-start gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={basemap}
            onChange={(e) => setBasemap(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-ink/25 text-accent-600 focus:ring-accent-600"
          />
          <span>
            OpenStreetMap
            <span className="mt-0.5 block text-[11px] leading-snug text-ink/55">
              Off by default. Turning this on requests map tiles from OpenStreetMap,
              which reveals roughly where this site is to a third party.
            </span>
          </span>
        </label>
      </fieldset>
    </div>
  );
}
