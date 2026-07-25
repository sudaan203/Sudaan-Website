#!/usr/bin/env node
/**
 * Creates or updates a client portal login.
 *
 * Usage:
 *   node scripts/portal-user.mjs "Full Name" email@company.com <client-slug|admin> [password]
 *
 * Writes portal-data/users.json (gitignored) and prints the value to paste into
 * the PORTAL_USERS environment variable on Vercel. If no password is given, a
 * strong one is generated and printed once, so copy it before closing the shell.
 *
 * Client slugs come from src/lib/portal/seed.ts.
 */

import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

const ROOT = process.cwd();
const USERS_FILE = path.join(ROOT, "portal-data", "users.json");
const SEED_FILE = path.join(ROOT, "src", "lib", "portal", "seed.ts");

function readClients() {
  const source = readFileSync(SEED_FILE, "utf8");
  const block = source.slice(
    source.indexOf("export const clients"),
    source.indexOf("export const sites"),
  );
  const clients = [];
  const pattern = /id:\s*"([^"]+)"\s*,\s*slug:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(block)) !== null) {
    clients.push({ id: match[1], slug: match[2], name: match[3] });
  }
  return clients;
}

function generatePassword() {
  // Readable but strong: 4 groups of 5 from an unambiguous alphabet.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let group = "";
    for (let i = 0; i < 5; i += 1) group += alphabet[randomInt(alphabet.length)];
    groups.push(group);
  }
  return groups.join("-");
}

function loadUsers() {
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

const [fullName, email, target, providedPassword] = process.argv.slice(2);

if (!fullName || !email || !target) {
  const clients = readClients();
  console.error(
    [
      "Usage: node scripts/portal-user.mjs \"Full Name\" email@company.com <client-slug|admin> [password]",
      "",
      "Available client slugs:",
      ...clients.map((c) => `  ${c.slug}  (${c.name})`),
      "  admin      (Sudaan staff, sees every client)",
    ].join("\n"),
  );
  process.exit(1);
}

const isAdmin = target === "admin";
const clients = readClients();
const client = isAdmin ? null : clients.find((c) => c.slug === target);

if (!isAdmin && !client) {
  console.error(
    `Unknown client slug "${target}". Known slugs: ${clients.map((c) => c.slug).join(", ")}`,
  );
  process.exit(1);
}

const password = providedPassword || generatePassword();
const passwordHash = await bcrypt.hash(password, 12);

const users = loadUsers();
const normalisedEmail = email.trim().toLowerCase();
const existing = users.findIndex((u) => u.email?.toLowerCase() === normalisedEmail);

const record = {
  // A uuid, because the Postgres backend stores user ids as uuid and a session
  // carrying anything else is refused at the SQL boundary.
  id: existing >= 0 ? users[existing].id : randomUUID(),
  email: normalisedEmail,
  fullName,
  role: isAdmin ? "admin" : "client",
  clientId: isAdmin ? null : client.id,
  passwordHash,
};

if (existing >= 0) {
  users[existing] = record;
} else {
  users.push(record);
}

mkdirSync(path.dirname(USERS_FILE), { recursive: true });
writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`, "utf8");

console.log(`${existing >= 0 ? "Updated" : "Created"} portal login`);
console.log(`  Name     ${fullName}`);
console.log(`  Email    ${normalisedEmail}`);
console.log(`  Access   ${isAdmin ? "admin (all clients)" : `${client.name} (${client.slug})`}`);
if (!providedPassword) {
  console.log(`  Password ${password}`);
  console.log("\nCopy the password now, it is not stored anywhere in readable form.");
}
console.log(`\nSaved to portal-data/users.json (gitignored, ${users.length} user(s) total).`);
console.log("\nFor Vercel, set PORTAL_USERS to this single line:");
console.log(JSON.stringify(users));
