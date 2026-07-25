import Link from "next/link";
import { requireSession } from "@/lib/portal/auth";
import { getClient, listAssetCounts, listSites, listSurveys } from "@/lib/portal/store";
import { queryDb } from "@/lib/portal/db/client";
import { categoryByKey, type AssetCategory } from "@/lib/portal/types";

/** Fail fast instead of hanging at Vercel's 300 second ceiling. */
export const maxDuration = 30;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default async function PortalDashboard() {
  const session = await requireSession();

  // Wrapped as one unit so a pooled connection that died between requests costs
  // a reconnect rather than an error page. See queryDb.
  const { client, cards } = await queryDb("portal dashboard", async () => {
    const sites = await listSites(session);
    return {
      client: session.clientId ? await getClient(session.clientId) : null,
      cards: await Promise.all(
        sites.map(async (site) => ({
          site,
          surveys: await listSurveys(site.id),
          counts: await listAssetCounts(session, site.id),
          owner: session.role === "admin" ? await getClient(site.clientId) : null,
        })),
      ),
    };
  });

  return (
    <div className="container-px py-10 sm:py-14">
      <div className="mb-10">
        <span className="eyebrow">
          {session.role === "admin" ? "Admin view" : (client?.name ?? "Your account")}
        </span>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
          Your sites
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink/70">
          Every site we have surveyed and processed for you. Open a site to view
          its reports, drawings and imagery in the browser.
        </p>
      </div>

      {session.role === "client" && !session.clientId ? (
        // Signed in, but no owner has attached this person to a client yet.
        <div className="surface p-8 text-center">
          <h2 className="text-lg font-semibold text-ink-900">Your account is not linked yet</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-ink/70">
            You are signed in as {session.email}, but this account has not been
            connected to a project yet. Send that email address to your Sudaan
            Geo-Analytics contact and they will give it access. Nothing else is
            needed from you, and this page will show your sites once they do.
          </p>
        </div>
      ) : cards.length === 0 ? (
        <div className="surface p-8 text-center">
          <p className="text-sm text-ink/70">
            No sites have been published to your account yet. We will let you know
            as soon as your first deliverables are ready.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ site, surveys, counts, owner }) => {
            const available = (Object.keys(counts) as AssetCategory[]).filter(
              (key) => counts[key] > 0,
            );
            return (
              <Link
                key={site.id}
                href={`/portal/${site.slug}`}
                className="surface surface-hover group flex flex-col p-6"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-semibold leading-snug text-ink-900 group-hover:text-accent-700">
                    {site.name}
                  </h2>
                  <span className="shrink-0 rounded-full bg-accent-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-accent-700">
                    {site.status === "in_progress" ? "In progress" : site.status}
                  </span>
                </div>

                {owner ? (
                  <p className="mt-1 text-xs font-semibold text-signal">{owner.name}</p>
                ) : null}

                <p className="mt-2 text-sm text-ink/70">{site.location}</p>

                <dl className="mt-4 space-y-1 text-xs text-ink/60">
                  {site.areaLabel ? (
                    <div className="flex gap-2">
                      <dt className="font-semibold text-ink/70">Area</dt>
                      <dd>{site.areaLabel}</dd>
                    </div>
                  ) : null}
                  {surveys[0] ? (
                    <div className="flex gap-2">
                      <dt className="font-semibold text-ink/70">Surveyed</dt>
                      <dd>{formatDate(surveys[0].flownOn)}</dd>
                    </div>
                  ) : null}
                </dl>

                {available.length > 0 ? (
                  <div className="mt-5 flex flex-wrap gap-1.5">
                    {available.map((key) => (
                      <span
                        key={key}
                        className="rounded-full border border-ink/10 bg-paper px-2.5 py-1 text-[11px] font-medium text-ink/70"
                      >
                        {categoryByKey(key).label} {counts[key]}
                      </span>
                    ))}
                  </div>
                ) : null}

                <span className="mt-6 text-sm font-semibold text-accent-600 group-hover:text-accent-700">
                  Open site
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
