#!/usr/bin/env node
/**
 * Does every portal page actually ship the files it reads at request time?
 *
 *   node scripts/portal-tracing-test.mjs        (after a production build)
 *
 * This guards a bug that shipped to production and survived two rounds of "the
 * map works": the site layout calls readMapManifest to decide whether to show the
 * Map tab, `outputFileTracingIncludes` was keyed on the *layout*, and Next does
 * not emit a trace for a layout. So the include matched nothing, the manifest was
 * absent from every page function except the map page's own, and the Map tab never
 * rendered on the deployed site.
 *
 * Nothing errored. The map page itself worked if you typed the URL, so the feature
 * looked present locally, where the files are simply on disk. Only the trace
 * manifests reveal it, which is what this reads.
 *
 * Related trap: these config keys are globs, so "[siteSlug]" is a character class
 * and a key spelled that way silently matches nothing.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const APP = ".next/server/app";

if (!existsSync(APP)) {
  console.error(
    `no ${APP}. Run a production build first: node node_modules/next/dist/bin/next build`,
  );
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

function traces(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return traces(p);
    return e.name.endsWith(".nft.json") ? [p] : [];
  });
}

const read = (f) => JSON.parse(readFileSync(f, "utf8")).files;
const routeOf = (f) => f.replace(`${APP}`, "").replace(".js.nft.json", "");

/* ------------------------------------------------ the layout's own data --- */

console.log("--- every page under [siteSlug] must ship manifest.json ---");
console.log("    (the shared layout reads it to build the Map tab)\n");

const portalPages = traces(path.join(APP, "portal")).filter((f) =>
  routeOf(f).includes("[siteSlug]"),
);
check("portal site pages were built", portalPages.length >= 4, `${portalPages.length} found`);

for (const f of portalPages) {
  const files = read(f);
  const manifests = files.filter(
    (x) => x.includes("portal-data/map") && x.endsWith("manifest.json"),
  );
  check(routeOf(f), manifests.length > 0, `${manifests.length} manifest(s)`);
}

/* ------------------------------------------- the routes that serve bytes --- */

console.log("\n--- routes that stream files must ship those files ---");

const mapRoute = traces(path.join(APP, "api", "portal")).find((f) =>
  routeOf(f).includes("/map/"),
);
if (mapRoute) {
  const tiles = read(mapRoute).filter((x) => /portal-data\/map\/.*\/tiles\//.test(x));
  check("the layer route ships tile pyramids", tiles.length > 100, `${tiles.length} tiles`);
} else {
  check("the layer route was built", false, "no trace found");
}

const assetRoute = traces(path.join(APP, "api", "portal")).find((f) =>
  routeOf(f).includes("/assets/"),
);
if (assetRoute) {
  const deliverables = read(assetRoute).filter((x) => x.includes("portal-data/files"));
  check("the asset route ships deliverables", deliverables.length > 0, `${deliverables.length} files`);
} else {
  check("the asset route was built", false, "no trace found");
}

/* -------------------------------------------------------------- weight --- */

console.log("\n--- weight, so an include does not quietly balloon a function ---");

// A page that only needs the manifest should not be carrying the pyramid. This is
// not fatal, but it is the difference between a two file include and a two
// thousand file one, and Vercel caps a function at 250 MB uncompressed.
for (const f of portalPages) {
  const route = routeOf(f);
  if (route.endsWith("/map/page")) continue; // the viewer page, allowed to be fat
  const tiles = read(f).filter((x) => /\/tiles\//.test(x));
  check(`${route} carries no tiles`, tiles.length === 0, `${tiles.length}`);
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
