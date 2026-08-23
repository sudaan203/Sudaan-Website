import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/portal/auth";
import { listAssetCounts, getSite, listVideos } from "@/lib/portal/store";
import { logPortalEvent } from "@/lib/portal/log";
import SiteTabs from "@/components/portal/SiteTabs";
import { readMapManifest } from "@/lib/portal/map-data";
import { assetCategories } from "@/lib/portal/types";

export default async function SiteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ siteSlug: string }>;
}) {
  const { siteSlug } = await params;
  const session = await requireSession(`/portal/${siteSlug}`);

  // getSite returns null both for "does not exist" and "belongs to another
  // client", and we answer 404 either way so a slug is never confirmed.
  const site = await getSite(session, siteSlug);
  if (!site) {
    logPortalEvent("denied", { userId: session.userId, site: siteSlug });
    notFound();
  }

  const counts = await listAssetCounts(session, site.id);
  const videos = await listVideos(session, site.id);

  const mapManifest = await readMapManifest(site.slug);

  const tabs = [
    { href: `/portal/${site.slug}`, label: "Overview", count: null as number | null },
    // Straight after Overview: for a survey client the map is the deliverable,
    // and the file lists are the supporting material.
    ...(mapManifest && mapManifest.layers.length > 0
      ? [
          {
            href: `/portal/${site.slug}/map`,
            label: "Map",
            count: mapManifest.layers.length,
          },
        ]
      : []),
    ...assetCategories
      .filter((category) => (counts[category.key] ?? 0) > 0)
      .map((category) => ({
        href: `/portal/${site.slug}/${category.slug}`,
        label: category.label,
        count: counts[category.key] ?? 0,
      })),
    ...(videos.length > 0
      ? [{ href: `/portal/${site.slug}/videos`, label: "Video", count: videos.length }]
      : []),
  ];

  /*
   * The site header is one band, not three stacked blocks.
   *
   * It used to be a back link, then a title block with 2rem of margin, then a
   * 224px left column of section links. On the map page — which is the product —
   * that pushed the canvas 590px down a 1000px screen, so the thing a client came
   * to look at started below the fold with a sliver visible.
   *
   * Now: the back link and title share a line with the section nav on the right,
   * and the nav is horizontal. That returns roughly 200px of height and the whole
   * left column to the content, which the map spends and every other page enjoys
   * as full width.
   */
  return (
    <div className="container-px flex flex-1 flex-col py-5 sm:py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <Link
            href="/portal"
            // -ml-2 keeps the text optically aligned with the heading below while
            // the padding gives the link a target that clears 24px. It was 63x16,
            // a small thing to hit on a phone and the only way back to the list.
            className="-ml-2 mb-1 inline-flex min-h-6 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-ink/55 transition-colors hover:bg-ink/[0.04] hover:text-accent-600"
          >
            <span aria-hidden>&larr;</span> All sites
          </Link>
          <h1 className="truncate text-2xl font-bold tracking-tight text-ink-900 sm:text-[1.75rem]">
            {site.name}
          </h1>
        {/*
          Deduplicated, because these three fields overlap in the data: Kotba's
          `location` is already "Kotba, Gandhinagar, Gujarat", so joining all
          three printed "Kotba, Gandhinagar, Gujarat, Gandhinagar, Gujarat".
          Matching on the parts rather than the whole strings, since the overlap
          is per place name.
        */}
        <p className="mt-2 text-sm text-ink/70">
          {[
            ...new Set(
              [site.location, site.district, site.state]
                .filter(Boolean)
                .flatMap((part) => String(part).split(",").map((s) => s.trim()))
                .filter(Boolean),
            ),
          ].join(", ")}
        </p>
        </div>

        <SiteTabs tabs={tabs} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
