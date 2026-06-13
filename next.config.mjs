// GitHub Pages project sites are served from /<repo>/, so a static export needs
// a basePath. Enabled only when GITHUB_PAGES=true (set in the deploy workflow);
// local dev and server (Vercel) builds keep full features.
const isPages = process.env.GITHUB_PAGES === "true";
const basePath = isPages ? "/Sudaan-Website" : "";

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
  basePath,
  assetPrefix: basePath || undefined,
  // Expose the base path to client code (raw <a>/<img> use lib/asset.ts).
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  images: {
    // Static export has no image optimizer; serve images as-is on Pages.
    unoptimized: isPages,
    formats: ["image/avif", "image/webp"],
  },
  ...(isPages
    ? { output: "export" } // emit a fully static site into ./out
    : {
        // headers() only applies on a server runtime (ignored by static export)
        async headers() {
          return [{ source: "/:path*", headers: securityHeaders }];
        },
      }),
};

export default nextConfig;
