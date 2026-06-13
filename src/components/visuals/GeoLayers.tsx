import Image from "next/image";
import { asset } from "@/lib/asset";
import { scene, W, H, elevColor, ndviColor } from "./scene";

const svgProps = {
  viewBox: `0 0 ${W} ${H}`,
  preserveAspectRatio: "xMidYMid slice",
  className: "h-full w-full",
  xmlns: "http://www.w3.org/2000/svg",
} as const;

function Label({ text, tone = "blue" }: { text: string; tone?: string }) {
  // Warm-palette badge tones (kept on-brand, no blue/green).
  const bg =
    tone === "green"
      ? "rgba(180,83,9,0.92)" // deep amber
      : tone === "amber"
        ? "rgba(229,142,58,0.95)" // soft orange
        : "rgba(217,119,6,0.92)"; // accent orange
  // Width estimate accounts for bold uppercase glyphs + letter-spacing so the
  // text never overflows the pill, with equal padding on both sides.
  const padX = 14;
  const charW = 10.6;
  const width = Math.round(text.length * charW + padX * 2);
  return (
    <g>
      <rect x={16} y={16} rx={6} width={width} height={30} fill={bg} />
      <text
        x={16 + padX}
        y={36}
        fill="#fff"
        fontSize={14}
        fontWeight={700}
        fontFamily="Inter, sans-serif"
        letterSpacing={1}
      >
        {text}
      </text>
    </g>
  );
}

/* ---------------- RAW DRONE IMAGERY ---------------- */
export function RawImagery() {
  return (
    <svg {...svgProps}>
      <defs>
        <filter id="raw-noise">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope="0.14" />
          </feComponentTransfer>
          <feComposite operator="over" in2="SourceGraphic" />
        </filter>
        <radialGradient id="raw-vig" cx="50%" cy="50%" r="75%">
          <stop offset="60%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill="#5b6650" />
      {/* tilted, overlapping unstitched frames */}
      {scene.fields.map((f, i) => {
        const rot = ((i % 5) - 2) * 1.4;
        const hue = 70 + (f.veg * 40 - 20);
        const light = 28 + f.veg * 22;
        return (
          <g
            key={i}
            transform={`rotate(${rot} ${f.x + f.w / 2} ${f.y + f.h / 2})`}
          >
            <rect
              x={f.x - 4}
              y={f.y - 4}
              width={f.w + 8}
              height={f.h + 8}
              fill={`hsl(${hue} 28% ${light}%)`}
              opacity={0.92}
            />
          </g>
        );
      })}
      <path d={scene.river} stroke="#3d5a6b" strokeWidth={18} fill="none" opacity={0.7} />
      {scene.roads.map((d, i) => (
        <path key={i} d={d} stroke="#8a8473" strokeWidth={10} fill="none" opacity={0.6} />
      ))}
      {scene.buildings.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          fill="#9a9384"
          transform={`rotate(${(i % 3) - 1} ${b.x} ${b.y})`}
        />
      ))}
      <rect width={W} height={H} filter="url(#raw-noise)" opacity={0.5} />
      <rect width={W} height={H} fill="url(#raw-vig)" />
      <Label text="RAW IMAGERY" tone="amber" />
    </svg>
  );
}

