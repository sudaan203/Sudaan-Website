import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/portal/auth";
import { listAssetCounts, getSite, listSurveys } from "@/lib/portal/store";
import { logPortalEvent } from "@/lib/portal/log";
import { assetCategories } from "@/lib/portal/types";
import ViewOnlyNote from "@/components/portal/ViewOnlyNote";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default async function SiteOverview({
  params,
}: {
  params: Promise<{ siteSlug: string }>;
}) {
  const { siteSlug } = await params;
  const session = await requireSession(`/portal/${siteSlug}`);
  const site = await getSite(session, siteSlug);
  if (!site) notFound();

  logPortalEvent("view_site", {
    userId: session.userId,
    clientId: session.clientId,
    site: site.slug,
  });

  const surveys = await listSurveys(site.id);
  const counts = await listAssetCounts(session, site.id);
  const available = assetCategories.filter((c) => (counts[c.key] ?? 0) > 0);

  const facts = [
    { label: "Location", value: site.location },
    { label: "District", value: site.district },
    { label: "State", value: site.state },
    { label: "Area surveyed", value: site.areaLabel },
    { label: "Sector", value: site.industry },
    {
      label: "Status",
      value: site.status === "in_progress" ? "In progress" : "Delivered",
    },
  ].filter((f) => Boolean(f.value));

  return (
    <div className="space-y-8">
      <section className="surface p-6 sm:p-8">
        <h2 className="text-lg font-semibold text-ink-900">Site summary</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink/75">{site.summary}</p>

        <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-xs font-semibold uppercase tracking-wider text-ink/50">
                {fact.label}
              </dt>
              <dd className="mt-1 text-sm text-ink-900">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {surveys.length > 0 ? (
        <section className="surface p-6 sm:p-8">
          <h2 className="text-lg font-semibold text-ink-900">Acquisitions</h2>
          <ul className="mt-4 divide-y divide-ink/[0.08]">
            {surveys.map((survey) => (
              <li key={survey.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                <span className="text-sm font-semibold text-ink-900">{survey.label}</span>
                <span className="text-sm text-ink/70">{formatDate(survey.flownOn)}</span>
                {survey.notes ? (
                  <span className="w-full text-xs text-ink/60">{survey.notes}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="mb-4 text-lg font-semibold text-ink-900">Available deliverables</h2>
        {available.length === 0 ? (
          <div className="surface p-6">
            <p className="text-sm text-ink/70">
              Deliverables for this site are still being prepared.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {available.map((category) => (
              <Link
                key={category.key}
                href={`/portal/${site.slug}/${category.slug}`}
                className="surface surface-hover group p-5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-semibold text-ink-900 group-hover:text-accent-700">
                    {category.label}
                  </h3>
                  <span className="text-xs font-semibold text-ink/50">
                    {counts[category.key]} item{counts[category.key] === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-2 text-sm text-ink/70">{category.blurb}</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <ViewOnlyNote />
    </div>
  );
}
