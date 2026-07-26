"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Error boundary for the marketing site.
 *
 * The portal had one; the public pages did not, so any failure there showed
 * Next's bare "Application error" on a blank white page, which is a bad look on
 * the pages prospective clients actually see. The reference is included because
 * production builds redact the message, and without it a report is unactionable.
 */
export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[site] render failed", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <section className="container-px flex min-h-[70vh] flex-col items-center justify-center text-center">
      <span className="eyebrow">Something went wrong</span>
      <h1 className="heading-lg mt-5">This page did not load</h1>
      <p className="lead mt-5 max-w-md">
        The fault is ours, not yours. Try again, and if it keeps happening let us
        know and we will chase it.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-4">
        <button type="button" onClick={reset} className="btn-primary">
          Try again
        </button>
        <Link href="/" className="btn-secondary">
          Back to home
        </Link>
      </div>
      {error.digest ? (
        <p className="mt-8 font-mono text-xs text-ink/45">Reference {error.digest}</p>
      ) : null}
    </section>
  );
}
