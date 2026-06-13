"use client";

import { useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { industries, projects, type Industry } from "@/data/projects";
import { ProjectThumb } from "@/components/visuals/ProjectThumb";
import { asset } from "@/lib/asset";

type Filter = Industry | "All";

export default function ProjectsExplorer() {
  const [filter, setFilter] = useState<Filter>("All");
  const filtered =
    filter === "All"
      ? projects
      : projects.filter((p) => p.industry === filter);

  const filters: Filter[] = ["All", ...industries];

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition-all ${
              filter === f
                ? "border-accent bg-accent text-white shadow-glow"
                : "border-ink/10 bg-panel text-ink/80 hover:border-accent/40 hover:text-accent-700"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <motion.div layout className="mt-10 grid gap-6 md:grid-cols-2">
        <AnimatePresence mode="popLayout">
          {filtered.map((p) => (
            <motion.article
              key={p.slug}
              layout
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="surface surface-hover group flex flex-col overflow-hidden"
            >
              <div className="relative aspect-[16/9] overflow-hidden border-b border-ink/10 bg-mist">
                {p.image ? (
                  <Image
                    src={asset(p.image)}
                    alt={`${p.name} deliverable`}
                    fill
                    sizes="(max-width: 768px) 100vw, 50vw"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                ) : (
                  <ProjectThumb seed={p.slug} />
                )}
                <span className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                  {p.industry}
                </span>
                {p.accuracy && (
                  <span className="absolute right-4 top-4 rounded-full bg-signal/90 px-3 py-1 text-xs font-semibold text-white">
                    {p.accuracy}
                  </span>
                )}
              </div>

              <div className="flex flex-1 flex-col p-7">
                <div className="flex items-center gap-2 text-xs text-ink/50">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M12 21s-6-5.7-6-10a6 6 0 1112 0c0 4.3-6 10-6 10z" />
                    <circle cx="12" cy="11" r="2" />
                  </svg>
                  {p.location}
                  <span className="text-ink/25">·</span>
                  {p.area}
                </div>
                <h3 className="mt-3 text-lg font-semibold text-ink-900">
                  {p.name}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink/60">
                  {p.summary}
                </p>

                <div className="mt-5 grid grid-cols-3 gap-3 border-y border-ink/[0.06] py-4">
                  {p.metrics.map((m) => (
                    <div key={m.label}>
                      <p className="text-base font-bold text-accent-700">
                        {m.value}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-tight text-ink/50">
                        {m.label}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">
                    Deliverables
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.deliverables.map((d) => (
                      <span
                        key={d}
                        className="rounded-md border border-ink/10 bg-ink/[0.03] px-2 py-1 text-[11px] text-ink/80"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-5 space-y-3 border-t border-ink/[0.06] pt-4 text-sm">
                  <p className="text-ink/80">
                    <span className="font-semibold text-accent-700">
                      Insight:
                    </span>{" "}
                    {p.insight}
                  </p>
                  <p className="text-ink/80">
                    <span className="font-semibold text-signal">Outcome:</span>{" "}
                    {p.outcome}
                  </p>
                </div>
              </div>
            </motion.article>
          ))}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
