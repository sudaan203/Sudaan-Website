export type Service = {
  slug: string;
  title: string;
  short: string;
  description: string;
  outcomes: string[];
  icon: string; // key for IconLibrary
};

export const services: Service[] = [
  {
    slug: "orthomosaic-generation",
    title: "Orthomosaic Generation",
    short:
      "High-resolution georeferenced orthomosaics for mapping and planning.",
    description:
      "We stitch thousands of overlapping aerial frames into a single, distortion-corrected, georeferenced map. Every pixel carries accurate real-world coordinates, giving planners a survey-grade basemap for measurement and design.",
    outcomes: [
      "Sub-2 cm ground sampling distance",
      "GCP-verified georeferencing",
      "GeoTIFF, ECW & web tile delivery",
    ],
    icon: "ortho",
  },
  {
    slug: "digital-surface-models",
    title: "Digital Surface Models (DSM)",
    short: "Surface representation including vegetation and structures.",
    description:
      "Our DSMs capture the true upper surface of a site, canopy, buildings, equipment and terrain, as a continuous elevation raster used for line-of-sight, drainage and clash analysis.",
    outcomes: [
      "Full above-ground elevation capture",
      "Raster & mesh outputs",
      "Drainage and shadow analysis ready",
    ],
    icon: "dsm",
  },
  {
    slug: "digital-terrain-models",
    title: "Digital Terrain Models (DTM)",
    short: "Accurate ground elevation extraction.",
    description:
      "By classifying and removing above-ground features, we deliver a bare-earth terrain model, the foundation for earthworks, hydrology and engineering design.",
    outcomes: [
      "Automated bare-earth classification",
      "Breakline enforcement",
      "Engineering-grade vertical accuracy",
    ],
    icon: "dtm",
  },
  {
    slug: "contour-mapping",
    title: "Contour Mapping",
    short: "Engineering-ready contour generation.",
    description:
      "Smoothed, labelled contour lines generated directly from terrain models at any interval, ready to drop into CAD and GIS workflows for design and permitting.",
    outcomes: [
      "Custom contour intervals",
      "CAD-ready DWG / DXF",
      "Index & intermediate labelling",
    ],
    icon: "contour",
  },
  {
    slug: "point-cloud-processing",
    title: "Point Cloud Processing",
    short: "Dense 3D reconstruction and visualization.",
    description:
      "Photogrammetric and LiDAR point clouds are cleaned, classified and colourised into rich 3D datasets for inspection, modelling and as-built documentation.",
    outcomes: [
      "Dense RGB-colourised clouds",
      "Semantic classification",
      "LAS / LAZ / E57 delivery",
    ],
    icon: "pointcloud",
  },
  {
    slug: "gis-data-analytics",
    title: "GIS Data Analytics",
    short: "Spatial analysis and decision support.",
    description:
      "We turn spatial layers into decisions, overlay analysis, suitability modelling, change detection and dashboards that surface the insight behind the map.",
    outcomes: [
      "Suitability & overlay modelling",
      "Change detection over time",
      "Interactive web dashboards",
    ],
    icon: "gis",
  },
  {
    slug: "volumetric-analysis",
    title: "Volumetric Analysis",
    short: "Cut-fill calculations and stockpile measurements.",
    description:
      "Precise volume computation for stockpiles, excavations and earthworks with auditable cut/fill reports to measure inventory and progress with confidence.",
    outcomes: [
      "Audit-ready cut/fill reports",
      "Stockpile inventory tracking",
      "Reference surface comparison",
    ],
    icon: "volume",
  },
  {
    slug: "construction-progress-monitoring",
    title: "Construction Progress Monitoring",
    short: "Periodic site monitoring and reporting.",
    description:
      "Recurring captures aligned to a single coordinate frame let you compare design vs. as-built, track schedule and share progress with every stakeholder.",
    outcomes: [
      "Design vs. as-built overlays",
      "Time-series progress reporting",
      "Stakeholder sharing portal",
    ],
    icon: "progress",
  },
  {
    slug: "corridor-mapping",
    title: "Corridor Mapping",
    short: "Road, railway, pipeline and transmission line analysis.",
    description:
      "Efficient linear capture and processing for long corridors, extracting alignments, cross-sections and clearance analysis for infrastructure design.",
    outcomes: [
      "Continuous corridor orthomosaics",
      "Cross-section extraction",
      "Clearance & encroachment checks",
    ],
    icon: "corridor",
  },
  {
    slug: "geospatial-intelligence",
    title: "Geospatial Intelligence",
    short: "Custom GIS solutions and spatial insights.",
    description:
      "Bespoke geospatial products, from custom analytics pipelines to integrated decision platforms, engineered around your operational questions.",
    outcomes: [
      "Custom analytics pipelines",
      "Integrated decision platforms",
      "API & data delivery",
    ],
    icon: "intel",
  },
];
