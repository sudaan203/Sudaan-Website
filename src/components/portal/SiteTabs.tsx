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
     * On a phone this is a horizontally scrolling row, and there was nothing to
     * say so: the last tab sat flush against the edge looking like the end of the
     * list rather than the start of an overflow. The mask fades the right edge, so
     * a cut off tab reads as "there is more this way".
     *
     * Implemented as a mask rather than a gradient overlay because the row scrolls
     * under it; an opaque overlay would need to match the page background, and this
     * page has two of them.
     */
    <nav
      aria-label="Site sections"
      className="-mx-6 shrink-0 overflow-x-auto px-6 pb-2 [mask-image:linear-gradient(to_right,transparent_0,black_1.5rem,black_calc(100%-2.5rem),transparent_100%)] lg:mx-0 lg:w-56 lg:overflow-visible lg:px-0 lg:pb-0 lg:[mask-image:none]"
    >
      <ul className="flex gap-2 lg:flex-col lg:gap-1">
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
                  "flex items-center justify-between gap-3 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent-600 text-white shadow-glow"
                    : "border border-ink/10 bg-panel text-ink/80 hover:border-accent/40 hover:text-accent-700 lg:border-transparent lg:bg-transparent",
                ].join(" ")}
              >
                <span className="flex items-center gap-2">
                  <LinkSpinner className="h-3.5 w-3.5" />
                  {tab.label}
                </span>
                {tab.count !== null ? (
                  <span
                    className={[
                      "rounded-full px-1.5 text-[11px] font-semibold",
                      active ? "bg-white/20 text-white" : "bg-paper text-ink/50",
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
