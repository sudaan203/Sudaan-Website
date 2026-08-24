/**
 * Malhar's shapefile tool, driven on the real map.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-shapefile-browser-test.mjs
 *
 * `shapefile-api-test.mjs` proves the route projects and round-trips
 * correctly. This proves a client can actually reach it: draw a polygon by
 * clicking the map, download it, and — because that is the entire point of the
 * tool — upload the very file that came back and have it draw on the map a
 * second time, so the two shapes visibly coincide.
 *
 * It also checks the one thing hardest to get right by accident: that drawing
 * a shapefile does not fight with every other tool on the map for the same
 * click. Switching to a numbered tool mid-draw must abandon the shapefile in
 * progress rather than leave both listening.
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

// Capture the shapefile zip when the browser tries to save one, the same way
// the surface-export suite captures a CSV: the blob has to be held against its
// object URL, because reading it inside createObjectURL races the click that
// names it.
await page.evaluateOnNewDocument(() => {
  window.__blobs = new Map();
  window.__saved = [];
  const realCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = realCreate(blob);
    window.__blobs.set(url, blob);
    return url;
  };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patched() {
    if (this.download) {
      window.__saved.push({ name: this.download, url: this.href });
      return;
    }
    return realClick.call(this);
  };
  window.__lastSaved = async () => {
    const last = window.__saved[window.__saved.length - 1];
    if (!last) return null;
    const blob = window.__blobs.get(last.url);
    const buf = await blob.arrayBuffer();
    return { name: last.name, base64: btoa(String.fromCharCode(...new Uint8Array(buf))) };
  };
});

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const PANEL = '[role="region"][aria-label="Shapefile"]';
const panelText = () =>
  page.evaluate((sel) => document.querySelector(sel)?.innerText.replace(/\s+/g, " ") ?? "", PANEL);

async function openSegment(label) {
  const clicked = await page.evaluate((needle) => {
    const b = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === needle);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  await settle(400);
  return clicked;
}

/**
 * Click a numbered tool by its accessible name, on the tool rail's own
 * toolbar — not inside a region named after the group, because the rail's
 * groups are `[role="tab"]` labels, not landmarks; the toolbar itself is the
 * single `[role="toolbar"][aria-label="Tools"]` for whichever group is
 * currently selected.
 */
async function clickRailTool(name) {
  return page.evaluate((needle) => {
    const b = [...document.querySelectorAll('[role="toolbar"] button')].find(
      (e) => e.getAttribute("aria-label") === needle,
    );
    if (!b || b.disabled) return false;
    b.click();
    return true;
  }, name);
}
async function clickIn(region, text) {
  return page.evaluate(
    (r, t) => {
      const panel = document.querySelector(`[role="region"][aria-label="${r}"]`);
      const b = [...(panel?.querySelectorAll("button") ?? [])].find(
        (e) => e.getAttribute("aria-label") === t || e.textContent.trim().startsWith(t),
      );
      if (!b || b.disabled) return false;
      b.click();
      return true;
    },
    region,
    text,
  );
}
async function clickMap(dx, dy) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await settle(300);
}
async function dblClickMap(dx, dy) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await settle(700);
}

const renderedCount = async (layer) =>
  page.evaluate((id) => {
    const m = window.__portalMap;
    return m?.getLayer(id) ? m.queryRenderedFeatures({ layers: [id] }).length : -1;
  }, layer);

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});
await page
  .waitForFunction(
    () => {
      const b = [...document.querySelectorAll("button")].find((e) => e.getAttribute("aria-label") === "Spot Level");
      return Boolean(b) && !b.disabled;
    },
    { timeout: 45000 },
  )
  .catch(() => {});

console.log("\nThe Shapefile segment is offered on every survey");
{
  const opened = await openSegment("Shapefile");
  check("the segment can be opened", opened);
  const t = await panelText();
  check("it explains what the tool is for", /export them as a real shapefile/i.test(t));
  check("upload is offered too", /Drop a \.zip here/i.test(t));
}

console.log("\nDrawing a polygon");
{
  check("Polygon can be selected", await clickIn("Shapefile", "Polygon"));
  const hint = await page.evaluate(() => document.body.innerText);
  check("the toolbar explains the gesture", /Click each corner, double click to finish/i.test(hint));

  await clickMap(-100, -60);
  await clickMap(80, -60);
  await clickMap(80, 60);
  await dblClickMap(-100, 60);

  const t = await panelText();
  check("the drawn polygon is counted", /Polygon\s*1/.test(t.replace(/\s+/g, " ")), t.slice(0, 120));

  const rendered = await renderedCount("shapefile-features-fill");
  check("it is actually drawn on the map, not just counted", rendered > 0, `${rendered} rendered`);
}

