// Prefix a public asset path with the deploy base path (set for GitHub Pages
// project sites, e.g. "/Sudaan-Website"). Empty in normal/local/Vercel builds.
// Use this for RAW <a href> / <img src> to /public files — next/link and
// next/image already apply the base path automatically.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function asset(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE}${path}`;
}
