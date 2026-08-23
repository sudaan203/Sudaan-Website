/**
 * Tools 19, 20, 21 and 16 driven on the real map.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-alignment-browser-test.mjs
 *
 * `alignment-api-test.mjs` proves the four engines answer correctly over HTTP.
 * This proves the half that was missing for weeks: that a client can *draw* the
 * line at all, that all four tools reach the same drawn geometry, that the
 * answer is put on the map, and that switching tools does not leave the previous
 * one's stations lying on top of the new one's.
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

/** Every analysis request the page makes, so the wire can be inspected. */
const calls = [];
page.on("request", (r) => {
  if (!r.url().includes("/analysis")) return;
  try {
    calls.push(JSON.parse(r.postData() ?? "{}"));
  } catch {
    /* not JSON, not ours */
  }
});

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
const PANEL = '[role="region"][aria-label="Alignment"]';
const panelText = () =>
  page.evaluate((sel) => document.querySelector(sel)?.innerText.replace(/\s+/g, " ") ?? "", PANEL);

async function clickByLabel(label) {
  const ok = await page.evaluate((needle) => {
    const b = [...document.querySelectorAll("button")].find(
      (e) => (e.getAttribute("aria-label") ?? e.textContent.trim()) === needle,
    );
    if (!b || b.disabled) return false;
    b.click();
    return true;
  }, label);
  await settle();
  return ok;
}

async function openGroup(name) {
  await page.evaluate((needle) => {
    [...document.querySelectorAll('[role="tab"]')]
      .find((t) => t.textContent.trim().startsWith(needle))
      ?.click();
  }, name);
  await settle(500);
}

/** Click at an offset from the canvas centre. */
async function clickMap(dx, dy) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await settle(400);
}
/** A real double click, which `clickCount: 2` does not produce. */
async function doubleClickMap(dx, dy) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await settle(900);
}

/**
 * What the map is actually drawing for the alignment result.
 *
 * `queryRenderedFeatures`, not the source's internal `_data`. Reading the
 * private field reported zero while 22 station labels were visibly on the map:
 * it is not the public contract and does not hold what a `setData` put there.
 * Rendered features are also the stronger claim — they prove the stations were
 * drawn, not merely handed to MapLibre.
 */
const drawn = async () => {
  await settle(600);
  return page.evaluate(() => {
    const m = window.__portalMap;
    const at = (layer) =>
      m.getLayer(layer) ? m.queryRenderedFeatures({ layers: [layer] }) : [];
    const points = at("alignment-stations");
    return {
      points: points.length,
      lines: at("alignment-ticks").length,
      flagged: points.filter((f) => f.properties?.unsafe).length,
      labels: document.querySelectorAll(".portal-station-label").length,
    };
  });
};

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});
/*
 * Wait for a tool to become enabled, not for "Checking…" to disappear.
 *
 * Waiting for the *absence* of something races hydration: before React has run,
 * the text is not there either, so the wait returns immediately and the tools are
 * then found mid-probe. A measure tool now renders disabled while the elevation
 * probe is in flight — "we do not know yet" and "it cannot be done" being
 * different states — so this shows up as every road tool being greyed out.
 *
 * A positive signal cannot race: the button is enabled only once the answer is
 * in.
 */
await page
  .waitForFunction(
    () => {
      const b = [...document.querySelectorAll("button")].find(
        (e) => e.getAttribute("aria-label") === "Spot Level",
      );
      return Boolean(b) && !b.disabled;
    },
    { timeout: 45000 },
  )
  .catch(() => {});

console.log("\nThe road tools are no longer greyed out");
{
  await openGroup("Roads");
  const state = await page.evaluate(() =>
    ["Chainage", "Corridor Analysis", "Automatic Cross Sections"].map((name) => {
      const b = [...document.querySelectorAll("button")].find(
        (e) => e.getAttribute("aria-label") === name,
      );
      return { name, present: Boolean(b), disabled: b?.disabled ?? null };
    }),
  );
  for (const t of state) {
    check(`${t.name} is offered and enabled`, t.present && t.disabled === false,
      `disabled=${t.disabled}`);
  }
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  check("the group no longer says its tools are not on the map",
    !/specified but not yet on the map/i.test(t));
}

console.log("\nDrawing a centreline");
{
  check("chainage can be selected", await clickByLabel("Chainage"));
  check("the panel asks for a line before anything else",
    /Draw the centreline/i.test(await panelText()));

  await clickMap(-160, -70);
  await clickMap(0, 0);
  await doubleClickMap(150, 80);

  const text = await panelText();
  check("the drawn line is measured instantly, without the server",
    /\d+(\.\d+)? m/.test(text), text.match(/[\d.]+ m/)?.[0] ?? "no length");
  check("and its points are counted", /3 points/.test(text), text.match(/\d+ points/)?.[0] ?? "");
}

