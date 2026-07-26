import Link from "next/link";

/**
 * The portal's own 404.
 *
 * Without it, a client who follows a stale link lands on the marketing 404, which
 * talks about survey extents and offers to show them the Data Insights page.
 * Inside a private portal that is disorienting.
 *
 * Note the wording: a site that belongs to another client returns 404 rather than
 * 403, deliberately, so this page must never imply that the thing exists and is
 * merely off limits. "Not available to your account" covers both cases honestly
 * without confirming anything.
 */
export default function PortalNotFound() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-20">
      <div className="surface w-full max-w-lg p-8 text-center">
        <h1 className="text-xl font-bold tracking-tight text-ink-900">
          Not available to your account
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink/70">
          This page either does not exist or is not part of your account. If you
          were sent a link and expected it to work, your Sudaan Geo-Analytics
          contact can check it.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/portal" className="btn-primary">
            Back to your sites
          </Link>
        </div>
      </div>
    </div>
  );
}
