export type Industry =
  | "Infrastructure"
  | "Hydrology"
  | "Mining"
  | "Solar"
  | "Transmission"
  | "LiDAR"
  | "Forestry";

export type Project = {
  slug: string;
  name: string;
  location: string;
  industry: Industry;
  area: string;
  accuracy?: string;
  summary: string;
  deliverables: string[];
  outcome: string;
  insight: string;
  metrics: { label: string; value: string }[];
  image?: string; // real deliverable screenshot in /public/projects
};

export const industries: Industry[] = [
  "Infrastructure",
  "Hydrology",
  "Mining",
  "Solar",
  "Transmission",
  "LiDAR",
  "Forestry",
];

export const projects: Project[] = [
  /* ----------------------- Infrastructure ----------------------- */
  {
    slug: "ambaji-topographic-survey",
    name: "Ambaji Topographic Survey",
    location: "Ambaji, Gujarat",
    industry: "Infrastructure",
    area: "70 km²",
    accuracy: "99%",
    summary:
      "Comprehensive drone survey and terrain modelling for accurate topographic assessment to support the Ambaji Walkway planning and design.",
    deliverables: ["Orthomosaic", "Contours (1 m)", "DSM & DTM", "CAD Drawings"],
    insight:
      "High-accuracy terrain modelling enabled planners to identify elevation variations and optimize the alignment of the Ambaji Walkway with confidence.",
    outcome:
      "Achieved 99% survey accuracy and delivered complete datasets within 12 days, accelerating project planning and decision-making.",
    metrics: [
      { label: "Area surveyed", value: "70 km²" },
      { label: "GCPs", value: "280" },
      { label: "Accuracy", value: "99%" },
    ],
  },
  {
    slug: "reliance-multi-site-monitoring",
    name: "Reliance Multi-site Monitoring",
    location: "Gujarat · Maharashtra · Karnataka",
    industry: "Infrastructure",
    area: "5–20 ha / site",
    summary:
      "Drone mapping and digital site monitoring across multiple locations to enable centralized access and management of infrastructure assets.",
    deliverables: ["Orthomosaic", "Contours (1 m)", "DSM & DTM", "CAD Drawings"],
    insight:
      "Centralized geospatial datasets let project teams remotely monitor multiple sites across Gujarat, Maharashtra and Karnataka from a single location.",
    outcome:
      "Reduced field visits, accelerated decision-making and improved operational efficiency with real-time access to project sites across India.",
    metrics: [
      { label: "Sites", value: "30 / mo" },
      { label: "Area / site", value: "5–20 ha" },
      { label: "GCPs / site", value: "5" },
    ],
  },
  {
    slug: "vadnagar-town-survey",
    name: "Vadnagar Town Survey",
    location: "Vadnagar, Gujarat",
    industry: "Infrastructure",
    area: "20 km²",
    summary:
      "Large-scale urban drone survey and terrain mapping for detailed town planning and infrastructure development.",
    deliverables: ["Orthomosaic", "Contours (1 m)", "DSM & DTM", "CAD Drawings"],
    insight:
      "Detailed elevation and surface models supported accurate urban planning and infrastructure expansion strategies.",
    outcome:
      "Delivered high-resolution geospatial data that improved planning efficiency and reduced dependence on conventional field surveys.",
    metrics: [
      { label: "Area surveyed", value: "20 km²" },
      { label: "GCPs", value: "94" },
      { label: "Deliverables", value: "4" },
    ],
  },
  {
    slug: "gandhinagar-riverfront",
    name: "Gandhinagar Riverfront",
    location: "Gandhinagar, Gujarat",
    industry: "Infrastructure",
    area: "25 km corridor",
    summary:
      "Drone-based topographic survey and terrain modelling for riverfront development and landscape planning.",
    deliverables: ["Orthomosaic", "Contours (1 m)", "DSM & DTM", "CAD Drawings"],
    insight:
      "Accurate terrain and elevation information helped engineers understand slope patterns and optimize the riverfront design.",
    outcome:
      "Enabled faster planning and reduced survey timelines while maintaining engineering-grade accuracy.",
    metrics: [
      { label: "Corridor length", value: "25 km" },
      { label: "GCPs", value: "40" },
      { label: "State", value: "Gujarat" },
    ],
  },
  {
    slug: "navsari-infrastructure-survey",
    name: "Navsari Infrastructure Survey",
    location: "Navsari, Gujarat",
    industry: "Infrastructure",
    area: "6 km²",
    summary:
      "Drone survey and terrain analysis for infrastructure planning and development.",
    deliverables: ["Orthomosaic", "Contours (1 m)", "DSM & DTM", "CAD Drawings"],
    insight:
      "Generated precise terrain models for better planning and execution of infrastructure projects.",
    outcome:
      "Reduced survey time and improved planning accuracy using drone-based mapping.",
    metrics: [
      { label: "Area surveyed", value: "6 km²" },
      { label: "Deliverables", value: "4" },
      { label: "State", value: "Gujarat" },
    ],
  },

  /* ----------------------- Hydrology ----------------------- */
  {
    slug: "bavla-flood-mapping",
    name: "Bavla Flood Mapping",
    location: "Bavla, Gujarat",
    industry: "Hydrology",
    area: "450 km²",
    summary:
      "Large-scale drone mapping and hydrological analysis for flood-risk assessment and watershed planning.",
    deliverables: [
      "DSM & DTM",
      "Orthomosaic",
      "Watershed",
      "Flood-prone Areas",
      "Stream Orders",
    ],
    insight:
      "Terrain analysis identified natural drainage patterns and flood-prone zones critical for flood-mitigation planning.",
    outcome:
      "Delivered actionable flood-risk maps and watershed information to support long-term water-management strategies.",
    metrics: [
      { label: "Area surveyed", value: "450 km²" },
      { label: "GCPs", value: "1,212" },
      { label: "State", value: "Gujarat" },
    ],
  },
  {
    slug: "lakhtar-hydrology-drainage-study",
    name: "Lakhtar Hydrology & Drainage Study",
    location: "Lakhtar, Gujarat",
    industry: "Hydrology",
    area: "2 km²",
    summary:
      "Drone-based hydrological analysis to assess drainage patterns and flood susceptibility.",
    deliverables: [
      "DSM & DTM",
      "Orthomosaic",
      "Watershed",
      "Flood-prone Areas",
      "Stream Orders",
    ],
    insight:
      "Micro-terrain analysis revealed water-accumulation zones and inefficient drainage channels.",
    outcome:
      "Identified flood-prone areas and supported effective drainage planning.",
    metrics: [
      { label: "Area surveyed", value: "2 km²" },
      { label: "GCPs", value: "8" },
      { label: "State", value: "Gujarat" },
    ],
  },
  {
    slug: "kutch-25-dams",
    name: "Kutch District 25 Dams",
    location: "Kutch, Gujarat",
    industry: "Hydrology",
    area: "25 dams",
    summary:
      "Data processing and hydrological analysis for reservoir-capacity assessment and siltation studies.",
    deliverables: [
      "DSM & DTM",
      "Orthomosaic",
      "Watershed",
      "Flood-prone Areas",
      "Stream Orders",
    ],
    insight:
      "Detailed terrain and reservoir analysis quantified silt deposition and erosion trends across multiple dams.",
    outcome:
      "Generated volume-capacity tables and siltation assessments to support reservoir management and maintenance planning.",
    metrics: [
      { label: "Dams analyzed", value: "25" },
      { label: "Deliverables", value: "5" },
      { label: "District", value: "Kutch" },
    ],
  },
  {
    slug: "navsari-hydrology-study",
    name: "Navsari Hydrology Study",
    location: "Navsari, Gujarat",
    industry: "Hydrology",
    area: "64 km²",
    summary:
      "Drone mapping and hydrological analysis to support water-conservation planning.",
    deliverables: [
      "DSM & DTM",
      "Orthomosaic",
      "Watershed",
      "Flood-prone Areas",
      "Stream Orders",
    ],
    insight:
      "Monsoon water-accumulation patterns highlighted ideal locations for future check dams and water-conservation structures.",
    outcome:
      "Enabled informed decision-making for check-dam placement and sustainable water-resource management.",
    metrics: [
      { label: "Area surveyed", value: "64 km²" },
      { label: "GCPs", value: "242" },
      { label: "State", value: "Gujarat" },
    ],
  },

  /* ----------------------- Mining ----------------------- */
  {
    slug: "dalmia-mines-meghalaya",
    name: "Dalmia Mines, Meghalaya",
    location: "Meghalaya",
    industry: "Mining",
    area: "5 km²",
    summary:
      "Drone survey and mine terrain analysis for operational monitoring and statutory compliance.",
    deliverables: ["Orthomosaic", "DSM & DTM", "Contours", "Volume Calculations"],
    insight:
      "High-resolution terrain models enabled accurate monitoring of excavation progress and compliance with mining regulations.",
    outcome:
      "Reduced survey time significantly while providing precise datasets for IBM reporting and mine planning.",
    metrics: [
      { label: "Area surveyed", value: "5 km²" },
      { label: "GCPs", value: "25" },
      { label: "State", value: "Meghalaya" },
    ],
  },
  {
    slug: "nirma-mines",
    name: "Nirma Mines",
    location: "Gujarat",
    industry: "Mining",
    area: "20 km²",
    summary:
      "Drone mapping and terrain analysis for production monitoring and resource management.",
    deliverables: ["Orthomosaic", "DSM & DTM", "Contours", "Volume Calculations"],
    insight:
      "Drone-derived datasets improved stockpile monitoring, excavation planning and regulatory reporting.",
    outcome:
      "Delivered accurate mine measurements faster than conventional surveys, improving operational efficiency.",
    metrics: [
      { label: "Area surveyed", value: "20 km²" },
      { label: "GCPs", value: "100" },
      { label: "State", value: "Gujarat" },
    ],
  },

  /* ----------------------- Solar ----------------------- */
  {
    slug: "mahindra-solar",
    name: "Mahindra & Mahindra Solar",
    location: "Gujarat",
    industry: "Solar",
    area: "12 km²",
    summary:
      "Drone mapping and terrain analysis for solar-farm planning and construction monitoring.",
    deliverables: ["Orthomosaic", "DSM & DTM", "Contours", "CAD Drawings"],
    insight:
      "Accurate terrain and surface models helped optimize panel layout, drainage planning and construction activities.",
    outcome:
      "Improved site-planning efficiency and reduced project-execution risks through high-resolution geospatial data.",
    metrics: [
      { label: "Area surveyed", value: "12 km²" },
      { label: "Deliverables", value: "4" },
      { label: "State", value: "Gujarat" },
    ],
  },
  {
    slug: "adani-solar-park",
    name: "Adani Solar Park",
    location: "Kutch, Gujarat",
    industry: "Solar",
    area: "24 km²",
    summary:
      "Large-scale drone survey and terrain mapping for solar-infrastructure development.",
    deliverables: ["Orthomosaic", "DSM & DTM", "Contours", "CAD Drawings"],
    insight:
      "Detailed terrain analysis enabled optimized solar-panel placement and efficient site grading.",
    outcome:
      "Accelerated planning and construction activities while maintaining engineering-grade accuracy.",
    metrics: [
      { label: "Area surveyed", value: "24 km²" },
      { label: "Location", value: "Kutch" },
      { label: "Terrain model", value: "High-res" },
    ],
  },

  /* ----------------------- Transmission ----------------------- */
  {
    slug: "sabarmati-sanand-transmission",
    name: "Sabarmati Ring Road to Sanand",
    location: "Ahmedabad, Gujarat",
    industry: "Transmission",
    area: "110 km corridor",
    summary:
      "Drone corridor survey for transmission-line route planning across diverse terrain conditions.",
    deliverables: ["Orthomosaic", "DTM", "Contours", "CAD Drawings"],
    insight:
      "Drone technology enabled safe and efficient surveying in difficult and inaccessible terrain.",
    outcome:
      "Reduced survey time by 75% while delivering highly accurate route-alignment data.",
    metrics: [
      { label: "Corridor length", value: "110 km" },
      { label: "Time saved", value: "75%" },
      { label: "Application", value: "Route survey" },
    ],
  },

  /* ----------------------- LiDAR ----------------------- */
  {
    slug: "diu-rajapara-lidar",
    name: "Diu Rajapara LiDAR Mapping",
    location: "Diu",
    industry: "LiDAR",
    area: "20 km²",
    accuracy: "±4 cm",
    summary:
      "LiDAR data acquisition and terrain modelling for high-precision surface analysis.",
    deliverables: ["LiDAR Point Cloud", "DTM", "DSM", "Contours"],
    insight:
      "LiDAR captured highly detailed terrain information and performed 45% more efficiently than conventional photogrammetry.",
    outcome:
      "Achieved 4 cm terrain accuracy while reducing survey time by 75%.",
    metrics: [
      { label: "Area surveyed", value: "20 km²" },
      { label: "GCPs", value: "22" },
      { label: "Accuracy", value: "±4 cm" },
    ],
  },

  /* ----------------------- Forestry ----------------------- */
  {
    slug: "dang-forest-survey",
    name: "Dang Forest Survey",
    location: "Dang, Gujarat",
    industry: "Forestry",
    area: "8 sites",
    accuracy: "±3 cm",
    summary:
      "LiDAR-based forest terrain mapping and GIS analysis for soil-moisture conservation planning.",
    deliverables: ["LiDAR Point Cloud", "DTM", "Slope Analysis", "Terrain Models"],
    insight:
      "Advanced GIS analysis identified the most suitable locations for soil-moisture conservation structures in dense forest and highly variable terrain.",
    outcome:
      "Mapped terrain beneath dense vegetation with 3 cm accuracy, enabling precise environmental planning and sustainable watershed management.",
    metrics: [
      { label: "Sites surveyed", value: "8" },
      { label: "Terrain variation", value: "80 m" },
      { label: "Accuracy", value: "±3 cm" },
    ],
  },
];

// Attach real deliverable screenshots (in /public/projects) where available.
const slugsWithImage = new Set([
  "dalmia-mines-meghalaya",
  "dang-forest-survey",
  "diu-rajapara-lidar",
  "kutch-25-dams",
  "navsari-hydrology-study",
  "navsari-infrastructure-survey",
  "reliance-multi-site-monitoring",
  "sabarmati-sanand-transmission",
  "vadnagar-town-survey",
]);
for (const p of projects) {
  if (slugsWithImage.has(p.slug)) p.image = `/projects/${p.slug}.webp`;
}
