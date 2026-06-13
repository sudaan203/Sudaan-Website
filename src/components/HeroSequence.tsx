"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

/**
 * Premium hero animation:
 * A drone sweeps across the panel emitting a scan; the surface below
 * transforms through the processing pipeline and loops:
 * Raw imagery -> Point cloud -> DSM -> Contours -> Intelligence dashboard.
 * Animation is transform/opacity based (GPU friendly) and lightweight.
 */

const STAGES = [
  { key: "raw", label: "Raw Imagery", caption: "Drone capture" },
  { key: "cloud", label: "Point Cloud", caption: "3D reconstruction" },
  { key: "dsm", label: "Surface Model", caption: "DSM / DTM" },
  { key: "contour", label: "Contours", caption: "Terrain extraction" },
  { key: "intel", label: "Intelligence", caption: "GIS analytics" },
] as const;

const VB = { w: 440, h: 320 };

export default function HeroSequence() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setStage((s) => (s + 1) % STAGES.length),
      2600
    );
    return () => clearInterval(id);
  }, []);

  const current = STAGES[stage];

  return (
    <div className="relative">
      <div className="surface relative aspect-[11/8] w-full overflow-hidden p-0">
        {/* soft grid base */}
        <div className="absolute inset-0 grid-overlay opacity-60" />

        {/* stage visuals (cross-fade) */}
        <svg
          viewBox={`0 0 ${VB.w} ${VB.h}`}
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 h-full w-full"
        >
          <AnimatePresence>
            <motion.g
              key={current.key}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, ease: "easeInOut" }}
            >
              <Stage which={current.key} />
            </motion.g>
          </AnimatePresence>
        </svg>

        {/* sweeping scan line */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-16"
          initial={{ top: "-15%" }}
          animate={{ top: "110%" }}
          transition={{ duration: 2.6, repeat: Infinity, ease: "linear" }}
          style={{
            background:
              "linear-gradient(to bottom, rgba(217,119,6,0) 0%, rgba(217,119,6,0.18) 50%, rgba(217,119,6,0) 100%)",
          }}
        >
          <div className="absolute bottom-0 left-0 right-0 h-px bg-accent-600/70" />
        </motion.div>

        {/* flying drone + scan rays */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute top-[12%]"
          initial={{ left: "-12%" }}
          animate={{ left: "104%" }}
          transition={{
            duration: 5.2,
            repeat: Infinity,
            ease: "easeInOut",
            repeatType: "reverse",
          }}
        >
          <Drone />
        </motion.div>

        {/* stage label */}
        <div className="absolute left-4 top-4 flex items-center gap-2">
          <span className="flex h-2 w-2">
            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-accent-500 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-600" />
          </span>
          <AnimatePresence mode="wait">
            <motion.span
              key={current.key}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.3 }}
              className="rounded-full bg-ink-900/85 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm"
            >
              {current.label}
              <span className="ml-2 font-normal text-white/60">
                {current.caption}
              </span>
            </motion.span>
          </AnimatePresence>
        </div>

        {/* pipeline progress dots */}
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1.5">
          {STAGES.map((s, i) => (
            <span
              key={s.key}
              className={`h-1.5 rounded-full transition-all duration-500 ${
                i === stage ? "w-6 bg-accent-600" : "w-1.5 bg-ink/20"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Drone ---------------- */
function Drone() {
  return (
    <div className="relative -translate-x-1/2">
      {/* scan rays */}
      <svg
        width="120"
        height="220"
        viewBox="0 0 120 220"
        className="absolute left-1/2 top-7 -translate-x-1/2"
        fill="none"
      >
        <defs>
          <linearGradient id="ray" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#D97706" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#D97706" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M60 0 L18 210 L102 210 Z" fill="url(#ray)" />
        <line x1="60" y1="0" x2="18" y2="210" stroke="#D97706" strokeWidth="1" strokeOpacity="0.5" />
        <line x1="60" y1="0" x2="102" y2="210" stroke="#D97706" strokeWidth="1" strokeOpacity="0.5" />
      </svg>
      {/* drone body (top view) */}
      <svg width="64" height="40" viewBox="0 0 64 40" className="relative">
        <g stroke="#111111" strokeWidth="2.4" fill="#111111" strokeLinecap="round">
          <line x1="16" y1="12" x2="48" y2="28" />
          <line x1="48" y1="12" x2="16" y2="28" />
          <circle cx="14" cy="11" r="6" fill="none" />
          <circle cx="50" cy="11" r="6" fill="none" />
          <circle cx="14" cy="29" r="6" fill="none" />
          <circle cx="50" cy="29" r="6" fill="none" />
          <rect x="26" y="14" width="12" height="12" rx="3" />
        </g>
        <circle cx="32" cy="20" r="2.4" fill="#D97706" />
      </svg>
    </div>
  );
}

/* ---------------- Stage visuals ---------------- */
function Stage({ which }: { which: (typeof STAGES)[number]["key"] }) {
  switch (which) {
    case "raw":
      return <RawStage />;
    case "cloud":
      return <CloudStage />;
    case "dsm":
      return <DsmStage />;
    case "contour":
      return <ContourStage />;
    default:
      return <IntelStage />;
  }
}

// round to keep server/client SVG output byte-identical (no hydration drift)
const r2 = (n: number) => Math.round(n * 1000) / 1000;

// deterministic cells
const cols = 10;
const rows = 8;
const cw = VB.w / cols;
const ch = VB.h / rows;
function cellSeed(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
const cells = Array.from({ length: cols * rows }).map((_, i) => {
  const c = i % cols;
  const r = Math.floor(i / cols);
  return {
    x: c * cw,
    y: r * ch,
    elev: Math.min(
      1,
      Math.max(0, 0.2 + (c / cols) * 0.5 + (1 - r / rows) * 0.3 + (cellSeed(i) - 0.5) * 0.25)
    ),
    v: cellSeed(i),
  };
});

// warm elevation ramp (light orange -> deep orange -> ink), on brand
function warmElev(t: number) {
  const stops: [number, [number, number, number]][] = [
    [0, [245, 200, 155]],
    [0.45, [229, 142, 58]],
    [0.75, [180, 83, 9]],
    [1, [46, 46, 46]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      const c = ca.map((vv, j) => Math.round(vv + (cb[j] - vv) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(46,46,46)";
}

function RawStage() {
  return (
    <g>
      <rect width={VB.w} height={VB.h} fill="#e9e3d8" />
      {cells.map((cell, i) => {
        const hue = r2(70 + cell.v * 40);
        const light = r2(55 + cell.v * 20);
        const rot = r2((cell.v - 0.5) * 3);
        return (
          <rect
            key={i}
            x={cell.x - 2}
            y={cell.y - 2}
            width={cw + 4}
            height={ch + 4}
            fill={`hsl(${hue} 22% ${light}%)`}
            transform={`rotate(${rot} ${cell.x + cw / 2} ${cell.y + ch / 2})`}
            opacity={0.95}
          />
        );
      })}
    </g>
  );
}

function CloudStage() {
  const dots = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    for (let k = 0; k < 4; k++) {
      const s = cellSeed(i * 7 + k * 3);
      dots.push({
        x: r2(cell.x + s * cw),
        y: r2(cell.y + cellSeed(i * 3 + k) * ch),
        e: cell.elev,
        r: r2(1 + s * 1.6),
      });
    }
  }
  return (
    <g>
      <rect width={VB.w} height={VB.h} fill="#fbf8f3" />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={warmElev(d.e)} opacity={0.85} />
      ))}
    </g>
  );
}

function DsmStage() {
  return (
    <g>
      <rect width={VB.w} height={VB.h} fill="#fbf8f3" />
      {cells.map((cell, i) => (
        <rect
          key={i}
          x={cell.x}
          y={cell.y}
          width={cw + 0.5}
          height={ch + 0.5}
          fill={warmElev(cell.elev)}
          opacity={0.92}
        />
      ))}
    </g>
  );
}

function ContourStage() {
  const levels = 8;
  return (
    <g>
      <rect width={VB.w} height={VB.h} fill="#fbf8f3" />
      <g fill="none" stroke="#D97706" strokeWidth={1.2}>
        {Array.from({ length: levels }).map((_, l) => {
          const yBase = r2(VB.h - (l / levels) * VB.h * 0.95);
          let d = `M -10 ${yBase}`;
          for (let x = 0; x <= VB.w + 10; x += 24) {
            const wob =
              Math.sin((x / VB.w) * Math.PI * 3 + l) * (10 + l * 2) +
              Math.cos((x / VB.w) * Math.PI * 1.5) * 14;
            d += ` L ${x} ${r2(yBase + wob)}`;
          }
          const major = l % 3 === 0;
          return (
            <path key={l} d={d} strokeWidth={major ? 2 : 1} opacity={major ? 1 : 0.55} />
          );
        })}
      </g>
    </g>
  );
}

function IntelStage() {
  return (
    <g fontFamily="Inter, sans-serif">
      <rect width={VB.w} height={VB.h} fill="#fbf8f3" />
      {/* mini map */}
      <rect x={16} y={16} width={210} height={170} rx={8} fill="#fff" stroke="#e6ded2" />
      {cells
        .filter((c) => c.x < 210 && c.y < 170)
        .map((cell, i) => (
          <rect
            key={i}
            x={r2(16 + cell.x * 0.46)}
            y={r2(16 + cell.y * 0.5)}
            width={r2(cw * 0.46)}
            height={r2(ch * 0.5)}
            fill={warmElev(cell.elev)}
            opacity={0.55}
          />
        ))}
      <circle cx={120} cy={100} r={8} fill="none" stroke="#D97706" strokeWidth={2} />
      <circle cx={120} cy={100} r={2.5} fill="#D97706" />
      {/* metric cards */}
      <g>
        <rect x={238} y={16} width={186} height={50} rx={8} fill="#fff" stroke="#e6ded2" />
        <text x={250} y={38} fontSize={11} fill="#7A7A7A">Accuracy</text>
        <text x={250} y={57} fontSize={18} fontWeight={700} fill="#111111">99.2%</text>
        <rect x={238} y={74} width={186} height={50} rx={8} fill="#fff" stroke="#e6ded2" />
        <text x={250} y={96} fontSize={11} fill="#7A7A7A">Area mapped</text>
        <text x={250} y={115} fontSize={18} fontWeight={700} fill="#111111">1,120 ha</text>
      </g>
      {/* bar chart */}
      <g>
        <rect x={238} y={132} width={186} height={172} rx={8} fill="#fff" stroke="#e6ded2" />
        {[0.5, 0.75, 0.62, 0.9, 0.7, 0.95].map((h, i) => (
          <rect
            key={i}
            x={252 + i * 28}
            y={288 - h * 130}
            width={16}
            height={h * 130}
            rx={3}
            fill={i % 2 ? "#E58E3A" : "#D97706"}
          />
        ))}
      </g>
    </g>
  );
}
