/**
 * The tool rail: Malhar's five documents, presented as five groups.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-tool-rail-test.mjs
 *
 * The point of this suite is not that buttons exist. It is that the dashboard
 * tells the truth about itself:
 *
 *  - every group in the specification is reachable, including the ones where
 *    little is built, because hiding those makes the product look finished;
 *  - a tool that is not on the map is *offered and disabled with a reason*,
 *    never silently absent and never a button that fails on click;
 *  - only one tool is armed at a time. Measure mode and hydrology mode used to
 *    be independent, so both could listen for the same click.
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

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector('[role="tab"]', { timeout: 30000 }).catch(() => {});
// The tools stay disabled until the server has said what can be measured.
await page
  .waitForFunction(() => !/Checking the elevation model/i.test(document.body.innerText), {
    timeout: 45000,
  })
  .catch(() => {});

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

const tabs = () =>
  page.$$eval('[role="tab"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

async function openGroup(name) {
  const ok = await page.evaluate((needle) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent.trim().startsWith(needle),
    );
    if (!tab) return false;
    tab.click();
    return true;
  }, name);
  await settle();
  return ok;
}

/** Every tool button in the rail: accessible name, whether it is enabled, why not. */
const railTools = () =>
  page.evaluate(() => {
    const rail = document.querySelector('[role="tablist"]')?.parentElement;
    if (!rail) return [];
    return [...rail.querySelectorAll("button")]
      .filter((b) => b.getAttribute("role") !== "tab")
      .map((b) => ({
        name: b.getAttribute("aria-label") ?? b.textContent.trim(),
        number: b.textContent.trim().match(/^\d+/)?.[0] ?? null,
        disabled: b.disabled,
        reason: b.title,
        pressed: b.getAttribute("aria-pressed") === "true",
      }));
  });

console.log("\nEvery group in the specification is reachable");
{
  const t = await tabs();
  for (const [name, range] of [
    ["Universal", "1–10, 37, 40"],
    ["Hydrology", "24–28"],
    ["Contractor", "11–14"],
    ["Mining", "15–18"],
    ["Roads", "19–21"],
  ]) {
    check(`${name} is offered`, t.some((x) => x.startsWith(name)), t.join(" | "));
    check(`  and carries its numbers ${range}`, t.some((x) => x.includes(range)));
  }
}

console.log("\nUniversal: the tools that work, and the ones that do not, both shown");
{
  await openGroup("Universal");
  const tools = await railTools();
  const by = (n) => tools.find((x) => x.name === n);

  /*
   * Twelve, not ten: 37 (CAD export) and 40 (dashboard summary) come from the
   * master prompt rather than from a numbered document, and both are universal
   * in nature. The group's own label has to admit that, which is the check
   * above.
   */
  check("all twelve universal tools are listed", tools.filter((x) => x.number).length === 12,
    `${tools.filter((x) => x.number).length} numbered`);
  check("in ascending order, gaps included",
    tools.filter((x) => x.number).map((x) => Number(x.number)).join(",") ===
      "1,2,3,4,5,6,7,8,9,10,37,40");

  for (const name of ["Spot Level", "Cross Section", "Cut & Fill", "Area"]) {
    check(`${name} is usable`, by(name) && !by(name).disabled, by(name)?.reason ?? "missing");
  }

  // The honest half. A tool nobody can reach must say why, on the button.
  for (const name of ["Grid Spot Levels", "Timeline Comparison", "Export Centre"]) {
    const tool = by(name);
    check(`${name} is offered but disabled`, Boolean(tool) && tool.disabled);
    check(`  with a reason a client can read`, Boolean(tool?.reason?.length > 20),
      tool?.reason ?? "");
  }

  const blockedReason = by("Timeline Comparison")?.reason ?? "";
  check("a blocked tool names what it is waiting on, not our file layout",
    /flown twice|repeat flight/i.test(blockedReason) && !/portal-data|\.tif|src\//.test(blockedReason),
    blockedReason);
}

console.log("\nHydrology: the group that is actually finished");
{
  await openGroup("Hydrology");
  const tools = await railTools();
  const by = (n) => tools.find((x) => x.name === n);
  check("tools 24 to 28 are listed",
    tools.filter((x) => x.number).map((x) => Number(x.number)).join(",") === "24,25,26,27,28");
  for (const name of ["Flow Accumulation", "Watershed Delineation", "Sink Detection", "Flood Simulation"]) {
    check(`${name} is usable`, by(name) && !by(name).disabled, by(name)?.reason ?? "missing");
  }
  check("Inspect is offered alongside them", tools.some((x) => x.name === "Inspect" && !x.disabled));
  check("Flow Direction says it is drawn as a grid rather than as arrows",
    /arrows/i.test(by("Flow Direction")?.reason ?? ""), by("Flow Direction")?.reason ?? "");
}

console.log("\nRoads: nothing is on the map, and the rail says so rather than pretending");
{
  await openGroup("Roads");
  const tools = await railTools();
  check("all three road tools are listed", tools.filter((x) => x.number).length === 3);
  check("every one is disabled", tools.filter((x) => x.number).every((x) => x.disabled));
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  check("and the group states the calculations exist but have no input",
    /specified but not yet on the map/i.test(t) && /draw the input/i.test(t),
    t.match(/[^.]*not yet on the map[^.]*\./)?.[0] ?? "not stated");
}

console.log("\nOnly one tool is armed at a time");
{
  await openGroup("Universal");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.getAttribute("aria-label") === "Spot Level")
      ?.click();
  });
  await settle();
  check("the spot tool is pressed", (await railTools()).some((x) => x.name === "Spot Level" && x.pressed));

  await openGroup("Hydrology");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.getAttribute("aria-label") === "Watershed Delineation")
      ?.click();
  });
  await settle();
  check("the watershed tool is now pressed",
    (await railTools()).some((x) => x.name === "Watershed Delineation" && x.pressed));

  /*
   * The check this suite exists for. Before the rail these were two independent
   * state machines and nothing turned one off when the other came on, so a click
   * on the map asked the server two unrelated questions and filled two panels.
   */
  await openGroup("Universal");
  const universal = await railTools();
  check("and the measure tool was switched off, not left listening",
    universal.every((x) => !x.pressed),
    universal.filter((x) => x.pressed).map((x) => x.name).join(", ") || "none pressed");
}

console.log("\nPressing an armed tool turns it off");
{
  const arm = async () =>
    page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.getAttribute("aria-label") === "Cut & Fill")
        ?.click();
    });
  await arm();
  await settle();
  check("armed", (await railTools()).some((x) => x.name === "Cut & Fill" && x.pressed));
  await arm();
  await settle();
  check("and disarmed by the same button",
    (await railTools()).every((x) => !x.pressed));
}

console.log("\nNothing broke");
check("no page errors or unexpected console errors", problems.length === 0,
  problems.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
