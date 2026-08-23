/**
 * Drives the hydrology tools on the survey map in a real browser.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-hydrology-browser-test.mjs
 *
 * Needs a server on :3000, `.env.local`, and hydrology generated for the site.
 *
 * `hydrology-api-test.mjs` proves the route returns the right numbers. This
 * proves the panel exists, hydrates, sends the requests it claims to, and puts
 * the answer on screen. A component that throws on hydration passes every HTTP
 * test ever written and shows the client a blank sidebar.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SITE = process.env.SITE ?? "kotba-survey";
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

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1100 });
await page.setCookie({ name: "sga_portal_session", value: token, domain: "localhost", path: "/" });

const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/WebGL|SwiftShader|GPU stall|Failed to load resource/i.test(t)) return;
  problems.push(`console: ${t.slice(0, 300)}`);
});

const calls = [];
page.on("request", (r) => {
  if (r.url().includes("/hydrology") && r.method() === "POST") {
    try { calls.push(JSON.parse(r.postData() ?? "{}")); } catch { calls.push({ bad: true }); }
  }
});

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});

// The panel only appears once the site is known to have hydrology.
const appeared = await page
  .waitForFunction(() => /HYDROLOGY/i.test(document.body.innerText), { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
check("the hydrology panel appears for a site that has it", appeared);
check("it asked the route what exists", calls.some((c) => c.op === "layers"));

const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

/**
 * Click a tool by its accessible name.
 *
 * The rail prints Malhar's tool number beside each name, so the button's text
 * content is "26Watershed Delineation". The number is `aria-hidden` and the
 * button carries an `aria-label` of the name alone, which is what a screen
 * reader announces and what does not move when the visual treatment changes.
 */
async function clickLabel(label) {
  for (const h of await page.$$("button")) {
    if ((await h.evaluate((e) => e.getAttribute("aria-label") ?? e.textContent.trim())) === label) {
      await h.click();
      await new Promise((r) => setTimeout(r, 400));
      return true;
    }
  }
  return false;
}

async function clickCheckbox(labelText) {
  const handle = await page.evaluateHandle((needle) => {
    const label = [...document.querySelectorAll("label")].find((l) =>
      l.textContent.trim().startsWith(needle),
    );
    return label?.querySelector('input[type="checkbox"]') ?? null;
  }, labelText);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  await new Promise((r) => setTimeout(r, 900));
  return true;
}

async function clickMap(dx = 0, dy = 0) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await new Promise((r) => setTimeout(r, 500));
}

/** Is a MapLibre layer present and visible? */
const layerVisible = (id) =>
  page.evaluate(() => true).then(async () => {
    // The map instance is not exposed globally, so visibility is inferred from
    // the request having been made and the legend having rendered instead.
    return null;
  });
void layerVisible;

/**
 * Open the inspector's Water segment.
 *
 * The right-hand panel used to stack every section at once — tools, layers,
 * point cloud, contours, hydrology, layer tree — in a 288px column that
 * overflowed the map. It is now segmented, and everything about drainage lives
 * under Water: its layers *and* its results, because a client thinking about
 * water wants both in one place rather than the toggles filed separately from
 * the answers.
 */
async function openWater() {
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === "Water")
      ?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
}

console.log("\nLayers");
{
  await openWater();
  check("the channel network can be switched on", await clickCheckbox("Channel network"));
  await page.waitForFunction(() => /STREAM ORDER/i.test(document.body.innerText), { timeout: 30000 })
    .catch(() => {});
  const t = await text();
  check("streams were fetched", calls.some((c) => c.op === "streams"));
  check("and a stream order legend appears once they are drawn", /STREAM ORDER/i.test(t));
  check("the legend explains what Strahler order means", /order 2 where two order 1/i.test(t));

  check("basins can be switched on", await clickCheckbox("Basins"));
  await new Promise((r) => setTimeout(r, 1200));
  check("basins were fetched", calls.some((c) => c.op === "basins"));
}

let groundLevel = NaN;
/*
 * The tool rail opens on the universal group, so the hydrology tools are not in
 * the document until that tab is chosen. This is the client's first click too.
 */
{
  const picked = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent.trim().startsWith("Hydrology"),
    );
    if (!tab) return false;
    tab.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 600));
  check("the hydrology group can be opened from the tool rail", picked);
}

