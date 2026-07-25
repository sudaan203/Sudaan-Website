import Link from "next/link";
import Image from "next/image";

/**
 * The logo links to the home page by default.
 *
 * Pass `asLink={false}` when the caller already wraps it in its own link, for
 * example the portal header, which links to the dashboard instead. Nesting one
 * anchor inside another is invalid HTML, and React reacts to it by failing
 * hydration, which in production shows up as a blank page reading "Application
 * error: a client-side exception". That is exactly what broke the owner console.
 */
export default function Logo({
  className = "",
  showWordmark = true,
  asLink = true,
}: {
  className?: string;
  showWordmark?: boolean;
  asLink?: boolean;
}) {
  const Wrapper = asLink ? Link : "span";
  const wrapperProps = asLink
    ? { href: "/", "aria-label": "Sudaan Geo-Analytics home" }
    : {};

  return (
    <Wrapper
      {...(wrapperProps as { href: string })}
      className={`group flex items-center gap-3 ${className}`}
    >
      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center sm:h-12 sm:w-12">
        <Image
          src="/logo-mark.png"
          alt="Sudaan Geo-Analytics logo"
          width={96}
          height={96}
          priority
          className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-105"
        />
      </span>
      {showWordmark && (
        <span className="flex flex-col leading-none">
          <span className="text-base font-bold tracking-tight text-ink-900 sm:text-lg">
            SUDAAN
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-accent-600 sm:text-xs">
            Geo-Analytics
          </span>
        </span>
      )}
    </Wrapper>
  );
}
