export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  date: string;
  readTime: string;
  author: string;
  body: string[];
};

export const blogPosts: BlogPost[] = [
  {
    slug: "dsm-vs-dtm-explained",
    title: "DSM vs. DTM: Choosing the Right Elevation Model",
    excerpt:
      "Surface or terrain? Understanding the difference between a Digital Surface Model and a Digital Terrain Model is the first step to a reliable engineering deliverable.",
    category: "Fundamentals",
    date: "2026-05-28",
    readTime: "6 min read",
    author: "Sudaan Geo-Analytics Team",
    body: [
      "Elevation models are the backbone of nearly every engineering decision made from aerial data. Yet two of the most common products, the Digital Surface Model (DSM) and the Digital Terrain Model (DTM), are routinely confused, leading to design errors that surface late and cost dearly.",
      "A DSM records the highest reflective surface at every location: rooftops, tree canopy, vehicles and the ground in between. It is ideal for line-of-sight studies, solar shading, and clash detection where everything above ground matters.",
      "A DTM, by contrast, represents the bare earth. Above-ground features are classified out and the remaining ground points are interpolated into a continuous surface. This is what earthworks, hydrology and road design depend on.",
      "The processing difference is significant. Producing a trustworthy DTM requires careful point classification, breakline enforcement along ridges and drainage, and quality control against ground control points. Skipping these steps produces a model that looks correct but misleads the designer.",
      "Our rule of thumb: if your question is about water, earth, or grade, you want a DTM. If it is about objects, visibility, or clearance, you want a DSM. Most projects need both.",
    ],
  },
  {
    slug: "ground-control-points-accuracy",
    title: "Why Ground Control Points Still Decide Your Accuracy",
    excerpt:
      "RTK drones are remarkable, but ground control remains the difference between a pretty map and a survey-grade deliverable. Here is how we plan control networks.",
    category: "Accuracy",
    date: "2026-05-12",
    readTime: "7 min read",
    author: "Sudaan Geo-Analytics Team",
    body: [
      "Modern drones with onboard RTK and PPK have transformed field efficiency, and it is tempting to conclude that ground control points (GCPs) are obsolete. In practice, GCPs remain the most reliable way to guarantee, and prove, absolute accuracy.",
      "GCPs serve two roles. As control, they anchor the photogrammetric block to a known datum. As checkpoints, independent markers not used in processing let us measure true accuracy rather than estimate it.",
      "Distribution matters more than quantity. A handful of well-distributed points, including the corners and centre of the site, with elevation control on terrain extremes, outperforms a dense cluster in one area.",
      "For corridor projects, we place control in alternating pairs along the route to constrain the long-axis drift that single-line captures are prone to.",
      "Every deliverable we issue includes a checkpoint residual report, so the accuracy figure on the cover page is a measurement, not a marketing number.",
    ],
  },
  {
    slug: "volumetrics-stockpile-best-practices",
    title: "Measuring Stockpiles You Can Audit",
    excerpt:
      "Volumetric reports are only as good as the surfaces beneath them. A field guide to defensible cut/fill and inventory measurement.",
    category: "Analytics",
    date: "2026-04-30",
    readTime: "5 min read",
    author: "Sudaan Geo-Analytics Team",
    body: [
      "Stockpile volumetrics are one of the highest-value, most-disputed products in geospatial work. When inventory feeds financial reporting, the method has to withstand audit.",
      "The single biggest source of error is the base surface. A flat-plane assumption under an irregular toe can swing a volume by double digits. We model the base from surrounding terrain or a prior bare-earth capture wherever possible.",
      "Consistent toe delineation between captures is essential for change-over-time tracking. We lock toe boundaries to a shared reference so successive volumes are genuinely comparable.",
      "Finally, every report states its method, base surface, density assumptions and confidence range. Transparency is what makes a number auditable.",
    ],
  },
  {
    slug: "ndvi-for-infrastructure-teams",
    title: "NDVI Isn't Just for Farmers",
    excerpt:
      "Vegetation indices quietly power encroachment monitoring, erosion detection and site rehabilitation tracking far beyond agriculture.",
    category: "Insights",
    date: "2026-04-08",
    readTime: "6 min read",
    author: "Sudaan Geo-Analytics Team",
    body: [
      "The Normalised Difference Vegetation Index (NDVI) is best known in precision agriculture, but its value extends across infrastructure, mining and government work.",
      "Along transmission and pipeline corridors, NDVI time-series surface vegetation encroachment before it becomes a clearance or fire risk.",
      "On rehabilitated mine land and embankments, the same index quantifies revegetation progress against permit commitments, turning a subjective inspection into a measured trend.",
      "Because NDVI requires near-infrared capture, we plan multispectral missions when these questions are in scope, and pair the index with high-resolution RGB for context.",
    ],
  },
];
