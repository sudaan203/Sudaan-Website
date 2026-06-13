"use client";

import { useEffect, useRef, useState } from "react";

type Pt = { x: number; y: number; z: number; r: number; g: number; b: number };

function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [20, 80, 140]],
    [0.4, [30, 180, 120]],
    [0.7, [220, 200, 70]],
    [1, [220, 90, 60]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      return [
        ca[0] + (cb[0] - ca[0]) * k,
        ca[1] + (cb[1] - ca[1]) * k,
        ca[2] + (cb[2] - ca[2]) * k,
      ];
    }
  }
  return [220, 90, 60];
}

function buildPoints(): Pt[] {
  let seed = 99173;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pts: Pt[] = [];
  const N = 4200;
  for (let i = 0; i < N; i++) {
    const x = rand() * 2 - 1;
    const y = rand() * 2 - 1;
    // terrain height field
    let z =
      Math.sin(x * 2.2) * 0.18 +
      Math.cos(y * 1.8) * 0.16 +
      (x + y) * 0.12 +
      (rand() - 0.5) * 0.04;
    // a couple of raised "structures"
    const inBldg =
      Math.abs(x - 0.35) < 0.16 && Math.abs(y - 0.1) < 0.12
        ? 0.42
        : Math.abs(x + 0.4) < 0.12 && Math.abs(y + 0.3) < 0.1
          ? 0.3
          : 0;
    z += inBldg;
    const t = Math.min(1, Math.max(0, (z + 0.5) / 1.1));
    const [r, g, b] = ramp(t);
    pts.push({ x, y, z, r, g, b });
  }
  return pts;
}

export default function PointCloudViewer({
  className = "",
}: {
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<Pt[]>([]);
  const stateRef = useRef({
    rotX: -1.05,
    rotZ: 0.6,
    zoom: 1,
    autoRotate: true,
    dragging: false,
    lastX: 0,
    lastY: 0,
  });
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    pointsRef.current = buildPoints();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    // Non-passive wheel listener so we can prevent the page from scrolling
    // while the cursor is over the viewer (React's onWheel is passive).
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const s = stateRef.current;
      s.zoom = Math.min(2.6, Math.max(0.5, s.zoom - e.deltaY * 0.001));
    };
    canvas.addEventListener("wheel", onWheelNative, { passive: false });

    const render = () => {
      const s = stateRef.current;
      if (s.autoRotate) s.rotZ += 0.0035;

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const scale = Math.min(w, h) * 0.42 * s.zoom;

      const cosZ = Math.cos(s.rotZ);
      const sinZ = Math.sin(s.rotZ);
      const cosX = Math.cos(s.rotX);
      const sinX = Math.sin(s.rotX);

      const projected = pointsRef.current.map((p) => {
        // rotate around Z then X
        const x1 = p.x * cosZ - p.y * sinZ;
        const y1 = p.x * sinZ + p.y * cosZ;
        const z1 = p.z;
        const y2 = y1 * cosX - z1 * sinX;
        const z2 = y1 * sinX + z1 * cosX;
        const depth = (z2 + 2.2) / 3;
        const persp = 2.4 / (2.4 + z2);
        return {
          sx: cx + x1 * scale * persp,
          sy: cy - y2 * scale * persp,
          depth,
          z2,
          p,
        };
      });

      projected.sort((a, b) => a.z2 - b.z2);

      for (const q of projected) {
        const a = Math.min(1, Math.max(0.15, q.depth));
        const size = (1.6 + q.depth * 1.8) * dpr;
        ctx.fillStyle = `rgba(${q.p.r | 0},${q.p.g | 0},${q.p.b | 0},${a})`;
        ctx.fillRect(q.sx - size / 2, q.sy - size / 2, size, size);
      }

      raf = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("wheel", onWheelNative);
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const s = stateRef.current;
    s.dragging = true;
    s.autoRotate = false;
    setAuto(false);
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = stateRef.current;
    if (!s.dragging) return;
    s.rotZ += (e.clientX - s.lastX) * 0.008;
    s.rotX += (e.clientY - s.lastY) * 0.008;
    s.rotX = Math.max(-Math.PI / 2, Math.min(0.2, s.rotX));
    s.lastX = e.clientX;
    s.lastY = e.clientY;
  };
  const onPointerUp = () => {
    stateRef.current.dragging = false;
  };

  const toggleAuto = () => {
    const s = stateRef.current;
    s.autoRotate = !s.autoRotate;
    setAuto(s.autoRotate);
  };

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-ink/10 bg-gradient-to-b from-[#13202f] to-[#0a0f1a] shadow-card ${className}`}
    >
      <div className="pointer-events-none absolute inset-0 grid-overlay opacity-30" />
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="relative h-full w-full cursor-grab touch-none active:cursor-grabbing"
        style={{ minHeight: 420 }}
      />
      <div className="pointer-events-none absolute left-4 top-4 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
        POINT CLOUD · 4.2K pts
      </div>
      <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between gap-3">
        <p className="hidden text-xs text-white/60 sm:block">
          Drag to rotate · Scroll to zoom
        </p>
        <button
          onClick={toggleAuto}
          className="pointer-events-auto rounded-full border border-white/15 bg-ink/[0.04] px-4 py-1.5 text-xs font-semibold text-white backdrop-blur-sm transition-colors hover:border-accent/50"
        >
          {auto ? "Pause rotation" : "Auto-rotate"}
        </button>
      </div>
    </div>
  );
}
