"use client";

/**
 * The forest inventory, drawn inside the survey map: tree points and crown
 * polygons, as ordinary MapLibre GeoJSON sources and built-in layer types.
 *
 * ## Read this before assuming a custom WebGL layer belongs here
 *
 * `point-cloud-layer.ts` is a raw `type: "custom"` WebGL layer, and its header
 * comment records four traps that all fail silently: feeding it the wrong
 * matrix (`mainMatrix`, not `modelViewProjectionMatrix`), a stencil test
 * inherited from whatever MapLibre drew last, a VAO that edits the library's
 * own attribute state, and drawing at true altitude instead of anchored to the
 * survey's own low point. All four exist because that layer is choosing, node
 * by node, which of up to 13 million points to load onto the GPU by hand.
 *
 * None of that is this file's problem. Ektanagar 1 has 26,776 trees — the
 * entire pack fits in one GeoJSON source, MapLibre's own tiler and renderer
 * already solve levels of detail, picking and the mercator projection
 * correctly for a source that size, and asking it to do that is not
 * reinventing what the point cloud solved, it is the ordinary way every other
 * vector layer in this file (`hydro-streams`, `measure-fill`, the shapefile
 * draw layer) already draws. Writing a second custom WebGL layer here would
 * reintroduce exactly those four traps for a dataset that does not need
 * whatever they buy: a plain `circle` and `fill` layer are the "boring,
 * correct" answer this size of data deserves.
 *
 * The one lesson that *does* carry over, restated for this simpler shape: get
 * the projection right once, at the boundary, and never invent a second path
 * for it. `forest-client.ts` reprojects every tree's UTM easting/northing to
 * WGS84 before a feature is ever built, using the same `utmToLonLat` every
 * server route already trusts. MapLibre's GeoJSON sources then place the
 * point exactly where every other WGS84 layer on this map is placed — there
 * is no float32 precision cliff to work around here, because there is no
 * custom shader doing the placement; MapLibre's own tiler handles it in the
 * same double precision its labels and contours already rely on.
 *
 * ## Colour: height as position along the CHM ramp, confidence as how solid it looks
 *
 * `docs/forest-tools-plan.md`'s honesty requirement (echoed in the task that
 * produced this file) is specific: confidence must be graduated visually, not
 * just height, and not buried in a popup nobody opens. Height is encoded as
 * hue, using the *same* ramp the CHM raster layer renders with (`CHM_RAMP` —
 * see `elevation-image.mjs`), so a tree drawn in the same colour as the canopy
 * height model underneath it is not a coincidence. Confidence is encoded as
 * opacity and, more subtly, size: a low-confidence tree is drawn smaller and
 * fainter, a high-confidence one larger and more solid. Both are stretched
 * against the survey's *own observed* confidence range rather than the full
 * 0..1 scale — because "not one tree currently reaches 0.6" (per the engine's
 * own manifest note) means a 0..1 stretch would render the entire inventory
 * at nearly the same faint opacity, which hides the very differences this
 * requirement exists to show. The stretch changes only how the difference
 * reads on screen; every popup and every filter still uses the raw, unstretched
 * number, so nothing here can be mistaken for a rescaled confidence score.
 */

import type { GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";
import { rampFor, sampleRamp } from "@/lib/geo/colour.mjs";
import { CHM_RAMP } from "@/lib/geo/elevation-image.mjs";
import type { CrownProperties, HeightClassDef, TreeRecord } from "./forest-client";

const SOURCE_TREES = "forest-trees";
const SOURCE_CROWNS = "forest-crowns";
export const LAYER_TREES = "forest-trees-circle";
const LAYER_CROWNS_FILL = "forest-crowns-fill";
const LAYER_CROWNS_LINE = "forest-crowns-line";

type TreeProps = { id: string; height: number; confidence: number };

function toTreePoints(trees: readonly TreeRecord[]): GeoJSON.FeatureCollection<GeoJSON.Point, TreeProps> {
  return {
    type: "FeatureCollection",
    features: trees.map((t) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [t.lon, t.lat] },
      properties: { id: t.id, height: t.height, confidence: t.confidence },
    })),
  };
}

