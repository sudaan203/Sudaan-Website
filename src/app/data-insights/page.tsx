import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import SectionHeading from "@/components/SectionHeading";
import CompareSlider from "@/components/CompareSlider";
import PointCloudViewer from "@/components/PointCloudViewer";
import CTASection from "@/components/CTASection";
import Reveal, { StaggerGroup, StaggerItem } from "@/components/Reveal";
import { asset } from "@/lib/asset";
import {
  RawImagery,
  Orthomosaic,
  DSM,
  DTM,
  Contours,
  NDVI,
  LidarCloud,
  SurfaceModel,
  ForestMap,
  SolarFarm,
  TransmissionCorridor,
  RealTile,
} from "@/components/visuals/GeoLayers";

export const metadata: Metadata = {
  title: "Data Insights",
  description:
    "Interactive showcase of processed geospatial outputs, orthomosaics, DSM/DTM, contours, LiDAR point clouds, NDVI vegetation, forest, solar and transmission-line examples, plus downloadable sample reports.",
  alternates: { canonical: "/data-insights" },
};

const examples = [
  {
    title: "Forest Mapping",
    visual: <ForestMap />,
    insight: "Canopy density & change",
    desc: "Canopy extent and density classified from multispectral capture, quantifying cover, clearings and rehabilitation over time.",
  },
  {
    title: "Solar Plant Survey",
    visual: <SolarFarm />,
    insight: "Row layout & grading",
    desc: "As-built panel-row mapping over graded terrain, supporting layout verification, grading checks and yield modelling.",
  },
  {
    title: "Transmission Line Survey",
    visual: <TransmissionCorridor />,
    insight: "Clearance & encroachment",
    desc: "Corridor capture with conductor, tower and clearance analysis, flagging vegetation encroachment along the route.",
  },
];

const comparisons = [
  {
    eyebrow: "Section 01",
    title: "Raw Drone Imagery → Orthomosaic",
    description:
      "Hundreds of overlapping, distorted frames are stitched and georeferenced into a single measurable basemap.",
    before: <RawImagery />,
    after: <Orthomosaic />,
    beforeLabel: "Raw imagery",
    afterLabel: "Orthomosaic",
  },
  {
    eyebrow: "Section 02",
    title: "Orthomosaic → Digital Surface Model",
    description:
      "A real Kotba site DSM, colourised and hill-shaded from our processed elevation model, showing every surface encoded as height. (Orthomosaic export pending.)",
    before: <Orthomosaic />,
    after: <RealTile src="/insights/kotba-dsm.webp" label="DSM · KOTBA" tone="amber" />,
    beforeLabel: "Orthomosaic",
    afterLabel: "DSM (real data)",
  },
  {
    eyebrow: "Section 03",
    title: "DSM → Digital Terrain Model",
    description:
      "Above-ground features are classified out, leaving a clean bare-earth model for engineering design.",
    before: <DSM />,
    after: <DTM />,
    beforeLabel: "DSM",
    afterLabel: "DTM",
  },
  {
    eyebrow: "Section 04",
    title: "Orthomosaic → Contours",
    description:
      "Terrain is distilled into labelled contour lines, ready to drop straight into CAD and GIS workflows.",
    before: <Orthomosaic />,
    after: <Contours overOrtho />,
    beforeLabel: "Orthomosaic",
    afterLabel: "Contours",
  },
  {
    eyebrow: "Section 05",
    title: "LiDAR Point Cloud → Surface Model",
    description:
      "Millions of classified LiDAR returns are interpolated into a continuous, engineering-ready surface model.",
    before: <LidarCloud />,
    after: <SurfaceModel />,
    beforeLabel: "LiDAR point cloud",
    afterLabel: "Surface model",
  },
];

const vegStats = [
  { label: "Mean NDVI", value: "0.62", note: "Healthy vegetation overall" },
  { label: "Stressed area", value: "84 ha", note: "Flagged for inspection" },
  { label: "Canopy cover", value: "47%", note: "Of total survey extent" },
  { label: "Bare ground", value: "12%", note: "Exposed / low-index zones" },
];

const deliverables = [
  {
    title: "Orthomosaic Report",
    desc: "Georeferenced basemap summary with resolution and accuracy.",
    href: "/reports/orthomosaic-sample.pdf",
    tag: "PDF · 2 pages",
  },
  {
    title: "Topographic Survey",
    desc: "Terrain model, spot heights and survey control summary.",
    href: "/reports/topographic-survey-sample.pdf",
    tag: "PDF · 2 pages",
  },
  {
    title: "Contour Map",
    desc: "Labelled contour deliverable with interval and datum notes.",
    href: "/reports/contour-map-sample.pdf",
    tag: "PDF · 2 pages",
  },
  {
    title: "Volume Analysis Report",
    desc: "Auditable cut/fill and stockpile inventory computation.",
    href: "/reports/volume-analysis-sample.pdf",
    tag: "PDF · 2 pages",
  },
];

