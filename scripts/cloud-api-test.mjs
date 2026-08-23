/**
 * The point cloud route, and the quadtree it serves.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/cloud-api-test.mjs
 *
 * Two things are being checked and they are different. That the route is
 * authorised, addresses nodes safely and caches them correctly is one. That the
 * *quadtree itself is sound* is the other, and it is the one that would go wrong
 * silently: a cloud whose nodes are quantised into the wrong box still draws, it
 * just draws in the wrong place, and nothing but arithmetic catches that.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SITE = process.env.SITE ?? "aektanagar-survey";
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const sql = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
const [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
await sql.end({ timeout: 3 });

const token = await new SignJWT({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

const authed = (path) =>
  fetch(`${BASE}${path}`, { headers: { Cookie: `sga_portal_session=${token}` } });

console.log("\nAuthorisation, before anything is opened");
{
  const anonymous = await fetch(`${BASE}/api/portal/sites/${SITE}/cloud`);
  check("no session is refused", anonymous.status === 401, `status ${anonymous.status}`);

  const missing = await authed(`/api/portal/sites/no-such-site/cloud`);
  check("an unknown site is a 404, not a 409", missing.status === 404, `status ${missing.status}`);

  const noCloud = await authed(`/api/portal/sites/kotba-survey/cloud`);
  check("a site with no cloud says so with a reason", noCloud.status === 409,
    `status ${noCloud.status}`);
  if (noCloud.status === 409) {
    const body = await noCloud.json();
    check("  the reason is machine readable", body.reason === "missing", body.reason);
    check("  and the message names nothing a client cannot act on",
      !/portal-data|\.las|scripts\//i.test(body.error), body.error);
  }
}

console.log("\nThe manifest");
const response = await authed(`/api/portal/sites/${SITE}/cloud`);
check("it is served", response.ok, `status ${response.status}`);
const manifest = await response.json();

check("it declares the format it is in", manifest.format === "SGAPC1");
check("it reports the full flown count, not just what was kept",
  manifest.sourcePointCount === 50183644, String(manifest.sourcePointCount));
check("and how many survived thinning",
  manifest.storedPointCount > 1e6 && manifest.storedPointCount < manifest.sourcePointCount,
  `${manifest.storedPointCount.toLocaleString("en-GB")}`);
check("the CRS is the survey's own UTM zone", manifest.crs.epsg === 32643, String(manifest.crs.epsg));
check("colour is declared present or absent, never assumed",
  typeof manifest.hasColour === "boolean", String(manifest.hasColour));
check("only the classes the cloud contains are listed",
  manifest.classifications.length > 0 && manifest.classifications.every((c) => c.count > 0),
  manifest.classifications.map((c) => `${c.name} ${c.count}`).join(", "));
/*
 * `max-age` with a real number on it, not merely present. The first version of
 * this check accepted any `max-age=<digits>`, and the header being served was
 * `no-store, max-age=0` — the general /api/portal rule in next.config silently
 * overriding the route's own, which is the third time that trap has bitten.
 */
{
  const cc = response.headers.get("cache-control") ?? "";
  const seconds = Number(cc.match(/max-age=(\d+)/)?.[1] ?? 0);
  check("the manifest is cached briefly, not forever",
    seconds >= 60 && seconds <= 3600 && !/immutable|no-store/.test(cc), cc);
}
check("and privately: this is one client's survey",
  /private/.test(response.headers.get("cache-control") ?? ""));

