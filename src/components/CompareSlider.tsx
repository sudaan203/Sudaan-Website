"use client";

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

export default function CompareSlider({
  before,
  after,
  beforeLabel,
  afterLabel,
  className = "",
}: {
  before: ReactNode;
  after: ReactNode;
  beforeLabel?: string;
  afterLabel?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);
  const dragging = useRef(false);

  const update = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(100, Math.max(0, pct)));
  }, []);

  // Drag from anywhere on the slider. Pointer capture on the container keeps
  // tracking even if the finger/cursor leaves the bounds. touch-action: pan-y
  // (set in className) lets the page still scroll vertically over the slider
  // while horizontal drags smoothly move the handle.
  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    containerRef.current?.setPointerCapture?.(e.pointerId);
    update(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    update(e.clientX);
  };
  const stop = () => {
    dragging.current = false;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") setPos((p) => Math.max(0, p - 4));
    if (e.key === "ArrowRight") setPos((p) => Math.min(100, p + 4));
  };

  return (
    <div
      ref={containerRef}
      className={`group relative aspect-[4/3] w-full cursor-ew-resize touch-pan-y select-none overflow-hidden rounded-2xl border border-ink/10 bg-navy ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
    >
      {/* After (full, underneath) */}
      <div className="pointer-events-none absolute inset-0">
        {after}
        {afterLabel && (
          <span className="absolute bottom-4 right-4 rounded-full bg-black/55 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
            {afterLabel}
          </span>
        )}
      </div>

      {/* Before (clipped to left of handle) */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      >
        {before}
        {beforeLabel && (
          <span className="absolute bottom-4 left-4 rounded-full bg-black/55 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
            {beforeLabel}
          </span>
        )}
      </div>

      {/* Handle */}
      <div
        className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-white/90 shadow-[0_0_12px_rgba(217,119,6,0.85)]"
        style={{ left: `${pos}%` }}
      >
        <button
          type="button"
          onKeyDown={onKeyDown}
          aria-label="Drag to compare"
          aria-valuenow={Math.round(pos)}
          aria-valuemin={0}
          aria-valuemax={100}
          role="slider"
          className="pointer-events-none absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-accent text-white shadow-glow transition-transform group-hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
            <path d="M9 6l-4 6 4 6V6zM15 6v12l4-6-4-6z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
