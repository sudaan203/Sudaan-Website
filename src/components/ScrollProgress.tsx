"use client";

import { motion, useScroll, useSpring } from "framer-motion";

/**
 * Thin scroll-progress bar pinned to the very top of the viewport.
 * Fills left -> right (0% at the top of the page, 100% at the bottom).
 * Sits above the navbar; spring-smoothed so it glides rather than jumps.
 */
export default function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 140,
    damping: 30,
    restDelta: 0.001,
  });

  return (
    <motion.div
      aria-hidden="true"
      style={{ scaleX }}
      // top-20 = navbar height (h-20), so the bar sits just under the navbar;
      // z-40 keeps it below the navbar (z-50) so the mobile menu covers it.
      className="fixed inset-x-0 top-20 z-40 h-[3px] origin-left bg-gradient-to-r from-accent-300 via-accent-500 to-accent-700"
    />
  );
}
