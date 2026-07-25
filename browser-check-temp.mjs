/**
 * Loads portal pages in a real browser and reports console errors, page errors
 * and failed requests. curl cannot catch a "client-side exception" because it
 * never runs the JavaScript, which is exactly how the owner console bug hid.
 */
import puppeteer from "puppeteer";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMAIL = process.argv[3] ?? "admin@sudaangeo.in";
const PASSWORD = process.argv[4] ?? "AdminPortal-2026-test";

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();

const problems = [];
page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(`console.error: ${msg.text().slice(0, 300)}`);
});
page.on("pageerror", (err) => problems.push(`pageerror: ${String(err).slice(0, 400)}`));
page.on("requestfailed", (req) =>
  problems.push(`requestfailed: ${req.url().slice(0, 120)} ${req.failure()?.errorText ?? ""}`),
);
page.on("response", (res) => {
  if (res.status() >= 500) problems.push(`http ${res.status()}: ${res.url().slice(0, 120)}`);
});

// Sign in with the staff password path, which needs no Google round trip.
await page.goto(`${BASE}/portal/login`, { waitUntil: "networkidle2", timeout: 60000 });
await page.evaluate(
  async (base, email, password) => {
    await fetch(`${base}/api/portal/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  },
  BASE,
  EMAIL,
  PASSWORD,
);

for (const path of ["/portal", "/portal/admin"]) {
  problems.length = 0;
  const before = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 60000 });
  const text = await page.evaluate(() => document.body.innerText.slice(0, 200));
  const brokeVisibly = text.includes("Application error");
  console.log(`\n=== ${path}  (${Date.now() - before}ms) ===`);
  console.log(`  visible text: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 120))}`);
  console.log(`  broken: ${brokeVisibly}`);
  if (problems.length === 0) {
    console.log("  no console errors");
  } else {
    for (const p of [...new Set(problems)].slice(0, 6)) console.log(`  ${p}`);
  }
}

await browser.close();
