import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import ServiceCard from "@/components/ServiceCard";
import CTASection from "@/components/CTASection";
import SectionHeading from "@/components/SectionHeading";
import { StaggerGroup, StaggerItem } from "@/components/Reveal";
import Reveal from "@/components/Reveal";
import ServiceIcon from "@/components/ServiceIcon";
import { services } from "@/data/services";
import { serviceCategories } from "@/data/serviceCategories";

export const metadata: Metadata = {
  title: "Services",
  description:
    "Field survey, LiDAR & 3D scanning, terrain modeling, orthomosaic generation, GIS analytics, utility & infrastructure mapping and environmental remote-sensing services.",
  alternates: { canonical: "/services" },
};

const formats = [
  "GeoTIFF",
  "LAS / LAZ",
  "DWG / DXF",
  "Shapefile",
  "GeoJSON",
  "E57",
  "PDF reports",
  "Web tiles",
];

export default function ServicesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Services"
        title={
          <>
            Engineering-grade geospatial{" "}
            <span className="text-accent-600">deliverables</span>
          </>
        }
        description="We process raw drone, LiDAR and survey data into accurate, decision-ready outputs. Explore our capabilities across the full geospatial production pipeline."
      />

      {/* Core / featured capabilities */}
      <section className="section-py">
        <div className="container-px">
          <SectionHeading
            eyebrow="Core capabilities"
            title="Our flagship geospatial deliverables"
            description="The processing services at the heart of every engagement."
          />
          <StaggerGroup className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((service, i) => (
              <ServiceCard key={service.slug} service={service} index={i} />
            ))}
          </StaggerGroup>
        </div>
      </section>

      {/* Full categorised catalogue */}
      <section className="section-py border-t border-ink/[0.06]">
        <div className="container-px">
          <SectionHeading
            eyebrow="Full service catalogue"
            title="Everything we offer, organised by discipline"
            description="From field acquisition to advanced processing, utilities and environmental analytics."
          />

          <div className="mt-14 space-y-16">
            {serviceCategories.map((cat) => (
              <div key={cat.key}>
                <Reveal>
                  <div className="flex items-center gap-4">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-600 text-white shadow-glow">
                      <ServiceIcon name={cat.icon} className="h-6 w-6" />
                    </span>
                    <div>
                      <h3 className="text-xl font-bold text-ink-900">
                        {cat.title}
                      </h3>
                      <p className="text-sm text-ink/60">{cat.description}</p>
                    </div>
                  </div>
                </Reveal>

                <StaggerGroup className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {cat.items.map((item) => (
                    <StaggerItem key={item.name}>
                      <div className="surface surface-hover group flex h-full items-start gap-3 p-5">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent-50 text-accent-700 transition-colors group-hover:bg-accent-600 group-hover:text-white">
                          <ServiceIcon name={item.icon} className="h-5 w-5" />
                        </span>
                        <div>
                          <h4 className="text-sm font-semibold leading-snug text-ink-900">
                            {item.name}
                          </h4>
                          <p className="mt-1 text-xs leading-relaxed text-ink/60">
                            {item.blurb}
                          </p>
                        </div>
                      </div>
                    </StaggerItem>
                  ))}
                </StaggerGroup>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Formats */}
      <section className="section-py border-t border-ink/[0.06]">
        <div className="container-px">
          <SectionHeading
            eyebrow="Delivery formats"
            title="We deliver in the formats your team already uses"
            align="center"
          />
          <StaggerGroup className="mx-auto mt-10 flex max-w-3xl flex-wrap justify-center gap-3">
            {formats.map((f) => (
              <StaggerItem key={f}>
                <span className="surface px-5 py-2.5 font-mono text-sm text-ink/90">
                  {f}
                </span>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      <CTASection />
    </>
  );
}
