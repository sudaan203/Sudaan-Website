import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/portal/auth";
import { getSite, listAssets } from "@/lib/portal/store";
import { categoryBySlug } from "@/lib/portal/types";
import ViewOnlyNote from "@/components/portal/ViewOnlyNote";

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ siteSlug: string; category: string }>;
}) {
  const { siteSlug, category: categorySlug } = await params;
  const session = await requireSession(`/portal/${siteSlug}/${categorySlug}`);

  const site = await getSite(session, siteSlug);
  if (!site) notFound();

  const category = categoryBySlug(categorySlug);
  if (!category) notFound();

  const assets = await listAssets(session, site.id, category.key);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">{category.label}</h2>
        <p className="mt-1 text-sm text-ink/70">{category.blurb}</p>
      </div>

      {assets.length === 0 ? (
        <div className="surface p-6">
          <p className="text-sm text-ink/70">Nothing published in this section yet.</p>
        </div>
      ) : category.layout === "gallery" ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((asset) => (
            <li key={asset.id}>
              <Link
                href={`/portal/${site.slug}/${category.slug}/${asset.id}`}
                className="surface surface-hover group block overflow-hidden"
              >
                {/*
                  Plain img, not next/image: the optimizer would cache client
                  imagery on a shared CDN, and this data is private.
                */}
                <span className="block aspect-[4/3] overflow-hidden bg-mist">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/portal/assets/${asset.id}/view`}
                    alt={asset.title}
                    loading="lazy"
                    draggable={false}
                    className="h-full w-full select-none object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                </span>
                <span className="block p-4">
                  <span className="block text-sm font-semibold text-ink-900 group-hover:text-accent-700">
                    {asset.title}
                  </span>
                  {asset.description ? (
                    <span className="mt-1 block text-xs text-ink/60">{asset.description}</span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="surface divide-y divide-ink/[0.08] overflow-hidden">
          {assets.map((asset) => (
            <li key={asset.id}>
              <Link
                href={`/portal/${site.slug}/${category.slug}/${asset.id}`}
                className="group flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-accent-50/50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink-900 group-hover:text-accent-700">
                    {asset.title}
                  </span>
                  {asset.description ? (
                    <span className="mt-0.5 block text-xs text-ink/60">{asset.description}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs font-semibold text-accent-600 group-hover:text-accent-700">
                  View
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <ViewOnlyNote />
    </div>
  );
}
