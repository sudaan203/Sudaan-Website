/**
 * Tools 2, 5 and 13 driven on the real map.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-surface-browser-test.mjs
 *
 * `surface-api-test.mjs` proves the three answer correctly over HTTP. This
 * proves a client can reach them: draw a polygon, choose a spacing or a
 * reference, and — for tool 2 — get a file out whose contents are checked, not
 * merely whose download was offered.
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
  if (!r.url().includes("/analysis")) return;
  try { calls.push(JSON.parse(r.postData() ?? "{}")); } catch { /* not ours */ }
});

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
const textIn = (label) =>
  page.evaluate(
    (l) =>
      document.querySelector(`[role="region"][aria-label="${l}"]`)?.innerText.replace(/\s+/g, " ") ?? "",
    label,
  );

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
async function clickIn(region, text) {
  const ok = await page.evaluate(
    (r, t) => {
      const panel = document.querySelector(`[role="region"][aria-label="${r}"]`);
      const b = [...(panel?.querySelectorAll("button") ?? [])].find(
        (e) => e.textContent.trim() === t,
      );
      if (!b || b.disabled) return false;
      b.click();
      return true;
    },
    region,
    text,
  );
  await settle();
  return ok;
}
async function openGroup(name) {
  await page.evaluate((needle) => {
    [...document.querySelectorAll('[role="tab"]')]
      .find((t) => t.textContent.trim().startsWith(needle))?.click();
  }, name);
  await settle(500);
}

async function drawPolygon() {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  const at = (dx, dy) => [box.x + box.width / 2 + dx, box.y + box.height / 2 + dy];
  for (const [dx, dy] of [[-90, -60], [70, -60], [70, 55]]) {
    await page.mouse.click(...at(dx, dy));
    await settle(350);
  }
  // A real double click. `clickCount: 2` does not produce one, and the polygon
  // then draws and reports its area but never closes.
  const [x, y] = at(-90, 55);
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await settle(900);
}

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});
await page
  .waitForFunction(() => !/Checking the elevation model/i.test(document.body.innerText), { timeout: 45000 })
  .catch(() => {});

// Capture every file the page offers, so an export can be read rather than
// merely counted. Downloads are otherwise invisible to a headless browser.
await page.evaluateOnNewDocument(() => {
  /*
   * Keep the Blob against its URL, and pair it with the file name at click time.
   *
   * The first version read `blob.text()` inside `createObjectURL` and attached
   * the name in the click handler, which is a race: `text()` is async and
   * resolves after the click, so names landed on the wrong entries and one file
   * went missing entirely. Holding the Blob also survives the
   * `revokeObjectURL` that follows every download.
   */
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
  window.__readSaved = async () =>
    Promise.all(
      window.__saved.map(async (f) => ({
        name: f.name,
        body: await (window.__blobs.get(f.url)?.text() ?? Promise.resolve("")),
      })),
    );
});
await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
await page
  .waitForFunction(() => !/Checking the elevation model/i.test(document.body.innerText), { timeout: 45000 })
  .catch(() => {});

console.log("\nTool 2: grid spot levels");
{
  await openGroup("Universal");
  check("grid spot levels is enabled", await clickByLabel("Grid Spot Levels"));
  check("the panel asks for a polygon first",
    /Draw the area to grid/i.test(await textIn("Grid levels")));

  await drawPolygon();
  let t = await textIn("Grid levels");
  check("the polygon is measured instantly", /Polygon [\d.]+/.test(t), t.slice(0, 60));
  check("and the point count is estimated before asking the server",
    /About [\d,]+ points/.test(t), t.match(/About [\d,]+ points/)?.[0]);

  const before = calls.length;
  check("a spacing can be chosen", await clickIn("Grid levels", "2 m"));
  check("levels can be generated", await clickIn("Grid levels", "Generate levels"));
  await page.waitForFunction(
    () => /Levels/.test(document.querySelector('[role="region"][aria-label="Grid levels"]')?.innerText ?? ""),
    { timeout: 45000 },
  ).catch(() => {});

  const sent = calls.slice(before).find((c) => c.op === "grid-levels");
  check("the page asked for grid levels", Boolean(sent));
  check("with the spacing shown", sent?.spacing === 2, `spacing=${sent?.spacing}`);
  check("sending a closed ring", Array.isArray(sent?.polygon) && sent.polygon.length >= 4);

  t = await textIn("Grid levels");
  check("levels are counted", /Levels [\d,]+/.test(t), t.match(/Levels [\d,]+/)?.[0]);
  check("and the four export formats are offered",
    ["CSV", "TXT", "DXF", "LandXML"].every((f) => t.includes(f)));
}

