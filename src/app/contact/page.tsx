import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import ContactForm from "@/components/ContactForm";
import Reveal from "@/components/Reveal";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Request a consultation. Tell us about your site and the data you have. We deliver engineering-grade geospatial outputs, typically within 48 hours.",
  alternates: { canonical: "/contact" },
};

const points = [
  {
    label: "Email",
    value: siteConfig.email,
    href: `mailto:${siteConfig.email}`,
  },
  ...siteConfig.phones.map((phone) => ({
    label: "Phone",
    value: phone,
    href: `tel:${phone.replace(/\s/g, "")}`,
  })),
  { label: "Location", value: siteConfig.address },
];

const expect = [
  "A response within one business day",
  "A scoped deliverable list and timeline",
  "Transparent pricing and accuracy targets",
  "Secure data transfer instructions",
];

export default function ContactPage() {
  return (
    <>
      <PageHeader
        eyebrow="Contact"
        title={
          <>
            Request a{" "}
            <span className="text-accent-600">consultation</span>
          </>
        }
        description="Tell us about your project and the data you have. We'll come back with a scoped set of deliverables, a timeline and a quote."
      />

      <section className="section-py">
        <div className="container-px grid gap-12 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <Reveal>
              <h2 className="heading-md">Let&apos;s talk data</h2>
              <p className="lead mt-4">
                Whether you have raw drone imagery ready to process or are
                planning a survey, our team can help you scope the right
                deliverables.
              </p>
            </Reveal>

            <div className="mt-10 space-y-4">
              {points.map((p) => (
                <Reveal key={`${p.label}-${p.value}`}>
                  <div className="surface flex items-center justify-between p-5">
                    <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
                      {p.label}
                    </span>
                    {p.href ? (
                      <a
                        href={p.href}
                        className="text-sm font-medium text-ink-900 transition-colors hover:text-accent-700"
                      >
                        {p.value}
                      </a>
                    ) : (
                      <span className="text-sm font-medium text-ink-900">
                        {p.value}
                      </span>
                    )}
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal className="mt-10">
              <div className="surface border-accent/20 bg-accent/5 p-6">
                <h3 className="text-sm font-semibold text-ink-900">
                  What to expect
                </h3>
                <ul className="mt-4 space-y-2.5">
                  {expect.map((e) => (
                    <li
                      key={e}
                      className="flex items-start gap-2 text-sm text-ink/80"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="mt-0.5 h-4 w-4 shrink-0 text-signal"
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
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>

          <Reveal direction="left">
            <ContactForm />
          </Reveal>
        </div>
      </section>
    </>
  );
}
