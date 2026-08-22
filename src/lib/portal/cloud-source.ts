/**
 * A site's LiDAR point cloud, as a quadtree of streamable nodes.
 *
 * Built once, offline, by `scripts/prepare-point-cloud.mjs`. Nothing here reads
 * a LAS file: Aektanagar's is 1.7 GB and 50,183,644 points, and no request
 * should ever touch it.
 *
 * The arrangement is the third instance of the same pattern in this codebase,
 * and deliberately so. Terrain is read as windows over byte ranges because the
 * rasters are enormous and a client only ever draws on part of one. Hydrology is
 * read whole because it is half a megabyte and routing cannot be windowed. A
 * cloud is read as *nodes*, which is a window with the level of detail chosen in
 * advance, because the browser's limit is how many points it can draw at once
 * rather than how many bytes it can hold.
 *
 * Local or remote, exactly as terrain and hydrology are: `PORTAL_CLOUD_URL`
 * wins, and it nests under `sites/<slug>/cloud/` for the same reason hydrology
 * nests — the map pyramid already owns `sites/<slug>/manifest.json`, and a
 * second file of that name at the same prefix would overwrite it, with the
 * symptom being the map losing its layers rather than anything mentioning point
 * clouds.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTileGrant, TILE_GRANT_COOKIE } from "@/lib/portal/tile-grant";

export class CloudUnavailable extends Error {
  readonly reason: "missing" | "incomplete";
  constructor(reason: "missing" | "incomplete", message: string) {
    super(message);
    this.reason = reason;
    this.name = "CloudUnavailable";
  }
}

/** One quadtree node, as the manifest describes it. */
export type CloudNode = {
  /** "level/col/row". */
  key: string;
  file: string;
  level: number;
  count: number;
  /** Metres between neighbouring points here: what the viewer picks LOD on. */
  spacing: number;
  /** [west, south, east, north], so a node can be culled before it is fetched. */
  lonLatBounds: [number, number, number, number];
  /**
   * The same box in the survey's projected metres.
   *
   * The quadtree is defined in UTM, so containment is exact here and only
   * approximate in longitude and latitude, where meridian convergence tilts the
   * grid. Carried so the invariant can actually be asserted.
   */
  utmBounds: [number, number, number, number];
  /** Dequantisation: mercator = origin + q / 65535 * span. */
  origin: [number, number, number];
  span: [number, number, number];
};

export type CloudManifest = {
  site: string;
  generatedAt: string;
  source: string;
  format: "SGAPC1";
  crs: { epsg: number | null; name: string | null };
  sourcePointCount: number;
  storedPointCount: number;
  hasColour: boolean;
  classifications: { code: number; name: string; count: number }[];
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
  lonLatBounds: [number, number, number, number];
  elevation: { min: number; max: number };
  grid: number;
  maxDepth: number;
  rootSpacing: number;
  /** The square the quadtree divides, in UTM. */
  rootSquare: [number, number, number, number];
  nodes: CloudNode[];
};

function cloudLocation(siteSlug: string) {
  const url = process.env.PORTAL_CLOUD_URL;
  if (url) {
    return { remote: true as const, base: `${url.replace(/\/+$/, "")}/${siteSlug}/cloud` };
  }
  const dir = process.env.PORTAL_CLOUD_DIR ?? join(process.cwd(), "portal-data", "cloud");
  return { remote: false as const, base: join(dir, siteSlug) };
}

/**
 * A node file's name, derived from its key and validated on the way.
 *
 * The key reaches this from a URL, so it is parsed rather than trusted: three
 * non-negative integers and nothing else. Building a path from an unchecked
 * segment is how a slug climbs out of its directory, and this one is joined onto
 * a filesystem path in the local case.
 */
export function nodeFileName(key: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,4})\/(\d{1,4})$/.exec(key);
  if (!match) return null;
  const [, level, col, row] = match;
  return `${Number(level)}-${Number(col)}-${Number(row)}.pnt`;
}

async function fetchBytes(
  siteSlug: string,
  remote: boolean,
  ref: string,
): Promise<Buffer | null> {
  if (!remote) return existsSync(ref) ? readFile(ref) : null;
  const response = await fetch(ref, {
    headers: { Cookie: `${TILE_GRANT_COOKIE}=${await createTileGrant(siteSlug)}` },
  });
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

const cache = new Map<string, Promise<CloudManifest>>();

/** A site's cloud manifest, or a stated reason there is none. */
export async function loadCloudManifest(siteSlug: string): Promise<CloudManifest> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteSlug)) {
    throw new CloudUnavailable("missing", `"${siteSlug}" is not a valid site slug`);
  }
  const hit = cache.get(siteSlug);
  if (hit) return hit;

  const loading = (async (): Promise<CloudManifest> => {
    const { remote, base } = cloudLocation(siteSlug);
    const ref = remote ? `${base}/cloud.json` : join(base, "cloud.json");
    const bytes = await fetchBytes(siteSlug, remote, ref);
    if (!bytes) {
      // Written for whoever runs the pipeline. The route turns this into client
      // wording from `reason`; it must never be shown as it stands, because it
      // names paths a client cannot act on.
      throw new CloudUnavailable(
        "missing",
        `No point cloud has been prepared for this site. Run: ` +
          `node scripts/prepare-point-cloud.mjs --site ${siteSlug} --las <file.las>`,
      );
    }
    let manifest: CloudManifest;
    try {
      manifest = JSON.parse(bytes.toString("utf8")) as CloudManifest;
    } catch {
      throw new CloudUnavailable("incomplete", "The point cloud manifest could not be read.");
    }
    if (manifest.format !== "SGAPC1" || !Array.isArray(manifest.nodes)) {
      throw new CloudUnavailable("incomplete", "The point cloud manifest is not in a known form.");
    }
    return manifest;
  })();

  cache.set(siteSlug, loading);
  loading.catch(() => cache.delete(siteSlug));
  return loading;
}

/** One node's points, exactly as written. Null when there is no such node. */
export async function readCloudNode(siteSlug: string, key: string): Promise<Buffer | null> {
  const name = nodeFileName(key);
  if (!name) return null;
  /*
   * Checked against the manifest, not just against the pattern. A well-formed
   * key for a node that was never written would otherwise become a filesystem
   * probe: the response would distinguish "exists" from "does not" for any path
   * shaped like a node.
   */
  const manifest = await loadCloudManifest(siteSlug);
  if (!manifest.nodes.some((n) => n.key === key)) return null;

  const { remote, base } = cloudLocation(siteSlug);
  const ref = remote ? `${base}/nodes/${name}` : join(base, "nodes", name);
  return fetchBytes(siteSlug, remote, ref);
}
