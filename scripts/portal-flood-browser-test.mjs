/**
 * Malhar's "Simulation Water Level Rise" tool, driven on the real map.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-flood-browser-test.mjs
 *
 * `flood-test.mjs` proves the engine and `analysis-api-test.mjs` proves the
 * route. Neither can prove a client can operate the thing: that the interval
 * buttons build the ladder they claim to, that pressing start actually
 * animates, that the slider moves the water independently of the animation,
 * and that a flood polygon is genuinely *drawn on the map* rather than merely
 * returned to a panel.
 *
 * His own "most important requirement" is that the 2/5/10 m interval buttons
 * work automatically, so that is what most of this checks: pick an interval,
 * press start, and assert the levels really are that far apart and that the
 * water on the map changes as the simulation steps.
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

/** Every flood request the page makes, so the ladder can be inspected. */
const floodCalls = [];
page.on("request", (r) => {
  if (r.url().includes("/analysis") && r.method() === "POST") {
    try {
      const body = JSON.parse(r.postData() ?? "{}");
      if (body.op === "flood") floodCalls.push(body);
    } catch {
      /* an unparseable body is caught by the checks that read one */
    }
  }
});

// Capture a saved export the same way the shapefile suite does: hold the Blob
// against its object URL, because reading it inside createObjectURL races the
// click that names it.
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
  window.__lastSavedText = async () => {
    const last = window.__saved[window.__saved.length - 1];
    if (!last) return null;
    const blob = window.__blobs.get(last.url);
    return { name: last.name, text: await blob.text(), type: blob.type };
  };
});

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const PANEL = '[role="region"][aria-label="Flood"]';
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

async function clickIn(text) {
  return page.evaluate(
    (sel, t) => {
      const panel = document.querySelector(sel);
      const b = [...(panel?.querySelectorAll("button") ?? [])].find(
        (e) => e.getAttribute("aria-label") === t || e.textContent.trim().startsWith(t),
      );
      if (!b || b.disabled) return false;
      b.click();
      return true;
    },
    PANEL,
    text,
  );
}

