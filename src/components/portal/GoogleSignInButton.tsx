"use client";

import { useState } from "react";
import { Spinner } from "@/components/Pending";

/** Google's mark, inlined so the button works with no external requests. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.94v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.94a9 9 0 0 0 0 8.1l3.03-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .94 4.95l3.03 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * A plain anchor, not next/link: this leaves the app for Google's consent
 * screen, so a client side route transition is the wrong model.
 *
 * That handshake is the slowest moment in the whole product, several seconds of
 * redirects before Google draws anything. The button holds a pending state until
 * the document is replaced, so nobody sits looking at an unchanged screen
 * wondering whether the click landed, and nobody double clicks into a second
 * OAuth handshake that invalidates the first.
 */
export default function GoogleSignInButton({ next }: { next: string }) {
  const [leaving, setLeaving] = useState(false);
  const href = `/api/auth/google/start?next=${encodeURIComponent(next)}`;

  return (
    <a
      href={href}
      onClick={(event) => {
        // Let the browser handle new tab and modified clicks normally, and do
        // not lock the button in a pending state it can never leave.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (leaving) {
          event.preventDefault();
          return;
        }
        setLeaving(true);
      }}
      aria-disabled={leaving}
      className={`flex w-full items-center justify-center gap-3 rounded-full border border-ink/15 bg-panel px-6 py-3 text-sm font-semibold text-ink-900 transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
        leaving
          ? "cursor-wait text-ink/70"
          : "hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-glow"
      }`}
    >
      {leaving ? <Spinner /> : <GoogleMark />}
      {leaving ? "Taking you to Google" : "Continue with Google"}
    </a>
  );
}
