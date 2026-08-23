"use client";

/**
 * The LiDAR cloud, drawn inside the survey map.
 *
 * A MapLibre custom layer rather than a separate 3D viewer, which is the whole
 * design decision here. Potree and its kind open a cloud in their own canvas
 * with their own camera, and the client then has two maps of one site that do
 * not agree about where anything is. Rendering into MapLibre's own GL context
 * means the cloud sits under the contours, over the orthomosaic, in the same
 * projection, moved by the same pan — and it costs no dependency at all.
 *
 * ## Precision, which is the thing that goes wrong
 *
 * Mercator coordinates are in [0, 1] across the world, so this survey sits near
 * x = 0.68 with a width of 1.2e-5. Float32 has about seven significant digits,
 * which puts its resolution at that magnitude near 1.6 m — a point cloud
 * rendered as a smeared grid, from code that looks entirely correct.
 *
 * The fix is the standard one and has to be applied in the right place: each
 * node's positions are stored *relative to that node's own origin*, so they are
 * small numbers a float32 holds precisely, and the origin is folded into the
 * matrix in **double precision on the CPU** before it is handed to the shader.
 * Doing the translation in the vertex shader instead would put the large number
 * back into a float32 and undo the whole exercise.
 *
 * ## Level of detail
 *
 * Nodes carry a `spacing` in metres. A node is worth loading when its spacing is
 * finer than what a screen pixel covers on the ground, and not before: drawing
 * points closer together than the screen can resolve costs memory and changes
 * nothing. Loading is budgeted, oldest-coarsest-first, so a client who zooms out
 * over a whole site does not pull 13 million points to look at a thumbnail.
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { CloudManifest, CloudNode } from "./cloud-source";

export type ColourMode = "rgb" | "elevation" | "classification";

/**
 * What MapLibre hands a custom layer's `render`.
 *
 * Narrower than the library's own type on purpose: this layer uses exactly two
 * fields, and naming them here documents which parts of that contract it is
 * actually relying on.
 */
type CustomRenderInput = {
  defaultProjectionData?: { mainMatrix?: ArrayLike<number> };
  shaderData?: { variantName?: string };
};

/** ASPRS classes, coloured the way a LiDAR technician expects to see them. */
export const CLASS_COLOURS: Record<number, [number, number, number]> = {
  0: [150, 150, 150],
  1: [170, 170, 170],
  2: [166, 124, 82],
  3: [140, 190, 110],
  4: [90, 165, 80],
  5: [40, 120, 55],
  6: [200, 90, 80],
  7: [230, 60, 200],
  9: [60, 130, 210],
  10: [140, 100, 190],
  11: [110, 110, 110],
  17: [220, 170, 60],
};

const VERT = `#version 300 es
precision highp float;
in vec3 a_offset;
in vec4 a_colour;
uniform mat4 u_matrix;
uniform float u_size;
out vec4 v_colour;
void main() {
  gl_Position = u_matrix * vec4(a_offset, 1.0);
  gl_PointSize = u_size;
  v_colour = a_colour;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 v_colour;
out vec4 fragColor;
void main() {
  // Round points. A square point looks like a rendering artefact at every zoom
  // and turns dense ground into a moire pattern of overlapping tiles.
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  fragColor = vec4(v_colour.rgb * v_colour.a, v_colour.a);
}`;

type Loaded = {
  node: CloudNode;
  count: number;
  /** Float32, three per point, relative to `node.origin` in mercator units. */
  offsets: Float32Array;
  /** The raw ten-byte records, kept so colour mode can change without refetching. */
  raw: Uint8Array;
  buffers: { position: WebGLBuffer; colour: WebGLBuffer; vao: WebGLVertexArrayObject } | null;
};

export type CloudOptions = {
  colourMode: ColourMode;
  pointSize: number;
  opacity: number;
  /** Classification codes to draw. Empty means all of them. */
  classes: Set<number>;
  /** Upper bound on points held on the GPU at once. */
  budget: number;
};

