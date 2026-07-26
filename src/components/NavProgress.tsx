"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The thin bar that runs across the top while the next page is being fetched.
 *
 * Portal pages are rendered on the server against a database in another
 * continent, so a click can take a second or two before anything changes on
 * screen. Without feedback that reads as a dead button and people click again.
 *
 * It deliberately waits before appearing. A navigation that resolves in 120ms
 * should not flash a progress bar at someone; that reads as jank rather than
 * responsiveness. Anything slower gets the bar, which creeps towards 90% and
 * only completes when the new route actually renders, so the motion always
 * corresponds to real work.
 */

/** Fired by code that navigates programmatically, where there is no link click. */
export const NAV_START_EVENT = "sga:navigation-start";

export function startNavProgress() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(NAV_START_EVENT));
  }
}

const SHOW_AFTER_MS = 140;
const TRICKLE_MS = 240;
const COMPLETE_MS = 260;
/** Nothing should sit there forever if a navigation is abandoned. */
const SAFETY_MS = 15000;

export default function NavProgress() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  const timers = useRef<{ show?: number; trickle?: number; done?: number; safety?: number }>({});

  const clearTimers = useCallback(() => {
    const { show, trickle, done, safety } = timers.current;
    if (show) window.clearTimeout(show);
    if (trickle) window.clearInterval(trickle);
    if (done) window.clearTimeout(done);
    if (safety) window.clearTimeout(safety);
    timers.current = {};
  }, []);

  const finish = useCallback(() => {
    const wasRunning = Boolean(timers.current.show || timers.current.trickle);
    clearTimers();
    if (!wasRunning) return;

    // Snap to full, hold briefly so the completion is legible, then reset.
    setProgress(1);
    timers.current.done = window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, COMPLETE_MS);
  }, [clearTimers]);

  const start = useCallback(() => {
    if (timers.current.show || timers.current.trickle) return; // already running
    clearTimers();

    timers.current.show = window.setTimeout(() => {
      setVisible(true);
      setProgress(0.08);
      // Ease towards 90% and stop. The last 10% belongs to the render landing.
      timers.current.trickle = window.setInterval(() => {
        setProgress((current) => current + (0.9 - current) * 0.18);
      }, TRICKLE_MS);
    }, SHOW_AFTER_MS);

    timers.current.safety = window.setTimeout(finish, SAFETY_MS);
  }, [clearTimers, finish]);

  // A navigation has landed when the path changes. Also covers the back button.
  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // Let the browser handle anything that is not a plain left click.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;

      let target: URL;
      try {
        target = new URL(href, window.location.href);
      } catch {
        return;
      }

      // Other sites, mailto: and tel: leave the app; the browser shows its own
      // progress for those.
      if (target.origin !== window.location.origin) return;

      // A link to where we already are, or to an anchor on this page, never
      // triggers a route change, so a bar would hang there looking broken.
      const sameDocument =
        target.pathname === window.location.pathname && target.search === window.location.search;
      if (sameDocument) return;

      start();
    }

    function onPopState() {
      start();
    }

    document.addEventListener("click", onClick, { capture: true });
    window.addEventListener("popstate", onPopState);
    window.addEventListener(NAV_START_EVENT, start);
    // A hard navigation (sign out, Google redirect) replaces the document, so
    // completion never arrives; showing the bar until then is still correct.
    window.addEventListener("beforeunload", clearTimers);

    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(NAV_START_EVENT, start);
      window.removeEventListener("beforeunload", clearTimers);
      clearTimers();
    };
  }, [start, clearTimers]);

  return (
    <>
      {/* The bar is decorative, so screen readers get the state in words. */}
      <span role="status" aria-live="polite" className="sr-only">
        {visible ? "Loading page" : ""}
      </span>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px]"
        style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms ease" }}
      >
      <div
        className="h-full origin-left bg-gradient-to-r from-accent-400 via-accent-600 to-accent-700"
        style={{
          transform: `scaleX(${progress})`,
          transition: `transform ${progress === 1 ? 120 : TRICKLE_MS}ms ease-out`,
        }}
      />
        {/* The soft leading edge that makes the bar read as motion rather than a
            block of colour sliding along. */}
        <div
          className="absolute top-0 h-full w-24 bg-gradient-to-r from-transparent to-accent-500/70 blur-[2px]"
          style={{
            left: `calc(${progress * 100}% - 6rem)`,
            opacity: visible && progress < 1 ? 1 : 0,
            transition: `left ${TRICKLE_MS}ms ease-out, opacity 200ms ease`,
          }}
        />
      </div>
    </>
  );
}
