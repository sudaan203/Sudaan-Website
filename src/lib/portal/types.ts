/**
 * Shared types for the client data portal.
 *
 * The portal is deliberately read only: clients view deliverables in the
 * browser, they never get a download link. See docs/client-portal-plan.md.
 */

import type { SiteVerticalAccuracy } from "./accuracy.mjs";

/**
 * "owner" is the Google era name for Sudaan staff. "admin" is the Phase 1 name and
 * means the same thing; it is still accepted so password logins keep working
 * during the switchover. Everything that branches on this treats non-client as
 * owner, see store-sql.ts viewerFor.
 */
export type PortalRole = "owner" | "admin" | "client";

/**
 * The only correct way to ask "is this Sudaan staff?".
 *
 * Comparing against "admin" alone silently excludes every Google owner, and
 * comparing against "owner" alone excludes the transitional password logins.
 * The dashboard had the first bug: owners saw a client's greeting and no
 * indication of which client each site belonged to.
 */
export function isOwnerRole(role: PortalRole): boolean {
  return role !== "client";
}

export type AssetCategory =
  | "report"
  | "drawing"
  | "photo"
  | "uav_dgps"
  | "lidar"
  | "control_area"
  | "misc";

/** A password login (transitional). Google users live in the database instead. */
export type PortalUser = {
  id: string;
  email: string;
  fullName: string;
  role: PortalRole;
  /** null for admins, who can see every client. */
  clientId: string | null;
  passwordHash: string;
};

/** The signed payload we keep in the session cookie. Never includes the hash. */
export type PortalSession = {
  userId: string;
  email: string;
  fullName: string;
  role: PortalRole;
  clientId: string | null;
  /** How this session was obtained. Only Google sessions are re-checked against the database. */
  via?: "google" | "password";
};

export type PortalClient = {
  id: string;
  slug: string;
  name: string;
};

/**
 * A figure from a survey's own checkpoint report, or absent.
 *
 * Re-exported from accuracy.mjs rather than redeclared, so the shape the
 * database stores, the shape the store hands out and the shape the wording is
 * built from cannot drift apart.
 */
export type { SiteVerticalAccuracy };

/** A surveyed project. Equivalent of a "Monument" in the reference portal. */
export type PortalSite = {
  id: string;
  clientId: string;
  slug: string;
  name: string;
  location: string;
  district?: string;
  state?: string;
  areaLabel?: string;
  industry?: string;
  status: "in_progress" | "delivered" | "archived";
  summary: string;
  /**
   * This survey's measured vertical accuracy, or null when no checkpoint report
   * has been supplied — which is true of every site published so far.
   *
   * Nullable on purpose and never defaulted here. Everything that needs a number
   * goes through `surveyAccuracy()`, which is the only place allowed to reach
   * for the company's typical figure and the only place that labels it as one.
   */
  verticalAccuracy?: SiteVerticalAccuracy | null;
};

/** One flight or acquisition campaign for a site. */
export type PortalSurvey = {
  id: string;
  siteId: string;
  label: string;
  flownOn: string; // ISO date
  notes?: string;
};

/** A viewable file. storageKey is a path under portal-data/files, never a URL. */
export type PortalAsset = {
  id: string;
  siteId: string;
  surveyId?: string;
  category: AssetCategory;
  title: string;
  fileName: string;
  storageKey: string;
  mimeType: string;
  description?: string;
  sortOrder: number;
};

export type PortalVideo = {
  id: string;
  siteId: string;
  title: string;
  youtubeId: string;
  kind: "front_view" | "360_view" | "walkthrough" | "other";
  sortOrder: number;
};

/** Tab metadata, drives the site sidebar and the [category] route. */
export const assetCategories: {
  key: AssetCategory;
  slug: string;
  label: string;
  blurb: string;
  layout: "list" | "gallery";
}[] = [
  {
    key: "report",
    slug: "reports",
    label: "Reports",
    blurb: "Survey reports and analysis documents for this site.",
    layout: "list",
  },
  {
    key: "drawing",
    slug: "drawings",
    label: "Drawings & Maps",
    blurb: "Plans, elevations, contour sheets and map outputs.",
    layout: "list",
  },
  {
    key: "photo",
    slug: "photos",
    label: "Imagery",
    blurb: "Processed layer previews and site photography.",
    layout: "gallery",
  },
  {
    key: "uav_dgps",
    slug: "uav-dgps",
    label: "UAV & DGPS",
    blurb: "Flight and ground control documentation.",
    layout: "list",
  },
  {
    key: "lidar",
    slug: "lidar",
    label: "LiDAR",
    blurb: "LiDAR derived deliverables.",
    layout: "list",
  },
  {
    key: "control_area",
    slug: "control-area",
    label: "Control Area",
    blurb: "Control points and digitisation sheets.",
    layout: "list",
  },
  {
    key: "misc",
    slug: "data",
    label: "Other Data",
    blurb: "Everything else delivered for this site.",
    layout: "list",
  },
];

export function categoryBySlug(slug: string) {
  return assetCategories.find((c) => c.slug === slug);
}

export function categoryByKey(key: AssetCategory) {
  return assetCategories.find((c) => c.key === key)!;
}
