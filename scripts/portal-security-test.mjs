/**
 * Checks the security boundaries from outside, against a running production build.
 *
 * Two jobs. First, prove the headers and the access rules are what we think they
 * are. Second, and the reason this exists rather than a checklist in a document:
 * prove the Content Security Policy did not quietly break the site. A CSP that
 * blocks your own stylesheet looks fine in a diff and ships a white page, so
 * every page below is loaded in a real browser and any CSP violation it reports
 * fails the run.
 *
 * Run:
 *   npm install --no-save puppeteer
 *   npm run build && npm run start
 *   node scripts/portal-security-test.mjs
 */
import { SignJWT } from "jose";
import postgres from "postgres";
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------- headers ---
console.log("\n--- security headers ---");
{
  const res = await fetch(`${BASE}/`, { redirect: "manual" });
  const csp = res.headers.get("content-security-policy") ?? "";
  check("Content-Security-Policy is set", csp.length > 0);
  check("frames are restricted to our own origin", csp.includes("frame-ancestors 'self'"));
  check("base tag injection is blocked", csp.includes("base-uri 'self'"));
  check("plugin content is blocked", csp.includes("object-src 'none'"));
  check("forms cannot post elsewhere", csp.includes("form-action 'self'"));
  check("no 'unsafe-eval' in a production build", !csp.includes("unsafe-eval"), csp.slice(0, 60));
  check("nosniff", res.headers.get("x-content-type-options") === "nosniff");
  check("HSTS", (res.headers.get("strict-transport-security") ?? "").includes("max-age="));
  check("server software is not advertised", !res.headers.get("x-powered-by"));
}

console.log("\n--- private pages are not cacheable ---");
{
  const res = await fetch(`${BASE}/portal`, { redirect: "manual" });
  const cache = res.headers.get("cache-control") ?? "";
  check("portal sends no-store", cache.includes("no-store"), cache);
  check("portal is not indexable", (res.headers.get("x-robots-tag") ?? "").includes("noindex"));
}

// ------------------------------------------------------------ access rules ---
console.log("\n--- unauthenticated access ---");
for (const path of ["/portal", "/portal/admin", "/portal/kotba-survey"]) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  check(`${path} redirects to sign in`, res.status === 307 && location.includes("/portal/login"),
    `${res.status} ${location.slice(0, 40)}`);
}
for (const path of ["/api/portal/assets/whatever/view", "/api/portal/logout"]) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual" });
  check(`${path} refuses anonymous callers`, res.status === 401, String(res.status));
}

console.log("\n--- open redirect ---");
for (const hostile of [
  "https://evil.example.com",
  "//evil.example.com",
  "/\\evil.example.com",
  "https://sudaangeo.in.evil.example.com/portal",
]) {
  const res = await fetch(
    `${BASE}/api/auth/google/start?next=${encodeURIComponent(hostile)}`,
    { redirect: "manual" },
  );
  const location = res.headers.get("location") ?? "";
  // Either we refuse to start, or we go to Google. Never straight to the attacker.
  const leaks = location.includes("evil.example.com");
  check(`next=${hostile.slice(0, 32)} does not redirect off site`, !leaks, location.slice(0, 60));
}

