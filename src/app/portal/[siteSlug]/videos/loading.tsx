import { Skeleton, SkeletonScreen } from "@/components/portal/Skeleton";

/**
 * Without this, switching to the Video tab falls back to the nearest ancestor
 * boundary, which redraws the entire site shell including the tab rail you just
 * clicked. Keeping the skeleton at this level means only the panel changes.
 */
export default function VideosLoading() {
  return (
    <SkeletonScreen label="Loading video">
      <div className="space-y-6">
        <div>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="mt-2 h-4 w-56 max-w-full" />
        </div>
        <Skeleton className="aspect-video w-full rounded-2xl" />
      </div>
    </SkeletonScreen>
  );
}
