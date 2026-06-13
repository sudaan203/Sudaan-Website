import type { ReactElement } from "react";

type Props = { name: string; className?: string };

const common = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export default function ServiceIcon({ name, className = "h-6 w-6" }: Props) {
  const paths: Record<string, ReactElement> = {
    ortho: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
      </>
    ),
    dsm: (
      <>
        <path d="M3 17l5-6 4 3 3-5 6 8" />
        <path d="M3 21h18" />
        <path d="M8 11V7M14 9V5" />
      </>
    ),
    dtm: (
      <>
        <path d="M3 18c4-1 5-5 9-5s5 4 9 3" />
        <path d="M3 21h18" />
        <path d="M3 13c4-1 5-4 9-4s5 3 9 2" />
      </>
    ),
    contour: (
      <>
        <path d="M12 12m-2 0a2 2 0 104 0 2 2 0 10-4 0" />
        <path d="M12 12m-5 0a5 5 0 1010 0 5 5 0 10-10 0" />
        <path d="M12 12m-8 0a8 8 0 1016 0 8 8 0 10-16 0" />
      </>
    ),
    pointcloud: (
      <>
        <circle cx="6" cy="8" r="1" />
        <circle cx="12" cy="5" r="1" />
        <circle cx="18" cy="9" r="1" />
        <circle cx="8" cy="14" r="1" />
        <circle cx="15" cy="13" r="1" />
        <circle cx="6" cy="19" r="1" />
        <circle cx="13" cy="19" r="1" />
        <circle cx="19" cy="17" r="1" />
        <circle cx="11" cy="10" r="1" />
      </>
    ),
    gis: (
      <>
        <path d="M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" />
        <path d="M9 3v15M15 6v15" />
      </>
    ),
    volume: (
      <>
        <path d="M12 3l9 5v8l-9 5-9-5V8l9-5z" />
        <path d="M3 8l9 5 9-5M12 13v8" />
      </>
    ),
    progress: (
      <>
        <path d="M3 3v18h18" />
        <path d="M7 15l3-4 3 2 4-6" />
        <circle cx="20" cy="7" r="1.4" />
      </>
    ),
    corridor: (
      <>
        <path d="M5 21L9 3M19 21l-4-18" />
        <path d="M11 7h2M10 12h4M9 17h6" />
      </>
    ),
    intel: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M11 8v6M8 11h6" />
        <path d="M16.5 16.5L21 21" />
      </>
    ),
    survey: (
      <>
        <path d="M12 2v6M12 8l-6 12M12 8l6 12" />
        <circle cx="12" cy="6" r="2" />
        <path d="M5 20h14" />
      </>
    ),
    gps: (
      <>
        <circle cx="12" cy="10" r="3" />
        <path d="M12 2v3M12 15v7M2 10h3M19 10h3" />
        <circle cx="12" cy="10" r="8" />
      </>
    ),
    pipeline: (
      <>
        <path d="M3 8h10a3 3 0 013 3v5h5" />
        <circle cx="3" cy="8" r="1.4" />
        <path d="M13 8v3M16 13h-3" />
      </>
    ),
    flood: (
      <>
        <path d="M3 16c2 0 2-1.5 4.5-1.5S10 16 12 16s2-1.5 4.5-1.5S19 16 21 16" />
        <path d="M3 20c2 0 2-1.5 4.5-1.5S10 20 12 20s2-1.5 4.5-1.5S19 20 21 20" />
        <path d="M7 11l5-8 5 8" />
      </>
    ),
    mine: (
      <>
        <path d="M14 3l7 7M18 6l-4 4" />
        <path d="M11 7L3 21h13l-2-9z" />
      </>
    ),
    inspect: (
      <>
        <rect x="3" y="4" width="14" height="14" rx="2" />
        <path d="M7 9h6M7 13h4" />
        <circle cx="17" cy="17" r="3.5" />
        <path d="M19.5 19.5L22 22" />
      </>
    ),
    lidar: (
      <>
        <path d="M12 3v5" />
        <path d="M12 8L5 21M12 8l7 13M12 8l-3 13M12 8l3 13" strokeOpacity="0.8" />
        <circle cx="12" cy="4" r="1.6" />
      </>
    ),
    scan: (
      <>
        <path d="M4 7V5a1 1 0 011-1h2M20 7V5a1 1 0 00-1-1h-2M4 17v2a1 1 0 001 1h2M20 17v2a1 1 0 01-1 1h-2" />
        <path d="M4 12h16" />
        <path d="M8 9l4-1 4 1M8 15l4 1 4-1" strokeOpacity="0.7" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>
    ),
    solar: (
      <>
        <rect x="3" y="11" width="18" height="8" rx="1" />
        <path d="M3 15h18M9 11v8M15 11v8" />
        <path d="M12 3v3M6 6l1.5 1.5M18 6l-1.5 1.5" />
      </>
    ),
    transmission: (
      <>
        <path d="M12 2v20M7 22l5-14 5 14" />
        <path d="M5 7h14M7 11h10" />
      </>
    ),
    wind: (
      <>
        <path d="M12 13v8M9 21h6" />
        <path d="M12 13l1-7M12 13l6 3M12 13l-7 2" />
        <circle cx="12" cy="13" r="1.4" />
      </>
    ),
    power: (
      <>
        <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
      </>
    ),
    forest: (
      <>
        <path d="M12 2l4 6h-3l3 5h-8l3-5H8z" />
        <path d="M12 13v8" />
        <path d="M5 21h14" />
      </>
    ),
    leaf: (
      <>
        <path d="M5 19c0-8 6-13 14-13 0 8-6 13-14 13z" />
        <path d="M5 19c3-5 6-7 10-9" />
      </>
    ),
    landcover: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 14l5-4 4 3 3-4 6 5" />
        <path d="M3 9h6M15 7h6" strokeOpacity="0.6" />
      </>
    ),
    watershed: (
      <>
        <path d="M12 3v7M12 10l-5 11M12 10l5 11" />
        <path d="M7 16c1.5 0 1.5-1 3-1M14 15c1.5 0 1.5 1 3 1" strokeOpacity="0.7" />
      </>
    ),
  };

  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      {paths[name] ?? paths.gis}
    </svg>
  );
}
