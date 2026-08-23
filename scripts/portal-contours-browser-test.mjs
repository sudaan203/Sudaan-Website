/**
 * Drives the contour elevation controls on the survey map in a real browser.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-contours-browser-test.mjs
 *
 * Contours arrive with an `elevation` attribute on every line. This proves the
 * map does something with it: that labels appear, that an elevation band hides
 * the levels outside it and only those, that index contours are drawn heavier,
 * and that colour is stretched across the band shown rather than left flat.
 *
 * Everything here is asserted against MapLibre's own view of the style and the
 * DOM, not against a screenshot, so a passing run means the map really is
 * filtering and labelling rather than merely looking as though it is.
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
await page.setViewport({ width: 1400, height: 1200 });
await page.setCookie({ name: "sga_portal_session", value: token, domain: "localhost", path: "/" });

const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/WebGL|SwiftShader|GPU stall|Failed to load resource/i.test(t)) return;
  problems.push(`console: ${t.slice(0, 300)}`);
});

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});

const appeared = await page
  .waitForFunction(() => /interval,/i.test(document.body.innerText), { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
check("the contour panel appears once the GeoJSON has loaded", appeared);

const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the contour layer's live style out of MapLibre.
 *
 * Reaching for the map instance rather than for pixels: a filter that is present
 * and a filter that is doing something are different claims, and only the style
 * can tell them apart.
 */
async function contourStyle() {
  return page.evaluate(() => {
    const m = window.__portalMap;
    if (!m) return null;
    const layer = m.getStyle().layers.find((l) => /contour/i.test(l.id));
    if (!layer) return null;
    return {
      id: layer.id,
      filter: m.getFilter(layer.id) ?? null,
      colour: m.getPaintProperty(layer.id, "line-color") ?? null,
      width: m.getPaintProperty(layer.id, "line-width") ?? null,
      visibility: m.getLayoutProperty(layer.id, "visibility") ?? "visible",
      rendered: m.queryRenderedFeatures({ layers: [layer.id] }).length,
      levels: [
        ...new Set(
          m.queryRenderedFeatures({ layers: [layer.id] }).map((f) => f.properties.elevation),
        ),
      ].sort((a, b) => a - b),
    };
  });
}

const labels = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".maplibregl-marker")]
      .map((el) => el.textContent.trim())
      .filter((t) => /^\d/.test(t)),
  );

/**
 * Click a checkbox by the label text it sits inside.
 *
 * `exact` exists because substring matching bit once already: the slope layer's
 * description reads "Shown in degrees", so looking for a label containing "Show"
 * found the slope radio, which has no checkbox, and the helper quietly did
 * nothing while the assertion after it blamed the map.
 */
async function toggle(labelText, exact = false) {
  const handle = await page.evaluateHandle(
    (needle, isExact) => {
      const l = [...document.querySelectorAll("label")].find((el) => {
        const t = el.textContent.replace(/\s+/g, " ").trim();
        return isExact ? t === needle : t.includes(needle);
      });
      return l?.querySelector('input[type="checkbox"]') ?? null;
    },
    labelText,
    exact,
  );
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  await settle();
  return true;
}

/** Drag a range input to a value the way React will notice. */
async function setRange(ariaLabel, value) {
  const ok = await page.evaluate(
    (label, v) => {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    ariaLabel,
    value,
  );
  await settle();
  return ok;
}

console.log("\nThe panel describes the contour set from the data");
{
  const t = await text();
  check("it states the interval", /1 m interval/.test(t), t.match(/[\d.]+ m interval[^.]*/)?.[0]);
  check("and the full elevation range", /338–424 m/.test(t) || /338-424 m/.test(t));
  check("and how many levels there are", /87 levels/.test(t));
}

console.log("\nElevation labels are drawn");
{
  const drawn = await labels();
  check("labels appear on the map", drawn.length > 0, `${drawn.length} labels`);
  check("and every one is a level that exists in the data", drawn.every((v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 338 && n <= 424;
  }), drawn.slice(0, 6).join(", "));
  check("no level is labelled twice", new Set(drawn).size === drawn.length,
    `${new Set(drawn).size} distinct of ${drawn.length}`);

  const off = await toggle("Elevation labels");
  check("the labels checkbox was found", off);
  check("labels can be turned off", (await labels()).length === 0);
  await toggle("Elevation labels");
  check("and back on", (await labels()).length > 0);
}

console.log("\nIndex contours are drawn heavier");
{
  const style = await contourStyle();
  check("the map instance is reachable for inspection", style !== null);
  check("line width is a case expression, not a constant",
    JSON.stringify(style?.width ?? "").includes("case"),
    JSON.stringify(style?.width ?? "").slice(0, 120));

  await toggle("Index contours");
  const plain = await contourStyle();
  check("turning them off removes the case expression",
    !JSON.stringify(plain?.width ?? "").includes("case"));
  await toggle("Index contours");
}

console.log("\nColour is stretched across the band shown");
{
  const style = await contourStyle();
  check("line colour is interpolated over elevation",
    JSON.stringify(style?.colour ?? "").includes("interpolate") &&
      JSON.stringify(style?.colour ?? "").includes("elevation"));

  await toggle("Colour by height");
  const flat = await contourStyle();
  check("turning it off gives a single colour", typeof flat?.colour === "string",
    JSON.stringify(flat?.colour ?? "").slice(0, 80));
  await toggle("Colour by height");
}

console.log("\nAn elevation band hides the levels outside it, and only those");
{
  const before = await contourStyle();
  check("everything is drawn to start with", before.levels.length > 3,
    `${before.levels.length} levels rendered`);

  await setRange("Lowest contour shown, in metres", 380);
  await setRange("Highest contour shown, in metres", 400);

  const after = await contourStyle();
  check("the filter now names the band",
    JSON.stringify(after.filter).includes("380") && JSON.stringify(after.filter).includes("400"),
    JSON.stringify(after.filter));
  check("nothing below the band is drawn", after.levels.every((l) => l >= 380),
    `lowest rendered ${after.levels[0]}`);
  check("nothing above the band is drawn", after.levels.every((l) => l <= 400),
    `highest rendered ${after.levels[after.levels.length - 1]}`);
  check("something is still drawn", after.levels.length > 0, `${after.levels.length} levels`);

  const t = await text();
  check("the panel counts what is shown", /of 87/.test(t), t.match(/\d+ of 87/)?.[0]);

  const drawn = await labels();
  check("and labels are confined to the band too",
    drawn.length === 0 || drawn.every((v) => Number(v) >= 380 && Number(v) <= 400),
    drawn.join(", "));

  // The band is a filter on the drawing, never a claim about the ground.
  check("a way back to the full range is offered", /Show every level/i.test(t));
}

console.log("\nHiding the layer takes its labels with it");
{
  const hid = await toggle("Show", true);
  check("the layer's own visibility checkbox was found", hid);
  const drawn = await labels();
  check("no labels remain over a hidden layer", drawn.length === 0, `${drawn.length} left`);
  await toggle("Show", true);
}

console.log("\nNothing broke");
check("no page errors or unexpected console errors", problems.length === 0,
  problems.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
