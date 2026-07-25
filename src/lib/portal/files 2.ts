/**
 * Reads portal files off disk. Node runtime only.
 *
 * Files live in portal-data/files, which is OUTSIDE public/, so nothing here is
 * reachable without passing through an authorised route handler. When we move to
 * hosted storage (Supabase Storage or R2), only this module changes: it becomes
 * a signed URL generator, and callers keep the same shape.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const FILES_ROOT = path.join(process.cwd(), "portal-data", "files");

/**
 * Resolves a storage key to an absolute path, refusing anything that escapes
 * the files root. Keys come from our own catalogue, but this guard means a bad
 * key can never turn into a path traversal.
 */
function resolveKey(storageKey: string): string {
  const resolved = path.resolve(FILES_ROOT, storageKey);
  const root = path.resolve(FILES_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refusing storage key outside the files root: ${storageKey}`);
  }
  return resolved;
}

export async function readPortalFile(storageKey: string): Promise<Buffer> {
  return readFile(resolveKey(storageKey));
}

export async function portalFileExists(storageKey: string): Promise<boolean> {
  try {
    const info = await stat(resolveKey(storageKey));
    return info.isFile();
  } catch {
    return false;
  }
}
