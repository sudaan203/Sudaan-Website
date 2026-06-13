import type { Metadata } from "next";
import Image from "next/image";
import PageHeader from "@/components/PageHeader";
import SectionHeading from "@/components/SectionHeading";
import CTASection from "@/components/CTASection";
import Reveal, { StaggerGroup, StaggerItem } from "@/components/Reveal";
import StatsCounter from "@/components/StatsCounter";
import { asset } from "@/lib/asset";

export const metadata: Metadata = {
  title: "About",
  description:
    "Sudaan Geo-Analytics is a team of expert engineers in surveying, geomatics, GIS, remote sensing, drone mapping and geospatial analytics, turning survey data into engineering intelligence.",
  alternates: { canonical: "/about" },
};

const expertise = [
  "Infrastructure",
  "Renewable Energy",
  "Mining",
  "Construction",
  "Forestry",
  "Utilities",
  "Government",
];

const coreValues = [
  "Accuracy",
  "Integrity",
  "Innovation",
  "Reliability",
  "Customer Focus",
  "Data Excellence",
];

const values = [
  {
    title: "Accuracy",
    text: "Every deliverable is verified against independent control and shipped with a measured accuracy report.",
  },
  {
    title: "Innovation",
    text: "We continually refine our processing pipeline to extract more insight from the same capture.",
  },
  {
    title: "Integrity",
    text: "Transparent methods and honest numbers. If a result has uncertainty, we state it.",
  },
  {
    title: "Reliability",
    text: "A disciplined, repeatable process keeps quality and turnaround predictable, project after project.",
  },
  {
    title: "Customer Focus",
    text: "We engineer every product around your operational questions and the decisions you need to make.",
  },
  {
    title: "Data Excellence",
    text: "Clean, well-structured, standards-compliant data that drops straight into your workflow.",
  },
];

const leadership = [
  {
    name: "Prakhar Pandey",
    photo: "/team/prakhar.webp",
    role: "Surveying & Field Operations",
    bio: "A passionate civil engineering professional specializing in surveying, drone operations, geospatial data acquisition and project execution with extensive field experience across infrastructure and industrial projects.",
  },
  {
    name: "Malhar Patel",
    photo: "/team/malhar.webp",
    role: "Geomatics & Data Analytics",
    bio: "Civil Engineer and Geomatics specialist with expertise in drone data processing, LiDAR analytics, orthomosaic generation, DSM/DTM modeling, GIS workflows and geospatial intelligence solutions.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHeader
        eyebrow="About"
        title={
          <>
            We make geospatial intelligence{" "}
            <span className="text-accent-600">accurate and actionable</span>
          </>
        }
        description="Sudaan Geo-Analytics is a geospatial data and analytics company. We convert raw drone, LiDAR and survey data into engineering-grade deliverables that teams can build decisions on."
      />

      {/* Who we are */}
      <section className="section-py">
        <div className="container-px grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <Reveal>
            <span className="eyebrow">
              <span className="h-px w-6 bg-accent-500" />
              Who we are
            </span>
            <h2 className="heading-lg mt-4">
              Expert engineers turning survey data into intelligence
            </h2>
            <div className="mt-8 flex flex-wrap gap-2.5">
              {expertise.map((e) => (
                <span
                  key={e}
                  className="surface inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-ink/80"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-600" />
                  {e}
                </span>
              ))}
            </div>
          </Reveal>

          <Reveal delay={0.1} className="space-y-5">
            <p className="lead">
              We are a team of expert engineers specializing in surveying,
              geomatics, GIS, remote sensing, drone mapping and geospatial
              analytics.
            </p>
            <p className="text-ink/75">
              We integrate advanced data acquisition with intelligent data
              processing to deliver actionable insights for informed decision
              making.
            </p>
            <p className="text-ink/75">
              Our expertise spans infrastructure, renewable energy, mining,
              construction, forestry, utilities and government projects.
            </p>
            <p className="text-ink/75">
              We have successfully processed and analyzed large-scale survey
              datasets with a strong focus on accuracy, reliability and
              engineering excellence.
            </p>
          </Reveal>
        </div>
      </section>

      {/* Mission, Vision & Values */}
      <section className="section-py border-t border-ink/[0.06]">
        <div className="container-px grid gap-6 lg:grid-cols-3">
          <Reveal>
            <div className="surface relative h-full overflow-hidden p-9">
              <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-accent/15 blur-3xl" />
              <span className="eyebrow">Mission</span>
              <p className="mt-5 text-xl font-semibold leading-snug text-ink-900">
                To make geospatial intelligence accessible, accurate, and
                actionable.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="surface relative h-full overflow-hidden p-9">
              <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-signal/15 blur-3xl" />
              <span className="eyebrow text-signal">Vision</span>
              <p className="mt-5 text-xl font-semibold leading-snug text-ink-900">
                To become a leading geospatial data and analytics company
                delivering engineering-grade insights across industries.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.16}>
            <div className="surface relative h-full overflow-hidden p-9">
              <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-accent/15 blur-3xl" />
              <span className="eyebrow">Values</span>
              <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5">
                {coreValues.map((v) => (
                  <li
                    key={v}
                    className="flex items-center gap-2 text-sm font-medium text-ink-900"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4 shrink-0 text-accent-600"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {v}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Stats */}
      <section className="pb-4 pt-10">
        <div className="container-px">
          <StatsCounter />
        </div>
      </section>

      {/* Technical leadership */}
      <section className="section-py border-t border-ink/[0.06]">
        <div className="container-px">
          <SectionHeading
            eyebrow="Technical leadership"
            title="Engineers behind the data"
            description="Our leadership pairs deep field surveying experience with advanced geospatial data science."
          />
          <StaggerGroup className="mt-12 grid gap-6 md:grid-cols-2">
            {leadership.map((p) => (
              <StaggerItem key={p.name}>
                <div className="surface surface-hover flex h-full flex-col gap-5 p-8 sm:flex-row sm:items-start">
                  <div className="relative shrink-0">
                    <Image
                      src={asset(p.photo)}
                      alt={p.name}
                      width={96}
                      height={96}
                      className="h-24 w-24 rounded-2xl object-cover shadow-card ring-1 ring-ink/10"
                    />
                    <span className="absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-lg border border-ink/10 bg-panel text-accent-600 shadow-card">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M3 7l9-4 9 4-9 4-9-4z" strokeLinejoin="round" />
                        <path d="M3 12l9 4 9-4" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-ink-900">{p.name}</h3>
                    <p className="mt-0.5 text-sm font-semibold text-accent-600">
                      {p.role}
                    </p>
                    <p className="mt-3 text-sm leading-relaxed text-ink/70">
                      {p.bio}
                    </p>
                  </div>
                </div>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      {/* Values in depth */}
      <section className="section-py border-t border-ink/[0.06]">
        <div className="container-px">
          <SectionHeading
            eyebrow="What drives us"
            title="The principles behind every deliverable"
            align="center"
          />
          <StaggerGroup className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {values.map((v, i) => (
              <StaggerItem key={v.title}>
                <div className="surface surface-hover h-full p-7">
                  <span className="font-mono text-sm text-accent-600/60">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-3 text-lg font-semibold text-ink-900">
                    {v.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink/60">
                    {v.text}
                  </p>
                </div>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      <CTASection title="Let's build your next decision on solid ground." />
    </>
  );
}
