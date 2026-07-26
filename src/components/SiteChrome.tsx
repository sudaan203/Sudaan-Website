"use client";

import { usePathname } from "next/navigation";

/**
 * Decides whether a page gets the marketing chrome (background decor, scroll
 * progress, navbar, footer, back to top). The client portal has its own shell,
 * so it opts out.
 *
 * The chrome is passed in as props rather than imported here, so those pieces
 * stay server components and marketing pages render exactly as before.
 *
 * Tradeoff: on portal routes the chrome is still serialised into the RSC payload
 * even though nothing renders it, which costs a few KB on private pages. Keeping
 * the marketing site's rendering untouched is worth that. To remove it later,
 * move the marketing routes into a (site) route group with its own layout.
 */
export default function SiteChrome({
  top,
  bottom,
  children,
}: {
  top: React.ReactNode;
  bottom: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isPortal = pathname?.startsWith("/portal") ?? false;

  if (isPortal) return <>{children}</>;

  return (
    <>
      {top}
      <main id="main" className="relative min-h-screen pt-20">
        {children}
      </main>
      {bottom}
    </>
  );
}
