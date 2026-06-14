import Link from "next/link";
import Logo from "./Logo";
import { navLinks, sectors, siteConfig } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="relative mt-10 border-t border-ink/10 bg-mist/60">
      <div className="container-px py-16">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="max-w-sm">
            <Logo />
            <p className="mt-5 text-sm leading-relaxed text-ink/60">
              {siteConfig.description}
            </p>
            <div className="mt-6 flex gap-3">
              <a
                href={siteConfig.social.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink/10 text-ink/60 transition-colors hover:border-accent/50 hover:text-accent-600"
                aria-label="LinkedIn"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                  <path d="M4.98 3.5a2.5 2.5 0 11-.02 5 2.5 2.5 0 01.02-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-1 1.83-2.05 3.76-2.05C21.4 8.65 22 11 22 14.2V21h-4v-6c0-1.43-.03-3.27-2-3.27-2 0-2.3 1.56-2.3 3.17V21h-4z" />
                </svg>
              </a>
              <a
                href={siteConfig.social.twitter}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink/10 text-ink/60 transition-colors hover:border-accent/50 hover:text-accent-600"
                aria-label="X"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                  <path d="M18.9 2H22l-7.3 8.3L23 22h-6.7l-5.2-6.8L5.1 22H2l7.8-8.9L1.6 2h6.9l4.7 6.2zM17.7 20h1.7L7.4 3.9H5.6z" />
                </svg>
              </a>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-ink-900">Navigate</h3>
            <ul className="mt-4 space-y-2.5">
              {navLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-ink/60 transition-colors hover:text-accent-600"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-ink-900">Sectors</h3>
            <ul className="mt-4 space-y-2.5">
              {sectors.slice(0, 8).map((sector) => (
                <li
                  key={sector}
                  className="flex items-center gap-2 text-sm text-ink/60"
                >
                  <span className="h-1 w-1 rounded-full bg-accent-500" />
                  {sector}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-ink-900">Contact</h3>
            <ul className="mt-4 space-y-2.5 text-sm text-ink/60">
              <li>
                <a
                  href={`mailto:${siteConfig.email}`}
                  className="transition-colors hover:text-accent-600"
                >
                  {siteConfig.email}
                </a>
              </li>
              {siteConfig.phones.map((phone) => (
                <li key={phone}>
                  <a
                    href={`tel:${phone.replace(/\s/g, "")}`}
                    className="transition-colors hover:text-accent-600"
                  >
                    {phone}
                  </a>
                </li>
              ))}
              <li>{siteConfig.address}</li>
            </ul>
            <Link href="/contact" className="btn-secondary mt-5 text-xs">
              Request Consultation
            </Link>
          </div>
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-ink/10 pt-8 text-xs text-ink/50 sm:flex-row">
          <p>
            © {new Date().getFullYear()} {siteConfig.name}. All rights reserved.
          </p>
          <p>Engineering-grade geospatial analytics.</p>
        </div>
      </div>
    </footer>
  );
}
