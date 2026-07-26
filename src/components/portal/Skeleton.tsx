/**
 * Placeholder shapes for the portal's loading states.
 *
 * These are not decoration. A loading.tsx built from them renders the instant a
 * portal link is clicked, so the page frame, the header and the layout are on
 * screen while the database work happens. That is the difference between "did my
 * click work?" and "it is coming".
 *
 * They mirror the real layout closely enough that nothing jumps when the content
 * arrives, which is the whole point of a skeleton rather than a spinner.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-ink/[0.07] ${className}`} />;
}

/** Wraps a screen's worth of placeholders and tells assistive tech what is happening. */
export function SkeletonScreen({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="surface flex flex-col p-6">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-4 w-32" />
      <Skeleton className="mt-6 h-3 w-24" />
      <Skeleton className="mt-2 h-3 w-28" />
      <div className="mt-5 flex flex-wrap gap-1.5">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <Skeleton className="mt-6 h-4 w-20" />
    </div>
  );
}

/** A titled panel with a few rows, the shape most console sections take. */
export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="surface overflow-hidden">
      <div className="border-b border-ink/[0.08] px-5 py-3">
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="divide-y divide-ink/[0.08]">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="mt-2 h-3 w-32" />
            </div>
            <Skeleton className="h-7 w-24 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