console.log("\n--- forged sessions ---");
{
  const forged = await new SignJWT({
    userId: "00000000-0000-0000-0000-000000000000",
    email: "attacker@example.com", role: "owner", clientId: null, via: "google",
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
    .sign(new TextEncoder().encode("a".repeat(48)));

  const res = await fetch(`${BASE}/portal/admin`, {
    headers: { cookie: `sga_portal_session=${forged}` },
    redirect: "manual",
  });
  check("a token signed with the wrong key is rejected", res.status === 307, String(res.status));

  const none = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VySWQiOiJ4Iiwicm9sZSI6Im93bmVyIn0.";
  const res2 = await fetch(`${BASE}/portal/admin`, {
    headers: { cookie: `sga_portal_session=${none}` },
    redirect: "manual",
  });
  check("an alg=none token is rejected", res2.status === 307, String(res2.status));
}

// Everything below needs real sessions and real ids.
const db = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
const secret = new TextEncoder().encode(val("PORTAL_AUTH_SECRET"));
const mint = (claims) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt()
    .setExpirationTime("8h").sign(secret);

const [owner] = await db`select id, email, full_name from users where role='owner' order by created_at limit 1`;
const ownerToken = await mint({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
});

console.log("\n--- cross origin logout, with a real session ---");
{
  const res = await fetch(`${BASE}/api/portal/logout`, {
    method: "POST",
    headers: { origin: "https://evil.example.com", cookie: `sga_portal_session=${ownerToken}` },
    redirect: "manual",
  });
  check("logout refuses a cross origin POST", res.status === 403, String(res.status));

  const same = await fetch(`${BASE}/api/portal/logout`, {
    method: "POST",
    headers: { origin: BASE, cookie: `sga_portal_session=${ownerToken}` },
    redirect: "manual",
  });
  check("logout still works from our own origin", same.status === 303, String(same.status));
}

console.log("\n--- assets still serve, and only to the right client ---");
{
  const assets = await db`
    select a.id, a.mime_type, s.client_id
    from assets a join sites s on s.id = a.site_id
    where a.is_published and s.is_published
    limit 20`;

  check("there are published assets to test with", assets.length > 0, `${assets.length}`);

  if (assets.length > 0) {
    // The allowlist must not have broken real files.
    const sample = assets[0];
    const res = await fetch(`${BASE}/api/portal/assets/${sample.id}/view`, {
      headers: { cookie: `sga_portal_session=${ownerToken}` },
    });
    check(`a real ${sample.mime_type} asset still serves`, res.status === 200, String(res.status));
    check("served inline, never as a download",
      (res.headers.get("content-disposition") ?? "").startsWith("inline"));
    check("asset response carries its own restrictive CSP",
      (res.headers.get("content-security-policy") ?? "").includes("default-src 'none'"));
    check("asset is not cacheable", (res.headers.get("cache-control") ?? "").includes("no-store"));

    // Tenant isolation. The session has to be one the server will actually
    // accept, so it is built from a real active client user: a made up userId is
    // rejected at the session check and proves nothing about isolation.
    const [member] = await db`
      select id, email, client_id from users
      where role = 'client' and is_active and client_id is not null
      limit 1`;

    const foreign = member
      ? assets.find((a) => a.client_id !== member.client_id)
      : undefined;

    if (member && foreign) {
      const theirs = await mint({
        userId: member.id, email: member.email, fullName: member.email,
        role: "client", clientId: member.client_id, via: "google",
      });
      const res2 = await fetch(`${BASE}/api/portal/assets/${foreign.id}/view`, {
        headers: { cookie: `sga_portal_session=${theirs}` },
      });
      // 404, not 403: a 403 would confirm the id exists.
      check("another client's asset returns 404, not 403", res2.status === 404, String(res2.status));
    } else {
      // Say so loudly rather than printing a pass for a check that never ran.
      console.log(
        `  ..   SKIPPED tenant isolation: needs an active client user and an asset ` +
          `belonging to a different client (have member=${Boolean(member)}, foreign=${Boolean(foreign)})`,
      );
    }

    // A session whose user no longer exists must be refused outright.
    const ghost = await mint({
      userId: "11111111-1111-4111-8111-111111111111",
      email: "ghost@example.com", fullName: "Ghost",
      role: "client", clientId: assets[0].client_id, via: "google",
    });
    const res3 = await fetch(`${BASE}/api/portal/assets/${assets[0].id}/view`, {
      headers: { cookie: `sga_portal_session=${ghost}` },
    });
    check("a validly signed token for a deleted user is refused", res3.status === 401,
      String(res3.status));
  }
}

await db.end({ timeout: 3 });

console.log("\n--- contact endpoint ---");
{
  const send = (body) =>
    fetch(`${BASE}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // Size first: the throttle below saturates this IP's bucket for ten minutes,
  // and a 429 here would look like a passing size check on a re-run.
  const huge = await send({ name: "x".repeat(50000), email: "a@b.co", message: "hello there" });
  if (huge.status === 429) {
    console.log("  ..   SKIPPED size check: this IP is still throttled from an earlier run");
  } else {
    check("oversized fields are refused", huge.status === 422, String(huge.status));
  }

  let limited = false;
  for (let i = 0; i < 9; i += 1) {
    const res = await send({ name: "Probe", email: "probe@example.com", message: "a real message" });
    if (res.status === 429) { limited = true; break; }
  }
  check("repeated submissions are throttled", limited);
}

// ------------------------------------------------------------ the browser ---
console.log("\n--- CSP does not break the site ---");
{
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setCookie({ name: "sga_portal_session", value: ownerToken, domain: "localhost", path: "/" });

  const violations = [];
  page.on("console", (m) => {
    const text = m.text();
    if (/content security policy|refused to (load|execute|apply|connect)/i.test(text)) {
      violations.push(text.slice(0, 160));
    }
  });
  page.on("pageerror", (e) => violations.push(`pageerror: ${String(e).slice(0, 160)}`));

  for (const path of ["/", "/services", "/projects", "/contact", "/portal", "/portal/admin"]) {
    violations.length = 0;
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 45000 });
    const styled = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      // If the stylesheet were blocked, the background would fall back to
      // transparent and nothing would be laid out.
      return { bg: body.backgroundColor, sheets: document.styleSheets.length };
    });
    const unique = [...new Set(violations)];
    check(`${path} loads with no CSP violation`, unique.length === 0, unique[0] ?? "");
    check(`${path} still has its stylesheet`, styled.sheets > 0, `${styled.sheets} sheets, bg ${styled.bg}`);
  }

  await browser.close();
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
