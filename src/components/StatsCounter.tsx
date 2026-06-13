"use client";

import {
  animate,
  motion,
  useInView,
  useMotionValue,
  useTransform,
} from "framer-motion";
import { useEffect, useRef } from "react";
import { stats } from "@/lib/site";

function Counter({
  value,
  suffix,
  label,
}: {
  value: number;
  suffix: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const count = useMotionValue(0);
  const rounded = useTransform(count, (v) => Math.round(v).toLocaleString());

  useEffect(() => {
    if (inView) {
      const controls = animate(count, value, {
        duration: 1.8,
        ease: [0.22, 1, 0.36, 1],
      });
      return controls.stop;
    }
  }, [inView, value, count]);

  return (
    <div
      ref={ref}
      className="surface surface-hover group relative overflow-hidden p-8 text-center"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-baseline justify-center text-5xl font-bold tracking-tight text-ink-900">
        <motion.span>{rounded}</motion.span>
        <span className="text-signal">{suffix}</span>
      </div>
      <p className="mt-3 text-sm font-medium uppercase tracking-wide text-ink/60">
        {label}
      </p>
    </div>
  );
}

export default function StatsCounter() {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((s) => (
        <Counter key={s.label} {...s} />
      ))}
    </div>
  );
}