/* ---------------- ORTHOMOSAIC ---------------- */
export function Orthomosaic() {
  return (
    <svg {...svgProps}>
      <defs>
        <linearGradient id="ortho-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7d8a66" />
          <stop offset="100%" stopColor="#65724f" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill="url(#ortho-sky)" />
      {scene.fields.map((f, i) => {
        const hue = 65 + f.veg * 45;
        const light = 30 + f.veg * 25;
        return (
          <g key={i}>
            <rect
              x={f.x}
              y={f.y}
              width={f.w}
              height={f.h}
              fill={`hsl(${hue} 35% ${light}%)`}
            />
            <rect
              x={f.x}
              y={f.y}
              width={f.w}
              height={f.h}
              fill="none"
              stroke="rgba(20,30,15,0.3)"
              strokeWidth={1}
            />
          </g>
        );
      })}
      <path d={scene.river} stroke="#2f6f86" strokeWidth={16} fill="none" />
      <path d={scene.river} stroke="#3f8aa3" strokeWidth={8} fill="none" opacity={0.7} />
      {scene.roads.map((d, i) => (
        <g key={i}>
          <path d={d} stroke="#cfc6b0" strokeWidth={9} fill="none" />
          <path d={d} stroke="#fff" strokeWidth={1} strokeDasharray="6 8" fill="none" opacity={0.5} />
        </g>
      ))}
      {scene.buildings.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="#b9b2a0" />
          <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="#6f6a5c" strokeWidth={1} />
        </g>
      ))}
      {/* faint georef grid */}
      <g stroke="rgba(255,255,255,0.12)" strokeWidth={1}>
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`v${i}`} x1={(i * W) / 8} y1={0} x2={(i * W) / 8} y2={H} />
        ))}
        {Array.from({ length: 7 }).map((_, i) => (
          <line key={`h${i}`} x1={0} y1={(i * H) / 6} x2={W} y2={(i * H) / 6} />
        ))}
      </g>
      <Label text="ORTHOMOSAIC" />
    </svg>
  );
}

/* ---------------- DSM (surface incl. structures) ---------------- */
export function DSM() {
  return (
    <svg {...svgProps}>
      <rect width={W} height={H} fill={elevColor(0.1)} />
      {scene.fields.map((f, i) => (
        <rect
          key={i}
          x={f.x - 6}
          y={f.y - 6}
          width={f.w + 12}
          height={f.h + 12}
          fill={elevColor(f.elev)}
          opacity={0.95}
        />
      ))}
      {/* structures rise above the surface -> hottest */}
      {scene.buildings.map((b, i) => (
        <g key={i}>
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill={elevColor(Math.min(1, 0.7 + b.height * 0.3))}
          />
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill="none"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={1}
          />
        </g>
      ))}
      <ElevLegend label="SURFACE ELEVATION" />
      <Label text="DSM" tone="amber" />
    </svg>
  );
}

/* ---------------- DTM (bare earth) ---------------- */
export function DTM() {
  return (
    <svg {...svgProps}>
      <defs>
        <filter id="dtm-smooth">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>
      <rect width={W} height={H} fill={elevColor(0.1)} />
      <g filter="url(#dtm-smooth)">
        {scene.fields.map((f, i) => (
          <rect
            key={i}
            x={f.x - 10}
            y={f.y - 10}
            width={f.w + 20}
            height={f.h + 20}
            fill={elevColor(f.elev)}
          />
        ))}
      </g>
      {/* no buildings, bare earth only */}
      <ElevLegend label="GROUND ELEVATION" />
      <Label text="DTM" tone="green" />
    </svg>
  );
}

/* ---------------- CONTOURS ---------------- */
export function Contours({ overOrtho = false }: { overOrtho?: boolean }) {
  // Concentric-ish contour rings driven by field elevation bands.
  const levels = 9;
  return (
    <svg {...svgProps}>
      {overOrtho ? (
        <g opacity={0.55}>
          {scene.fields.map((f, i) => (
            <rect
              key={i}
              x={f.x}
              y={f.y}
              width={f.w}
              height={f.h}
              fill={`hsl(${65 + f.veg * 45} 30% ${30 + f.veg * 22}%)`}
            />
          ))}
        </g>
      ) : (
        <rect width={W} height={H} fill="#0c1726" />
      )}
      <g
        fill="none"
        stroke={overOrtho ? "rgba(255,255,255,0.85)" : "#D97706"}
        strokeWidth={1.2}
      >
        {Array.from({ length: levels }).map((_, l) => {
          const t = l / levels;
          // build a wavy iso-line across the field
          const yBase = H - t * H * 0.95;
          let d = `M -20 ${yBase}`;
          for (let x = 0; x <= W + 20; x += 40) {
            const wob =
              Math.sin((x / W) * Math.PI * 3 + l) * (18 + l * 3) +
              Math.cos((x / W) * Math.PI * 1.5) * 22;
            d += ` L ${x} ${yBase + wob}`;
          }
          const major = l % 3 === 0;
          return (
            <path
              key={l}
              d={d}
              strokeWidth={major ? 2.2 : 1}
              opacity={major ? 1 : 0.6}
            />
          );
        })}
      </g>
      <Label text="CONTOURS" />
    </svg>
  );
}