export class PointCloudLayer {
  readonly id: string;
  readonly type = "custom" as const;
  /** 3d so the cloud shares the depth buffer and is occluded correctly. */
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uMatrix: WebGLUniformLocation | null = null;
  private uSize: WebGLUniformLocation | null = null;

  private readonly manifest: CloudManifest;
  private readonly fetchNode: (key: string) => Promise<ArrayBuffer>;
  private readonly loaded = new Map<string, Loaded>();
  private readonly inFlight = new Set<string>();
  private readonly failed = new Set<string>();
  private options: CloudOptions;
  private colourDirty = true;
  private onStats: ((stats: { points: number; nodes: number; loading: number }) => void) | null;
  private warnedProjection = false;

  constructor(
    id: string,
    manifest: CloudManifest,
    fetchNode: (key: string) => Promise<ArrayBuffer>,
    options: CloudOptions,
    onStats?: (stats: { points: number; nodes: number; loading: number }) => void,
  ) {
    this.id = id;
    this.manifest = manifest;
    this.fetchNode = fetchNode;
    this.options = options;
    this.onStats = onStats ?? null;
  }

  setOptions(next: CloudOptions) {
    const before = this.options;
    this.options = next;
    if (
      before.colourMode !== next.colourMode ||
      before.opacity !== next.opacity ||
      before.classes !== next.classes
    ) {
      this.colourDirty = true;
    }
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;

    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind);
      if (!shader) throw new Error("could not create a shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? "shader would not compile");
      }
      return shader;
    };

    const program = gl.createProgram();
    if (!program) throw new Error("could not create a GL program");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "program would not link");
    }
    this.program = program;
    this.uMatrix = gl.getUniformLocation(program, "u_matrix");
    this.uSize = gl.getUniformLocation(program, "u_size");
  }

  onRemove() {
    const gl = this.gl;
    if (gl) {
      for (const entry of this.loaded.values()) {
        if (entry.buffers) {
          gl.deleteBuffer(entry.buffers.position);
          gl.deleteBuffer(entry.buffers.colour);
          gl.deleteVertexArray(entry.buffers.vao);
        }
      }
      if (this.program) gl.deleteProgram(this.program);
    }
    this.loaded.clear();
    this.map = null;
    this.gl = null;
    this.program = null;
  }

  /**
   * Which nodes are worth having, given where the camera is.
   *
   * Two rules, in order. A node off screen is never wanted, however coarse.
   * Among the rest, a node is wanted while its spacing is coarser than roughly
   * two screen pixels on the ground — descending past that draws points the
   * display cannot separate. The list is coarsest first so that the budget, when
   * it bites, keeps a complete low-detail cloud rather than a detailed patch and
   * holes everywhere else.
   */
  private wanted(): CloudNode[] {
    const map = this.map;
    if (!map) return [];
    const bounds = map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();

    // Ground metres per screen pixel at the centre of the view.
    const centre = map.getCenter();
    const metresPerPixel =
      (156543.03392 * Math.cos((centre.lat * Math.PI) / 180)) / 2 ** map.getZoom();
    const finestUseful = metresPerPixel * 2;

    const visible = this.manifest.nodes.filter((node) => {
      const [w, s, e, n] = node.lonLatBounds;
      if (e < west || w > east || n < south || s > north) return false;
      // The root is always kept, even when its spacing is finer than needed,
      // because it is the only thing that covers the whole site while the rest
      // is still arriving.
      return node.level === 0 || node.spacing >= finestUseful / 4;
    });

    visible.sort((a, b) => a.level - b.level);

    const keep: CloudNode[] = [];
    let points = 0;
    for (const node of visible) {
      if (points + node.count > this.options.budget && keep.length > 0) break;
      keep.push(node);
      points += node.count;
    }
    return keep;
  }

  /** Ask for anything wanted that is not here yet, and drop what is not. */
  private reconcile(wanted: CloudNode[]) {
    const want = new Set(wanted.map((n) => n.key));

    for (const [key, entry] of this.loaded) {
      if (want.has(key)) continue;
      const gl = this.gl;
      if (gl && entry.buffers) {
        gl.deleteBuffer(entry.buffers.position);
        gl.deleteBuffer(entry.buffers.colour);
        gl.deleteVertexArray(entry.buffers.vao);
      }
      this.loaded.delete(key);
    }

    for (const node of wanted) {
      if (this.loaded.has(node.key) || this.inFlight.has(node.key)) continue;
      if (this.failed.has(node.key)) continue;
      // Two at a time. A view can want sixty nodes, and firing them all makes
      // the browser queue them anyway while starving every other request the
      // page makes, including the tiles under the cloud.
      if (this.inFlight.size >= 2) break;
      this.inFlight.add(node.key);
      void this.fetchNode(node.key)
        .then((buffer) => this.accept(node, buffer))
        .catch(() => {
          // Recorded rather than retried. A node that 404s or fails to parse
          // will do so again, and retrying every frame is a request storm that
          // looks like a broken map.
          this.failed.add(node.key);
        })
        .finally(() => {
          this.inFlight.delete(node.key);
          this.map?.triggerRepaint();
          this.report();
        });
    }
  }

  /** Dequantise a node's bytes into positions relative to its own origin. */
  private accept(node: CloudNode, buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (
      bytes.length < 12 ||
      String.fromCharCode(...bytes.subarray(0, 6)) !== "SGAPC1"
    ) {
      throw new Error(`${node.key} is not a point node`);
    }
    const count = view.getUint32(6, true);
    const stride = view.getUint16(10, true);
    if (stride !== 10 || 12 + count * stride > bytes.length) {
      throw new Error(`${node.key} is truncated or in an unknown layout`);
    }

    const [sx, sy, sz] = node.span;
    const offsets = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const at = 12 + i * 10;
      // Relative to the node origin, which the matrix carries in double
      // precision. Absolute mercator here would be the 1.6 m smear.
      offsets[i * 3] = (view.getUint16(at, true) / 65535) * sx;
      offsets[i * 3 + 1] = (view.getUint16(at + 2, true) / 65535) * sy;
      offsets[i * 3 + 2] = (view.getUint16(at + 4, true) / 65535) * sz;
    }

    this.loaded.set(node.key, {
      node,
      count,
      offsets,
      raw: bytes.subarray(12, 12 + count * 10),
      buffers: null,
    });
    this.colourDirty = true;
  }

  /** Colours for one node, in the current mode. */
  private colours(entry: Loaded): Uint8Array {
    const { colourMode, opacity, classes } = this.options;
    const out = new Uint8Array(entry.count * 4);
    const [, , oz] = entry.node.origin;
    const sz = entry.node.span[2];
    const { min, max } = this.manifest.elevation;
    // The node stores mercator z; turn it back into metres for the ramp, so a
    // colour means the same height everywhere rather than per node.
    const zRange = Math.max(max - min, 1e-9);

    for (let i = 0; i < entry.count; i += 1) {
      const at = i * 10;
      const classification = entry.raw[at + 9];
      const alpha = classes.size > 0 && !classes.has(classification) ? 0 : opacity * 255;

      let r: number;
      let g: number;
      let b: number;
      if (colourMode === "classification") {
        [r, g, b] = CLASS_COLOURS[classification] ?? [200, 200, 200];
      } else if (colourMode === "elevation") {
        // Quantised z back to a fraction of the survey's whole height range.
        const q = (entry.raw[at + 4] | (entry.raw[at + 5] << 8)) / 65535;
        const mercZ = oz + q * sz;
        // The pipeline's metres-to-mercator factor varies only with latitude and
        // is effectively constant over one survey, so the ratio of this node's
        // mercator z to the site's mercator z range is the ratio in metres.
        const t = Math.min(1, Math.max(0, (mercZ - this.zeroZ()) / (zRange * this.zScale())));
        [r, g, b] = elevationRamp(t);
      } else {
        r = entry.raw[at + 6];
        g = entry.raw[at + 7];
        b = entry.raw[at + 8];
        // A cloud with no RGB writes zeros. Black would be indistinguishable
        // from genuinely dark ground, so it falls back to height instead.
        if (!this.manifest.hasColour) {
          const q = (entry.raw[at + 4] | (entry.raw[at + 5] << 8)) / 65535;
          [r, g, b] = elevationRamp(q);
        }
      }
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = alpha;
    }
    return out;
  }

  /**
   * The site's minimum elevation and metres-per-mercator, in mercator z units.
   *
   * Derived from the manifest's own bounds rather than measured off the points,
   * so every node shares one scale and a colour means the same height across the
   * whole survey. Computed once and cached: this is called per point.
   */
  private zeroZCache: number | null = null;
  private zScaleCache: number | null = null;
  private zeroZ(): number {
    if (this.zeroZCache === null) this.computeZ();
    return this.zeroZCache as number;
  }
  private zScale(): number {
    if (this.zScaleCache === null) this.computeZ();
    return this.zScaleCache as number;
  }
  private computeZ() {
    const [, south, , north] = this.manifest.lonLatBounds;
    const lat = (south + north) / 2;
    const perMetre = 1 / (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180));
    this.zScaleCache = perMetre;
    this.zeroZCache = this.manifest.elevation.min * perMetre;
  }

  /**
   * The last numbers reported, so an unchanged frame reports nothing.
   *
   * `report` is called from `render`, which runs on every animation frame while
   * the map is moving. Handing React a fresh object each time is a state update
   * per frame, which re-renders the whole viewer sixty times a second to tell it
   * the same three numbers.
   */
  private lastStats = "";
  private report() {
    if (!this.onStats) return;
    let points = 0;
    for (const entry of this.loaded.values()) points += entry.count;
    const key = `${points}/${this.loaded.size}/${this.inFlight.size}`;
    if (key === this.lastStats) return;
    this.lastStats = key;
    this.onStats({ points, nodes: this.loaded.size, loading: this.inFlight.size });
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderInput) {
    if (!this.program) return;
    this.reconcile(this.wanted());

    /*
     * `defaultProjectionData.mainMatrix`, not `modelViewProjectionMatrix`.
     *
     * The two differ by the world size and the difference is not subtle: the
     * model-view-projection matrix takes coordinates in *world pixels at the
     * current zoom*, which at zoom 16 is mercator multiplied by 32,113,031.
     * Feeding it mercator coordinates puts every point within a rounding error
     * of the map's origin, off the top left corner of the world — the cloud
     * loaded, reported its point count, drew, and was nowhere on screen.
     *
     * `mainMatrix` with `tileMercatorCoords` of [0, 0, 1, 1], which is what a
     * custom layer is handed under mercator, takes mercator [0,1] directly. That
     * is the space the pipeline writes, so it is the one to use.
     */
    const projection = options.defaultProjectionData;
    if (options.shaderData?.variantName !== "mercator") {
      // Globe projection hands out a matrix that projects a unit sphere, which
      // this layer's flat mercator offsets are not. Drawing anyway would put the
      // cloud somewhere confidently wrong, so it draws nothing and says so once.
      if (!this.warnedProjection) {
        this.warnedProjection = true;
        console.warn("[point cloud] only the mercator projection is supported");
      }
      return;
    }
    const base = Array.from((projection?.mainMatrix ?? []) as ArrayLike<number>);
    if (base.length !== 16) return;

    gl.useProgram(this.program);
    gl.uniform1f(this.uSize, this.options.pointSize);

    /*
     * The GL state this layer inherits is not its own, and two pieces of it stop
     * a point cloud drawing at all.
     *
     * **The stencil test.** MapLibre clips tiled layers with a stencil mask, and
     * a custom layer is handed the context with whatever mask was last set. A
     * cloud drawn under someone else's clip is almost entirely discarded — the
     * symptom was 179 lit pixels out of fifty thousand points, scattered where
     * the geometry is not.
     *
     * **A bound vertex array object.** MapLibre binds its own VAO, so calling
     * `vertexAttribPointer` here edits *their* attribute state, and whatever
     * else that VAO has enabled is still pointing at their buffers during our
     * draw. Each node gets its own VAO instead, which is both correct and
     * cheaper: the attribute layout is set once rather than per frame.
     *
     * The interface's own documentation says a custom layer "cannot make any
     * assumptions about the current GL state" beyond blending and depth. This is
     * what taking that seriously looks like.
     */
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);

    const positionLocation = gl.getAttribLocation(this.program, "a_offset");
    const colourLocation = gl.getAttribLocation(this.program, "a_colour");

    for (const entry of this.loaded.values()) {
      if (!entry.buffers) {
        const position = gl.createBuffer();
        const colour = gl.createBuffer();
        const vao = gl.createVertexArray();
        if (!position || !colour || !vao) continue;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, position);
        gl.bufferData(gl.ARRAY_BUFFER, entry.offsets, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, colour);
        gl.enableVertexAttribArray(colourLocation);
        gl.vertexAttribPointer(colourLocation, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        gl.bindVertexArray(null);
        entry.buffers = { position, colour, vao };
        this.colourDirty = true;
      }
      if (this.colourDirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffers.colour);
        gl.bufferData(gl.ARRAY_BUFFER, this.colours(entry), gl.STATIC_DRAW);
      }

      /*
       * The node's origin folded into the matrix, in doubles, here on the CPU.
       *
       * This is the line the precision argument at the top of the file is about.
       * `base` is column major, so translating by (tx, ty, tz) means adding
       * `t · column` into the last column.
       */
      /*
       * Anchored to the survey's own lowest ground, not to sea level.
       *
       * MapLibre's camera is perspective even looking straight down, so anything
       * standing above the map plane projects outward from the centre of the
       * view. Aektanagar sits 29 to 103 m above sea level, and drawn at true
       * altitude the whole cloud was pushed 6.5% outward — up to 21 px, about
       * 50 m on the ground, at the edge of the survey. It looked like a
       * projection bug and was ordinary parallax on a cloud floating a hundred
       * metres above the map.
       *
       * Subtracting the survey's minimum puts its lowest ground on the plane the
       * rasters are drawn on, so the cloud lines up with the orthomosaic
       * underneath it. The site's own relief still produces parallax, which is
       * correct: it is what makes the cloud read as three dimensional the moment
       * anyone pitches the map, and it is why this is anchoring rather than
       * flattening.
       */
      const [tx, ty] = entry.node.origin;
      const tz = entry.node.origin[2] - this.zeroZ();
      const m = base.slice();
      m[12] = base[0] * tx + base[4] * ty + base[8] * tz + base[12];
      m[13] = base[1] * tx + base[5] * ty + base[9] * tz + base[13];
      m[14] = base[2] * tx + base[6] * ty + base[10] * tz + base[14];
      m[15] = base[3] * tx + base[7] * ty + base[11] * tz + base[15];
      gl.uniformMatrix4fv(this.uMatrix, false, new Float32Array(m));

      gl.bindVertexArray(entry.buffers.vao);
      gl.drawArrays(gl.POINTS, 0, entry.count);
    }

    // Leave the context as it was found, so the next layer is not rendered
    // through this one's vertex array.
    gl.bindVertexArray(null);
    this.colourDirty = false;
    this.report();
  }
}

/**
 * Low to high, the same reading as the terrain ramp on the raster layers.
 *
 * Deliberately the *terrain* ramp rather than the rainbow that elevation tiles
 * default to: a point cloud coloured like a relief map reads as ground, and a
 * rainbow cloud reads as data about something else.
 */
export function elevationRamp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [46, 90, 140]],
    [0.25, [60, 145, 105]],
    [0.5, [190, 185, 110]],
    [0.75, [165, 110, 70]],
    [1, [245, 245, 245]],
  ];
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (clamped >= a && clamped <= b) {
      const k = (clamped - a) / (b - a);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * k),
        Math.round(ca[1] + (cb[1] - ca[1]) * k),
        Math.round(ca[2] + (cb[2] - ca[2]) * k),
      ];
    }
  }
  return stops[stops.length - 1][1];
}
