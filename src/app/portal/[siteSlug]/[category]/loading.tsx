import { Skeleton, SkeletonScreen } from "@/components/portal/Skeleton";

/**
 * Sits inside the site shell, so the tab rail and site name stay on screen and
 * only the section content is replaced. Switching tabs should feel like moving
 * within a page, not leaving one.
 */
export default function CategoryLoading() {
  return (
    <SkeletonScreen label="Loading deliverables">
      <div className="space-y-6">
        <div>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-64 max-w-full" />
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="surface overflow-hidden">
              <Skeleton className="aspect-[4/3] rounded-none" />
              <div className="p-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-2 h-3 w-24" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </SkeletonScreen>
  );
}