/* ---------------- NDVI VEGETATION ---------------- */
export function NDVI() {
  return (
    <svg {...svgProps}>
      <rect width={W} height={H} fill="#1a1208" />
      {scene.fields.map((f, i) => (
        <rect
          key={i}
          x={f.x - 4}
          y={f.y - 4}
          width={f.w + 8}
          height={f.h + 8}
          fill={ndviColor(f.veg)}
        />
      ))}
      <path d={scene.river} stroke="#11313f" strokeWidth={16} fill="none" />
      {scene.buildings.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="#3a2a1a" />
      ))}
      <NDVILegend />
      <Label text="NDVI" tone="green" />
    </svg>
  );
}

/* ---------------- Legends ---------------- */
function ElevLegend({ label }: { label: string }) {
  return (
    <g transform={`translate(${W - 196} ${H - 44})`}>
      <rect x={-8} y={-22} width={188} height={36} rx={6} fill="rgba(0,0,0,0.45)" />
      <text x={0} y={-6} fill="#cbd5e1" fontSize={10} fontFamily="Inter, sans-serif" letterSpacing={1}>
        {label}
      </text>
      <defs>
        <linearGradient id={`legend-${label}`} x1="0" y1="0" x2="1" y2="0">
          {[0, 0.3, 0.55, 0.75, 1].map((t) => (
            <stop key={t} offset={`${t * 100}%`} stopColor={elevColor(t)} />
          ))}
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={172} height={8} rx={2} fill={`url(#legend-${label})`} />
      <text x={0} y={20} fill="#94a3b8" fontSize={8} fontFamily="Inter, sans-serif">
        low
      </text>
      <text x={158} y={20} fill="#94a3b8" fontSize={8} fontFamily="Inter, sans-serif">
        high
      </text>
    </g>
  );
}

function NDVILegend() {
  return (
    <g transform={`translate(${W - 196} ${H - 44})`}>
      <rect x={-8} y={-22} width={188} height={36} rx={6} fill="rgba(0,0,0,0.45)" />
      <text x={0} y={-6} fill="#cbd5e1" fontSize={10} fontFamily="Inter, sans-serif" letterSpacing={1}>
        VEGETATION INDEX
      </text>
      <defs>
        <linearGradient id="legend-ndvi" x1="0" y1="0" x2="1" y2="0">
          {[0, 0.35, 0.6, 1].map((t) => (
            <stop key={t} offset={`${t * 100}%`} stopColor={ndviColor(t)} />
          ))}
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={172} height={8} rx={2} fill="url(#legend-ndvi)" />
      <text x={0} y={20} fill="#94a3b8" fontSize={8} fontFamily="Inter, sans-serif">
        stressed
      </text>
      <text x={140} y={20} fill="#94a3b8" fontSize={8} fontFamily="Inter, sans-serif">
        healthy
      </text>
    </g>
  );
}

/* ---------------- LIDAR POINT CLOUD ---------------- */
const r2 = (n: number) => Math.round(n * 100) / 100;

