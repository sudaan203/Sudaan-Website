import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import CTASection from "@/components/CTASection";
import Reveal from "@/components/Reveal";
import { ProjectThumb } from "@/components/visuals/ProjectThumb";
import { blogPosts } from "@/data/blog";
import { siteConfig } from "@/lib/site";

export function generateStaticParams() {
  return blogPosts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = blogPosts.find((p) => p.slug === slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.excerpt,
      publishedTime: post.date,
    },
  };
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = blogPosts.find((p) => p.slug === slug);
  if (!post) notFound();

  const related = blogPosts.filter((p) => p.slug !== slug).slice(0, 3);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    author: { "@type": "Organization", name: post.author },
    publisher: { "@type": "Organization", name: siteConfig.name },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PageHeader
        eyebrow={`${post.category} · ${post.readTime}`}
        title={post.title}
        description={post.excerpt}
      >
        <p className="text-sm text-ink/50">
          {formatDate(post.date)} · {post.author}
        </p>
      </PageHeader>

      <article className="section-py">
        <div className="container-px">
          <Reveal>
            <div className="mx-auto max-w-3xl">
              <div className="aspect-[16/7] overflow-hidden rounded-2xl border border-ink/10">
                <ProjectThumb seed={post.slug} />
              </div>
              <div className="mt-10 space-y-6">
                {post.body.map((para, i) => (
                  <p
                    key={i}
                    className="text-lg leading-relaxed text-ink/80"
                  >
                    {para}
                  </p>
                ))}
              </div>

              <div className="mt-12 border-t border-ink/10 pt-8">
                <Link href="/blog" className="btn-secondary">
                  ← Back to all articles
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </article>

      {/* Related */}
      <section className="section-py border-t border-ink/[0.06]">
        <div className="container-px">
          <h2 className="heading-md">More articles</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {related.map((p) => (
              <Link
                key={p.slug}
                href={`/blog/${p.slug}`}
                className="surface surface-hover group p-6"
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-accent-600">
                  {p.category}
                </span>
                <h3 className="mt-3 text-base font-semibold text-ink-900 transition-colors group-hover:text-accent-700">
                  {p.title}
                </h3>
                <p className="mt-2 text-sm text-ink/60">{p.excerpt}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <CTASection />
    </>
  );
}
