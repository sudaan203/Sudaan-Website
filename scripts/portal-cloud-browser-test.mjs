/**
 * The LiDAR cloud, drawn in a real browser.
 *
 *   npm install --no-save puppeteer
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/portal-cloud-browser-test.mjs
 *
 * `cloud-api-test.mjs` proves the quadtree is arithmetically sound. This proves
 * the browser can actually draw it: that the WebGL layer compiles and links,
 * that nodes are fetched by level of detail rather than all at once, that the
 * detail budget is respected, and — the one that matters most — that the points
 * land on the survey rather than somewhere plausible-looking a kilometre away.
 *
 * Position is checked against the pixels the map actually paints, because that
 * is the only thing that can tell a correct cloud from one drawn through the
 * wrong matrix: the second loads, reports its point count, and is simply not
 * where the survey is.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SITE = process.env.SITE ?? "aektanagar-survey";
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
await page.setViewport({ width: 1200, height: 900 });
await page.setCookie({ name: "sga_portal_session", value: token, domain: "localhost", path: "/" });

const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/WebGL|SwiftShader|GPU stall|Failed to load resource/i.test(t)) return;
  problems.push(`console: ${t.slice(0, 300)}`);
});

/** Every node the page fetches, so LOD can be checked from the outside. */
const nodeRequests = [];
page.on("request", (r) => {
  const m = /\/cloud\/(\d+)\/(\d+)\/(\d+)$/.exec(new URL(r.url()).pathname);
  if (m) nodeRequests.push({ level: Number(m[1]), key: `${m[1]}/${m[2]}/${m[3]}` });
});

const settle = (ms = 2500) => new Promise((r) => setTimeout(r, ms));

/**
 * The point cloud panel's own text.
 *
 * Scoped to its landmark, never to `document.body`. Matching the whole document
 * for "<number> drawn" found the page's intro copy — "every layer we produced
 * for this site, drawn over each other" — whose comma satisfied `[\d,.]+`, and
 * reported a viewer drawing 53,238 points as drawing none.
 */
const text = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[role="region"][aria-label="Point cloud"]');
    return (panel ?? document.body).innerText.replace(/\s+/g, " ");
  });

console.log(`\nOpening the ${SITE} map`);
await page.goto(`${BASE}/portal/${SITE}/map`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 }).catch(() => {});