/** Set one of the panel's number or range inputs by its accessible name. */
async function setInput(label, value) {
  return page.evaluate(
    (sel, l, v) => {
      const panel = document.querySelector(sel);
      const input = [...(panel?.querySelectorAll("input") ?? [])].find(
        (e) => e.getAttribute("aria-label") === l,
      );
      if (!input) return false;
      // React listens for `input`, and assigning `.value` directly does not
      // notify it — the native setter has to be called so React's own
      // value-tracker sees the change. Without this every set silently no-ops
      // and the field reverts on the next render.
      const setter = Object.getOwnPropertyDescriptor(
        input instanceof HTMLInputElement && input.type === "range"
          ? window.HTMLInputElement.prototype
          : window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    PANEL,
    label,
    value,
  );
}

async function clickMap(dx, dy) {
  const box = await (await page.$("canvas.maplibregl-canvas")).boundingBox();
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await settle(400);
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
      const b = [...document.querySelectorAll("button")].find(
        (e) => e.getAttribute("aria-label") === "Spot Level",
      );
      return Boolean(b) && !b.disabled;
    },
    { timeout: 45000 },
  )
  .catch(() => {});

console.log("\nThe Flood segment is reachable");
{
  check("the Flood segment opens", await openSegment("Flood"));
  check("and its panel is a named landmark", (await page.$(PANEL)) !== null);
  const text = await panelText();
  check("all three of Malhar's intervals are offered", /2 m/.test(text) && /5 m/.test(text) && /10 m/.test(text));
  check("both water-source modes are offered",
    /Select on map/i.test(text) && /From elevation/i.test(text));
  check("and it says which surface it reads, unprompted", /terrain model/i.test(text));
}

console.log("\nRunning from a typed elevation: the threshold flood");
{
  /*
   * 340 to 370, not a round 330. Kotba's DTM bottoms out at 337.14 m, so a
   * ladder starting below that floods nothing at all for its first steps —
   * which is the correct answer and a useless fixture: every check about a
   * drawn polygon, an animation running on, or an all-levels export holding
   * more than one feature has nothing to look at. Anchored to the survey's
   * own relief instead.
   */
  check("a starting elevation can be typed", await setInput("Start elevation in metres", 340));
  check("and a maximum", await setInput("Maximum elevation in metres", 370));
  check("the 5 m interval is selectable", await clickIn("5 m interval"));

  const before = floodCalls.length;
  check("start simulation is pressable", await clickIn("▶ Start simulation"));
  await page
    .waitForFunction(
      (sel) => /Current level/i.test(document.querySelector(sel)?.innerText ?? ""),
      { timeout: 60000 },
      PANEL,
    )
    .catch(() => {});

  const call = floodCalls.slice(before).at(-1);
  check("the page asked the analysis API for a flood", Boolean(call));
  check("sending an explicit ladder of levels rather than one level",
    Array.isArray(call?.levels) && call.levels.length > 1, `${call?.levels?.length} levels`);
  check("the ladder starts where the client said",
    call?.levels?.[0] === 340, String(call?.levels?.[0]));
  check("every step is exactly the chosen interval apart — his most important requirement",
    call?.levels?.every((l, i, all) => i === 0 || Math.abs(l - all[i - 1] - 5) < 1e-6),
    call?.levels?.join(", "));
  check("and it stops at the maximum, not past it",
    call?.levels?.at(-1) <= 370, String(call?.levels?.at(-1)));
  check("no water source was sent, so this is the threshold flood",
    call?.at === undefined && call?.polygon === undefined);

  const text = await panelText();
  check("the panel reports a current water level", /Current level [\d.]+ m/.test(text),
    text.match(/Current level [\d.]+ m/)?.[0] ?? "none");
  check("and the flooded area in hectares", /Flooded [\d.,]+ ha/.test(text),
    text.match(/Flooded [\d.,]+ ha/)?.[0] ?? "none");
  check("and in square kilometres, as the spec asks", /[\d.]+ km²/.test(text));
  check("and which step of how many", /Step \d+ of \d+/.test(text),
    text.match(/Step \d+ of \d+/)?.[0] ?? "none");
  check("the whole ladder is tabulated, one row per level", /340\.00 m/.test(text));
  check("it names the mode it actually ran in",
    /connected or not|hollow at or below the level/i.test(text) || /Every hollow/i.test(text));
}

console.log("\nThe slider moves the water without the animation running");
{
  const first = await panelText();
  const firstLevel = Number(first.match(/Current level ([\d.]+) m/)?.[1]);
  const firstArea = Number(first.match(/Flooded ([\d.]+) ha/)?.[1]);

  check("the water-level slider is draggable to another step", await setInput("Water level", 2));
  await settle(500);

  const later = await panelText();
  const laterLevel = Number(later.match(/Current level ([\d.]+) m/)?.[1]);
  const laterArea = Number(later.match(/Flooded ([\d.]+) ha/)?.[1]);

  check("the level moves with the slider", laterLevel > firstLevel, `${firstLevel} -> ${laterLevel}`);
  check("exactly two intervals up, because that is what step 2 means",
    Math.abs(laterLevel - firstLevel - 10) < 1e-6, `${firstLevel} -> ${laterLevel}`);
  check("and the flooded area grows with it, never shrinks",
    laterArea >= firstArea, `${firstArea} ha -> ${laterArea} ha`);
  check("the rise is reported against the start, not against the last step",
    new RegExp(`Rise \\+${(laterLevel - firstLevel).toFixed(2)} m`).test(later),
    later.match(/Rise [+\d.]+ m/)?.[0] ?? "none");
  // No request went out for any of that: the ladder was fetched once.
  const before = floodCalls.length;
  await setInput("Water level", 1);
  await settle(400);
  check("stepping the slider makes no new request — the ladder is already here",
    floodCalls.length === before, `${floodCalls.length - before} extra requests`);
}

console.log("\nThe water is genuinely drawn on the map");
{
  /*
   * Checked at the *top* of the ladder, not the bottom. At 340 m — the first
   * step — Kotba floods 0.44 ha spread across 207 separate patches, most of
   * them below one screen pixel at the default zoom, so
   * `queryRenderedFeatures` finding nothing there is honest rather than a
   * defect. It came back 1 on one run and 0 on the next, which is exactly what
   * a marginal fixture looks like. At the top of the ladder there are several
   * hectares of water and the question is unambiguous.
   */
  await setInput("Water level", 6);
  await settle(900);
  const drawn = await renderedCount("flood-fill");
  check("a flood polygon is rendered, not merely returned", drawn > 0, `${drawn} features`);
  check("and it carries an outline as well as a fill", (await renderedCount("flood-outline")) > 0);
}

console.log("\nPlayback: start, step, pause, reset");
{
  check("reset returns to the first level", await clickIn("Reset"));
  await settle(400);
  const atStart = await panelText();
  check("and the panel says step 1", /Step 1 of/.test(atStart), atStart.match(/Step \d+ of \d+/)?.[0] ?? "");

  check("step forward advances one level", await clickIn("Step forward"));
  await settle(400);
  check("the panel is now on step 2", /Step 2 of/.test(await panelText()));

  check("step back returns", await clickIn("Step back"));
  await settle(400);
  check("back to step 1", /Step 1 of/.test(await panelText()));

  // Play, then confirm it actually moved on its own before pausing it.
  check("play starts the animation", await clickIn("Play"));
  await settle(2500);
  const playedTo = Number((await panelText()).match(/Step (\d+) of/)?.[1]);
  check("the simulation advanced by itself", playedTo > 1, `reached step ${playedTo}`);
  check("pause is offered while playing, and stops it", await clickIn("Pause"));
  await settle(1600);
  const pausedAt = Number((await panelText()).match(/Step (\d+) of/)?.[1]);
  check("and it stays where it was paused", pausedAt === playedTo, `${playedTo} -> ${pausedAt}`);
}

console.log("\nExporting a flood polygon");
{
  check("this level can be exported as GeoJSON", await clickIn("This level as GeoJSON"));
  await settle(700);
  const saved = await page.evaluate(() => window.__lastSavedText());
  check("a file was actually saved", Boolean(saved), saved?.name ?? "nothing saved");
  check("named for the water level it holds", /^Flood_\d+m\.geojson$/.test(saved?.name ?? ""),
    saved?.name ?? "");

  let parsed = null;
  try {
    parsed = JSON.parse(saved?.text ?? "");
  } catch {
    /* the check below is the finding */
  }
  check("and it is valid GeoJSON", parsed?.type === "FeatureCollection");
  check("holding a MultiPolygon, so disconnected ponds stay separate patches",
    parsed?.features?.[0]?.geometry?.type === "MultiPolygon",
    parsed?.features?.[0]?.geometry?.type);
  const props = parsed?.features?.[0]?.properties ?? {};
  check("with the water level as an attribute, as the spec requires",
    typeof props.Water_Level === "number", String(props.Water_Level));
  check("and the flooded area in all three units",
    typeof props.Flood_Area_m2 === "number" &&
    typeof props.Flood_Area_Ha === "number" &&
    typeof props.Flood_Area_km2 === "number");
  check("in lon/lat, as RFC 7946 requires of GeoJSON",
    Math.abs(parsed?.features?.[0]?.geometry?.coordinates?.[0]?.[0]?.[0]?.[0] ?? 999) <= 180);

  check("all levels can be exported in one file", await clickIn("All levels as GeoJSON"));
  await settle(700);
  const all = await page.evaluate(() => window.__lastSavedText());
  const allParsed = JSON.parse(all?.text ?? "{}");
  check("which holds one polygon per flooded level, not just the current one",
    (allParsed.features?.length ?? 0) > 1, `${allParsed.features?.length} features`);
  check("each at its own water level",
    new Set(allParsed.features?.map((f) => f.properties.Water_Level)).size ===
      allParsed.features?.length);
}

console.log("\nA water source on the map switches to the connected flood");
{
  // The pick button only exists in "Select on map" mode — in elevation mode
  // there is no source to place, and offering the button there would arm the
  // map for a click the simulation would then ignore.
  check("the panel can be switched to select a source on the map",
    await clickIn("Select on map"));
  await settle(300);
  check("picking a source arms the map", await clickIn("Click the map where the water starts"));
  await settle(300);
  await clickMap(0, 0);
  await page
    .waitForFunction(
      // The *number*, not the label. "Ground here:" renders the instant the
      // source is placed, with an em dash where the elevation will go, so a
      // wait for the words is satisfied before the spot level has arrived —
      // the single most productive source of false results in this codebase.
      (sel) => /Ground here: [\d.]+ m/.test(document.querySelector(sel)?.innerText ?? ""),
      { timeout: 30000 },
      PANEL,
    )
    .catch(() => {});

  const text = await panelText();
  check("the ground elevation at the click is read from the model, not guessed",
    /Ground here: [\d.]+ m/.test(text), text.match(/Ground here: [\d.]+ m/)?.[0] ?? "none");

  const before = floodCalls.length;
  await clickIn("▶ Start simulation");
  await page
    .waitForFunction(
      (sel) => /Current level/i.test(document.querySelector(sel)?.innerText ?? ""),
      { timeout: 60000 },
      PANEL,
    )
    .catch(() => {});

  const call = floodCalls.slice(before).at(-1);
  check("this time a water source is sent with the request", Array.isArray(call?.at),
    JSON.stringify(call?.at));
  check("and the panel says it flooded from that source, not everywhere below the level",
    /from the source you chose/i.test(await panelText()));
}

console.log("\nThe flood tool does not fight the other tools for a click");
{
  // Arm the source picker, then press a numbered tool. The picker must let go:
  // if both stayed armed, one click would place a water source *and* start a
  // measurement, which is the exact failure the third mode axis exists to
  // prevent.
  await openSegment("Flood");
  await clickIn("Move");
  await settle(300);
  const armed = await page.evaluate(
    () => document.body.innerText.includes("Click where the water starts"),
  );
  check("the rail hint says the map is armed for a water source", armed);

  const tookTool = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[role="toolbar"] button')].find(
      (e) => e.getAttribute("aria-label") === "Spot Level",
    );
    if (!b || b.disabled) return false;
    b.click();
    return true;
  });
  check("a numbered tool can still be selected", tookTool);
  await settle(400);
  const stillArmed = await page.evaluate(
    () => document.body.innerText.includes("Click where the water starts"),
  );
  check("and the water-source arming was released, not left listening", !stillArmed);
}

console.log("\nNothing broke");
check("no page errors or unexpected console errors", problems.length === 0,
  problems.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
