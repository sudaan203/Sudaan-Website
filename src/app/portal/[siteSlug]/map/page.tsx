import { notFound } from "next/navigation";
import { requireSession } from "@/lib/portal/auth";
import { getSite } from "@/lib/portal/store";
import { readMapManifest } from "@/lib/portal/map-data";
import { logPortalEvent } from "@/lib/portal/log";
import MapViewer from "@/components/portal/MapViewer";
import ViewOnlyNote from "@/components/portal/ViewOnlyNote";

export const maxDuration = 30;

export default async function SiteMapPage({
  params,
}: {
  params: Promise<{ siteSlug: string }>;
}) {
  const { siteSlug } = await params;
  const session = await requireSession(`/portal/${siteSlug}/map`);

  const site = await getSite(session, siteSlug);
  if (!site) notFound();

  const manifest = await readMapManifest(siteSlug);

  logPortalEvent("view_map", {
    userId: session.userId,
    clientId: session.clientId,
    site: site.slug,
    layers: manifest?.layers.length ?? 0,
  });

  if (!manifest || manifest.layers.length === 0) {
    return (
      <div className="surface p-6">
        <h2 className="text-lg font-semibold text-ink-900">Survey map</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink/70">
          There are no georeferenced layers published for this site yet. When the
          surface model, terrain model and contours are ready they appear here as
          a map you can pan, zoom and fade between.
        </p>
      </div>
    );
  }

  /*
   * No heading and no paragraph above the map any more.
   *
   * They cost 90px of a screen whose entire purpose is the canvas below them, and
   * they described controls that are visible three inches away. What was worth
   * keeping — that these are real layers drawn over each other, and that a
   * contour gives up its height — now lives inside the map as a hint that
   * dismisses itself once a tool is used.
   */
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <MapViewer siteSlug={site.slug} siteName={site.name} layers={manifest.layers} />
      <ViewOnlyNote />
    </div>
  );
}
