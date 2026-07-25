const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  images: {
    formats: ["image/avif", "image/webp"],
  },
  // Client portal deliverables live outside public/ and are read at runtime by
  // the asset route, so Vercel must bundle them with that serverless function.
  // Keep this pattern narrow and anchored: a broad glob here walks the whole
  // project (including the multi hundred MB gitignored survey data) and hangs
  // the build at the trace collection step.
  outputFileTracingIncludes: {
    "/api/portal/assets/[assetId]/view/route": ["portal-data/files/**"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The portal is private: keep it out of search engines entirely.
      {
        source: "/portal/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
