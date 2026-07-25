import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/portal/auth";
import { getAssetForSession, getSite } from "@/lib/portal/store";
import { categoryBySlug } from "@/lib/portal/types";
import AssetViewer from "@/components/portal/AssetViewer";
import ViewOnlyNote from "@/components/portal/ViewOnlyNote";

export default async function AssetPage({
  params,
}: {
  params: Promise<{ siteSlug: string; category: string; assetId: string }>;
}) {
  const { siteSlug, category: categorySlug, assetId } = await params;
  const session = await requireSession(`/portal/${siteSlug}/${categorySlug}/${assetId}`);

  const site = await getSite(session, siteSlug);
  if (!site) notFound();

  const category = categoryBySlug(categorySlug);
  if (!category) notFound();

  const found = await getAssetForSession(session, assetId);
  // Confirm the asset really belongs to the site AND the category in the URL, so
  // there is exactly one valid address for every asset.
  if (!found || found.site.id !== site.id || found.asset.category !== category.key) {
    notFound();
  }

  const { asset } = found;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/portal/${site.slug}/${category.slug}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink/60 transition-colors hover:text-accent-600"
        >
          <span aria-hidden>&larr;</span> {category.label}
        </Link>
        <h2 className="mt-3 text-lg font-semibold text-ink-900">{asset.title}</h2>
        {asset.description ? (
          <p className="mt-1 text-sm text-ink/70">{asset.description}</p>
        ) : null}
      </div>

      <AssetViewer
        src={`/api/portal/assets/${asset.id}/view`}
        title={asset.title}
        mimeType={asset.mimeType}
      />

      <ViewOnlyNote />
    </div>
  );
}
