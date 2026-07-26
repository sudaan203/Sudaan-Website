import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { siteConfig } from "@/lib/site";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import BackgroundDecor from "@/components/BackgroundDecor";
import ScrollProgress from "@/components/ScrollProgress";
import BackToTop from "@/components/BackToTop";
import SiteChrome from "@/components/SiteChrome";
import NavProgress from "@/components/NavProgress";
import MotionProvider from "@/components/MotionProvider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: `${siteConfig.name}: ${siteConfig.tagline}`,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: siteConfig.keywords,
  authors: [{ name: siteConfig.name }],
  creator: siteConfig.name,
  publisher: siteConfig.name,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteConfig.url,
    siteName: siteConfig.name,
    title: `${siteConfig.name}: ${siteConfig.tagline}`,
    description: siteConfig.description,
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: siteConfig.name,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteConfig.name}: ${siteConfig.tagline}`,
    description: siteConfig.description,
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  category: "technology",
};

export const viewport: Viewport = {
  themeColor: "#FAF7F2",
  width: "device-width",
  initialScale: 1,
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: siteConfig.name,
  url: siteConfig.url,
  description: siteConfig.description,
  email: siteConfig.email,
  telephone: siteConfig.phones,
  address: {
    "@type": "PostalAddress",
    streetAddress: "405 Ugati Complex, Randesan",
    addressLocality: "Gandhinagar",
    addressRegion: "Gujarat",
    postalCode: "382419",
    addressCountry: "IN",
  },
  sameAs: [siteConfig.social.linkedin, siteConfig.social.twitter],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {/* Outside SiteChrome so the portal gets it too: the portal is where
            navigations actually take time. */}
        <NavProgress />

        <a
          href="#main"
          className="sr-only z-[70] focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:rounded-full focus:bg-accent-600 focus:px-5 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>

        <MotionProvider>
          <SiteChrome
            top={
              <>
                <BackgroundDecor />
                <ScrollProgress />
                <Navbar />
              </>
            }
            bottom={
              <>
                <Footer />
                <BackToTop />
              </>
            }
          >
            {children}
          </SiteChrome>
        </MotionProvider>
      </body>
    </html>
  );
}
