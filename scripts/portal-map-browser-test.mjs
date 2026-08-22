/**
 * Drives the survey map in a real browser and reads the numbers off the panel.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-map-browser-test.mjs
 *
 * Needs a server on :3000 and `.env.local`.
 *
 * ## Why this exists on top of the HTTP tests
 *
 * `analysis-api-test.mjs` proves the API returns the right numbers.
 * `portal-smoke-test.mjs` proves the page server renders. Neither would notice a
 * component that throws on hydration, because the server rendered HTML is
 * already correct by then and the crash happens in the browser afterwards. That
 * failure looks like "the map is blank" and nothing in CI says a word.
 *
 * So this clicks the tools the way a client does and asserts that a real
 * measurement appears, that it matches what the API was asked for, and that the
 * console stayed clean throughout.
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

// No --use-gl override. Forcing swiftshader here stopped MapLibre creating its
// canvas at all, so every check failed for a reason that had nothing to do with
// the page. Headless Chrome's default WebGL is enough to instantiate the map.
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 950 });
await page.setCookie({ name: "sga_portal_session", value: token, domain: "localhost", path: "/" });

/**
 * MapLibre reports WebGL trouble through its own error event, and a headless
 * Chrome without a GPU is noisy in ways that say nothing about this code. Only
 * real page errors and genuine console errors are collected.
 */
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (/WebGL|SwiftShader|GPU stall|Failed to load resource/i.test(text)) return;
  problems.push(`console: ${text.slice(0, 300)}`);
});

/** Every analysis call the page makes, so the browser and the API can be compared. */
const analysisCalls = [];
page.on("request", (r) => {
  if (r.url().includes("/analysis") && r.method() === "POST") {
    try {
      analysisCalls.push(JSON.parse(r.postData() ?? "{}"));
    } catch {
      analysisCalls.push({ unparseable: true });
    }
  }
});

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });

// The canvas is the proof the map itself started; the toolbar is the proof our
// component hydrated rather than merely being server rendered.
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});
check("the map canvas exists", (await page.$("canvas.maplibregl-canvas")) !== null);

const buttons = () => page.$$eval("button", (els) => els.map((e) => e.textContent.trim()));
const labels = await buttons();
for (const tool of ["Spot level", "Distance", "Area", "Volume"]) {
  check(`the ${tool} tool is offered`, labels.includes(tool));
}

/** Click a tool button by its visible label. */
async function clickTool(label) {
  const handles = await page.$$("button");
  for (const h of handles) {
    const text = (await h.evaluate((e) => e.textContent.trim())) ?? "";
    if (text === label) {
      const disabled = await h.evaluate((e) => e.disabled);
      if (disabled) return false;
      await h.click();
      return true;
    }
  }
  return false;
}

/** The whole panel's text, which is what a client actually reads. */
const panelText = () =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

/**
 * Click at an offset from the canvas centre, in CSS pixels.
 *
 * The pause matters: two fast clicks near the same spot are a double click to
 * MapLibre, which finishes a measurement rather than extending it.
 */
async function clickMap(dx, dy, settle = 400) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await new Promise((r) => setTimeout(r, settle));
}

/**
 * Finish a shape, the way a client does: two real clicks in quick succession.
 *
 * Not `click(..., { clickCount: 2 })`. That sends a single press carrying
 * `detail = 2`, and the browser only synthesises a `dblclick` after two complete
 * click sequences, so the map received one ordinary click and the ring never
 * closed. The symptom was a polygon that drew correctly and reported its area
 * while never asking the server for anything, which is exactly what a broken
 * close looks like from outside.
 */
async function doubleClickMap(dx, dy) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  await page.mouse.move(x, y);
  // Chrome only raises `dblclick` when the second press carries clickCount 2,
  // and puppeteer will not infer that from two ordinary clicks however fast they
  // are sent. Both of the simpler spellings produce zero dblclick events.
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await new Promise((r) => setTimeout(r, 900));
}

console.log("\nTool 1, spot level");
{
  check("the spot tool activates", await clickTool("Spot level"));
  const before = analysisCalls.length;
  await clickMap(0, 0);
  await page.waitForFunction(
    () => /\d+\.\d{3} m/.test(document.body.innerText),
    { timeout: 20000 },
  ).catch(() => {});

  const text = await panelText();
  check("a level appears in the panel", /\d+\.\d{3} m/.test(text), text.match(/\d+\.\d{3} m/)?.[0] ?? "none");
  check("the page asked the analysis API for it", analysisCalls.length > before);

  const spotCall = analysisCalls.slice(before).find((c) => c.op === "spot");
  check("it asked for a spot level", Boolean(spotCall), spotCall ? JSON.stringify(spotCall.at) : "no spot call");
  check("in lon/lat, letting the server project", spotCall?.crs === "lonlat", spotCall?.crs);
  check("naming the surface it wants", spotCall?.surface === "dtm" || spotCall?.surface === "dsm", spotCall?.surface);

  // A second click must accumulate rather than replace: the spec asks for a list.
  await clickMap(60, 40);
  await page.waitForFunction(
    () => (document.body.innerText.match(/\d+\.\d{3} m/g) ?? []).length >= 2,
    { timeout: 20000 },
  ).catch(() => {});
  const two = await panelText();
  check(
    "a second click accumulates rather than replacing",
    (two.match(/\d+\.\d{3} m/g) ?? []).length >= 2,
    `${(two.match(/\d+\.\d{3} m/g) ?? []).length} levels`,
  );
  check("and the list offers an export", /Download CSV/.test(two));
}

