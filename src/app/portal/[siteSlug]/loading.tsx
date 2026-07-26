import { Skeleton, SkeletonScreen } from "@/components/portal/Skeleton";

/**
 * Covers the site shell: this segment's layout fetches the site and its counts
 * before it can draw the tab rail, so the whole frame is pending here.
 */
export default function SiteLoading() {
  return (
    <SkeletonScreen label="Loading site">
      <div className="container-px flex-1 py-8 sm:py-10">
        <Skeleton className="mb-5 h-3 w-20" />
        <div className="mb-8">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="mt-3 h-4 w-56" />
        </div>

        <div className="flex flex-col gap-8 lg:flex-row">
          <div className="flex gap-2 lg:w-56 lg:shrink-0 lg:flex-col lg:gap-1">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-32 rounded-xl lg:w-full" />
            ))}
          </div>
          <div className="min-w-0 flex-1 space-y-8">
            <div className="surface p-6 sm:p-8">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="mt-4 h-4 w-full" />
              <Skeleton className="mt-2 h-4 w-3/4" />
              <div className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i}>
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="mt-2 h-4 w-32" />
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-28 rounded-2xl" />
              <Skeleton className="h-28 rounded-2xl" />
            </div>
          </div>
        </div>
      </div>
    </SkeletonScreen>
  );
}
