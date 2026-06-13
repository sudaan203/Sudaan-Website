import Link from "next/link";
import Image from "next/image";
import { asset } from "@/lib/asset";

export default function Logo({
  className = "",
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <Link
      href="/"
      className={`group flex items-center gap-3 ${className}`}
      aria-label="Sudaan Geo-Analytics home"
    >
      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center sm:h-12 sm:w-12">
        <Image
          src={asset("/logo-mark.png")}
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
    </Link>
  );
}
