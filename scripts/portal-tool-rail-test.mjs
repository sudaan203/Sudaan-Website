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
  /*
   * A positive signal, not the absence of one: waiting for "Checking…" to
   * disappear races hydration, because before React runs the text is missing too
   * and the wait returns before the page has done anything.
   */
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

/**
 * The tools on offer for the chosen group.
 *
 * Read from the named toolbar rather than from "every button near the tabs".
 * The rail's markup changed in the design pass and a structural selector broke
 * with it; the role and the label are the contract.
 */
const railTools = () =>
  page.evaluate(() => {
    const rail = document.querySelector('[role="toolbar"][aria-label="Tools"]');
    if (!rail) return [];
    return [...rail.querySelectorAll("button")]
      .filter((b) => !/not yet$/.test(b.textContent.trim()))
      .map((b) => ({
        name: b.getAttribute("aria-label") ?? b.textContent.trim(),
        number: b.textContent.trim().match(/^\d+/)?.[0] ?? null,
        disabled: b.disabled,
        reason: b.title,
        pressed: b.getAttribute("aria-pressed") === "true",
      }));
  });

/**
 * The tools that are specified but not reachable, with their reasons.
 *
 * They used to be rendered inline, greyed out. Eight disabled buttons above a
 * map is not transparency, so they now collapse behind one count that opens a
 * list — the same information, a hundredth of the space. This opens it.
 */
const pendingTools = async () => {
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[role="toolbar"] button')].find((e) =>
      /not yet$/.test(e.textContent.trim()),
    );
    if (!b) return false;
    b.click();
    return true;
  });
  if (!opened) return [];
  await settle(300);
  const list = await page.evaluate(() =>
    [...document.querySelectorAll('[role="group"][aria-label="Not yet available"] li')].map(
      (li) => ({
        name: li.querySelector("p")?.textContent.replace(/^\d+\s*/, "").trim() ?? "",
        reason: li.querySelectorAll("p")[1]?.textContent.trim() ?? "",
      }),
    ),
  );
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => document.body.click());
  await settle(200);
  return list;
};

console.log("\nEvery group in the specification is reachable");
{
  const t = await tabs();
  /*
   * The tab no longer prints its number range. It was accurate and it was noise:
   * five tabs each carrying "1-10, 37, 40" is a lot of small grey text above a
   * map, and every tool still shows its own number on its own button. The
   * ranges live in docs/tool-catalogue.md, which is where someone reconciling
   * against Malhar's documents is reading anyway.
   */
  for (const name of ["Universal", "Hydrology", "Contractor", "Mining", "Roads"]) {
    check(`${name} is offered`, t.some((x) => x.startsWith(name)), t.join(" | "));
  }
}

console.log("\nUniversal: the tools that work, and the ones that do not, both shown");
{
  await openGroup("Universal");
  const tools = await railTools();
  const by = (n) => tools.find((x) => x.name === n);

  const pending = await pendingTools();

  /*
   * Twelve, not ten: 37 (CAD export) and 40 (dashboard summary) come from the
   * master prompt rather than from a numbered document, and both are universal
   * in nature. They are split across two places now — what works is on the
   * toolbar, what does not is behind the count — so the group is complete only
   * when the two are added together. That the sum is right is the check.
   */
  check("every universal tool is accounted for, on the bar or behind the count",
    tools.filter((x) => x.number).length + pending.length === 12,
    `${tools.filter((x) => x.number).length} usable + ${pending.length} pending`);

  for (const name of ["Spot Level", "Grid Spot Levels", "Cross Section", "Cut & Fill", "Area"]) {
    check(`${name} is on the bar`, Boolean(by(name)) && !by(name).disabled,
      by(name)?.reason ?? "missing");
  }

  /*
   * The honest half. Nothing is hidden by collapsing the unreachable tools: each
   * is still named, and still says what it is waiting on. That is the whole
   * defence of the change, so it is what is asserted.
   */
  for (const name of ["Timeline Comparison", "Export Centre"]) {
    const tool = pending.find((p) => p.name === name);
    check(`${name} is listed as not yet available`, Boolean(tool),
      pending.map((p) => p.name).join(", "));
    check(`  with a reason a client can read`, (tool?.reason?.length ?? 0) > 20,
      tool?.reason ?? "");
  }

  const blocked = pending.find((p) => p.name === "Timeline Comparison")?.reason ?? "";
  check("a blocked tool names what it is waiting on, not our file layout",
    /flown twice|repeat flight/i.test(blocked) && !/portal-data|\.tif|src\//.test(blocked),
    blocked);
}

console.log("\nHydrology: the group that is actually finished");
{
  await openGroup("Hydrology");
  const tools = await railTools();
  const by = (n) => tools.find((x) => x.name === n);
  const hydroPending = await pendingTools();
  check("all five hydrology tools are accounted for",
    tools.filter((x) => x.number).length + hydroPending.length === 5,
    `${tools.filter((x) => x.number).length} usable + ${hydroPending.length} pending`);
  for (const name of ["Flow Accumulation", "Watershed Delineation", "Sink Detection", "Flood Simulation"]) {
    check(`${name} is usable`, by(name) && !by(name).disabled, by(name)?.reason ?? "missing");
  }
  check("Inspect is offered alongside them", tools.some((x) => x.name === "Inspect" && !x.disabled));
  const flowDirection = hydroPending.find((p) => p.name === "Flow Direction");
  check("Flow Direction says it is drawn as a grid rather than as arrows",
    /arrows/i.test(flowDirection?.reason ?? ""), flowDirection?.reason ?? "");
}

console.log("\nRoads: all three are now reachable");
{
  await openGroup("Roads");
  const tools = await railTools();
  check("all three road tools are listed", tools.filter((x) => x.number).length === 3);
  /*
   * This block used to assert the opposite — that every road tool was disabled
   * and the group said so. All three were engine-only for weeks, waiting on one
   * missing piece of UI: something to draw an alignment with. That now exists,
   * so the assertion is inverted rather than deleted, because "the group is
   * complete" is exactly as worth guarding as "the group is honest about being
   * empty".
   */
  check("and every one is enabled", tools.filter((x) => x.number).every((x) => !x.disabled),
    tools.filter((x) => x.disabled).map((x) => x.name).join(", ") || "none disabled");
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  check("so the group no longer says its tools are waiting on the map",
    !/specified but not yet on the map/i.test(t));
}

console.log("\nContractor: still honest about what is missing");
{
  await openGroup("Contractor");
  const pending = await pendingTools();
  check("the tools that are not on the map are still named",
    pending.length > 0, `${pending.length} pending`);
  check("each with a reason a client can read",
    pending.every((x) => (x.reason ?? "").length > 20),
    pending.map((x) => `${x.name}: ${x.reason}`)[0] ?? "");
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
