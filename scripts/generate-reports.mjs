// Generates lightweight, valid sample PDF deliverables into /public/reports.
// Run with: node scripts/generate-reports.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "reports");
mkdirSync(outDir, { recursive: true });

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Build a minimal single-page PDF with a title and body lines.
function buildPdf({ title, subtitle, lines }) {
  // Page content stream
  const content = [];
  content.push("BT");
  // Accent rule
  content.push("0 0.118 0.157 rg"); // dark background bar handled separately
  content.push("ET");

  // We compose text operations.
  const text = [];
  text.push("BT");
  text.push("/F2 22 Tf");
  text.push("0.118 0.533 0.898 rg"); // accent blue
  text.push("72 720 Td");
  text.push(`(${esc(title)}) Tj`);
  text.push("/F1 12 Tf");
  text.push("0.3 0.34 0.4 rg");
  text.push("0 -22 Td");
  text.push(`(${esc(subtitle)}) Tj`);
  text.push("/F1 11 Tf");
  text.push("0.15 0.18 0.22 rg");
  text.push("0 -34 Td");
  text.push("14 TL");
  for (const ln of lines) {
    text.push(`(${esc(ln)}) Tj`);
    text.push("T*");
  }
  text.push("ET");

  // A header rule line
  const graphics = [
    "0.118 0.533 0.898 RG",
    "2 w",
    "72 740 m 523 740 l S",
    "0.85 0.88 0.92 RG",
    "0.5 w",
    "72 690 m 523 690 l S",
  ];

  const stream = [...graphics, ...text].join("\n");

  const objects = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
  );
  objects.push(
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

const reports = [
  {
    file: "orthomosaic-sample.pdf",
    title: "Orthomosaic Report",
    subtitle: "Sudaan Geo-Analytics  |  Sample Deliverable",
    lines: [
      "Project:        Sample Site - Khartoum State",
      "Deliverable:    Georeferenced Orthomosaic (GeoTIFF)",
      "Ground sample distance:   1.8 cm / pixel",
      "Coordinate system:        UTM Zone 36N / WGS84",
      "Total area mapped:        640 hectares",
      "Ground control points:    24 (RTK surveyed)",
      "Checkpoint RMSE (horiz):  0.021 m",
      "",
      "Notes:",
      "This orthomosaic was produced from 1,420 overlapping aerial",
      "frames, radiometrically balanced and georeferenced against",
      "independent ground control. Every pixel carries an accurate",
      "real-world coordinate suitable for measurement and design.",
      "",
      "This is a representative sample for demonstration purposes only.",
    ],
  },
  {
    file: "topographic-survey-sample.pdf",
    title: "Topographic Survey",
    subtitle: "Sudaan Geo-Analytics  |  Sample Deliverable",
    lines: [
      "Project:        Sample Site - Northern State",
      "Deliverable:    Digital Terrain Model + Spot Heights",
      "Vertical datum:           EGM2008",
      "Coordinate system:        UTM Zone 36N / WGS84",
      "DTM grid resolution:      0.25 m",
      "Checkpoint RMSE (vert):   0.034 m",
      "Surveyed area:            480 hectares",
      "",
      "Contents:",
      "  - Bare-earth digital terrain model",
      "  - Classified ground point cloud",
      "  - Spot heights and breaklines",
      "  - Survey control summary and residuals",
      "",
      "This is a representative sample for demonstration purposes only.",
    ],
  },
  {
    file: "contour-map-sample.pdf",
    title: "Contour Map",
    subtitle: "Sudaan Geo-Analytics  |  Sample Deliverable",
    lines: [
      "Project:        Sample Site - Gezira State",
      "Deliverable:    Contour Map (DWG / DXF)",
      "Contour interval:         0.5 m (index every 2.5 m)",
      "Source surface:           DTM @ 0.25 m",
      "Coordinate system:        UTM Zone 36N / WGS84",
      "Vertical datum:           EGM2008",
      "",
      "Contents:",
      "  - Smoothed, labelled contour lines",
      "  - Index and intermediate classification",
      "  - CAD-ready layering",
      "  - Spot elevations at key features",
      "",
      "This is a representative sample for demonstration purposes only.",
    ],
  },
  {
    file: "volume-analysis-sample.pdf",
    title: "Volume Analysis Report",
    subtitle: "Sudaan Geo-Analytics  |  Sample Deliverable",
    lines: [
      "Project:        Sample Site - Aggregate Operation",
      "Deliverable:    Stockpile & Earthworks Volumetrics",
      "Method:                   Surface-to-surface (TIN)",
      "Base surface:             Surrounding-terrain interpolation",
      "Number of stockpiles:     14",
      "",
      "Summary:",
      "  Total stockpile volume:   38,420 m3",
      "  Cut volume:               12,650 m3",
      "  Fill volume:               9,310 m3",
      "  Net (cut - fill):          3,340 m3",
      "  Estimated uncertainty:     +/- 2.1%",
      "",
      "This is a representative sample for demonstration purposes only.",
    ],
  },
];

for (const r of reports) {
  const buf = buildPdf(r);
  writeFileSync(join(outDir, r.file), buf);
  console.log("wrote", r.file, buf.length, "bytes");
}