console.log("\nA second numbered tool takes the click away cleanly");
{
  check("Point can be armed", await clickIn("Shapefile", "Point")); // to prove it gets cleared
  await openGroup("Universal");
  check("Spot Level can be selected on the rail", await clickRailTool("Spot Level"));
  await settle(500);

  const t = await panelText();
  check("the shapefile panel no longer shows an armed tool",
    !/Click anywhere to place a point/i.test(await page.evaluate(() => document.body.innerText)));

  // A click now should take a spot level, not draw a shapefile point.
  const before = await renderedCount("shapefile-features-points");
  await clickMap(0, 0);
  await settle(800);
  const after = await renderedCount("shapefile-features-points");
  check("clicking the map after switching tools did not add a shapefile point",
    after === before, `${before} -> ${after}`);
  void t;
}

async function openGroup(name) {
  await page.evaluate((needle) => {
    [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim().startsWith(needle))?.click();
  }, name);
  await settle(400);
}

console.log("\nDownload: the actual file, read back and checked");
{
  await openSegment("Shapefile");
  await clickIn("Shapefile", "Polygon"); // re-arm; the switch above cleared it
  await settle(300);
  // The panel should already show the one polygon drawn earlier — confirm the
  // count survived switching away and back before downloading it.
  const t = await panelText();
  check("the earlier polygon is still there after switching tools", /Polygon\s*1/.test(t.replace(/\s+/g, " ")));

  check("Download can be pressed", await clickIn("Shapefile", "Download"));
  await page.waitForFunction(() => window.__saved.length > 0, { timeout: 15000 }).catch(() => {});

  const saved = await page.evaluate(() => window.__lastSaved());
  check("a file was actually saved", Boolean(saved), JSON.stringify(saved));
  check("named like a shapefile zip", /\.zip$/i.test(saved?.name ?? ""), saved?.name);
}

console.log("\nUpload: the file just downloaded, read back onto the map");
let uploadedOk = false;
{
  const saved = await page.evaluate(() => window.__lastSaved());
  const fileInput = await page.$('[role="region"][aria-label="Shapefile"] input[type="file"]');
  check("the upload control exists", Boolean(fileInput));

  if (fileInput && saved) {
    // Puppeteer's uploadFile needs a real path on disk; write the captured
    // bytes out, then feed that file back in through the actual <input>, which
    // exercises the same multipart path a person dragging a file in would.
    const { writeFileSync } = await import("node:fs");
    const path = "/tmp/portal-shapefile-browser-test-upload.zip";
    writeFileSync(path, Buffer.from(saved.base64, "base64"));
    await fileInput.uploadFile(path);
    await page.waitForFunction(
      (sel) => /Read as/i.test(document.querySelector(sel)?.innerText ?? ""),
      { timeout: 15000 },
      PANEL,
    ).catch(() => {});
    uploadedOk = true;
  }

  const t = await panelText();
  check("the upload succeeded", /1 polygon/i.test(t), t.slice(0, 160));
  check("and states the projection it was read as", /UTM zone 43N/i.test(t), t.slice(0, 200));

  const rendered = await renderedCount("shapefile-uploaded-fill");
  check("the uploaded shape is drawn on the map", rendered > 0, `${rendered} rendered`);
}

console.log("\nDrawn and uploaded are visibly two different things");
{
  const drawnColour = await page.evaluate(() => {
    const m = window.__portalMap;
    return m.getPaintProperty("shapefile-features-fill", "fill-color");
  });
  const uploadedColour = await page.evaluate(() => {
    const m = window.__portalMap;
    return m.getPaintProperty("shapefile-uploaded-fill", "fill-color");
  });
  check("drawn and uploaded features use different colours",
    drawnColour !== uploadedColour, `${drawnColour} vs ${uploadedColour}`);
}

console.log("\nClearing each half works independently");
{
  check("uploaded can be removed", await clickIn("Shapefile", "Remove"));
  await settle(400);
  check("only the uploaded layer emptied", (await renderedCount("shapefile-uploaded-fill")) === 0);
  check("the drawn polygon is still there", (await renderedCount("shapefile-features-fill")) > 0);

  check("drawn features can be cleared", await clickIn("Shapefile", "Clear drawn"));
  await settle(400);
  check("the drawn layer is now empty too", (await renderedCount("shapefile-features-fill")) === 0);
}

console.log("\nNothing broke");
check("no page errors or unexpected console errors", problems.length === 0,
  problems.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
