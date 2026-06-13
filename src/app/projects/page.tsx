import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import ProjectsExplorer from "@/components/ProjectsExplorer";
import CTASection from "@/components/CTASection";

export const metadata: Metadata = {
  title: "Projects",
  description:
    "Case studies across infrastructure, hydrology, mining, solar, transmission, LiDAR and forestry, engineering-grade geospatial deliverables and measurable outcomes.",
  alternates: { canonical: "/projects" },
};

export default function ProjectsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Projects"
        title={
          <>
            Case studies in{" "}
            <span className="text-accent-600">measurable outcomes</span>
          </>
        }
        description="A selection of geospatial projects across sectors. Filter by industry to see the deliverables, data insights and client outcomes for each engagement."
      />

      <section className="section-py">
        <div className="container-px">
          <ProjectsExplorer />
        </div>
      </section>

      <CTASection />
    </>
  );
}
