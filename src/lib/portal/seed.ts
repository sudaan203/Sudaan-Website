/**
 * Portal catalogue: clients, sites, surveys, assets and videos.
 *
 * This is the v1 store. It is a typed, read only seed so the portal can run on
 * the Vercel Hobby plan with no database and no paid services. Every function
 * in store.ts is async and tenant scoped, so replacing this file with Drizzle
 * plus Postgres later is a swap behind that interface, not a rewrite of the UI.
 * Schema to migrate to: docs/client-portal-plan.md section 5.
 *
 * Logins are NOT here. They live outside git, see users.ts.
 *
 * Client ids match the uuids that scripts/portal-db-seed.mjs writes to Postgres,
 * so one set of logins works against either backend during the migration.
 */

import type {
  PortalAsset,
  PortalClient,
  PortalSite,
  PortalSurvey,
  PortalVideo,
} from "./types";

export const clients: PortalClient[] = [
  { id: "11111111-1111-4111-8111-111111111111", slug: "demo-client", name: "Demo Client" },
  { id: "22222222-2222-4222-8222-222222222222", slug: "second-client", name: "Second Client" },
];

export const sites: PortalSite[] = [
  {
    id: "st_kotba",
    clientId: "11111111-1111-4111-8111-111111111111",
    slug: "kotba-survey",
    name: "Kotba Site Survey",
    location: "Kotba, Gujarat",
    district: "Gandhinagar",
    state: "Gujarat",
    areaLabel: "42 ha",
    industry: "Infrastructure",
    status: "delivered",
    summary:
      "UAV survey of the Kotba site with GCP controlled processing. Deliverables include a 3 cm orthomosaic, DSM, DTM and 0.5 m contours.",
  },
  {
    id: "st_aektanagar",
    clientId: "11111111-1111-4111-8111-111111111111",
    slug: "aektanagar-survey",
    name: "Aektanagar Site Survey",
    location: "Aektanagar, Gujarat",
    district: "Narmada",
    state: "Gujarat",
    areaLabel: "25.3 ha",
    industry: "Infrastructure",
    status: "delivered",
    summary:
      "UAV LiDAR and photogrammetric survey of the Aektanagar site. Deliverables include a 1.8 cm orthomosaic, surface and terrain models spanning 29.5 to 103.0 m, 1 m contours, a 5 m elevation grid and a 50.2 million point LiDAR cloud.",
  },
  {
    id: "st_ambaji",
    clientId: "22222222-2222-4222-8222-222222222222",
    slug: "ambaji-corridor",
    name: "Ambaji Corridor Survey",
    location: "Ambaji, Gujarat",
    district: "Banaskantha",
    state: "Gujarat",
    areaLabel: "18 ha",
    industry: "Infrastructure",
    status: "delivered",
    summary:
      "Corridor mapping for alignment studies. Present so we can prove that one client cannot reach another client's data.",
  },
];

export const surveys: PortalSurvey[] = [
  {
    id: "sv_kotba_1",
    siteId: "st_kotba",
    label: "Baseline flight",
    flownOn: "2024-05-03",
    notes: "DJI survey, 12 GCPs, RTK corrected.",
  },
  {
    id: "sv_aektanagar_1",
    siteId: "st_aektanagar",
    label: "Baseline flight",
    flownOn: "2024-07-20",
    notes: "UAV LiDAR and high-resolution RGB camera survey, 10 GCPs, RTK & PPK corrected.",
  },
  {
    id: "sv_ambaji_1",
    siteId: "st_ambaji",
    label: "Baseline flight",
    flownOn: "2024-06-19",
  },
];