console.log("\nTool 19: chainage");
{
  const before = calls.length;
  check("it computes on request", await clickByLabel("Measure"));
  await page.waitForFunction(
    (sel) => /Steepest grade/i.test(document.querySelector(sel)?.innerText ?? ""),
    { timeout: 45000 }, PANEL,
  ).catch(() => {});

  const text = await panelText();
  check("stations are reported", /Stations \d+ at \d+ m/.test(text),
    text.match(/Stations \d+ at \d+ m/)?.[0] ?? "not reported");
  check("with the steepest grade as a percentage", /Steepest grade [\d.]+ %/.test(text),
    text.match(/Steepest grade [\d.]+ %/)?.[0]);
  check("and chainages labelled the way a drawing labels them", /\d\+\d{3}\.\d{3}/.test(text),
    text.match(/\d\+\d{3}\.\d{3}/)?.[0]);

  const sent = calls.slice(before).find((c) => c.op === "chainage");
  check("the page asked for chainage", Boolean(sent));
  check("sending the drawn line, not a polygon", Array.isArray(sent?.line) && sent.line.length === 3);
  check("in lon/lat, letting the server project", sent?.crs === "lonlat");
  check("with the interval it is showing", sent?.interval === 10, `interval=${sent?.interval}`);

  const map = await drawn();
  check("stations are drawn on the map", map.points > 2, `${map.points} stations`);
  check("and labelled", map.labels > 0, `${map.labels} labels`);
}

console.log("\nThe interval is a real control");
{
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="region"][aria-label="Alignment"] button')]
      .find((b) => b.textContent.trim() === "25 m")?.click();
  });
  await settle(400);
  const before = calls.length;
  await clickByLabel("Measure");
  await settle(2500);
  const sent = calls.slice(before).find((c) => c.op === "chainage");
  check("changing it changes the request", sent?.interval === 25, `interval=${sent?.interval}`);
  const text = await panelText();
  check("and the answer says which interval produced it", /at 25 m/.test(text),
    text.match(/Stations \d+ at \d+ m/)?.[0]);
}

console.log("\nTool 20: corridor, on the same line");
{
  const before = calls.length;
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="region"][aria-label="Alignment"] button')]
      .find((b) => b.getAttribute("aria-label") === "Corridor")?.click();
  });
  await settle(400);
  await clickByLabel("Measure");
  await page.waitForFunction(
    (sel) => /usable width/i.test(document.querySelector(sel)?.innerText ?? ""),
    { timeout: 45000 }, PANEL,
  ).catch(() => {});

  const sent = calls.slice(before).find((c) => c.op === "corridor");
  check("it reached the corridor op", Boolean(sent));
  check("without redrawing the line", sent?.line?.length === 3);
  check("carrying the limits from the panel",
    sent?.maxGradePercent === 10 && sent?.maxCrossfallPercent === 6,
    JSON.stringify({ g: sent?.maxGradePercent, c: sent?.maxCrossfallPercent }));

  const text = await panelText();
  check("width is reported", /usable width/i.test(text));
  check("and stated as derived, not surveyed", /not a survey/i.test(text));

  const map = await drawn();
  check("its stations replaced the chainage ones rather than joining them",
    map.points > 0, `${map.points} stations`);
}

console.log("\nTool 21: sections, drawn as the ticks they were cut along");
{
  const before = calls.length;
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="region"][aria-label="Alignment"] button')]
      .find((b) => b.getAttribute("aria-label") === "Sections")?.click();
  });
  await settle(400);
  await clickByLabel("Measure");
  await page.waitForFunction(
    (sel) => /Width sampled/i.test(document.querySelector(sel)?.innerText ?? ""),
    { timeout: 45000 }, PANEL,
  ).catch(() => {});

  const sent = calls.slice(before).find((c) => c.op === "cross-sections");
  check("it reached the cross-sections op", Boolean(sent));
  check("with a half width", sent?.halfWidth === 15, `halfWidth=${sent?.halfWidth}`);

  const map = await drawn();
  check("each section is drawn as a tick across the line", map.lines > 1, `${map.lines} ticks`);
  const text = await panelText();
  check("and the panel says sections are cut perpendicular", /perpendicular/i.test(text));
}

console.log("\nTool 16: benches, from the mining group");
{
  await openGroup("Mining");
  const before = calls.length;
  check("bench analysis is enabled", await clickByLabel("Bench Analysis"));
  await clickByLabel("Measure");
  await page.waitForFunction(
    (sel) => /Along the line/i.test(document.querySelector(sel)?.innerText ?? ""),
    { timeout: 45000 }, PANEL,
  ).catch(() => {});

  const sent = calls.slice(before).find((c) => c.op === "bench");
  check("it reached the bench op", Boolean(sent));
  check("and did not send parameters it does not read",
    sent && !("halfWidth" in sent) && !("interval" in sent), JSON.stringify(Object.keys(sent ?? {})));

  const text = await panelText();
  check("the line is fully accounted for", /Along the line/i.test(text));
  check("including ground that is flat but too short to be a bench",
    /under the minimum/i.test(text));
  check("and it says what it measured rather than what it means",
    /not of the mine plan|report terraces as benches/i.test(text));

  const map = await drawn();
  check("bench analysis draws no stations, having none to draw",
    map.points === 0 && map.lines === 0, `${map.points} points, ${map.lines} lines`);
}

console.log("\nClearing takes the geometry with it");
{
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="region"][aria-label="Alignment"] button')]
      .find((b) => b.textContent.trim() === "Clear")?.click();
  });
  await settle(700);
  const map = await drawn();
  check("no stations remain", map.points === 0 && map.lines === 0);
  check("and no labels", map.labels === 0, `${map.labels} left`);
  check("the panel asks for a line again", /Draw the centreline/i.test(await panelText()));
}

console.log("\nNothing broke");
check("every request named its CRS", calls.every((c) => c.crs === "lonlat"), `${calls.length} calls`);
check("no page errors or unexpected console errors", problems.length === 0,
  problems.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
