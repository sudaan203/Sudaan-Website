import { scene, W, H, ndviColor } from "./scene";

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

const r2 = (n: number) => Math.round(n * 100) / 100;

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
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={label}
        draggable={false}
        className="h-full w-full select-none object-cover"
      />
      <span
        className={`absolute left-4 top-4 rounded-md px-3 py-1 text-xs font-bold uppercase tracking-wider text-white ${badge}`}
      >
        {label}
      </span>
    </div>
  );
}
