export type CatalogueItem = {
  name: string;
  blurb: string;
  icon: string;
};

export type ServiceCategory = {
  key: string;
  title: string;
  description: string;
  icon: string;
  items: CatalogueItem[];
};

export const serviceCategories: ServiceCategory[] = [
  {
    key: "field-survey",
    title: "Field Survey Services",
    description:
      "Precision ground and aerial data acquisition for engineering and planning.",
    icon: "survey",
    items: [
      {
        name: "Topographical Survey",
        blurb: "Detailed terrain, feature and level surveys for design.",
        icon: "dtm",
      },
      {
        name: "DGPS Survey",
        blurb: "Differential GNSS control and high-accuracy positioning.",
        icon: "gps",
      },
      {
        name: "Contour Survey",
        blurb: "Field-measured contours at engineering intervals.",
        icon: "contour",
      },
      {
        name: "Highway & Railway Alignment Survey",
        blurb: "Corridor surveys and alignment data for transport routes.",
        icon: "corridor",
      },
      {
        name: "Pipeline Route Survey",
        blurb: "Route mapping and cross-sections for pipeline design.",
        icon: "pipeline",
      },
      {
        name: "Flood Mapping",
        blurb: "Inundation extents and flood-risk terrain analysis.",
        icon: "flood",
      },
      {
        name: "Mining & Quarry Survey",
        blurb: "Pit, bench and stockpile surveys for operations.",
        icon: "mine",
      },
      {
        name: "Construction Progress Monitoring",
        blurb: "Periodic site capture, design-vs-as-built reporting.",
        icon: "progress",
      },
      {
        name: "Infrastructure Inspection",
        blurb: "High-resolution asset and structure condition capture.",
        icon: "inspect",
      },
      {
        name: "Smart City GIS Mapping",
        blurb: "Urban basemaps and layered GIS for smart cities.",
        icon: "gis",
      },
    ],
  },
  {
    key: "data-processing",
    title: "Advanced Data Processing Services",
    description:
      "Turning raw capture into engineering-grade geospatial deliverables.",
    icon: "scan",
    items: [
      {
        name: "LiDAR Survey & Mapping",
        blurb: "Airborne LiDAR acquisition and classified deliverables.",
        icon: "lidar",
      },
      {
        name: "Industrial LiDAR & 3D Laser Scanning",
        blurb: "Terrestrial scanning for plants, structures and as-builts.",
        icon: "scan",
      },
      {
        name: "Terrain Modeling (DSM / DTM)",
        blurb: "Surface and bare-earth elevation models.",
        icon: "dsm",
      },
      {
        name: "Orthomosaic Generation",
        blurb: "Georeferenced, distortion-corrected basemaps.",
        icon: "ortho",
      },
      {
        name: "Point Cloud Processing",
        blurb: "Cleaned, classified, colourised 3D point clouds.",
        icon: "pointcloud",
      },
      {
        name: "Contour Extraction",
        blurb: "CAD-ready contours derived from terrain models.",
        icon: "contour",
      },
      {
        name: "Geospatial Data Processing",
        blurb: "End-to-end processing pipelines with rigorous QA.",
        icon: "gis",
      },
      {
        name: "GIS Database Creation",
        blurb: "Structured, standards-compliant spatial databases.",
        icon: "database",
      },
      {
        name: "Volumetric Analysis",
        blurb: "Stockpile and earthwork volume computation.",
        icon: "volume",
      },
      {
        name: "Cut & Fill Analysis",
        blurb: "Auditable earthworks balance and grading reports.",
        icon: "volume",
      },
    ],
  },
  {
    key: "utility-infra",
    title: "Utility & Infrastructure Services",
    description:
      "Specialised mapping for energy and utility networks.",
    icon: "power",
    items: [
      {
        name: "Solar Plant Survey",
        blurb: "Grading, layout and yield-support mapping for solar.",
        icon: "solar",
      },
      {
        name: "Transmission Line Survey",
        blurb: "Conductor, tower and clearance corridor analysis.",
        icon: "transmission",
      },
      {
        name: "Windmill Survey",
        blurb: "Site assessment and access mapping for wind farms.",
        icon: "wind",
      },
      {
        name: "Utility Corridor Mapping",
        blurb: "Linear utility corridors and encroachment checks.",
        icon: "corridor",
      },
      {
        name: "Power Infrastructure Mapping",
        blurb: "Network asset mapping for power infrastructure.",
        icon: "power",
      },
    ],
  },
  {
    key: "environmental",
    title: "Environmental Services",
    description:
      "Remote-sensing analytics for land, vegetation and water.",
    icon: "forest",
    items: [
      {
        name: "Forest Mapping",
        blurb: "Canopy extent, density and change over time.",
        icon: "forest",
      },
      {
        name: "Vegetation Analysis",
        blurb: "NDVI and multispectral vegetation health insights.",
        icon: "leaf",
      },
      {
        name: "Land Use Land Cover Classification",
        blurb: "Automated LULC classification and mapping.",
        icon: "landcover",
      },
      {
        name: "Watershed Analysis",
        blurb: "Catchments, flow paths and drainage modelling.",
        icon: "watershed",
      },
    ],
  },
];
