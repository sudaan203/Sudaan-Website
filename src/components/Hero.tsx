"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import HeroSequence from "./HeroSequence";

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <HeroBackdrop />

      <div className="container-px relative z-10 grid min-h-[calc(100vh-5rem)] items-center gap-12 py-20 lg:grid-cols-[1.05fr_0.95fr]">
        {/* Copy */}
        <div>
          <motion.span
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="eyebrow"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500 opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-600" />
            </span>
            Sudaan Geo-Analytics
          </motion.span>

          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.08 }}
            className="heading-xl mt-6 max-w-2xl"
          >
            Transforming Survey Data Into{" "}
            <span className="bg-gradient-to-r from-accent-500 via-accent-600 to-signal bg-clip-text text-transparent">
              Actionable Intelligence
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.16 }}
            className="lead mt-6 max-w-xl"
          >
            Engineering-grade geospatial analytics, orthomosaics, LiDAR
            processing, DSM/DTM modeling, contour generation and GIS intelligence
            solutions.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.24 }}
            className="mt-9 flex flex-wrap items-center gap-4"
          >
            <Link href="/services" className="btn-primary">
              View Services
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <Link href="/projects" className="btn-secondary">
              Explore Projects
            </Link>
            <Link
              href="/data-insights"
              className="btn text-accent-700 hover:text-accent-800"
            >
              Explore Data Insights →
            </Link>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.5 }}
            className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs font-semibold uppercase tracking-wider text-ink/50"
          >
            <span>LiDAR Processing</span>
            <span className="text-ink/25">/</span>
            <span>Orthomosaics</span>
            <span className="text-ink/25">/</span>
            <span>DSM &amp; DTM</span>
            <span className="text-ink/25">/</span>
            <span>Contours</span>
            <span className="text-ink/25">/</span>
            <span>GIS Analytics</span>
          </motion.div>
        </div>

        {/* Animated pipeline */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <HeroSequence />
        </motion.div>
      </div>
    </section>
  );
}

function HeroBackdrop() {
  return (
    <div className="absolute inset-0 -z-0 overflow-hidden">
      <div className="absolute inset-0 bg-radial-accent" />

      {/* perspective survey grid (subtle, warm) */}
      <div className="absolute inset-x-0 bottom-0 h-[60%] opacity-30">
        <motion.div
          initial={{ backgroundPosition: "0px 0px" }}
          animate={{ backgroundPosition: "0px 60px" }}
          transition={{ duration: 7, repeat: Infinity, ease: "linear" }}
          className="absolute inset-0 origin-bottom"
          style={{
            transform: "rotateX(64deg)",
            backgroundImage:
              "linear-gradient(rgba(217,119,6,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(217,119,6,0.18) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
            maskImage: "linear-gradient(to top, black 5%, transparent 75%)",
            WebkitMaskImage: "linear-gradient(to top, black 5%, transparent 75%)",
          }}
        />
      </div>

      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-paper to-transparent" />
    </div>
  );
}
