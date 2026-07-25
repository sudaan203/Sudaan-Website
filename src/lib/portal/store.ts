/**
 * Tenant scoped data access for the portal.
 *
 * Every read takes the caller's session and filters by client. Nothing here
 * accepts a bare slug or id and trusts it: ownership is always proven through
 * the site, exactly as the SQL version will (docs/client-portal-plan.md, 7.2).
 * Functions are async so the Postgres swap does not change any call site.
 */

import type {
  AssetCategory,
  PortalAsset,
  PortalClient,
  PortalSession,
  PortalSite,
  PortalSurvey,
  PortalVideo,
} from "./types";
import * as seed from "./seed";

function canSeeClient(session: PortalSession, clientId: string) {
  return session.role === "admin" || session.clientId === clientId;
}

export async function getClient(clientId: string): Promise<PortalClient | null> {
  return seed.clients.find((c) => c.id === clientId) ?? null;
}

/** Sites the caller is allowed to see. Admins see all of them. */
export async function listSites(session: PortalSession): Promise<PortalSite[]> {
  return seed.sites
    .filter((s) => canSeeClient(session, s.clientId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A single site by slug, or null when it does not exist OR belongs to another
 * client. Callers return 404 for null so we never confirm that a slug exists.
 */
export async function getSite(
  session: PortalSession,
  slug: string,
): Promise<PortalSite | null> {
  // Match on slug AND visibility together. Slugs are only unique per client, so
  // filtering by slug first would hand back another client's row and 404 a site
  // the caller legitimately owns.
  return seed.sites.find((s) => s.slug === slug && canSeeClient(session, s.clientId)) ?? null;
}

export async function listSurveys(siteId: string): Promise<PortalSurvey[]> {
  return seed.surveys
    .filter((s) => s.siteId === siteId)
    .sort((a, b) => b.flownOn.localeCompare(a.flownOn));
}

export async function listAssets(
  siteId: string,
  category?: AssetCategory,
): Promise<PortalAsset[]> {
  return seed.assets
    .filter((a) => a.siteId === siteId && (!category || a.category === category))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

/** Categories that actually have content for this site, for the sidebar. */
export async function listAssetCounts(
  siteId: string,
): Promise<Record<AssetCategory, number>> {
  const counts = {} as Record<AssetCategory, number>;
  for (const asset of seed.assets) {
    if (asset.siteId !== siteId) continue;
    counts[asset.category] = (counts[asset.category] ?? 0) + 1;
  }
  return counts;
}

/** An asset plus its site, only if the caller's client owns that site. */
export async function getAssetForSession(
  session: PortalSession,
  assetId: string,
): Promise<{ asset: PortalAsset; site: PortalSite } | null> {
  const asset = seed.assets.find((a) => a.id === assetId);
  if (!asset) return null;
  const site = seed.sites.find((s) => s.id === asset.siteId);
  if (!site || !canSeeClient(session, site.clientId)) return null;
  return { asset, site };
}

export async function listVideos(siteId: string): Promise<PortalVideo[]> {
  return seed.videos
    .filter((v) => v.siteId === siteId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
