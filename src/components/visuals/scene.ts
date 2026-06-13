// Deterministic procedural "site" used to render every geospatial layer.
// Seeded RNG keeps server and client output identical (no hydration drift).

export const W = 800;
export const H = 600;

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Field = {
  x: number;
  y: number;
  w: number;
  h: number;
  elev: number; // 0..1 ground elevation
  veg: number; // 0..1 vegetation index
};

export type Building = {
  x: number;
  y: number;
  w: number;
  h: number;
  height: number; // 0..1 structure height
};

export type Scene = {
  fields: Field[];
  buildings: Building[];
  river: string; // svg path
  roads: string[]; // svg paths
};

function buildScene(): Scene {
  const rng = mulberry32(20260613);

  // Elevation increases gently from bottom-left to top-right with noise.
  const elevAt = (x: number, y: number) => {
    const base = (x / W) * 0.5 + (1 - y / H) * 0.4;
    const ridge =
      Math.sin((x / W) * Math.PI * 1.6) * 0.12 +
      Math.cos((y / H) * Math.PI * 1.3) * 0.1;
    return Math.min(1, Math.max(0, base + ridge + (rng() - 0.5) * 0.08));
  };

  // Field grid with jitter.
  const fields: Field[] = [];
  const cols = 7;
  const rows = 6;
  const cw = W / cols;
  const ch = H / rows;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const pad = 6 + rng() * 6;
      const x = c * cw + pad;
      const y = r * ch + pad;
      const w = cw - pad * 2;
      const h = ch - pad * 2;
      fields.push({
        x,
        y,
        w,
        h,
        elev: elevAt(x + w / 2, y + h / 2),
        veg: Math.min(1, Math.max(0, 0.25 + rng() * 0.7)),
      });
    }
  }

  // A cluster of buildings (the "site").
  const buildings: Building[] = [];
  const clusterX = W * 0.58;
  const clusterY = H * 0.34;
  for (let i = 0; i < 14; i++) {
    const bw = 24 + rng() * 46;
    const bh = 20 + rng() * 40;
    buildings.push({
      x: clusterX + (rng() - 0.5) * 240,
      y: clusterY + (rng() - 0.5) * 180,
      w: bw,
      h: bh,
      height: 0.4 + rng() * 0.6,
    });
  }

  const river = `M -20 ${H * 0.78} C ${W * 0.25} ${H * 0.62}, ${W * 0.3} ${
    H * 0.5
  }, ${W * 0.52} ${H * 0.48} S ${W * 0.85} ${H * 0.3}, ${W + 20} ${H * 0.22}`;

  const roads = [
    `M 0 ${H * 0.55} C ${W * 0.3} ${H * 0.5}, ${W * 0.6} ${H * 0.42}, ${W} ${
      H * 0.36
    }`,
    `M ${W * 0.45} 0 C ${W * 0.5} ${H * 0.3}, ${W * 0.55} ${H * 0.6}, ${
      W * 0.62
    } ${H}`,
  ];

  return { fields, buildings, river, roads };
}

export const scene: Scene = buildScene();

// Shared elevation color ramp (blue -> green -> yellow -> red) for DSM/DTM.
export function elevColor(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [12, 44, 92]],
    [0.3, [22, 120, 160]],
    [0.55, [40, 175, 110]],
    [0.75, [220, 200, 70]],
    [1, [210, 90, 55]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(210,90,55)";
}

// NDVI ramp (bare/red -> sparse/yellow -> healthy/green).
export function ndviColor(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [140, 40, 35]],
    [0.35, [200, 150, 50]],
    [0.6, [150, 190, 60]],
    [1, [30, 130, 50]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(30,130,50)";
}
