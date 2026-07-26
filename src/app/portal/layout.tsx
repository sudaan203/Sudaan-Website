import type { Metadata } from "next";
import { getSession } from "@/lib/portal/auth";
import PortalHeader from "@/components/portal/PortalHeader";

export const metadata: Metadata = {
  title: "Client Portal",
  description: "Secure access to your Sudaan Geo-Analytics deliverables.",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Portal shell. The marketing navbar and footer are suppressed for /portal by
 * SiteChrome, so this layout owns the whole frame.
 */
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      {session ? <PortalHeader session={session} /> : null}
      {/* The portal had no main landmark, so "skip to content" and screen reader
          navigation had nothing to target. */}
      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>
    </div>
  );
}