console.log("\n  and the files it writes carry their projection");
{
  await page.evaluate(() => { window.__saved = []; });
  await clickIn("Grid levels", "CSV");
  await settle(600);
  await clickIn("Grid levels", "DXF");
  await settle(600);
  await clickIn("Grid levels", "LandXML");
  await settle(600);

  const saved = await page.evaluate(() => window.__readSaved());
  const by = (ext) => saved.find((f) => (f.name ?? "").endsWith(ext));

  check("a CSV is produced", Boolean(by(".csv")), saved.map((f) => f.name).join(", "));
  check("naming its CRS in the header",
    /EPSG:32643/.test(by(".csv")?.body ?? ""), by(".csv")?.body?.split("\n")[0]?.slice(0, 80));
  check("and warning these are not longitude and latitude",
    /not longitude|easting/i.test(by(".csv")?.body ?? ""));

  check("a DXF is produced", Boolean(by(".dxf")));
  check("with a POINT entity per level", (by(".dxf")?.body.match(/\nPOINT\r?\n/g) ?? []).length > 100,
    `${(by(".dxf")?.body.match(/\nPOINT\r?\n/g) ?? []).length} points`);
  /*
   * DXF has nowhere to record a projection, so the sidecar is not optional: a
   * client who takes only the DXF has a file that cannot be placed on the earth.
   */
  check("and a .prj sidecar beside it, because DXF cannot hold a CRS",
    Boolean(by(".prj")) && /UTM.*43N|Transverse_Mercator/i.test(by(".prj")?.body ?? ""),
    by(".prj")?.body?.slice(0, 70));

  check("a LandXML is produced", Boolean(by(".xml")));
  check("recording the EPSG code", /32643/.test(by(".xml")?.body ?? ""));
  /*
   * LandXML writes northing BEFORE easting, per the schema. Getting that
   * backwards transposes the whole survey and the file still opens.
   */
  const first = by(".xml")?.body.match(/<CgPoint[^>]*>([-\d.]+)\s+([-\d.]+)/);
  check("with northing before easting, as the schema requires",
    first ? Number(first[1]) > 2_000_000 && Number(first[2]) < 1_000_000 : false,
    first ? `${first[1]} ${first[2]}` : "no point found");
}

console.log("\nTool 5: surface comparison");
{
  check("surface comparison is enabled", await clickByLabel("Surface Comparison"));
  await drawPolygon();

  const before = calls.length;
  check("it will not compute without a reference chosen",
    /Compare against/i.test(await textIn("Surface comparison")));
  /*
   * The *other* model. The tools measure on the DTM by default, and picking the
   * DTM as the reference is comparing a surface with itself — which the panel
   * correctly refuses by disabling the button. The first version of this test
   * clicked whichever button it found first and then blamed the panel.
   */
  check("comparing against the other model is offered",
    await clickIn("Surface comparison", "Surface (DSM)"));
  check("and it can be computed", await clickIn("Surface comparison", "Compare"));
  await page.waitForFunction(
    () => /Mean difference/i.test(document.querySelector('[role="region"][aria-label="Surface comparison"]')?.innerText ?? ""),
    { timeout: 45000 },
  ).catch(() => {});

  const sent = calls.slice(before).find((c) => c.op === "compare");
  check("the page asked to compare", Boolean(sent));
  check("naming the reference explicitly, never defaulted", Boolean(sent?.reference), sent?.reference);
  check("and asked for no tolerance, this being tool 5",
    sent && !("tolerance" in sent), JSON.stringify(Object.keys(sent ?? {})));

  const t = await textIn("Surface comparison");
  check("a mean difference is reported", /Mean difference/i.test(t));
  check("alongside the mean that does not cancel", /ignoring sign/i.test(t));
}

console.log("\nTool 13: tolerance");
{
  await openGroup("Contractor");
  check("tolerance analysis is enabled", await clickByLabel("Tolerance Analysis"));
  await drawPolygon();
  await clickIn("Surface comparison", "Surface (DSM)");

  const before = calls.length;
  check("a tolerance can be chosen", await clickIn("Surface comparison", "± 50 mm"));
  check("and checked", await clickIn("Surface comparison", "Check"));
  await page.waitForFunction(
    () => /Within tolerance/i.test(document.querySelector('[role="region"][aria-label="Surface comparison"]')?.innerText ?? ""),
    { timeout: 45000 },
  ).catch(() => {});

  const sent = calls.slice(before).find((c) => c.op === "compare");
  check("the tolerance went to the server in metres", sent?.tolerance === 0.05,
    `tolerance=${sent?.tolerance}`);
  const t = await textIn("Surface comparison");
  check("the share within tolerance is reported", /Within tolerance/i.test(t));

  /*
   * The check this tool exists to get right. A ±10 mm tolerance on a survey good
   * to ±40 mm cannot be assessed, and the panel must say so rather than
   * colouring in a map of survey noise that reads as a map of defects.
   */
  await clickIn("Surface comparison", "± 10 mm");
  await clickIn("Surface comparison", "Check");
  await settle(3000);
  const warned = await textIn("Surface comparison");
  check("a tolerance finer than the survey warns rather than answering confidently",
    /cannot distinguish|survey noise/i.test(warned),
    warned.match(/The survey's[^.]*\./)?.[0]?.slice(0, 100) ?? "no warning");
}

console.log("\nThe difference layer is offered, and cannot be miscoloured");
{
  /*
   * The inspector is segmented now — Tool, Layers, Water — instead of stacking
   * all six panels in a column that overflowed the map. The rendered layers live
   * under Layers, and the previous block left the panel on Tool.
   */
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === "Layers")
      ?.click();
  });
  await settle(600);
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  check("it appears among the rendered layers", /Surface minus terrain/i.test(t));

  const picked = await page.evaluate(() => {
    const l = [...document.querySelectorAll("label")].find((e) =>
      e.textContent.trim().startsWith("Surface minus terrain"),
    );
    const radio = l?.querySelector('input[type="radio"]');
    if (!radio) return false;
    radio.click();
    return true;
  });
  check("and can be turned on", picked);
  await settle(3000);

  const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  check("with no ramp chooser, because only a diverging ramp is honest here",
    /diverging ramp centred on zero/i.test(after));
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
