"use client";

import { MotionConfig } from "framer-motion";

/**
 * Makes the site's animation actually respect "reduce motion".
 *
 * globals.css has a prefers-reduced-motion block, but it only reaches CSS
 * transitions and keyframes. Everything animated here is driven by Framer
 * Motion, which writes inline transforms from JavaScript and sails straight past
 * that rule. So the section reveals, the staggered cards and the sliding nav
 * pill all kept moving for people who had explicitly asked them not to.
 *
 * reducedMotion="user" defers to the operating system setting and drops
 * movement to a plain fade, which keeps the content legible without the travel.
 */
export default function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