export function LidarCloud() {
  const dots: { x: number; y: number; e: number; r: number }[] = [];
  scene.fields.forEach((f, i) => {
    for (let k = 0; k < 8; k++) {
      const sx = Math.abs(Math.sin(i * 3.1 + k * 1.7));
      const sy = Math.abs(Math.cos(i * 2.3 + k * 0.9));
      dots.push({
        x: r2(f.x + sx * f.w),
        y: r2(f.y + sy * f.h),
        e: f.elev,
        r: r2(1.1 + sx * 1.4),
      });
    }
  });
  // building points (denser, higher)
  scene.buildings.forEach((b, i) => {
    for (let k = 0; k < 10; k++) {
      const sx = Math.abs(Math.sin(i * 1.9 + k));
      const sy = Math.abs(Math.cos(i * 2.7 + k));
      dots.push({
        x: r2(b.x + sx * b.w),
        y: r2(b.y + sy * b.h),
        e: Math.min(1, 0.7 + b.height * 0.3),
        r: 1.4,
      });
    }
  });
  return (
    <svg {...svgProps}>
      <rect width={W} height={H} fill="#0c1726" />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={elevColor(d.e)} opacity={0.9} />
      ))}
      <ElevLegend label="LIDAR ELEVATION" />
      <Label text="LIDAR POINT CLOUD" />
    </svg>
  );
}

/* ---------------- SURFACE MODEL (alias of DSM look) ---------------- */
export function SurfaceModel() {
  return (
    <svg {...svgProps}>
      <rect width={W} height={H} fill={elevColor(0.1)} />
      {scene.fields.map((f, i) => (
        <rect
          key={i}
          x={f.x - 6}
          y={f.y - 6}
          width={f.w + 12}
          height={f.h + 12}
          fill={elevColor(f.elev)}
          opacity={0.95}
        />
      ))}
      {scene.buildings.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          fill={elevColor(Math.min(1, 0.7 + b.height * 0.3))}
          stroke="rgba(255,255,255,0.3)"
        />
      ))}
      <ElevLegend label="SURFACE MODEL" />
      <Label text="SURFACE MODEL" tone="amber" />
    </svg>
  );
}

/* ---------------- FOREST MAPPING ---------------- */
export function ForestMap() {
  const trees: { x: number; y: number; r: number; d: number }[] = [];
  for (let i = 0; i < 320; i++) {
    const sx = Math.abs(Math.sin(i * 12.9898)) ;
    const sy = Math.abs(Math.sin(i * 78.233));
    const d = Math.abs(Math.sin(i * 3.7)); // density / health
    // leave a cleared patch
    const x = r2(sx * W);
    const y = r2(sy * H);
    const cleared = x > 480 && x < 620 && y > 120 && y < 260;
    if (cleared) continue;
    trees.push({ x, y, r: r2(6 + d * 12), d });
  }
  return (
    <svg {...svgProps}>
      <rect width={W} height={H} fill="#27331f" />
      {trees.map((t, i) => {
        const light = 22 + t.d * 30;
        return (
          <circle
            key={i}
            cx={t.x}
            cy={t.y}
            r={t.r}
            fill={`hsl(${95 + t.d * 30} 40% ${light}%)`}
            opacity={0.92}
          />
        );
      })}
      {/* cleared / low-canopy patch */}
      <rect x={480} y={120} width={140} height={140} fill="#6b5836" opacity={0.65} rx={6} />
      <NDVILegend />
      <Label text="FOREST CANOPY" tone="green" />
    </svg>
  );
}

