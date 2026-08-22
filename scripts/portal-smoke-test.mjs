/**
 * Every portal route still answers the way it did. A regression net, not a test
 * of any one feature.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-smoke-test.mjs
 *
 * Needs a server on :3000 and `.env.local` for DATABASE_URL and
 * PORTAL_AUTH_SECRET. Walks every site in the database rather than a hardcoded
 * list, so a newly published survey is covered the day it appears.
 *
 * The point is breadth over depth: it will not tell you a measurement is wrong,
 * but it will tell you that a change to the map broke the admin console, which
 * is the failure that actually goes unnoticed until a client finds it.
 */
import { SignJWT } from "jose";
import postgres from "postgres";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

const sql = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
const [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
const sites = await sql`select slug from sites order by slug`;
await sql.end({ timeout: 3 });

const token = await new SignJWT({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

let fails = 0;
const check = (label, ok, detail = "") => {
  if (!ok) fails += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function get(path, { auth = true } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: auth ? { Cookie: `sga_portal_session=${token}` } : {},
    redirect: "manual",
  });
  const body = r.status === 200 ? await r.text() : "";
  return { status: r.status, body };
}

console.log("\nPublic pages still render");
for (const p of ["/", "/services", "/projects", "/contact", "/data-insights", "/blog"]) {
  const { status } = await get(p, { auth: false });
  check(`GET ${p}`, status === 200, `status ${status}`);
}

console.log("\nPortal pages, signed in");
for (const p of ["/portal", "/portal/admin"]) {
  const { status } = await get(p);
  check(`GET ${p}`, status === 200, `status ${status}`);
}

console.log("\nEvery site's pages and map");
for (const { slug } of sites) {
  const site = await get(`/portal/${slug}`);
  check(`GET /portal/${slug}`, site.status === 200, `status ${site.status}`);

  const map = await get(`/portal/${slug}/map`);
  check(
    `GET /portal/${slug}/map`,
    map.status === 200 || map.status === 404,
    `status ${map.status}`,
  );
  if (map.status === 200) {
    /*
     * Not every site has a published map, and the one that does not must say so
     * rather than render an empty frame. So the assertion branches on which of
     * the two legitimate states the page is in; asserting the toolbar
     * unconditionally just fails on any site awaiting its first deliverable.
     */
    const unpublished = map.body.includes("no georeferenced layers published");
    if (unpublished) {
      check(`  ${slug} has no map yet, and says so plainly`, true, "empty state");
    } else {
      // The server-rendered shell must carry what the client hydrates.
      check(`  ${slug} map ships the measure toolbar`, map.body.includes("Spot level"));
      check(`  ${slug} map ships the layer tree`, map.body.includes("Base map"));
      check(`  ${slug} map offers the terrain and surface tools`, map.body.includes("Volume"));
    }
    /*
     * Next's flight payload contains the literal string `"digest":"$undefined"`
     * next to `"error":null` on every healthy render, so grepping for "digest"
     * matches every page ever served. Match what a broken page actually shows a
     * human instead.
     */
    check(
      `  ${slug} map rendered without an error boundary`,
      !/Application error:|client-side exception|Internal Server Error/i.test(map.body),
    );
  }
}

console.log("\nAuthorisation still holds without a session");
for (const p of ["/portal", "/portal/admin", `/portal/${sites[0].slug}/map`]) {
  const { status } = await get(p, { auth: false });
  check(`GET ${p} unauthenticated redirects or refuses`, status === 307 || status === 302 || status === 401 || status === 404, `status ${status}`);
}

console.log("\nTile grant endpoint, which the map depends on");
{
  const r = await fetch(`${BASE}/api/portal/sites/${sites[0].slug}/tile-grant`, {
    method: "POST",
    headers: { Cookie: `sga_portal_session=${token}` },
  });
  check("POST tile-grant is authorised", r.status === 200 || r.status === 204, `status ${r.status}`);
}

console.log(`\n${fails === 0 ? "portal smoke test passed" : `${fails} FAILURES`}\n`);
process.exit(fails ? 1 : 0);
