const isDev = process.env.NODE_ENV === "development";

/**
 * Content Security Policy.
 *
 * Honest about what it is: strict everywhere except script-src, which still
 * needs 'unsafe-inline' because Next inlines its hydration bootstrap and the
 * nonce alternative means running middleware on every marketing request to mint
 * one. So this does not stop injected inline script; what it does stop is an
 * injected <script src> to someone else's domain, a <base> tag rewriting every
 * relative URL, plugin content, form posts to another origin, and framing by
 * anyone else. Those are worth having now, and the nonce upgrade is a contained
 * change later.
 *
 * 'unsafe-eval' is development only: the dev server's hot reload needs it, and
 * shipping it to production would weaken the policy for no benefit.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  // Tailwind's injected styles and Framer Motion's inline transforms.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // next/font self hosts Inter, so no external font origin is needed.
  "font-src 'self' data:",
  "connect-src 'self'",
  // The PDF viewer frames our own asset route, nothing else.
  "frame-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Superseded by frame-ancestors above, kept for browsers that predate CSP 2.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
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
      // The portal is private: keep it out of search engines, and out of any
      // shared cache between the client and us. Without no-store a proxy or a
      // browser's back/forward cache can hold one client's page and hand it to
      // whoever uses the machine next.
      {
        source: "/portal/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/api/portal/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
        ],
      },
      // Client files get a far tighter policy than the app around them, and it
      // has to be declared here rather than in the route handler: a header set
      // in next.config overrides one the handler sets, so the route's own
      // stricter CSP was being silently discarded. Verified by reading the
      // response, not by reading the code.
      //
      // Not "sandbox", which stops Chrome's built in PDF viewer rendering.
      {
        source: "/api/portal/assets/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
