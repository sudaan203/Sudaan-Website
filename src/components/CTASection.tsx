import Link from "next/link";
import Reveal from "./Reveal";

export default function CTASection({
  title = "Have raw survey data? Let's turn it into intelligence.",
  description = "Send us your drone or survey data and receive engineering-grade deliverables, typically within 48 hours.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <section className="section-py">
      <div className="container-px">
        <Reveal>
          <div className="surface relative overflow-hidden p-10 sm:p-16">
            <div className="absolute inset-0 grid-overlay opacity-30" />
            <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
            <div className="absolute -bottom-24 -left-10 h-72 w-72 rounded-full bg-signal/10 blur-3xl" />
            <div className="relative flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
              <div className="max-w-2xl">
                <h2 className="heading-md">{title}</h2>
                <p className="lead mt-4">{description}</p>
              </div>
              <div className="flex flex-wrap gap-4">
                <Link href="/contact" className="btn-primary">
                  Request Consultation
                </Link>
                <Link href="/data-insights" className="btn-secondary">
                  Explore Data Insights
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