const appeared = await page
  .waitForFunction(() => /LIDAR POINT CLOUD/i.test(document.body.innerText), { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
check("the point cloud panel appears for a survey that has one", appeared);

{
  const t = await text();
  check("it states how many points were flown, not how many are drawn",
    /50,183,644 points flown/.test(t), t.match(/[\d,]+ points flown[^.]*\./)?.[0] ?? "not stated");
}

/** Turn the cloud on with its own Show checkbox. */
async function toggleCloud() {
  const handle = await page.evaluateHandle(() => {
    const panel = document.querySelector('[role="region"][aria-label="Point cloud"]');
    return panel?.querySelector('input[type="checkbox"]') ?? null;
  });
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  await settle(4000);
  return true;
}

console.log("\nTurning it on");
{
  const before = nodeRequests.length;
  check("the cloud can be switched on", await toggleCloud());
  await page
    .waitForFunction(() => /\d+ tiles/.test(document.body.innerText), { timeout: 40000 })
    .catch(() => {});

  const asked = nodeRequests.slice(before);
  check("nodes are fetched", asked.length > 0, `${asked.length} nodes`);
  check("starting from the root", asked.some((n) => n.key === "0/0/0"));
  check("and not all 989 of them at once", asked.length < 200, `${asked.length} requested`);

  const t = await text();
  // The thousands separator is part of the number: matching without it read
  // "53,238 drawn" as "238 drawn" and made a working viewer look broken.
  check("the panel reports what is actually drawn",
    /[\d,.]+M? drawn · \d+ tiles/.test(t),
    t.match(/[\d,.]+M? drawn · \d+ tiles/)?.[0] ?? "not reported");
  const drawn = Number((t.match(/([\d,.]+)M? drawn/)?.[1] ?? "0").replace(/,/g, ""));
  check("and it is a real number of points, not a handful",
    drawn > 10000, `${drawn} drawn`);
  check("and says the cloud thins out rather than pretending it is complete",
    /thins out to stay drawable/i.test(t));
}

console.log("\nThe WebGL layer really is running");
{
  /*
   * `getLayer`, not `getStyle().layers`.
   *
   * A custom layer cannot be serialised into a style document, so MapLibre omits
   * it from `getStyle()` entirely. Looking for it there reports a perfectly
   * working layer as absent, which is how the first version of this check
   * failed while the cloud was visibly drawing.
   */
  const state = await page.evaluate(() => {
    const m = window.__portalMap;
    const layer = m?.getLayer("lidar-cloud");
    return { present: Boolean(layer), type: layer?.type ?? null };
  });
  check("a custom layer was added to the map", state.present && state.type === "custom",
    JSON.stringify(state));
  check("no shader or link errors reached the console",
    !problems.some((p) => /shader|link|program/i.test(p)),
    problems.filter((p) => /shader|link|program/i.test(p))[0] ?? "");
}

/**
 * Where the points landed.
 *
 * By screenshot of the canvas element, differenced against the same view with
 * the cloud switched off.
 *
 * `readPixels` on MapLibre's own context returns nothing: the map is created
 * without `preserveDrawingBuffer`, so the drawing buffer is cleared as soon as
 * the frame is composited, and a test that asks for a context with that flag
 * simply gets the existing one back and reads an empty buffer. A screenshot is
 * taken from the composited page and does not care.
 *
 * Differencing rather than looking for "non background" pixels, because with
 * every other layer hidden the background is whatever the page paints, and
 * "different from the frame without the cloud" is exactly the set of pixels the
 * cloud is responsible for. This is the check that separates a correct cloud
 * from one drawn through the wrong projection matrix: the latter loads, reports
 * its point count, and is nowhere on screen. It is how this layer's real defect
 * was found — `modelViewProjectionMatrix` takes world pixels, not mercator.
 *
 * Two things that overlay the canvas are removed first, because both change
 * with the cloud and neither is the cloud. The floating sidebar's controls
 * appear and disappear with it. The contour labels are HTML markers composited
 * on top, and re-rasterising them over changed canvas content shifts their
 * antialiasing — which showed up as a fringe of "stray" points along the western
 * edge of the survey, exactly where a projection error would have put them.
 */
console.log("\nThe points are where the survey is");
{
  await page.evaluate(() => {
    /*
     * `.portal-contour-label` as well as MapLibre's own class: a marker given a
     * custom element keeps only the classes that element arrived with, so the
     * contour labels never had `maplibregl-marker` on them and survived the
     * first version of this. They then differed with the canvas underneath them and
     * were counted as points 14 pixels west of the survey.
     */
    for (const el of document.querySelectorAll(
      ".maplibregl-marker, .maplibregl-ctrl, .portal-contour-label",
    )) {
      el.style.display = "none";
    }
    const m = window.__portalMap;
    for (const layer of m.getStyle().layers) {
      try {
        m.setLayoutProperty(layer.id, "visibility", "none");
      } catch {
        /* not every layer has a visibility property */
      }
    }
    m.triggerRepaint();
  });
  await settle(2000);

  const canvas = await page.$("canvas.maplibregl-canvas");
  const shoot = () => canvas.screenshot({ encoding: "base64" });

  const withCloud = await shoot();
  await toggleCloud(); // off
  const without = await shoot();
  await toggleCloud(); // back on
  await settle(3000);

  const result = await page.evaluate(
    async (a, b, siteSlug) => {
      const load = (data) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = `data:image/png;base64,${data}`;
        });
      const [imgA, imgB] = await Promise.all([load(a), load(b)]);
      const w = imgA.width;
      const h = imgA.height;
      const draw = (img) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, w, h).data;
      };
      const pa = draw(imgA);
      const pb = draw(imgB);

      const m = window.__portalMap;
      const canvasRect = m.getCanvas().getBoundingClientRect();
      /*
       * The floating sidebar, in image coordinates. An element screenshot has
       * its origin at the element's top left, so a rectangle taken from
       * `getBoundingClientRect` has to have the canvas's own offset removed —
       * mixing the two spaces silently masks the wrong part of the picture.
       */
      const panel = document
        .querySelector('[role="region"][aria-label="Point cloud"]')
        ?.closest("div.overflow-y-auto")
        ?.getBoundingClientRect();
      const scale = w / m.getCanvas().clientWidth;
      const masked = panel
        ? {
            x0: (panel.left - canvasRect.left) * scale,
            x1: (panel.right - canvasRect.left) * scale,
            y0: (panel.top - canvasRect.top) * scale,
            y1: (panel.bottom - canvasRect.top) * scale,
          }
        : null;

      const response = await fetch(`/api/portal/sites/${siteSlug}/cloud`, {
        credentials: "same-origin",
      });
      const manifest = await response.json();
      const [west, south, east, north] = manifest.lonLatBounds;
      const corners = [
        m.project([west, south]),
        m.project([west, north]),
        m.project([east, south]),
        m.project([east, north]),
      ];
      let x0 = Math.min(...corners.map((c) => c.x)) * scale;
      let x1 = Math.max(...corners.map((c) => c.x)) * scale;
      let y0 = Math.min(...corners.map((c) => c.y)) * scale;
      let y1 = Math.max(...corners.map((c) => c.y)) * scale;

      /*
       * The footprint is a box on the map plane; the cloud has relief above it,
       * and MapLibre's camera is perspective even looking straight down. So the
       * top of the survey legitimately projects outward from the centre of the
       * view, and the box has to be expanded by that much or the check fails on
       * correct rendering.
       *
       * The factor is derived, not chosen: the camera sits
       * `0.5 · height / tan(fov/2)` pixels above the plane — MapLibre's default
       * field of view is 0.6435 rad — and a point `r` pixels up projects outward
       * by `d / (d − r)`. The cloud is anchored to the survey's lowest ground,
       * so `r` is the site's relief, not its height above sea level.
       */
      const relief = manifest.elevation.max - manifest.elevation.min;
      const metresPerPixel =
        (156543.03392 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / 2 ** m.getZoom();
      const cameraPx = (0.5 * m.getCanvas().clientHeight) / Math.tan(0.6435011087932844 / 2);
      const parallax = cameraPx / Math.max(cameraPx - relief / metresPerPixel, 1);
      const cx = w / 2;
      const cy = h / 2;
      const grow = (v, centre) => centre + (v - centre) * parallax;
      // How much the box actually grows at its edge, which is the number worth
      // reporting; the distance from the centre to the grown edge is not.
      const allowance = Math.max(x0 - grow(x0, cx), grow(x1, cx) - x1);
      x0 = grow(x0, cx);
      x1 = grow(x1, cx);
      y0 = grow(y0, cy);
      y1 = grow(y1, cy);

      let changed = 0;
      let inside = 0;
      let worst = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const at = (y * w + x) * 4;
          const d =
            Math.abs(pa[at] - pb[at]) +
            Math.abs(pa[at + 1] - pb[at + 1]) +
            Math.abs(pa[at + 2] - pb[at + 2]);
          if (d < 24) continue;
          if (masked && x >= masked.x0 && x <= masked.x1 && y >= masked.y0 && y <= masked.y1) {
            continue;
          }
          changed += 1;
          if (x >= x0 - 4 && x <= x1 + 4 && y >= y0 - 4 && y <= y1 + 4) inside += 1;
          else {
            const away = Math.max(x0 - x, x - x1, y0 - y, y - y1);
            if (away > worst) worst = away;
          }
        }
      }
      return {
        changed,
        inside,
        worst,
        box: [x0, y0, x1, y1],
        size: [w, h],
        parallax,
        allowance,
      };
    },
    withCloud,
    without,
    SITE,
  );

  check("switching the cloud on changes the picture", result.changed > 2000,
    `${result.changed} pixels differ`);
  /*
   * 99.5% of the cloud inside the survey's footprint, allowing for relief.
   *
   * Three earlier failures here were all real, and none of them was this check
   * being too strict. The survey's longitude and latitude box was built from two
   * corners of a UTM rectangle, which under grid convergence misses the ground
   * the other two cover. The contour labels are HTML composited over the canvas
   * and were being counted as points. And the cloud was drawn at height above
   * sea level rather than above the survey's own ground, so perspective pushed
   * all of it outward and it no longer sat on the orthomosaic.
   */
  check("and essentially every changed pixel is inside the survey's footprint",
    result.changed > 0 && result.inside / result.changed > 0.995,
    `${result.inside}/${result.changed} = ${((result.inside / (result.changed || 1)) * 100).toFixed(1)}%` +
      (result.worst ? `, furthest stray ${result.worst.toFixed(0)} px outside` : ""),
  );
  check("the relief allowance is small, so the footprint is still a real bound",
    result.parallax < 1.06,
    `${((result.parallax - 1) * 100).toFixed(1)}% outward, ${result.allowance.toFixed(0)} px at the edge`);
  check("the footprint really is on screen, so that was not a vacuous test",
    result.box[2] - result.box[0] > result.size[0] * 0.3 &&
      result.box[3] - result.box[1] > result.size[1] * 0.3,
    `footprint ${(result.box[2] - result.box[0]).toFixed(0)}×${(result.box[3] - result.box[1]).toFixed(0)} px ` +
      `of ${result.size[0]}×${result.size[1]}`);
}

console.log("\nNothing broke");
check("no page errors or unexpected console errors", problems.length === 0,
  problems.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