export default function DataInsightsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Data Insights"
        title={
          <>
            See your data{" "}
            <span className="text-accent-600">transform</span>
          </>
        }
        description="This is where raw capture becomes engineering intelligence. Drag the sliders, rotate the point cloud and download sample deliverables to explore exactly what we produce."
      />

      {/* Comparison sliders */}
      {comparisons.map((c, i) => (
        <section key={c.eyebrow} className="section-py border-b border-ink/[0.06]">
          <div
            className={`container-px grid items-center gap-10 lg:grid-cols-2 ${
              i % 2 === 1 ? "lg:[&>*:first-child]:order-2" : ""
            }`}
          >
            <div>
              <SectionHeading
                eyebrow={c.eyebrow}
                title={c.title}
                description={c.description}
              />
              <Reveal delay={0.1} className="mt-6">
                <p className="text-xs uppercase tracking-wider text-ink/50">
                  ◂ Drag the handle to compare ▸
                </p>
              </Reveal>
            </div>
            <Reveal direction={i % 2 === 1 ? "right" : "left"}>
              <CompareSlider
                before={c.before}
                after={c.after}
                beforeLabel={c.beforeLabel}
                afterLabel={c.afterLabel}
              />
            </Reveal>
          </div>
        </section>
      ))}

      {/* Section 6: Vegetation analysis */}
      <section className="section-py border-b border-ink/[0.06]">
        <div className="container-px">
          <SectionHeading
            eyebrow="Section 06"
            title="Vegetation Analysis (NDVI)"
            description="Near-infrared capture reveals crop health, encroachment and rehabilitation progress that the eye cannot see."
          />
          <div className="mt-12 grid gap-8 lg:grid-cols-[1.3fr_1fr]">
            <Reveal>
              <div className="aspect-[4/3] overflow-hidden rounded-2xl border border-ink/10">
                <NDVI />
              </div>
            </Reveal>
            <StaggerGroup className="grid grid-cols-2 gap-4">
              {vegStats.map((s) => (
                <StaggerItem key={s.label}>
                  <div className="surface surface-hover h-full p-6">
                    <p className="text-3xl font-bold text-ink-900">{s.value}</p>
                    <p className="mt-1 text-sm font-medium text-accent-700">
                      {s.label}
                    </p>
                    <p className="mt-2 text-xs text-ink/60">{s.note}</p>
                  </div>
                </StaggerItem>
              ))}
              <StaggerItem className="col-span-2">
                <div className="surface border-signal/30 bg-signal/5 p-6">
                  <p className="text-sm text-ink/90">
                    <span className="font-semibold text-signal">Insight:</span>{" "}
                    NDVI time-series isolated 84 ha of stressed vegetation linked
                    to reduced irrigation flow, enabling targeted intervention
                    before yield loss.
                  </p>
                </div>
              </StaggerItem>
            </StaggerGroup>
          </div>
        </div>
      </section>

      {/* Section 7: Application examples */}
      <section className="section-py border-b border-ink/[0.06]">
        <div className="container-px">
          <SectionHeading
            eyebrow="Section 07"
            title="Application Examples"
            description="The same pipeline, applied across industries, each output engineered around a specific decision."
          />
          <StaggerGroup className="mt-12 grid gap-6 md:grid-cols-3">
            {examples.map((ex) => (
              <StaggerItem key={ex.title}>
                <div className="surface surface-hover group flex h-full flex-col overflow-hidden">
                  <div className="relative aspect-[4/3] overflow-hidden border-b border-ink/10">
                    {ex.visual}
                    <span className="absolute right-3 top-3 rounded-full bg-accent-600 px-3 py-1 text-xs font-semibold text-white shadow-glow">
                      {ex.insight}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col p-6">
                    <h3 className="text-lg font-semibold text-ink-900">
                      {ex.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-ink/60">
                      {ex.desc}
                    </p>
                  </div>
                </div>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      {/* Section 8: Point cloud viewer */}
      <section className="section-py border-b border-ink/[0.06]">
        <div className="container-px">
          <SectionHeading
            eyebrow="Section 08"
            title="Interactive Point Cloud Viewer"
            description="A dense 3D reconstruction you can explore in the browser. Rotate, zoom and inspect the terrain and structures."
          />
          <Reveal className="mt-12">
            <PointCloudViewer className="h-[480px]" />
          </Reveal>
        </div>
      </section>

      {/* Section 9: Deliverables */}
      <section className="section-py">
        <div className="container-px">
          <SectionHeading
            eyebrow="Section 09"
            title="Project Deliverables"
            description="Download representative sample reports to see the structure and detail of our standard outputs."
          />
          <StaggerGroup className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {deliverables.map((d) => (
              <StaggerItem key={d.title}>
                <a
                  href={asset(d.href)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="surface surface-hover group flex h-full flex-col p-6"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent-700">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-6 w-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path
                        d="M14 3v4a1 1 0 001 1h4M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8l-5-5z"
                        strokeLinejoin="round"
                      />
                      <path d="M9 13h6M9 17h6M9 9h1" strokeLinecap="round" />
                    </svg>
                  </span>
                  <h3 className="mt-5 text-base font-semibold text-ink-900">
                    {d.title}
                  </h3>
                  <p className="mt-2 flex-1 text-sm text-ink/60">{d.desc}</p>
                  <div className="mt-5 flex items-center justify-between border-t border-ink/[0.06] pt-4">
                    <span className="font-mono text-xs text-ink/50">
                      {d.tag}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-accent-700 transition-transform group-hover:translate-x-0.5">
                      Download
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path
                          d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </div>
                </a>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      <CTASection title="Want this level of insight on your site?" />
    </>
  );
}