console.log("\nInspect");
{
  check("the inspect tool activates", await clickLabel("Inspect"));
  await clickMap(0, 0);
  /*
   * Case sensitive, and followed by a digit.
   *
   * The channel network's own hint reads "Cells with at least 500 m² draining
   * through them", so a case-insensitive wait for "Draining through" matched
   * text that was already on the page and returned instantly, before the
   * request had answered. Every assertion after it then read a panel that had
   * not filled in yet, and reported the layer hint as though it were the result.
   */
  await page.waitForFunction(
    () => /Draining through\s+[\d.]/.test(document.body.innerText),
    { timeout: 45000 },
  ).catch(() => {});
  const t = await text();
  check("it asked the route to inspect", calls.some((c) => c.op === "inspect"));
  check("an elevation is shown", /Elevation [\d.]+ m/i.test(t), t.match(/Elevation [\d.]+ m/i)?.[0] ?? "");
  // Both units, always: Malhar's three specifications give three slope schemes
  // and one is in percent, so an unlabelled number is a wrong map waiting.
  check("slope is shown in degrees and percent", /Slope [\d.]+° · [\d.]+%/.test(t),
    t.match(/Slope [^ ]+ · [^ ]+/)?.[0] ?? "");
  check("contributing area is shown, not a cell count",
    /Draining through\s+[\d.]+\s*(ha|m²|km²)/.test(t),
    t.match(/Draining through\s+[\d.]+\s*\S+/)?.[0] ?? "not found");

  /*
   * Grab the ground level now, while the inspect panel is on screen.
   *
   * Reading it later, in the flood section, found nothing: tracing a watershed
   * replaces the inspect readout by design, so the flood branch was guarded on a
   * null and skipped itself while the suite still printed green. A skipped check
   * that reports success is worse than a failing one.
   */
  groundLevel = Number(t.match(/Elevation\s+([\d.]+)\s*m/)?.[1] ?? NaN);
  check("a ground level was captured for the flood test", Number.isFinite(groundLevel),
    `${groundLevel}`);
}

console.log("\nWatershed");
{
  check("the watershed tool activates", await clickLabel("Watershed Delineation"));
  await clickMap(0, 0);
  await page.waitForFunction(
    () => /Catchment\s+[\d.]+\s*ha/.test(document.body.innerText),
    { timeout: 45000 },
  ).catch(() => {});
  const t = await text();
  check("it asked the route to trace a catchment", calls.some((c) => c.op === "watershed"));
  check("a catchment area is reported", /Catchment [\d.]+ ha/i.test(t), t.match(/Catchment [\d.]+ ha/i)?.[0] ?? "");
  // The two honesty requirements, on screen rather than only in the payload.
  check("snapping, if it happened, is explained",
    !/pour point was moved/i.test(t) || /drains the hillside, not the valley/i.test(t));
  check("truncation, if any, is stated in words",
    !/lower bound/i.test(t) || /reaches the edge of the surveyed ground/i.test(t));
}

console.log("\nFlood");
{
  check("the flood tool activates", await clickLabel("Flood Simulation"));
  // Clicking with no level must be refused in the UI, not sent to the server.
  const before = calls.filter((c) => c.op === "flood").length;
  await clickMap(0, 0);
  const refused = await text();
  check("clicking with no level is refused before any request",
    /Enter a water level/i.test(refused) && calls.filter((c) => c.op === "flood").length === before);

  const input = await page.$('input[aria-label="Water level in metres"]');
  check("a water level can be entered", Boolean(input));
  check("and the flood test has a ground level to work from", Number.isFinite(groundLevel));
  if (input && Number.isFinite(groundLevel)) {
    await input.click({ clickCount: 3 });
    await input.type((groundLevel + 1.5).toFixed(1));
    await clickMap(0, 0);
    await page.waitForFunction(
      () => /Storage\s+[\d,]+\s*m³/.test(document.body.innerText),
      { timeout: 45000 },
    ).catch(() => {});
    const t = await text();
    check("a flood was computed", calls.some((c) => c.op === "flood" && Number.isFinite(c.level)));
    check("storage is reported", /Storage [\d,]+ m³/i.test(t), t.match(/Storage [\d,]+ m³/i)?.[0] ?? "");
    check("and the method says it is a connected fill", /connected fill/i.test(t));
  }
}

console.log("\nDepressions");
{
  check("sinks can be found", await clickLabel("Find"));
  await page.waitForFunction(
    () => /Deepest\s+[\d.]/.test(document.body.innerText),
    { timeout: 45000 },
  ).catch(() => {});
  const t = await text();
  check("it asked the route for sinks", calls.some((c) => c.op === "sinks"));
  check("a storage figure is reported", /Storage [\d,]+ m³/i.test(t));
  check("and the deepest depression", /Deepest [\d.]+ ?m/i.test(t), t.match(/Deepest [\d.]+ ?m/i)?.[0] ?? "");
}

console.log("\nProvenance and cleanliness");
{
  const t = await text();
  check("the panel says why hydrology is coarser than the survey", /coarser/i.test(t));
  check("no page errors or unexpected console errors", problems.length === 0,
    problems.slice(0, 3).join(" | "));
  check("every hydrology request declared its CRS or needed none",
    calls.every((c) => c.op === "layers" || c.op === "streams" || c.op === "basins" || c.op === "sinks" || c.crs === "lonlat"),
    `${calls.length} calls`);
  console.log(`  (${calls.length} hydrology requests: ${[...new Set(calls.map((c) => c.op))].join(", ")})`);
}

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
