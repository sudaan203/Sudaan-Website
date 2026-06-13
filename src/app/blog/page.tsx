import type { Metadata } from "next";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import CTASection from "@/components/CTASection";
import { StaggerGroup, StaggerItem } from "@/components/Reveal";
import { ProjectThumb } from "@/components/visuals/ProjectThumb";
import { blogPosts } from "@/data/blog";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Insights on geospatial data processing, DSM vs DTM, ground control accuracy, volumetrics best practices, NDVI analysis and more.",
  alternates: { canonical: "/blog" },
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BlogPage() {
  return (
    <>
      <PageHeader
        eyebrow="Blog"
        title={
          <>
            Field notes on{" "}
            <span className="text-accent-600">geospatial data</span>
          </>
        }
        description="Practical guidance from our processing team on producing accurate, decision-ready geospatial deliverables."
      />

      <section className="section-py">
        <div className="container-px">
          <StaggerGroup className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {blogPosts.map((post) => (
              <StaggerItem key={post.slug}>
                <Link
                  href={`/blog/${post.slug}`}
                  className="surface surface-hover group flex h-full flex-col overflow-hidden"
                >
                  <div className="relative aspect-[16/9] overflow-hidden border-b border-ink/10">
                    <ProjectThumb seed={post.slug} />
                    <span className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                      {post.category}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col p-7">
                    <div className="flex items-center gap-2 text-xs text-ink/50">
                      <span>{formatDate(post.date)}</span>
                      <span className="text-ink/25">·</span>
                      <span>{post.readTime}</span>
                    </div>
                    <h2 className="mt-3 text-lg font-semibold text-ink-900 transition-colors group-hover:text-accent-700">
                      {post.title}
                    </h2>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-ink/60">
                      {post.excerpt}
                    </p>
                    <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-accent-700">
                      Read article
                      <svg viewBox="0 0 24 24" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </div>
                </Link>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      <CTASection />
    </>
  );
}
