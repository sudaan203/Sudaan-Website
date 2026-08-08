/**
 * The tile edge, attacked from outside.
 *
 * `docs/portal-map-architecture.md` section 11 lists the Worker as new attack
 * surface and says it must be covered by tests rather than bolted on. This is
 * that cover. The Worker is exercised through its real `fetch` handler against a
 * fake R2 binding, so what is tested is the code that gets deployed, not a
 * description of it.
 *
 * The cases that matter are the ones where a request is *plausible*: a client
 * with a genuine, unexpired, correctly signed grant for their own site, asking
 * for something they should not have. A token check that stops there and does
 * not also check the key would pass a naive test suite and leak every survey in
 * the bucket.
 *
 * Run:
 *   node scripts/portal-tile-grant-test.mjs
 */

import {
  TILE_GRANT_COOKIE,
  createTileGrant,
  verifyTileGrant,
  keyIsWithinSite,
  siteObjectPrefix,
} from "../src/lib/portal/tile-grant-core.mjs";
import worker from "../workers/tile-gateway/src/index.js";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

const SECRET = "test-secret-of-at-least-thirty-two-characters";
const OTHER_SECRET = "a-completely-different-secret-also-long-enough";

/** Minimal stand-in for the R2 binding, holding two clients' objects. */
const BUCKET = new Map([
  ["sites/kotba-survey/dtm.tif", Buffer.from("KOTBA-TERRAIN-DATA")],
  ["sites/kotba-survey-2/dtm.tif", Buffer.from("SECOND-KOTBA-SITE")],
  ["sites/ambaji-survey/dtm.tif", Buffer.from("ANOTHER-CLIENTS-DATA")],
]);

const env = {
  PORTAL_TILE_SECRET: SECRET,
  SURVEY_BUCKET: {
    async get(key, options) {
      const body = BUCKET.get(key);
      if (!body) return null;
      const rangeHeader = options?.range?.get?.("Range");
      const object = {
        size: body.length,
        httpEtag: `"${key.length}-${body.length}"`,
        writeHttpMetadata() {},
        range: null,
        body,
      };
      if (rangeHeader) {
        const [, from, to] = /bytes=(\d*)-(\d*)/.exec(rangeHeader) ?? [];
        const start = from ? Number(from) : 0;
        const end = to ? Number(to) : body.length - 1;
        object.range = { offset: start, length: end - start + 1 };
        object.body = body.subarray(start, end + 1);
      }
      return object;
    },
  },
};

const ask = (key, { token, method = "GET", range } = {}) => {
  const headers = new Headers();
  if (token) headers.set("Cookie", `other=1; ${TILE_GRANT_COOKIE}=${token}; trailing=2`);
  if (range) headers.set("Range", range);
  return worker.fetch(new Request(`https://tiles.example.com/${key}`, { method, headers }), env);
};

// ---------------------------------------------------------------------------
console.log("\nThe token itself");
{
  const token = await createTileGrant("kotba-survey", SECRET);
  check("a freshly minted grant verifies",
    (await verifyTileGrant(token, SECRET))?.site === "kotba-survey");
  check("and verifies against the site it names",
    (await verifyTileGrant(token, SECRET, { expectedSite: "kotba-survey" })) !== null);
  check("but NOT against a different site",
    (await verifyTileGrant(token, SECRET, { expectedSite: "ambaji-survey" })) === null,
    "a signature proves we issued it, not what it authorises");

  check("a token signed with another secret is rejected",
    (await verifyTileGrant(token, OTHER_SECRET)) === null);
  check("a tampered payload is rejected",
    (await verifyTileGrant(
      `${btoa('{"site":"ambaji-survey","exp":9999999999}').replace(/=+$/, "")}.${token.split(".")[1]}`,
      SECRET,
    )) === null);
  check("a tampered signature is rejected",
    (await verifyTileGrant(`${token.split(".")[0]}.AAAA${token.split(".")[1].slice(4)}`, SECRET)) === null);
  check("an unsigned token is rejected", (await verifyTileGrant("just-a-payload", SECRET)) === null);
  check("an empty token is rejected", (await verifyTileGrant("", SECRET)) === null);
  check("a missing secret cannot accidentally verify anything",
    (await verifyTileGrant(token, "")) === null);

  const expired = await createTileGrant("kotba-survey", SECRET, { minutes: -1 });
  check("an expired grant is rejected", (await verifyTileGrant(expired, SECRET)) === null);

  // Expiry is enforced by clock, so prove it actually bites at the boundary.
  const shortLived = await createTileGrant("kotba-survey", SECRET, { minutes: 1 });
  check("a grant valid now is refused once the clock passes its expiry",
    (await verifyTileGrant(shortLived, SECRET)) !== null &&
    (await verifyTileGrant(shortLived, SECRET, { now: Date.now() + 61 * 1000 })) === null);

  check("the payload carries no identity, only a site and an expiry",
    JSON.stringify(Object.keys(await verifyTileGrant(token, SECRET)).sort()) ===
      JSON.stringify(["exp", "site"]),
    "the edge must not learn who the client is");
}

