/**
 * Drives the rendered raster layers on the survey map in a real browser.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-render-browser-test.mjs
 *
 * `render-api-test.mjs` proves the tiler returns correct images. This proves the
 * map asks it for the right ones: that a layer can be turned on, that the tile
 * requests carry an explicit range rather than letting each tile stretch itself,
 * that the colourbar reflects the layer actually selected, and that changing a
 * control changes the request instead of leaving cached tiles on screen.
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

/** Every tile URL the map asks the renderer for. */
const tiles = [];
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/render/")) tiles.push(u);
});

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});

const appeared = await page
  .waitForFunction(() => /RENDERED LAYERS/i.test(document.body.innerText), { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
check("the rendered layers panel appears", appeared);

const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

/**
 * Select a rendered layer by its visible label.
 *
 * Waits for that *label* rather than for the panel heading. The list is filled
 * in two stages — the hydrology layers come from a manifest, the terrain layers
 * wait on the elevation probe — so "RENDERED LAYERS" appears while "Terrain,
 * shaded" does not yet exist, and clicking then finds nothing. It failed about
 * one run in three, which is the worst kind of test.
 */
async function selectLayer(label) {
  await page
    .waitForFunction(
      (needle) =>
        [...document.querySelectorAll("label")].some((el) =>
          el.textContent.trim().startsWith(needle),
        ),
      { timeout: 45000 },
      label,
    )
    .catch(() => {});
  const handle = await page.evaluateHandle((needle) => {
    const l = [...document.querySelectorAll("label")].find((el) =>
      el.textContent.trim().startsWith(needle),
    );
    return l?.querySelector('input[type="radio"]') ?? null;
  }, label);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  await new Promise((r) => setTimeout(r, 2500));
  return true;
}

const paramsOf = (url) => Object.fromEntries(new URL(url).searchParams.entries());

console.log("\nThe layers on offer");
{
  const t = await text();
  for (const expected of ["Terrain, shaded", "Slope", "Flow accumulation"]) {
    check(`${expected} is offered`, t.includes(expected));
  }
  check("each carries a plain language description",
    /Bare earth, coloured by height/i.test(t) && /Steepness of the ground/i.test(t));
  check("slope explains the unit trap", /15° is about 27%/.test(t));
}

console.log("\nTurning on the shaded terrain");
{
  const before = tiles.length;
  check("the layer can be selected", await selectLayer("Terrain, shaded"));
  await page.waitForFunction(
    (n) => window.performance.getEntriesByType("resource").filter((e) => e.name.includes("/render/")).length > n,
    { timeout: 40000 },
    before,
  ).catch(() => {});

  const asked = tiles.slice(before);
  check("the map requested tiles from the renderer", asked.length > 0, `${asked.length} tiles`);

  if (asked.length) {
    const p = paramsOf(asked[0]);
    // The chessboard guard, checked where it is actually decided.
    check("every request carries an explicit range", asked.every((u) => {
      const q = paramsOf(u);
      return Number.isFinite(Number(q.min)) && Number.isFinite(Number(q.max)) && q.min !== q.max;
    }), `min=${p.min} max=${p.max}`);
    check("and every tile of the layer uses the same range",
      new Set(asked.map((u) => `${paramsOf(u).min}/${paramsOf(u).max}`)).size === 1,
      [...new Set(asked.map((u) => `${paramsOf(u).min}/${paramsOf(u).max}`))].join(", "));
    check("the range looks like this survey's elevations",
      Number(p.min) > 100 && Number(p.max) < 900, `${p.min}..${p.max}`);
    check("relief is requested for a surface", "exaggeration" in p, JSON.stringify(p));
    check("the layer asked for is the one selected", /\/render\/dtm\//.test(asked[0]));
  }

  const t = await text();
  check("a colourbar appears with round ticks", /\d+ m/.test(t));
  check("and it is described for a screen reader",
    (await page.$('[aria-label*="Terrain, shaded from"]')) !== null);
}

console.log("\nSwitching layer changes what is asked for");
{
  const before = tiles.length;
  check("slope can be selected", await selectLayer("Slope"));
  await new Promise((r) => setTimeout(r, 2500));
  const asked = tiles.slice(before);
  check("new tiles are requested", asked.length > 0, `${asked.length}`);
  if (asked.length) {
    check("for the slope layer", asked.every((u) => /\/render\/slope_degrees\//.test(u)));
    const p = paramsOf(asked[0]);
    check("with slope's own range, not the terrain's",
      Number(p.max) < 100, `${p.min}..${p.max}`);
    check("and no relief, because slope is not a surface", !("exaggeration" in p), JSON.stringify(p));
  }
  const t = await text();
  check("the colourbar switched to degrees", /\d+°/.test(t));
}

console.log("\nFlow accumulation is drawn logarithmically");
{
  const before = tiles.length;
  check("flow accumulation can be selected", await selectLayer("Flow accumulation"));
  await new Promise((r) => setTimeout(r, 2500));
  const asked = tiles.slice(before);
  check("tiles are requested", asked.length > 0, `${asked.length}`);
  const t = await text();
  // The client must be told, or the colours read as proportional when they are not.
  check("and the panel says the scale is logarithmic",
    /logarithmic/i.test(t), "not stated");
  check("saying what that means in plain words",
    /step up the bar is a multiplication/i.test(t));
}

console.log("\nControls change the request rather than leaving stale tiles");
{
  await selectLayer("Terrain, shaded");
  await new Promise((r) => setTimeout(r, 2000));
  const before = tiles.length;

  const slider = await page.$("#rendered-exaggeration");
  check("the relief control exists for a surface layer", Boolean(slider));
  if (slider) {
    await slider.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "35");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 2500));
    const asked = tiles.slice(before);
    check("changing relief re-requests tiles", asked.length > 0, `${asked.length}`);
    if (asked.length) {
      check("with the new exaggeration in the URL",
        Number(paramsOf(asked[0]).exaggeration) > 2,
        `exaggeration=${paramsOf(asked[0]).exaggeration}`);
    }
  }
}

console.log("\nNothing broke");
check("no page errors or unexpected console errors", problems.length === 0,
  problems.slice(0, 3).join(" | "));
console.log(`  (${tiles.length} tile requests observed)`);

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
