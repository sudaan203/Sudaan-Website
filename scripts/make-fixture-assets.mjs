#!/usr/bin/env node
/**
 * Distinct, obviously synthetic assets for the isolation test fixture.
 *
 *   node scripts/make-fixture-assets.mjs
 *
 * Second Client's Ambaji site exists to prove one client cannot reach another
 * client's data (see seed.ts). Its two files were copies of Kotba's, byte for
 * byte, which is wrong twice over:
 *
 *   1. It puts one client's real survey imagery in another client's folder.
 *   2. It defeats the test it exists for. If a bug served Kotba's file to Second
 *      Client, identical bytes would make that invisible. A fixture has to be
 *      recognisable to be useful.
 *
 * So these are generated, clearly labelled, and share no bytes with any real
 * survey. scripts/portal-assets-test.mjs enforces the "no shared bytes" part.
 */

import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pdf, PAGE } from "./lib/pdf.mjs";

const root = resolve("portal-data", "files", "second-client", "ambaji");

/* ------------------------------------------------------------------ image --- */

const W = 1200;
const H = 900;

// A flat graphic, not a fake aerial photo. Anyone glancing at this must be able to
// tell it is not survey imagery, otherwise it is the same trap in a new colour.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#E8E8E8"/>
  <g stroke="#C9C9C9" stroke-width="1">
    ${Array.from({ length: 23 }, (_, i) => `<line x1="0" y1="${(i + 1) * 40}" x2="${W}" y2="${(i + 1) * 40}"/>`).join("")}
    ${Array.from({ length: 29 }, (_, i) => `<line x1="${(i + 1) * 40}" y1="0" x2="${(i + 1) * 40}" y2="${H}"/>`).join("")}
  </g>
  <rect x="60" y="60" width="${W - 120}" height="${H - 120}" fill="none" stroke="#2E2E2E" stroke-width="2" stroke-dasharray="14 8"/>
  <text x="${W / 2}" y="${H / 2 - 46}" text-anchor="middle" font-family="Helvetica" font-size="46" font-weight="bold" fill="#2E2E2E">
    ISOLATION TEST FIXTURE
  </text>
  <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="Helvetica" font-size="26" fill="#5A5A5A">
    Second Client &#183; Ambaji Corridor Survey
  </text>
  <text x="${W / 2}" y="${H / 2 + 46}" text-anchor="middle" font-family="Helvetica" font-size="19" fill="#5A5A5A">
    Not survey data. Present only to prove one client cannot
  </text>
  <text x="${W / 2}" y="${H / 2 + 74}" text-anchor="middle" font-family="Helvetica" font-size="19" fill="#5A5A5A">
    reach another client's deliverables.
  </text>
  <text x="${W / 2}" y="${H - 96}" text-anchor="middle" font-family="Helvetica" font-size="15" fill="#8A8A8A">
    If you are a real client and you see this, tell Sudaan Geo-Analytics.
  </text>
</svg>`;

mkdirSync(join(root, "imagery"), { recursive: true });
const img = await sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
writeFileSync(join(root, "imagery", "ortho.webp"), img);
console.log(`wrote imagery/ortho.webp  ${(img.length / 1024).toFixed(0)} KB`);

/* -------------------------------------------------------------------- pdf --- */

const pdf = new Pdf({ title: "Ambaji Corridor, isolation test fixture" });
const ctx = pdf.page(PAGE.a4);
const M = 48;
const right = ctx.width - M;

ctx.rect(0, ctx.height - 76, ctx.width, 76, [0.98, 0.969, 0.949]);
ctx.line(M, ctx.height - 76, right, ctx.height - 76, [0.85, 0.84, 0.82], 0.75);
ctx.text(M, ctx.height - 40, "SUDAAN GEO-ANALYTICS", { size: 11, bold: true, color: [0.851, 0.467, 0.024] });
ctx.text(M, ctx.height - 58, "Isolation Test Fixture", { size: 17, bold: true });
ctx.textRight(right, ctx.height - 40, "Ambaji Corridor Survey", { size: 11, bold: true });
ctx.textRight(right, ctx.height - 56, "Second Client", { size: 9, color: [0.45, 0.45, 0.45] });

let y = ctx.height - 116;
const para = (s, opts = {}) => {
  for (const line of wrap(s, 92)) {
    ctx.text(M, y, line, { size: 10, color: [0.27, 0.27, 0.27], ...opts });
    y -= 14;
  }
  y -= 8;
};

para(
  "This document is not a survey deliverable. It contains no measurements and " +
    "describes no real site.",
  { bold: true },
);
para(
  "The Ambaji Corridor site exists in this portal for one purpose: to prove that a " +
    "signed in client can reach their own data and nothing else. Tenant filtering " +
    "happens in SQL, and a request for another client's site answers 404 rather " +
    "than 403, so an id is never confirmed.",
);
para(
  "This file replaced a copy of another client's topographic survey report. That " +
    "copy was wrong on both counts: it placed one client's real deliverable inside " +
    "another client's folder, and because the bytes were identical it would have " +
    "hidden exactly the failure this fixture is meant to catch. A fixture has to be " +
    "recognisable to be worth having.",
);
para(
  "If you are a real Sudaan Geo-Analytics client and this document appeared under " +
    "your account, please tell us. It means a site was published to the wrong " +
    "client, and we would want to know immediately.",
);

y -= 6;
ctx.line(M, y, right, y, [0.85, 0.84, 0.82], 0.6);
y -= 16;
y = ctx.row(M, y, right, "Purpose", "Access isolation fixture");
y = ctx.row(M, y, right, "Contains survey data", "No");
y = ctx.row(M, y, right, "Generated by", "scripts/make-fixture-assets.mjs");
y = ctx.row(M, y, right, "Guarded by", "scripts/portal-assets-test.mjs");

ctx.line(M, 52, right, 52, [0.85, 0.84, 0.82], 0.75);
ctx.text(M, 38, "Generated fixture. Shares no bytes with any real survey.", {
  size: 7.5,
  color: [0.45, 0.45, 0.45],
});

function wrap(s, cols) {
  const words = s.split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > cols) { out.push(line.trim()); line = w; }
    else line += " " + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

mkdirSync(join(root, "reports"), { recursive: true });
const buf = pdf.toBuffer();
writeFileSync(join(root, "reports", "topographic-survey.pdf"), buf);
console.log(`wrote reports/topographic-survey.pdf  ${(buf.length / 1024).toFixed(1)} KB`);
