/**
 * Catching the storage misconfiguration that looks like an empty portal.
 *
 * Each of terrain, hydrology and the point cloud reads from either a local
 * directory or a URL. On Vercel only the URL can work: the filesystem is read
 * only, the rasters are gitignored and total hundreds of megabytes, and a
 * serverless bundle caps out around 250 MB. There is no value of
 * `PORTAL_TERRAIN_DIR` that works there.
 *
 * The failure when someone sets one anyway is the worst shape available. No
 * error is raised — a missing file is a legitimate answer to "does this site
 * have hydrology?" — so the site loads, the tools are simply absent, and it
 * reads as "the portal is broken" rather than "one environment variable points
 * at a disk that does not exist".
 *
 * ## Why this checks the directory rather than the environment
 *
 * The obvious rule is "refuse `_DIR` in production", and it is wrong. It assumes
 * production means Vercel, which is true today and is not a property of the
 * code — the same build on a VM with a real disk would be refused for no reason.
 *
 * What is actually broken is narrower and can be tested directly: a directory
 * was named and it is not there. That catches the Vercel case exactly, stays
 * silent on a deployment where the disk is real, and needs no belief about where
 * this is running.
 */

import { existsSync } from "node:fs";

const warned = new Set<string>();

/**
 * @param dirVar e.g. "PORTAL_TERRAIN_DIR"
 * @param urlVar the remote alternative, named in the message because it is the fix
 * @param dir the resolved directory, default or explicit
 * @param explicit whether the environment named it, as opposed to falling back
 *
 * Throws when an explicitly configured directory is absent, because a stated
 * intention that cannot be honoured should stop rather than degrade. A default
 * that happens not to exist only warns: that is an ordinary local checkout with
 * no survey data in it, which is a normal state for someone working on the
 * marketing site.
 */
export function checkStorageDir(
  dirVar: string,
  urlVar: string,
  dir: string,
  explicit: boolean,
): void {
  if (existsSync(dir)) return;

  const message =
    `${dirVar} is set to "${dir}", which does not exist. ` +
    `Nothing will be served from it, and the portal will look like it has no data ` +
    `rather than reporting an error. On a deployment with no persistent disk ` +
    `(Vercel), unset ${dirVar} and set ${urlVar} to the tile Worker's base URL instead.`;

  if (explicit) throw new Error(`[portal] ${message}`);

  if (!warned.has(dirVar)) {
    warned.add(dirVar);
    console.warn(`[portal] ${dir} does not exist, so ${dirVar} serves nothing. ${message}`);
  }
}
