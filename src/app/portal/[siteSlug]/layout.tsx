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

  return (
    <div className="container-px flex-1 py-8 sm:py-10">
      <Link
        href="/portal"
        // -ml-2 keeps the text optically aligned with the heading below while the
        // padding gives the link a target that clears 24px. It was 63x16, which is
        // a small thing to hit on a phone and the only way back to the site list.
        className="mb-4 -ml-2 inline-flex min-h-6 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-ink/60 transition-colors hover:bg-ink/[0.04] hover:text-accent-600"
      >
        <span aria-hidden>&larr;</span> All sites
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
          {site.name}
        </h1>
        <p className="mt-2 text-sm text-ink/70">
          {[site.location, site.district, site.state].filter(Boolean).join(", ")}
        </p>
      </div>

      <div className="flex flex-col gap-8 lg:flex-row">
        <SiteTabs tabs={tabs} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
