/**
 * Checks the navigation feedback in a real browser, on a production build.
 *
 * The interesting failure for a progress bar is not "does it appear" but "does
 * it ever fail to go away". A bar stuck at 80% is worse than no bar at all, so
 * every check here looks at the state after the navigation has settled as well
 * as during it, including the cases that strand a naive implementation: a link
 * to the page you are already on, and the back button.
 *
 * Run:
 *   npm install --no-save puppeteer
 *   npm run build && npm run start        # a production build, in another shell
 *   node scripts/portal-ux-test.mjs
 *
 * Needs .env.local for DATABASE_URL and PORTAL_AUTH_SECRET: it mints an owner
 * session directly rather than driving the Google consent screen.
 */
import { SignJWT } from "jose";
import postgres from "postgres";
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const ENV = readFileSync("/Users/ompatel/Documents/Sudan-Geo-Infomatics/.env.local", "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

const sql = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
const [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
await sql.end({ timeout: 3 });

const token = await new SignJWT({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.setCookie({ name: "sga_portal_session", value: token, domain: "localhost", path: "/" });

let failures = 0;
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// The bar is the fixed z-[60] strip at the very top.
const barOpacity = () =>
  page.evaluate(() => {
    const el = document.querySelector('div[aria-hidden].fixed.inset-x-0.top-0');
    return el ? Number(getComputedStyle(el).opacity) : -1;
  });

const srStatus = () =>
  page.evaluate(() => {
    const el = document.querySelector('span[role="status"][aria-live="polite"]');
    return el ? el.textContent.trim() : null;
  });

console.log("\n--- marketing site ---");
await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 45000 });
check("home renders", (await page.title()).length > 0, await page.title());
check("progress bar is hidden at rest", (await barOpacity()) === 0);
check("skip link exists", await page.$('a[href="#main"]') !== null);
check("main landmark exists", await page.$("main#main") !== null);

// Click Client Login and watch the bar mid flight.
console.log("\n--- click Client Login ---");
const loginLink = await page.$('nav a[href="/portal"]');
check("Client Login link found", loginLink !== null);
await Promise.all([
  loginLink.click(),
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
]);
await new Promise((r) => setTimeout(r, 1200));
check("landed in the portal", page.url().includes("/portal"), page.url());
check("bar cleared after arrival", (await barOpacity()) === 0, `opacity ${await barOpacity()}`);
check("screen reader status cleared", (await srStatus()) === "", JSON.stringify(await srStatus()));

console.log("\n--- portal shell ---");
check("portal has a main landmark", await page.$("main#main") !== null);
check("owner console button present", await page.$('a[href="/portal/admin"]') !== null);
check(
  "sign out is a submit button inside its form",
  await page.$('form[action="/api/portal/logout"] button[type="submit"]') !== null,
);

// The console is the slow page: check the bar actually shows during it.
console.log("\n--- click Owner console (the slow one) ---");
const consoleLink = await page.$('a[href="/portal/admin"]');
await consoleLink.click();
// Feedback is whichever arrives: the skeleton (routes with loading.tsx go
// straight there, which is better than a bar) or the bar itself.
let feedback = null;
for (let i = 0; i < 40; i += 1) {
  const skeleton = await page.$('[aria-busy="true"]');
  if (skeleton) { feedback = "skeleton"; break; }
  if ((await barOpacity()) > 0) { feedback = "bar"; break; }
  await new Promise((r) => setTimeout(r, 50));
}
check("immediate feedback on the slow navigation", feedback !== null, feedback ?? "nothing appeared");
await page.waitForFunction(
  () => document.body.innerText.includes("Access control"),
  { timeout: 45000 },
).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
check("owner console rendered", (await page.evaluate(() => document.body.innerText)).includes("Access control"));
check("bar cleared after the console loaded", (await barOpacity()) === 0);

// A link to the current page must not start a bar that never finishes.
console.log("\n--- same page link ---");
await page.evaluate(() => {
  const a = document.createElement("a");
  a.href = window.location.pathname;
  a.id = "same-page-probe";
  a.textContent = "same";
  document.body.appendChild(a);
});
await page.click("#same-page-probe");
await new Promise((r) => setTimeout(r, 900));
check("no stuck bar after a same page link", (await barOpacity()) === 0);

// The bar's own logic, driven directly. Clicking a real link cannot prove this
// reliably because Next prefetches marketing routes, so those navigations finish
// before the bar's deliberate 140ms delay has elapsed.
console.log("\n--- progress bar mechanics ---");
await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 45000 });
await page.evaluate(() => window.dispatchEvent(new Event("sga:navigation-start")));
await new Promise((r) => setTimeout(r, 100));
check("bar still hidden before its delay elapses", (await barOpacity()) === 0, "no flash on fast navigations");
await new Promise((r) => setTimeout(r, 400));
check("bar appears once a navigation is genuinely slow", (await barOpacity()) > 0);
check("screen reader is told the page is loading", (await srStatus()) === "Loading page");
const width1 = await page.evaluate(() => {
  const el = document.querySelector('div[aria-hidden].fixed.inset-x-0.top-0 > div');
  return el.getBoundingClientRect().width;
});
await new Promise((r) => setTimeout(r, 800));
const width2 = await page.evaluate(() => {
  const el = document.querySelector('div[aria-hidden].fixed.inset-x-0.top-0 > div');
  return el.getBoundingClientRect().width;
});
check("bar advances while waiting", width2 > width1, `${Math.round(width1)}px -> ${Math.round(width2)}px`);

// Landing on a new route must complete it.
await page.click('nav a[href="/about"]');
await page.waitForFunction(() => window.location.pathname === "/about", { timeout: 45000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
check("bar completes when the route lands", (await barOpacity()) === 0, `opacity ${await barOpacity()}`);

console.log("\n--- back button ---");
await page.goBack({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
check("bar cleared after going back", (await barOpacity()) === 0);

const unique = [...new Set(problems)];
check("no console or page errors", unique.length === 0, unique.slice(0, 3).join(" | "));

await browser.close();
console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
