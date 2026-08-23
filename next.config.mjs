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
  /**
   * MapLibre renders through WebGL and decodes tiles in a worker it creates from
   * a blob, so `blob:` is required for the survey map to draw at all.
   *
   * The basemap needs **both** OpenStreetMap forms listed, and getting this wrong
   * is what broke it:
   *
   *   https://tile.openstreetmap.org      <- what we actually request
   *   https://*.tile.openstreetmap.org    <- what was listed
   *
   * A CSP wildcard matches subdomains and **not** the bare domain, so every
   * basemap tile was blocked by policy. Nothing looked broken in our own code:
   * MapLibre just drew nothing under the survey, because a CSP violation is not a
   * failed request the map can report. The bare domain is the canonical host now;
   * the a/b/c subdomains are kept only for older clients.
   */
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // next/font self hosts Inter, so no external font origin is needed.
  "font-src 'self' data:",
  "connect-src 'self' https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
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

    // Only the layer route serves tile bytes, so it is the only entry that needs
    // the whole pyramid.
    "/api/portal/sites/[siteSlug]/map/[...path]/route": ["portal-data/map/**"],

    /**
     * Every portal page needs manifest.json, because the shared `[siteSlug]`
     * layout calls readMapManifest to decide whether to show the Map tab.
     *
     * Two traps here, both of which produced a silent failure and cost a
     * production bug that survived two "shipped" claims:
     *
     * 1. **There is no layout entry to add.** Next does not emit a trace for a
     *    layout; a layout is bundled into each page function that renders it. The
     *    old config keyed on "/portal/[siteSlug]/layout", which matched nothing.
     *    The map page had its own entry so the map itself worked, while the
     *    layout's readMapManifest returned null on every other page, so the Map
     *    tab never rendered in production and nothing linked to the map at all.
     *
     * 2. **These keys are globs, so `[` and `]` are character classes.** Keys
     *    spelled "/portal/[siteSlug]/page" therefore match nothing: the brackets
     *    are read as "one character from s,i,t,e,S,l,u,g". Verified by building
     *    with them and finding zero manifests in the trace. Use a wildcard.
     *
     * Also kept narrow deliberately: these pages never read a tile, only the
     * manifest, so including `portal-data/map/**` here would put 2,164 files into
     * functions that need two.
     *
     * scripts/portal-tracing-test.mjs asserts this stays true, because the whole
     * failure mode is invisible: no error, no warning, just a missing tab.
     */
    "/portal/**": ["portal-data/map/*/manifest.json"],
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
      /*
       * Rendered tiles are the one exception, and they must be, because
       * `no-store` here is not merely wasteful: a map view is roughly twenty
       * tiles, each is read from the source raster, reprojected per pixel,
       * shaded and encoded, and without caching every pan repeats all of it.
       *
       * `private` still does the work the blanket rule was written for. It keeps
       * survey imagery out of every shared cache; only the end user's own
       * browser may keep a copy, which is the same thing it does with the
       * decoded pixels on screen anyway. `immutable` is honest here in a way it
       * would not be for a page: a tile is a pure function of the survey, the
       * layer and the query, so the only thing that can change it is
       * republishing, which changes the survey.
       *
       * This has to live in next.config rather than in the route handler. A
       * header set here overrides one the handler sets, which is exactly how the
       * route's own Cache-Control was being discarded, and how the client files
       * rule below lost its CSP. Later entries win, so this must stay after the
       * general rule above.
       */
      {
        source: "/api/portal/sites/:slug/render/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, max-age=86400, immutable" },
        ],
      },
      /*
       * Point cloud nodes, for the same reason and with the same trap.
       *
       * A node is written once by an offline pipeline and does not change until
       * the survey is reflown, and a view of a cloud is dozens of them. Under
       * the general `no-store` rule above, panning across a site refetched every
       * node it had already drawn.
       *
       * The route sets a shorter life on the manifest itself, which this would
       * override — so the manifest is served from `/cloud` with no further path
       * segments and the pattern below requires at least one, leaving the
       * manifest to the general rule and to the handler.
       */
      /*
       * The manifest itself, which the pattern below deliberately excludes.
       *
       * Five minutes rather than a day: this is the file that tells a client a
       * *new* cloud has been published, and a stale one would hide a reflight
       * behind a browser cache nobody can reach to clear. But it is 320 KB, and
       * under the general `no-store` rule above it was refetched on every single
       * page load.
       */
      {
        source: "/api/portal/sites/:slug/cloud",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, max-age=300" },
        ],
      },
      {
        source: "/api/portal/sites/:slug/cloud/:node+",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, max-age=86400, immutable" },
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
