import { CardSkeleton, Skeleton, SkeletonScreen } from "@/components/portal/Skeleton";

/** Shown the moment "Client Login" or the portal logo is clicked. */
export default function DashboardLoading() {
  return (
    <SkeletonScreen label="Loading your sites">
      <div className="container-px py-10 sm:py-14">
        <div className="mb-10">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-4 h-9 w-56" />
          <Skeleton className="mt-4 h-4 w-full max-w-xl" />
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    </SkeletonScreen>
  );
}