console.log("\nThe quadtree is well formed");
{
  const levels = new Map();
  for (const node of manifest.nodes) {
    levels.set(node.level, (levels.get(node.level) ?? 0) + 1);
  }
  check("there is exactly one root", levels.get(0) === 1, `${levels.get(0)} at level 0`);
  check("every level below it has more nodes than the one above",
    [...levels.keys()].sort((a, b) => a - b).every((l, i, all) =>
      i === 0 || levels.get(l) >= levels.get(all[i - 1])),
    [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}:${n}`).join(" "));

  check("spacing halves with each level",
    manifest.nodes.every((n) =>
      Math.abs(n.spacing - manifest.rootSpacing / 2 ** n.level) < 1e-9),
    `root ${manifest.rootSpacing.toFixed(3)} m`);

  // No node may hold more points than its own grid has cells: that is the
  // invariant the thinning rests on, and breaking it would mean a cell was
  // written twice and the cloud is denser in some places for no reason.
  const cells = manifest.grid * manifest.grid;
  check("no node exceeds its grid",
    manifest.nodes.every((n) => n.count <= cells),
    `cap ${cells}, largest ${Math.max(...manifest.nodes.map((n) => n.count))}`);

  check("stored count equals the sum of the nodes",
    manifest.nodes.reduce((sum, n) => sum + n.count, 0) === manifest.storedPointCount);

  check("every node has a positive span in all three axes",
    manifest.nodes.every((n) => n.span.every((s) => s > 0)),
    manifest.nodes.filter((n) => n.span.some((s) => !(s > 0))).map((n) => n.key)[0] ?? "");

  /*
   * Containment, checked in UTM where it is exact.
   *
   * The first version of this asserted it in longitude and latitude and failed
   * on node 1/0/1 — correctly, in the sense that the node really does sit a
   * fraction of a degree west of the survey's own west edge. That is meridian
   * convergence, not a defect: Aektanagar sits 1.35° west of the zone's central
   * meridian, so the UTM grid is tilted about half a degree against true north
   * and a node's west edge moves ~2.4 m of longitude over 278 m of northing. The
   * quadtree is defined in projected metres, so that is where the invariant
   * lives, and the manifest now carries it.
   */
  const [rx0, ry0, rx1, ry1] = manifest.rootSquare;
  const inRoot = (node) => {
    const [x0, y0, x1, y1] = node.utmBounds;
    return x0 >= rx0 - 1e-6 && y0 >= ry0 - 1e-6 && x1 <= rx1 + 1e-6 && y1 <= ry1 + 1e-6;
  };
  check("every node lies inside the root square",
    manifest.nodes.every(inRoot),
    manifest.nodes.find((node) => !inRoot(node))?.key ?? "");

  check("the root square really is square and covers the data",
    Math.abs((rx1 - rx0) - (ry1 - ry0)) < 1e-6 &&
      rx0 <= manifest.bounds.minX + 1e-6 &&
      ry0 <= manifest.bounds.minY + 1e-6 &&
      rx1 >= manifest.bounds.maxX - 1e-6 &&
      ry1 >= manifest.bounds.maxY - 1e-6,
    `${(rx1 - rx0).toFixed(3)} × ${(ry1 - ry0).toFixed(3)} m`);

  check("every node is the size its level says it is",
    manifest.nodes.every((node) => {
      const [x0, , x1] = node.utmBounds;
      return Math.abs((x1 - x0) - (rx1 - rx0) / 2 ** node.level) < 1e-6;
    }));

  // And each node's own lon/lat box, which is what the viewer culls on, must at
  // least overlap the survey rather than describing somewhere else entirely.
  const [west, south, east, north] = manifest.lonLatBounds;
  check("and every node's map footprint overlaps the survey",
    manifest.nodes.every((node) => {
      const [w, s, e, n] = node.lonLatBounds;
      return e > west && w < east + 1e-2 && n > south && s < north + 1e-2;
    }),
    manifest.nodes.find((node) => {
      const [w, s, e, n] = node.lonLatBounds;
      return !(e > west && w < east + 1e-2 && n > south && s < north + 1e-2);
    })?.key ?? "");
}

console.log("\nA node's bytes");
{
  const root = manifest.nodes.find((n) => n.level === 0);
  const node = await authed(`/api/portal/sites/${SITE}/cloud/${root.key}`);
  check("the root node is served", node.ok, `status ${node.status}`);
  check("as bytes, not JSON",
    node.headers.get("content-type") === "application/octet-stream",
    node.headers.get("content-type"));
  check("cached hard, because a node never changes",
    /immutable/.test(node.headers.get("cache-control") ?? ""),
    node.headers.get("cache-control"));

  const bytes = new Uint8Array(await node.arrayBuffer());
  check("it carries the format's magic",
    String.fromCharCode(...bytes.subarray(0, 6)) === "SGAPC1",
    String.fromCharCode(...bytes.subarray(0, 6)));

  const view = new DataView(bytes.buffer);
  const count = view.getUint32(6, true);
  const stride = view.getUint16(10, true);
  check("the count matches the manifest", count === root.count, `${count} vs ${root.count}`);
  check("ten bytes a point", stride === 10, String(stride));
  check("and the file is exactly that long", bytes.length === 12 + count * 10,
    `${bytes.length} vs ${12 + count * 10}`);

  /*
   * The check that matters. Dequantise every point and confirm it lands inside
   * the node's declared mercator box, then convert the box back to longitude and
   * latitude and confirm *that* is where the manifest says the node is. A cloud
   * quantised against the wrong box renders perfectly and is in the wrong place.
   */
  const [surveyWest, , surveyEast] = [
    manifest.lonLatBounds[0],
    manifest.lonLatBounds[1],
    manifest.lonLatBounds[2],
  ];
  const [ox, oy, oz] = root.origin;
  const [sx, sy, sz] = root.span;
  let outside = 0;
  let minLon = Infinity;
  let maxLon = -Infinity;
  const lonOf = (mx) => mx * 360 - 180;
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 10;
    const x = ox + (view.getUint16(at, true) / 65535) * sx;
    const y = oy + (view.getUint16(at + 2, true) / 65535) * sy;
    const z = oz + (view.getUint16(at + 4, true) / 65535) * sz;
    if (x < ox - 1e-12 || x > ox + sx + 1e-12) outside += 1;
    if (y < oy - 1e-12 || y > oy + sy + 1e-12) outside += 1;
    if (z < oz - 1e-12 || z > oz + sz + 1e-12) outside += 1;
    const lon = lonOf(x);
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  check("every point dequantises inside its node's box", outside === 0, `${outside} outside`);
  check("and the node's points really are where the survey is",
    minLon >= surveyWest - 1e-4 && maxLon <= surveyEast + 1e-4,
    `points span ${minLon.toFixed(5)}..${maxLon.toFixed(5)}, survey ${surveyWest.toFixed(5)}..${surveyEast.toFixed(5)}`);

  // Classification must survive the round trip through the packing.
  const seen = new Set();
  for (let i = 0; i < count; i += 1) seen.add(bytes[12 + i * 10 + 9]);
  const declared = new Set(manifest.classifications.map((c) => c.code));
  check("every classification in the node is one the manifest declares",
    [...seen].every((c) => declared.has(c)),
    `node has ${[...seen].join(",")}, manifest declares ${[...declared].join(",")}`);
}

console.log("\nNode addressing refuses what it should");
{
  for (const [path, why] of [
    ["/cloud/9/9/9", "a node that was never written"],
    ["/cloud/1/2", "an incomplete address"],
    ["/cloud/0/0/0/0", "an over-long address"],
    ["/cloud/x/y/z", "a non numeric address"],
    ["/cloud/0/0/..%2f..%2fcloud.json", "a traversal attempt"],
  ]) {
    const r = await authed(`/api/portal/sites/${SITE}${path}`);
    check(`${why} is refused`, r.status === 404 || r.status === 400, `status ${r.status}`);
  }
}

console.log("\nTenancy still holds");
{
  /*
   * Two different refusals, and the difference is worth knowing.
   *
   * A session whose `clientId` claim does not match the account's own row is
   * rejected by `sessionStillValid` before this route sees it, so a *forged*
   * tenancy is a 401 rather than a 404. That is the stronger answer: the token
   * is not merely denied this site, it is not a session at all.
   *
   * A genuine client session that simply does not own this site gets a 404,
   * which is the answer this route is responsible for and the one that must not
   * leak the site's existence.
   */
  const forged = await new SignJWT({
    userId: owner.id,
    email: "someone@second-client.example",
    fullName: "Second Client user",
    role: "client",
    clientId: "22222222-2222-4222-8222-222222222222",
    via: "google",
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
    .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

  for (const path of [`/cloud`, `/cloud/0/0/0`]) {
    const r = await fetch(`${BASE}/api/portal/sites/${SITE}${path}`, {
      headers: { Cookie: `sga_portal_session=${forged}` },
    });
    check(`a forged tenancy claim is not a session at all (${path})`, r.status === 401,
      `status ${r.status}`);
  }

  const db = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
  const [outsider] = await db`select id, email, full_name, client_id from users where role = 'client' order by created_at limit 1`;
  await db.end({ timeout: 3 });

  if (!outsider) {
    check("a client account exists to test the 404 path with", false, "none in this database");
  } else {
    const clientToken = await new SignJWT({
      userId: outsider.id,
      email: outsider.email,
      fullName: outsider.full_name ?? outsider.email,
      role: "client",
      clientId: outsider.client_id,
      via: "google",
    }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
      .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

    for (const path of [`/cloud`, `/cloud/0/0/0`]) {
      const r = await fetch(`${BASE}/api/portal/sites/${SITE}${path}`, {
        headers: { Cookie: `sga_portal_session=${clientToken}` },
      });
      check(`a client who does not own this site gets 404, not 409 (${path})`,
        r.status === 404, `status ${r.status}`);
    }
  }
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
