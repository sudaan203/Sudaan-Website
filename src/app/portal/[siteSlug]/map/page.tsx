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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">Survey map</h2>
        <p className="mt-1 text-sm text-ink/70">
          Every georeferenced layer we produced for this site, drawn over each
          other. Toggle a layer, fade it with its slider, and hover a contour to
          read its height.
        </p>
      </div>

      <MapViewer siteSlug={site.slug} siteName={site.name} layers={manifest.layers} />

      <ViewOnlyNote />
    </div>
  );
}