export const assets: PortalAsset[] = [
  // ---- Demo Client, Kotba ----
  {
    id: "as_kotba_report_topo",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "report",
    title: "Topographic Survey Report",
    fileName: "topographic-survey.pdf",
    storageKey: "demo-client/kotba/reports/topographic-survey.pdf",
    mimeType: "application/pdf",
    description: "Methodology, control network, accuracy statement and outputs.",
    sortOrder: 1,
  },
  {
    id: "as_kotba_report_volume",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "report",
    title: "Volume Analysis Report",
    fileName: "volume-analysis.pdf",
    storageKey: "demo-client/kotba/reports/volume-analysis.pdf",
    mimeType: "application/pdf",
    description: "Cut and fill computation against the delivered DTM.",
    sortOrder: 2,
  },
  {
    id: "as_kotba_drawing_contour",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "drawing",
    title: "Contour Map, 0.5 m interval",
    fileName: "contour-map.pdf",
    storageKey: "demo-client/kotba/drawings/contour-map.pdf",
    mimeType: "application/pdf",
    sortOrder: 1,
  },
  {
    id: "as_kotba_drawing_ortho",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "drawing",
    title: "Orthomosaic Sheet, A1",
    fileName: "orthomosaic-sheet.pdf",
    storageKey: "demo-client/kotba/drawings/orthomosaic-sheet.pdf",
    mimeType: "application/pdf",
    sortOrder: 2,
  },
  {
    id: "as_kotba_img_ortho",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "photo",
    title: "Orthomosaic preview",
    fileName: "ortho.webp",
    storageKey: "demo-client/kotba/imagery/ortho.webp",
    mimeType: "image/webp",
    description: "True colour orthomosaic, 3 cm GSD.",
    sortOrder: 1,
  },
  {
    id: "as_kotba_img_dsm",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "photo",
    title: "DSM preview",
    fileName: "dsm.webp",
    storageKey: "demo-client/kotba/imagery/dsm.webp",
    mimeType: "image/webp",
    description: "Digital surface model, colourised with hillshade.",
    sortOrder: 2,
  },
  {
    id: "as_kotba_img_dtm",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "photo",
    title: "DTM preview",
    fileName: "dtm.webp",
    storageKey: "demo-client/kotba/imagery/dtm.webp",
    mimeType: "image/webp",
    description: "Bare earth terrain model.",
    sortOrder: 3,
  },
  {
    id: "as_kotba_img_contours",
    siteId: "st_kotba",
    surveyId: "sv_kotba_1",
    category: "photo",
    title: "Contours over orthomosaic",
    fileName: "contours.webp",
    storageKey: "demo-client/kotba/imagery/contours.webp",
    mimeType: "image/webp",
    sortOrder: 4,
  },

  // ---- Demo Client, Aektanagar ----
  {
    id: "as_aektanagar_report_topo",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "report",
    title: "Topographic Survey Report",
    fileName: "topographic-survey-report.pdf",
    storageKey: "demo-client/aektanagar/reports/topographic-survey-report.pdf",
    mimeType: "application/pdf",
    description: "Methodology, control network, accuracy statement and LiDAR deliverables summary.",
    sortOrder: 1,
  },
  {
    id: "as_aektanagar_drawing_contour",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "drawing",
    title: "Contour Map, 1 m interval",
    fileName: "contour-map.pdf",
    storageKey: "demo-client/aektanagar/drawings/contour-map.pdf",
    mimeType: "application/pdf",
    description:
      "108 contour lines from 30 to 97 m, index every 5 m, drawn to scale in UTM 43N.",
    sortOrder: 1,
  },
  {
    id: "as_aektanagar_drawing_grid",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "drawing",
    title: "Survey Elevation Grid (5m x 5m)",
    fileName: "Grid.csv",
    storageKey: "demo-client/aektanagar/drawings/Grid.csv",
    mimeType: "text/csv",
    description: "5m grid elevation point dataset exported in UTM 43N / WGS84.",
    sortOrder: 2,
  },
  {
    id: "as_aektanagar_img_ortho",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "photo",
    title: "Orthomosaic preview",
    fileName: "ortho.webp",
    storageKey: "demo-client/aektanagar/imagery/ortho.webp",
    mimeType: "image/webp",
    description: "True colour high-resolution orthomosaic (1.8 cm GSD).",
    sortOrder: 1,
  },
  {
    id: "as_aektanagar_img_dsm",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "photo",
    title: "DSM preview",
    fileName: "dsm.webp",
    storageKey: "demo-client/aektanagar/imagery/dsm.webp",
    mimeType: "image/webp",
    description: "Digital surface model, colourised with elevation gradient.",
    sortOrder: 2,
  },
  {
    id: "as_aektanagar_img_dtm",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "photo",
    title: "DTM preview",
    fileName: "dtm.webp",
    storageKey: "demo-client/aektanagar/imagery/dtm.webp",
    mimeType: "image/webp",
    description: "Bare earth digital terrain model.",
    sortOrder: 3,
  },
  {
    id: "as_aektanagar_img_contours",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "photo",
    title: "Contours over orthomosaic",
    fileName: "contours.webp",
    storageKey: "demo-client/aektanagar/imagery/contours.webp",
    mimeType: "image/webp",
    sortOrder: 4,
  },
  {
    id: "as_aektanagar_pointcloud",
    siteId: "st_aektanagar",
    surveyId: "sv_aektanagar_1",
    category: "lidar",
    title: "LiDAR Point Cloud, survey summary",
    fileName: "point-cloud-summary.pdf",
    storageKey: "demo-client/aektanagar/uav/point-cloud-summary.pdf",
    mimeType: "application/pdf",
    description:
      "50,183,644 points at 181.7 per m2, ground and unclassified returns, LAS 1.2. " +
      "Read from the file header. The cloud itself needs a point cloud viewer, which is not built yet.",
    sortOrder: 1,
  },

  // ---- Second Client, Ambaji (isolation test fixture) ----
  {
    id: "as_ambaji_report_topo",
    siteId: "st_ambaji",
    surveyId: "sv_ambaji_1",
    category: "report",
    title: "Topographic Survey Report",
    fileName: "topographic-survey.pdf",
    storageKey: "second-client/ambaji/reports/topographic-survey.pdf",
    mimeType: "application/pdf",
    sortOrder: 1,
  },
  {
    id: "as_ambaji_img_ortho",
    siteId: "st_ambaji",
    surveyId: "sv_ambaji_1",
    category: "photo",
    title: "Orthomosaic preview",
    fileName: "ortho.webp",
    storageKey: "second-client/ambaji/imagery/ortho.webp",
    mimeType: "image/webp",
    sortOrder: 1,
  },
];

/** No real uploads yet, so the Video tab stays hidden until this has rows. */
export const videos: PortalVideo[] = [];
