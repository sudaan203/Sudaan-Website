/**
 * Seed file backed implementation of the portal store (Phase 1).
 *
 * Used whenever DATABASE_URL is absent, so the portal keeps working with no
 * database at all. The Postgres implementation in store-sql.ts is the same shape,
 * and store.ts picks between them.
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
  return session.role !== "client" || session.clientId === clientId;
}

export async function getClient(clientId: string): Promise<PortalClient | null> {
  return seed.clients.find((c) => c.id === clientId) ?? null;
}

export async function listSites(session: PortalSession): Promise<PortalSite[]> {
  return seed.sites
    .filter((s) => canSeeClient(session, s.clientId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Matches on slug AND visibility together. Slugs are only unique per client, so
 * filtering by slug first would hand back another client's row and 404 a site the
 * caller legitimately owns.
 */
export async function getSite(
  session: PortalSession,
  slug: string,
): Promise<PortalSite | null> {
  return seed.sites.find((s) => s.slug === slug && canSeeClient(session, s.clientId)) ?? null;
}

export async function listSurveys(siteId: string): Promise<PortalSurvey[]> {
  return seed.surveys
    .filter((s) => s.siteId === siteId)
    .sort((a, b) => b.flownOn.localeCompare(a.flownOn));
}

export async function listAssets(
  _session: PortalSession,
  siteId: string,
  category?: AssetCategory,
): Promise<PortalAsset[]> {
  return seed.assets
    .filter((a) => a.siteId === siteId && (!category || a.category === category))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

export async function listAssetCounts(
  _session: PortalSession,
  siteId: string,
): Promise<Record<AssetCategory, number>> {
  const counts = {} as Record<AssetCategory, number>;
  for (const asset of seed.assets) {
    if (asset.siteId !== siteId) continue;
    counts[asset.category] = (counts[asset.category] ?? 0) + 1;
  }
  return counts;
}

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

export async function listVideos(
  _session: PortalSession,
  siteId: string,
): Promise<PortalVideo[]> {
  return seed.videos
    .filter((v) => v.siteId === siteId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
