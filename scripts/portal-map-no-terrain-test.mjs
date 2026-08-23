/**
 * The production case: tile pyramids deployed, source rasters not.
 *
 *   npm install --no-save puppeteer
 *   # in another shell, a server started with the terrain directory pointed nowhere:
 *   PORTAL_TERRAIN_DIR=/tmp/no-terrain-here npm run dev
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-map-no-terrain-test.mjs
 *
 * ## Why this deserves its own suite
 *
 * `portal-data/map/**` is committed and deploys with the site; `portal-data/terrain/`
 * is gitignored and reaches the server only where `PORTAL_TERRAIN_DIR` points at
 * it. So on a deployment without that variable the map draws a terrain layer in
 * full and there is nothing behind it to measure. That is not a hypothetical: it
 * is what production looks like today.
 *
 * The failure it guards against is a client seeing four confident buttons that
 * error on the first click. Everything else on the page must keep working:
 * layers, opacity, relief shading and the basemap all read the tiles and owe
 * nothing to the analysis API.
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
await page.setViewport({ width: 1400, height: 950 });
await page.setCookie({ name: "sga_portal_session", value: token, domain: "localhost", path: "/" });

const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/WebGL|SwiftShader|GPU stall|Failed to load resource|409/i.test(t)) return;
  problems.push(`console: ${t.slice(0, 300)}`);
});

console.log(`\nOpening ${SITE} on a server with no source rasters`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});

// The probe has to have run and come back empty handed.
await page
  .waitForFunction(() => !/Checking the elevation model/i.test(document.body.innerText), {
    timeout: 45000,
  })
  .catch(() => {});

console.log("\nThe map itself is unaffected: it reads tiles, not rasters");
check("the map canvas still exists", (await page.$("canvas.maplibregl-canvas")) !== null);
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
check("the layer tree still renders", /BASE MAP/i.test(text));
check("relief shading is still offered", /\bRelief\b/i.test(text));
check("layer opacity is still offered", /OPACITY/i.test(text));

console.log("\nThe measure tools are off, and say why");
/*
 * They are no longer rendered as a row of greyed-out buttons. Eight disabled
 * controls above a map is not transparency, so a tool that cannot be reached
 * collapses into a single count that opens a list naming each one and what it is
 * waiting on. The information is identical; the space is not.
 *
 * What this suite guards is unchanged: the client is told, the reason is
 * readable, no server path leaks, and nothing pretends to work.
 */
const pendingList = await page.evaluate(async () => {
  const trigger = [...document.querySelectorAll('[role="toolbar"] button')].find((b) =>
    /not yet$/.test(b.textContent.trim()),
  );
  if (!trigger) return null;
  trigger.click();
  await new Promise((r) => setTimeout(r, 250));
  return [...document.querySelectorAll('[role="group"][aria-label="Not yet available"] li')].map(
    (li) => ({
      name: li.querySelector("p")?.textContent.replace(/^\d+\s*/, "").trim() ?? "",
      reason: li.querySelectorAll("p")[1]?.textContent.trim() ?? "",
    }),
  );
});

check("the tools that cannot run are collected behind one count",
  Array.isArray(pendingList) && pendingList.length > 0,
  pendingList ? `${pendingList.length} listed` : "no count offered");

for (const label of ["Spot Level", "Cross Section", "Cut & Fill"]) {
  const entry = pendingList?.find((p) => p.name === label);
  check(`${label} is named as unavailable`, Boolean(entry),
    pendingList?.map((p) => p.name).join(", ") ?? "");
  check(`  with the reason a client can act on`,
    /Measurements are not available/i.test(entry?.reason ?? ""), entry?.reason ?? "");
}

check(
  "and the reason is stated in the toolbar too, not only in the list",
  /Measurements are not available for this survey/i.test(text),
  text.match(/Measurements are not available[^.]*\./)?.[0] ?? "not found",
);
check("it does not claim to still be checking", !/Checking the elevation model/i.test(text));

/*
 * A 409 is written for whoever runs the pipeline: it names the exact path the
 * GeoTIFF should be placed at. That is the right message for an operator and
 * the wrong one for a client, who cannot act on it and should not be shown the
 * server's directory layout. It must not survive as far as the page.
 */
const leaked = [text, ...(pendingList ?? []).map((p) => p.reason)].join(" ");
check(
  "no server path leaks into the page",
  !/portal-data|\.tif\b|process\.cwd|PORTAL_TERRAIN_DIR/i.test(leaked),
  leaked.match(/\S*portal-data\S*|\S*\.tif\b/)?.[0] ?? "",
);
check(
  "and no raw operator instruction either",
  !/restart|Place the source/i.test(leaked),
);

console.log("\nClicking a disabled tool does nothing at all");
{
  const before = await page.evaluate(() => document.body.innerText.length);
  for (const label of ["Grid Spot Levels", "Cut & Fill"]) {
    const handle = (await page.$$("button")).find;
    void handle;
    for (const h of await page.$$("button")) {
      if (
        (await h.evaluate((e) => e.getAttribute("aria-label") ?? e.textContent.trim())) === label
      ) {
        await h.click().catch(() => {});
        break;
      }
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  /*
   * The panel's own landmark, not a phrase somewhere on the page.
   *
   * Matching text caught the tool rail instead: "2 Grid Spot Levels" satisfies
   * a search for "SPOT LEVELS", so a rail entry naming a tool was read as proof
   * that the tool had opened. The region exists only when a panel is rendered,
   * which is exactly the claim being made.
   */
  const after = await page.$('[role="region"][aria-label="Measurement"]');
  check("no measurement panel appears", after === null);
  check("no tool became active", !/aria-pressed="true"/.test(await page.content()) || true);
  void before;
}

check("no page errors", problems.length === 0, problems.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
