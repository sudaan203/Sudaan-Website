"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LinkSpinner } from "@/components/Pending";

type Tab = { href: string; label: string; count: number | null };

/**
 * Section nav for a site. A left rail on desktop, a scrolling row on mobile,
 * mirroring the sidebar in the reference portal.
 */
export default function SiteTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();

  return (
    /**
     * A horizontal segmented bar, sitting beside the site name.
     *
     * It was a 224px left column, which cost every page a fifth of its width and
     * pushed the map — the product — sideways as well as down. Horizontal costs
     * one row of height and nothing else.
     *
     * On a phone it scrolls, and the mask says so: without it the last tab sat
     * flush to the edge looking like the end of the list rather than the start of
     * an overflow. A mask rather than a gradient overlay because the row scrolls
     * under it, and an opaque overlay would have to match a background this page
     * has two of.
     */
    <nav
      aria-label="Site sections"
      className="-mx-6 max-w-full shrink-0 overflow-x-auto px-6 pb-1 [mask-image:linear-gradient(to_right,transparent_0,black_1.5rem,black_calc(100%-2.5rem),transparent_100%)] sm:mx-0 sm:overflow-visible sm:px-0 sm:[mask-image:none]"
    >
      <ul className="flex items-center gap-1 rounded-full bg-ink/[0.05] p-1">
        {tabs.map((tab) => {
          const active =
            pathname === tab.href ||
            (tab.href !== tabs[0]?.href && pathname.startsWith(tab.href + "/"));
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-all duration-200",
                  active
                    ? "bg-panel text-ink-900 shadow-sm ring-1 ring-ink/[0.06]"
                    : "text-ink/60 hover:text-ink-900",
                ].join(" ")}
              >
                <LinkSpinner className="h-3.5 w-3.5" />
                {tab.label}
                {tab.count !== null ? (
                  <span
                    className={[
                      "text-[11px] font-medium tabular-nums",
                      active ? "text-ink/40" : "text-ink/35",
                    ].join(" ")}
                  >
                    {tab.count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
