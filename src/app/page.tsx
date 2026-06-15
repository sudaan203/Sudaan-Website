import Link from "next/link";
import Hero from "@/components/Hero";
import StatsCounter from "@/components/StatsCounter";
import SectionHeading from "@/components/SectionHeading";
import ServiceCard from "@/components/ServiceCard";
import CTASection from "@/components/CTASection";
import Reveal, { StaggerGroup, StaggerItem } from "@/components/Reveal";
import CompareSlider from "@/components/CompareSlider";
import { RealTile } from "@/components/visuals/GeoLayers";
import { services } from "@/data/services";
import { sectors, clients } from "@/lib/site";

const workflow = [
  {
    step: "01",
    title: "Ingest",
    text: "We securely receive your raw drone imagery, GNSS logs and ground control.",
  },
  {
    step: "02",
    title: "Process",
    text: "Photogrammetric processing, classification and rigorous QA against control.",
  },
  {
    step: "03",
    title: "Analyse",
    text: "We derive terrain models, contours, volumes and spatial analytics.",
  },
  {
    step: "04",
    title: "Deliver",
    text: "Engineering-grade outputs in your CAD/GIS formats, with an accuracy report.",
  },
];

export default function HomePage() {
  return (
    <>
      <Hero />

      {/* Stats */}
      <section className="section-py">
        <div className="container-px">
          <StatsCounter />
        </div>
      </section>

      {/* Trusted by */}
      <section className="border-y border-ink/[0.06] bg-mist/50 py-16">
        <div className="container-px">
          <Reveal className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
              Trusted By Leading Organisations
            </h2>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-x-12 gap-y-5">
              {clients.map((client) => (
                <span
                  key={client}
                  className="bg-gradient-to-r from-accent-500 via-accent-600 to-signal bg-clip-text text-2xl font-bold tracking-tight text-transparent sm:text-3xl lg:text-4xl"
                >
                  {client}
                </span>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* Insight teaser */}
      <section className="section-py">
        <div className="container-px grid items-center gap-12 lg:grid-cols-2">
          <div>
            <SectionHeading
              eyebrow="From pixels to precision"
              title="Orthomosaic in. Engineering-grade intelligence out."
              description="Drag the slider to see a real field's georeferenced orthomosaic become a colourised digital surface model, ready for measurement and design."
            />
            <Reveal delay={0.1} className="mt-8">
              <Link href="/data-insights" className="btn-primary">
                Explore Data Insights
              </Link>
            </Reveal>
          </div>
          <Reveal direction="left">
            <CompareSlider
              before={<RealTile src="/insights/ortho1.webp" label="ORTHOMOSAIC" bgClass="bg-white" />}
              after={<RealTile src="/insights/dsm1.webp" label="DSM" tone="amber" bgClass="bg-white" />}
              beforeLabel="Orthomosaic"
              afterLabel="DSM"
            />
          </Reveal>
        </div>
      </section>

      {/* Services */}
      <section className="section-py">
        <div className="container-px">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-end">
            <SectionHeading
              eyebrow="What we deliver"
              title="A full geospatial production pipeline"
              description="Ten engineering-grade services covering every stage from capture to decision support."
            />
            <Reveal>
              <Link href="/services" className="btn-secondary shrink-0">
                All services →
              </Link>
            </Reveal>
          </div>

          <StaggerGroup className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {services.slice(0, 6).map((service, i) => (
              <ServiceCard key={service.slug} service={service} index={i} />
            ))}
          </StaggerGroup>
        </div>
      </section>

      {/* Workflow */}
      <section className="section-py">
        <div className="container-px">
          <SectionHeading
            eyebrow="How it works"
            title="A measured, repeatable process"
            description="Every project follows the same disciplined pipeline, so quality and turnaround stay predictable."
            align="center"
          />
          <StaggerGroup className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {workflow.map((w) => (
              <StaggerItem key={w.step}>
                <div className="surface surface-hover relative h-full p-7">
                  <span className="text-4xl font-bold text-accent/30">
                    {w.step}
                  </span>
                  <h3 className="mt-3 text-lg font-semibold text-ink-900">
                    {w.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink/60">
                    {w.text}
                  </p>
                </div>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      {/* Industries */}
      <section className="section-py">
        <div className="container-px">
          <SectionHeading
            eyebrow="Sectors we serve"
            title="Trusted across sectors that depend on accuracy"
            description="From energy and infrastructure to forestry and government, our deliverables fit the way each sector works."
            align="center"
          />
          <StaggerGroup className="mx-auto mt-12 flex max-w-5xl flex-wrap justify-center gap-3">
            {sectors.map((sector) => (
              <StaggerItem key={sector}>
                <span className="surface inline-flex items-center gap-2 px-5 py-3 text-sm font-medium text-ink/90">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />
                  {sector}
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
