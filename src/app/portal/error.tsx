"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Error boundary for everything under /portal.
 *
 * Without this, a failure anywhere in the portal renders Next's bare
 * "Application error: a client-side exception has occurred" on a blank page,
 * which tells the person nothing and tells us even less. This shows something
 * civil, offers a retry, and surfaces the digest so a screenshot is enough to
 * find the fault.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Goes to the browser console, and to the Vercel logs when it is a server error.
    console.error("[portal] render failed", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-20">
      <div className="surface w-full max-w-lg p-8 text-center">
        <h1 className="text-xl font-bold tracking-tight text-ink-900">
          Something went wrong loading this page
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink/70">
          This is our problem, not yours. Try again, and if it keeps happening
          send us the reference below and we will chase it.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button type="button" onClick={reset} className="btn-primary">
            Try again
          </button>
          <Link href="/portal" className="btn-secondary">
            Back to your sites
          </Link>
        </div>

        <dl className="mt-8 space-y-2 border-t border-ink/[0.08] pt-5 text-left">
          <div className="flex gap-2 text-xs">
            <dt className="font-semibold text-ink/60">Reference</dt>
            <dd className="font-mono text-ink/70">{error.digest ?? "none"}</dd>
          </div>
          {error.message ? (
            <div className="flex gap-2 text-xs">
              <dt className="shrink-0 font-semibold text-ink/60">Detail</dt>
              <dd className="break-words font-mono text-ink/70">{error.message.slice(0, 300)}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
