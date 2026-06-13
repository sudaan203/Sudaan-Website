import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";
import { navLinks } from "@/lib/site";
import { blogPosts } from "@/data/blog";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  const staticRoutes: MetadataRoute.Sitemap = navLinks.map((link) => ({
    url: `${siteConfig.url}${link.href === "/" ? "" : link.href}`,
    lastModified,
    changeFrequency: link.href === "/" ? "weekly" : "monthly",
    priority: link.href === "/" ? 1 : link.href === "/data-insights" ? 0.9 : 0.7,
  }));

  const blogRoutes: MetadataRoute.Sitemap = blogPosts.map((post) => ({
    url: `${siteConfig.url}/blog/${post.slug}`,
    lastModified: new Date(post.date),
    changeFrequency: "yearly",
    priority: 0.6,
  }));

  return [...staticRoutes, ...blogRoutes];
}

export const dynamic = "force-static";
