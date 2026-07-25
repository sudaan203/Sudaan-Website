/**
 * User lookup and password verification. Node runtime only (uses bcryptjs and fs).
 *
 * Users are never committed to git. They come from either:
 *   1. PORTAL_USERS, a JSON array in an environment variable (used on Vercel), or
 *   2. portal-data/users.json, a gitignored file (used in local development).
 *
 * Create entries with: node scripts/portal-user.mjs "Full Name" email@example.com client-slug
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { PortalUser } from "./types";

let cache: PortalUser[] | null = null;

function parseUsers(raw: string, source: string): PortalUser[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON array of users`);
  }
  return parsed.map((u, i) => {
    for (const field of ["id", "email", "fullName", "role", "passwordHash"]) {
      if (typeof u[field] !== "string" || !u[field]) {
        throw new Error(`${source}: user ${i} is missing "${field}"`);
      }
    }
    return {
      id: u.id,
      email: String(u.email).toLowerCase(),
      fullName: u.fullName,
      role: u.role === "admin" ? "admin" : "client",
      clientId: u.role === "admin" ? null : (u.clientId ?? null),
      passwordHash: u.passwordHash,
    } satisfies PortalUser;
  });
}

function loadUsers(): PortalUser[] {
  if (cache) return cache;

  const fromEnv = process.env.PORTAL_USERS;
  if (fromEnv && fromEnv.trim()) {
    cache = parseUsers(fromEnv, "PORTAL_USERS");
    return cache;
  }

  try {
    const file = path.join(process.cwd(), "portal-data", "users.json");
    cache = parseUsers(readFileSync(file, "utf8"), "portal-data/users.json");
    return cache;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.warn(
        "[portal] no users configured. Set PORTAL_USERS or create portal-data/users.json",
      );
      cache = [];
      return cache;
    }
    throw err;
  }
}

/**
 * Verifies credentials. Returns the user on success, null on any failure.
 * Runs a bcrypt compare even when the email is unknown, so response timing
 * does not reveal which emails exist.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<PortalUser | null> {
  const users = loadUsers();
  const user = users.find((u) => u.email === email.trim().toLowerCase());
  const hash =
    user?.passwordHash ??
    "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
  const ok = await bcrypt.compare(password, hash);
  return ok && user ? user : null;
}

export function findUserById(id: string) {
  return loadUsers().find((u) => u.id === id) ?? null;
}