// ---------------------------------------------------------------------------
console.log("\nWhich keys a grant reaches");
{
  check("its own site is reachable", keyIsWithinSite("sites/kotba-survey/dtm.tif", "kotba-survey"));
  check("nested paths under it are reachable",
    keyIsWithinSite("sites/kotba-survey/tiles/ortho/14/1/2.webp", "kotba-survey"));
  check("another site is not", !keyIsWithinSite("sites/ambaji-survey/dtm.tif", "kotba-survey"));

  // The one a naive startsWith gets wrong, and these slugs are realistic.
  check("a site whose slug merely STARTS WITH ours is not reachable",
    !keyIsWithinSite("sites/kotba-survey-2/dtm.tif", "kotba-survey"),
    "startsWith without the trailing slash would allow this");

  check("traversal with .. is refused", !keyIsWithinSite("sites/kotba-survey/../ambaji-survey/dtm.tif", "kotba-survey"));
  check("percent encoded traversal is refused",
    !keyIsWithinSite("sites/kotba-survey/%2e%2e/ambaji-survey/dtm.tif", "kotba-survey"));
  check("backslashes are refused", !keyIsWithinSite("sites\\kotba-survey\\dtm.tif", "kotba-survey"));
  check("a leading slash is refused", !keyIsWithinSite("/sites/kotba-survey/dtm.tif", "kotba-survey"));
  check("the bucket root is not reachable", !keyIsWithinSite("sites/", "kotba-survey"));
  check("an empty key is refused", !keyIsWithinSite("", "kotba-survey"));
  check("an empty site grants nothing", !keyIsWithinSite("sites/kotba-survey/dtm.tif", ""));
  check("the prefix helper matches the rule", siteObjectPrefix("kotba-survey") === "sites/kotba-survey/");
}

// ---------------------------------------------------------------------------
console.log("\nThe Worker, end to end against a fake bucket");
{
  const token = await createTileGrant("kotba-survey", SECRET);

  const ok = await ask("sites/kotba-survey/dtm.tif", { token });
  check("a valid grant reads its own site", ok.status === 200);
  check("and gets the actual bytes", (await ok.clone().text()) === "KOTBA-TERRAIN-DATA");
  check("the response is marked private", (ok.headers.get("cache-control") ?? "").includes("private"));
  check("view only is preserved", ok.headers.get("content-disposition") === "inline");
  check("it is not indexable", (ok.headers.get("x-robots-tag") ?? "").includes("noindex"));
  check("sniffing is off", ok.headers.get("x-content-type-options") === "nosniff");
  check("range support is advertised", ok.headers.get("accept-ranges") === "bytes");
  check("the content type comes from the extension", ok.headers.get("content-type") === "image/tiff");

  // The whole point of the architecture: byte ranges for COG and PMTiles.
  const partial = await ask("sites/kotba-survey/dtm.tif", { token, range: "bytes=0-4" });
  check("a range request returns 206", partial.status === 206);
  check("with only those bytes", (await partial.clone().text()) === "KOTBA");
  check("and a correct Content-Range",
    partial.headers.get("content-range") === "bytes 0-4/18",
    partial.headers.get("content-range") ?? "missing");

  const head = await ask("sites/kotba-survey/dtm.tif", { token, method: "HEAD" });
  check("HEAD returns metadata with no body",
    head.status === 200 && (await head.text()) === "" && head.headers.get("content-length") === "18");

  // --- the attacks --------------------------------------------------------
  check("no cookie at all is refused",
    (await ask("sites/kotba-survey/dtm.tif")).status === 404);
  check("a grant for another site cannot read this one",
    (await ask("sites/kotba-survey/dtm.tif", {
      token: await createTileGrant("ambaji-survey", SECRET),
    })).status === 404);
  check("a valid grant cannot reach another client's site",
    (await ask("sites/ambaji-survey/dtm.tif", { token })).status === 404,
    "the object exists in the bucket");
  check("a valid grant cannot reach a site whose slug starts with its own",
    (await ask("sites/kotba-survey-2/dtm.tif", { token })).status === 404,
    "the object exists in the bucket");
  check("a token signed with the wrong secret is refused",
    (await ask("sites/kotba-survey/dtm.tif", {
      token: await createTileGrant("kotba-survey", OTHER_SECRET),
    })).status === 404);
  check("an expired grant is refused",
    (await ask("sites/kotba-survey/dtm.tif", {
      token: await createTileGrant("kotba-survey", SECRET, { minutes: -1 }),
    })).status === 404);
  check("traversal out of the site is refused",
    (await ask("sites/kotba-survey/../ambaji-survey/dtm.tif", { token })).status === 404);
  check("writes are refused",
    (await ask("sites/kotba-survey/dtm.tif", { token, method: "PUT" })).status === 404);
  check("deletes are refused",
    (await ask("sites/kotba-survey/dtm.tif", { token, method: "DELETE" })).status === 404);
  check("cross origin preflight is not granted",
    (await ask("sites/kotba-survey/dtm.tif", { token, method: "OPTIONS" })).status === 405);

  // A missing object and a forbidden one must be indistinguishable, or the
  // response itself becomes a way to enumerate which sites exist.
  const missing = await ask("sites/kotba-survey/no-such-file.tif", { token });
  const forbidden = await ask("sites/ambaji-survey/dtm.tif", { token });
  check("a missing object and a forbidden one answer identically",
    missing.status === forbidden.status && missing.status === 404 &&
    (await missing.text()) === (await forbidden.text()),
    "otherwise the status code enumerates the bucket");

  // If the Worker is misconfigured it must fail closed, not open.
  const noSecret = await worker.fetch(
    new Request("https://tiles.example.com/sites/kotba-survey/dtm.tif", {
      headers: { Cookie: `${TILE_GRANT_COOKIE}=${token}` },
    }),
    { SURVEY_BUCKET: env.SURVEY_BUCKET },
  );
  check("a Worker deployed without its secret serves nothing", noSecret.status === 404,
    "fails closed, not open");
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
