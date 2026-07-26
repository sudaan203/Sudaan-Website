import { PanelSkeleton, Skeleton, SkeletonScreen } from "@/components/portal/Skeleton";

/**
 * The console reads four tables, so it is the slowest page in the portal and the
 * one where a blank screen was mistaken for a broken button.
 */
export default function AdminLoading() {
  return (
    <SkeletonScreen label="Loading the owner console">
      <div className="container-px space-y-10 py-10">
        <header>
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-3 h-9 w-64" />
          <Skeleton className="mt-4 h-4 w-full max-w-2xl" />
        </header>

        {[0, 1, 2].map((section) => (
          <section key={section} className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <PanelSkeleton rows={section === 1 ? 3 : 2} />
            <div className="surface p-5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-5 h-10 w-full rounded-xl" />
              <Skeleton className="mt-3 h-10 w-full rounded-xl" />
              <Skeleton className="mt-5 h-10 w-full rounded-full" />
            </div>
          </section>
        ))}
      </div>
    </SkeletonScreen>
  );
}