/* ---------------- SOLAR PLANT ---------------- */
export function SolarFarm() {
  const rows = 9;
  const perRow = 7;
  return (
    <svg {...svgProps}>
      <rect width={W} height={H} fill="#cdba9e" />
      {Array.from({ length: rows }).map((_, r) =>
        Array.from({ length: perRow }).map((_, c) => {
          const x = 40 + c * 105;
          const y = 36 + r * 58;
          return (
            <g key={`${r}-${c}`} transform={`translate(${x} ${y})`}>
              <rect x={0} y={6} width={86} height={20} rx={2} fill="#1f3550" />
              <line x1={0} y1={16} x2={86} y2={16} stroke="#3a5a82" strokeWidth={1} />
              {[17, 34, 51, 68].map((lx) => (
                <line key={lx} x1={lx} y1={6} x2={lx} y2={26} stroke="#3a5a82" strokeWidth={0.8} />
              ))}
              <rect x={40} y={26} width={3} height={6} fill="#555" />
            </g>
          );
        })
      )}
      {/* inverter blocks */}
      <rect x={W - 120} y={H - 70} width={40} height={30} rx={3} fill="#2E2E2E" />
      <rect x={W - 70} y={H - 70} width={40} height={30} rx={3} fill="#2E2E2E" />
      <Label text="SOLAR PLANT" tone="amber" />
    </svg>
  );
}

/* ---------------- TRANSMISSION LINE CORRIDOR ---------------- */
export function TransmissionCorridor() {
  const towers = [120, 320, 520, 700];
  const baseY = 150;
  return (
    <svg {...svgProps}>
      {/* terrain + vegetation */}
      <rect width={W} height={H} fill="#5d6b46" />
      {scene.fields.map((f, i) => (
        <rect
          key={i}
          x={f.x}
          y={f.y}
          width={f.w}
          height={f.h}
          fill={`hsl(${80 + f.veg * 40} 30% ${28 + f.veg * 18}%)`}
        />
      ))}
      {/* cleared corridor strip */}
      <rect x={0} y={baseY - 46} width={W} height={92} fill="#8a7d54" opacity={0.85} />
      <line x1={0} y1={baseY - 46} x2={W} y2={baseY - 46} stroke="#c2410c" strokeWidth={1.5} strokeDasharray="8 6" />
      <line x1={0} y1={baseY + 46} x2={W} y2={baseY + 46} stroke="#c2410c" strokeWidth={1.5} strokeDasharray="8 6" />
      {/* conductors */}
      {[-14, 0, 14].map((off) => (
        <path
          key={off}
          d={`M ${towers[0]} ${baseY + off} Q ${(towers[0] + towers[1]) / 2} ${baseY + off + 22} ${towers[1]} ${baseY + off} T ${towers[3]} ${baseY + off}`}
          fill="none"
          stroke="#1a1a1a"
          strokeWidth={1.2}
          opacity={0.8}
        />
      ))}
      {/* towers (top view + symbolic) */}
      {towers.map((tx) => (
        <g key={tx} stroke="#1a1a1a" strokeWidth={2} fill="none">
          <rect x={tx - 10} y={baseY - 16} width={20} height={32} />
          <line x1={tx - 10} y1={baseY - 16} x2={tx + 10} y2={baseY + 16} />
          <line x1={tx + 10} y1={baseY - 16} x2={tx - 10} y2={baseY + 16} />
        </g>
      ))}
      <Label text="TRANSMISSION CORRIDOR" />
    </svg>
  );
}

/* ---------------- REAL RASTER TILE (processed deliverables) ---------------- */
export function RealTile({
  src,
  label,
  tone = "blue",
  bgClass = "bg-[#0f1620]",
}: {
  src: string;
  label: string;
  tone?: "blue" | "amber" | "green";
  bgClass?: string;
}) {
  const badge =
    tone === "green"
      ? "bg-[rgba(180,83,9,0.92)]"
      : tone === "amber"
        ? "bg-[rgba(229,142,58,0.95)]"
        : "bg-[rgba(217,119,6,0.92)]";
  return (
    <div className={`relative h-full w-full ${bgClass}`}>
      <Image
        src={asset(src)}
        alt={label}
        fill
        sizes="(max-width: 1024px) 100vw, 50vw"
        draggable={false}
        className="select-none object-cover"
      />
      <span
        className={`absolute left-4 top-4 rounded-md px-3 py-1 text-xs font-bold uppercase tracking-wider text-white ${badge}`}
      >
        {label}
      </span>
    </div>
  );
}