console.log("\nTool 3, distance and profile");
{
  check("the distance tool activates", await clickTool("Distance"));
  const before = analysisCalls.length;
  await clickMap(-120, -60);
  await clickMap(120, 60);

  // Geometry is computed in the browser and must appear without waiting on the
  // network at all. This is the half of the design that should never be blocked.
  await page.waitForFunction(() => /Length/.test(document.body.innerText), { timeout: 10000 }).catch(() => {});
  const text = await panelText();
  check("a length appears", /Length/.test(text), text.match(/Length [\d.]+ ?\w+/)?.[0] ?? "");
  check("computed in the survey's own UTM zone, and it says so", /UTM zone \d+/.test(text));

  await page.waitForFunction(
    () => /Lowest|no data under this line/.test(document.body.innerText),
    { timeout: 25000 },
  ).catch(() => {});
  const withHeights = await panelText();
  check("heights arrive from the server", /Lowest/.test(withHeights));
  check("and the panel states where they were read from", /native .* cell|bilinearly/.test(withHeights));
  const profileCall = analysisCalls.slice(before).find((c) => c.op === "profile");
  check("the page asked for a profile", Boolean(profileCall));
  check("sending the drawn line", Array.isArray(profileCall?.line) && profileCall.line.length >= 2);
}

console.log("\nTool 4, cut and fill");
{
  check("the volume tool activates", await clickTool("Volume"));
  const prompt = await panelText();
  check("it asks for a polygon before offering anything", /Draw a polygon/i.test(prompt));

  // Three corners, then finish on the fourth. Clicking the fourth and *then*
  // double clicking the same point makes MapLibre read the pair as the double
  // click, which closes the ring a corner early.
  await clickMap(-90, -70);
  await clickMap(90, -70);
  await clickMap(90, 70);
  await doubleClickMap(-90, 70);

  await page
    .waitForFunction(() => /Measure against/i.test(document.body.innerText), { timeout: 15000 })
    .catch(() => {});
  const text = await panelText();
  check("the ring closed and the panel woke up", /Cut and fill/i.test(text));
  check("a reference surface must be chosen before anything is computed", /Measure against/i.test(text));
  check("the rim option is offered", /own rim/i.test(text));
  check("a stated level plane is offered", /level plane/i.test(text));

  const before = analysisCalls.length;
  const clicked = await clickTool("Compute volumes");
  check("the compute button is available once a reference is picked", clicked);

  await page.waitForFunction(
    () => /m³|no survey data/i.test(document.body.innerText),
    { timeout: 40000 },
  ).catch(() => {});
  const result = await panelText();
  check(
    "cut, fill and net are reported",
    /\bCut\b/i.test(result) && /\bFill\b/i.test(result) && /\bNet\b/i.test(result),
  );
  check("as real cubic metres", /[\d,]+(\.\d+)? m³/.test(result), result.match(/[\d,]+(\.\d+)? m³/)?.[0] ?? "none");
  // Must be the volume panel's own band, not the "±4 cm" the spot panel prints.
  check(
    "with the uncertainty band beside them",
    /±\s?[\d,]+(\.\d+)? m³/.test(result),
    result.match(/±\s?[\d,]+(\.\d+)? m³/)?.[0] ?? "none",
  );
  check("and the sign convention spelled out", /material to export|above the reference/i.test(result));

  const volumeCall = analysisCalls.slice(before).find((c) => c.op === "volume");
  check("the page asked for a volume", Boolean(volumeCall));
  check(
    "with an explicit reference, never absent",
    typeof volumeCall?.reference === "string" && volumeCall.reference.length > 0,
    volumeCall?.reference,
  );
}

console.log("\nNothing broke along the way");
check("no page errors or unexpected console errors", problems.length === 0, problems.slice(0, 3).join(" | "));
check(
  "every analysis request named its CRS",
  analysisCalls.every((c) => c.crs === "lonlat" || c.crs === "utm"),
  `${analysisCalls.length} calls`,
);
console.log(`  (${analysisCalls.length} analysis requests made)`);

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