/** A colour ramp's stops, as MapLibre's `interpolate` expression wants them:
 * a flat `[value, "rgb(r,g,b)", value, "rgb(r,g,b)", ...]` list, built from a
 * value domain rather than the ramp's own 0..1 position. */
function rampStops(ramp: string, domainMin: number, domainMax: number, steps = 8): (number | string)[] {
  const span = domainMax - domainMin || 1;
  const stops = rampFor(ramp);
  const out: (number | string)[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const [r, g, b] = sampleRamp(stops, t);
    out.push(Number((domainMin + t * span).toFixed(3)), `rgb(${r} ${g} ${b})`);
  }
  return out;
}

export type ForestLayerOptions = {
  /** The survey's own height domain, so colour means the same thing at every
   * zoom and does not rescale as a filter narrows the visible set. */
  heightDomain: [number, number];
  /** Likewise for confidence, per the header comment above: the *display*
   * stretch, computed once from the whole inventory, not the filtered view. */
  confidenceDomain: [number, number];
};

export class ForestLayer {
  private readonly map: MapLibreMap;
  private mounted = false;
  private onClick: ((feature: MapGeoJSONFeature) => void) | null = null;
  private readonly handleClick = (event: { features?: MapGeoJSONFeature[] }) => {
    const feature = event.features?.[0];
    if (feature) this.onClick?.(feature);
  };
  private readonly handleEnter = () => {
    this.map.getCanvas().style.cursor = "pointer";
  };
  private readonly handleLeave = () => {
    this.map.getCanvas().style.cursor = "";
  };

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  mount(options: ForestLayerOptions) {
    if (this.mounted) return;
    const map = this.map;

    map.addSource(SOURCE_CROWNS, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(SOURCE_TREES, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    // Crowns first, so tree points draw on top of their own polygons rather
    // than being hidden by them.
    map.addLayer({
      id: LAYER_CROWNS_FILL,
      type: "fill",
      source: SOURCE_CROWNS,
      layout: { visibility: "none" },
      paint: {
        "fill-color": [
          "interpolate",
          ["linear"],
          ["get", "height_m"],
          ...rampStops(CHM_RAMP, options.heightDomain[0], options.heightDomain[1]),
        ] as unknown as string,
        "fill-opacity": 0.32,
      },
    });
    map.addLayer({
      id: LAYER_CROWNS_LINE,
      type: "line",
      source: SOURCE_CROWNS,
      layout: { visibility: "none" },
      paint: { "line-color": "#2f3b2a", "line-width": 0.6, "line-opacity": 0.55 },
    });

    map.addLayer({
      id: LAYER_TREES,
      type: "circle",
      source: SOURCE_TREES,
      layout: { visibility: "visible" },
      paint: {
        "circle-color": [
          "interpolate",
          ["linear"],
          ["get", "height"],
          ...rampStops(CHM_RAMP, options.heightDomain[0], options.heightDomain[1]),
        ] as unknown as string,
        "circle-radius": this.confidenceExpression(options.confidenceDomain, 3, 3.5) as unknown as number,
        "circle-opacity": this.confidenceExpression(options.confidenceDomain, 0.35, 0.65) as unknown as number,
        "circle-stroke-color": "#1c2418",
        "circle-stroke-width": 0.5,
        "circle-stroke-opacity": 0.5,
      },
    });

    map.on("click", LAYER_TREES, this.handleClick);
    map.on("mouseenter", LAYER_TREES, this.handleEnter);
    map.on("mouseleave", LAYER_TREES, this.handleLeave);
    this.mounted = true;
  }

  /** `["interpolate", ["linear"], ["get","confidence"], min, base, max,
   * base+span]` — the stretch the header comment explains: two points
   * mapping the survey's *observed* confidence range onto a visible span,
   * with a floor so the least confident tree is still findable rather than
   * invisible. Falls back to a flat mid-value when every tree in the survey
   * happens to share one confidence (a domain of zero width), which an
   * `interpolate` expression cannot be built from. */
  private confidenceExpression(
    domain: [number, number],
    base: number,
    span: number,
  ): unknown {
    const [min, max] = domain;
    if (!(max > min)) return base + span / 2;
    return ["interpolate", ["linear"], ["get", "confidence"], min, base, max, base + span];
  }

  setTrees(trees: readonly TreeRecord[]) {
    const source = this.map.getSource(SOURCE_TREES) as GeoJSONSource | undefined;
    source?.setData(toTreePoints(trees) as GeoJSON.FeatureCollection);
  }

  setCrowns(collection: GeoJSON.FeatureCollection<GeoJSON.Polygon, CrownProperties>) {
    const source = this.map.getSource(SOURCE_CROWNS) as GeoJSONSource | undefined;
    source?.setData(collection as GeoJSON.FeatureCollection);
  }

  setVisible(which: { points: boolean; crowns: boolean }) {
    const map = this.map;
    if (map.getLayer(LAYER_TREES)) {
      map.setLayoutProperty(LAYER_TREES, "visibility", which.points ? "visible" : "none");
    }
    if (map.getLayer(LAYER_CROWNS_FILL)) {
      map.setLayoutProperty(LAYER_CROWNS_FILL, "visibility", which.crowns ? "visible" : "none");
    }
    if (map.getLayer(LAYER_CROWNS_LINE)) {
      map.setLayoutProperty(LAYER_CROWNS_LINE, "visibility", which.crowns ? "visible" : "none");
    }
  }

  /**
   * Colour the crown fill by height class instead of by continuous height,
   * for the moment a client wants to *see* Malhar's bands rather than a
   * smooth gradient. Rebuilt on demand (classes are user-editable, per §5.4)
   * rather than kept as a static expression; ten to twenty classes is a
   * trivial `match` expression to regenerate.
   */
  setCrownColourByClass(classDefs: readonly HeightClassDef[]) {
    if (!this.map.getLayer(LAYER_CROWNS_FILL)) return;
    const enabled = classDefs.filter((c) => c.enabled);
    const fallback = "#9a9a9a"; // a class label the current defs no longer name

    // MapLibre's `match` expression requires at least one input/output pair
    // before its final fallback argument — a client can disable every class
    // from the editor, and a flat colour is the only well-formed expression
    // left at that point, not a `match` with nothing to match against.
    if (enabled.length === 0) {
      this.map.setPaintProperty(LAYER_CROWNS_FILL, "fill-color", fallback);
      return;
    }

    const expr: unknown[] = ["match", ["get", "height_class"]];
    enabled.forEach((c, i) => {
      const t = enabled.length > 1 ? i / (enabled.length - 1) : 0;
      const [r, g, b] = sampleRamp(rampFor(CHM_RAMP), t);
      expr.push(c.label, `rgb(${r} ${g} ${b})`);
    });
    expr.push(fallback);
    this.map.setPaintProperty(LAYER_CROWNS_FILL, "fill-color", expr as unknown as string);
  }

  setCrownColourByHeight(domain: [number, number]) {
    if (!this.map.getLayer(LAYER_CROWNS_FILL)) return;
    this.map.setPaintProperty(LAYER_CROWNS_FILL, "fill-color", [
      "interpolate",
      ["linear"],
      ["get", "height_m"],
      ...rampStops(CHM_RAMP, domain[0], domain[1]),
    ] as unknown as string);
  }

  onTreeClick(callback: ((feature: MapGeoJSONFeature) => void) | null) {
    this.onClick = callback;
  }

  destroy() {
    const map = this.map;
    map.off("click", LAYER_TREES, this.handleClick);
    map.off("mouseenter", LAYER_TREES, this.handleEnter);
    map.off("mouseleave", LAYER_TREES, this.handleLeave);
    for (const id of [LAYER_TREES, LAYER_CROWNS_LINE, LAYER_CROWNS_FILL]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of [SOURCE_TREES, SOURCE_CROWNS]) {
      if (map.getSource(id)) map.removeSource(id);
    }
    this.mounted = false;
  }
}
