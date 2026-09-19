#!/usr/bin/env node
/**
 * Delete objects under `sites/<slug>/` that no local file would produce.
 *
 *   node scripts/r2-prune.mjs --site <slug>          # say what is orphaned
 *   node scripts/r2-prune.mjs --site <slug> --yes    # and delete it
 *
 * ## Why this exists
 *
 * `upload-site.mjs` adds and replaces; it has never removed. So the bucket
 * accumulates whatever a previous shape of the pipeline put there, and two sites
 * are carrying that today:
 *
 *   - Ektanagar 2's point cloud is stored twice. 741 objects sit under `cloud/`,
 *     which is what `cloud-source.ts` reads, and 741 more sit flat at `nodes/`
 *     with a stray `cloud.json` beside them, from a `--from` that pointed one
 *     level too deep. The portal reads the first set and we pay for both.
 *   - Kotba has tiles from a tile build the repository no longer tracks.
 *
 * Neither breaks anything, which is exactly why neither was noticed. They are a
 * standing bill and a standing confusion about which objects are real.
 *
 * ## Why it refuses more than it deletes
 *
 * A pruner is the one tool here that can destroy a client's data, and the way it
 * would happen is mundane: someone runs it on a machine where `portal-data/`
 * is half populated, and every object whose local file is merely *absent* looks
 * orphaned. Nothing about that is obviously wrong at the moment of running it.
 *
 * So a prune requires a complete picture. A data class missing from disk blocks
 * it — but only when the bucket actually holds objects under that class's
 * prefix, because "this site has no point cloud" and "this machine has no point
 * cloud" look identical on disk, and Kotba and Kiru are the first kind. Map and
 * terrain stay strict either way: they share the site root, so nothing
 * distinguishes their objects from each other. `--only` is not offered.
 *
 * It also never deletes what it cannot name: the key set comes from
 * `lib/site-objects.mjs`, the same module `upload-site.mjs` builds its uploads
 * from, so the two cannot disagree about where a file belongs.
 */

import { CLASSES, assertSafeSlug, localObjects, presentClasses } from "./lib/site-objects.mjs";
import { deleteKey, listKeys, r2Client, r2Credentials } from "./lib/r2.mjs";

/* --------------------------------------------------------------- options --- */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const site = flag("site");
const confirmed = has("yes");
const concurrency = Number(flag("concurrency", "8"));

if (!site || has("help") || has("h")) {
  console.log(`
  node scripts/r2-prune.mjs --site <slug> [--yes]

    --site   the site to prune. Only sites/<slug>/ is ever touched.
    --yes    actually delete. Without it this lists and exits 0.

  Refuses when a data class is missing locally but present in the bucket: such
  an object is indistinguishable from an orphan, and this tool deletes orphans.

  Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.
`);
  process.exit(site ? 0 : 1);
}

assertSafeSlug(site);

/* ------------------------------------------------------------------- work --- */

const creds = r2Credentials({ required: true });
const client = r2Client(creds);

const prefix = `sites/${site}/`;
const remote = await listKeys(client, prefix);

/*
 * The complete-picture rule, and why it is not simply "every class present".
 *
 * A pruner is the one tool here that can destroy a client's data, and the way it
 * would happen is mundane: someone runs it where `portal-data/` is half
 * populated, and every object whose local file is merely *absent* looks
 * orphaned. Nothing about that is obviously wrong at the moment of running it.
 *
 * But "this site has no point cloud" and "this machine has no point cloud" look
 * identical on disk, and Kotba and Kiru are the first kind — they were never
 * flown with LiDAR. Refusing on local absence alone would make those two
 * sites permanently unprunable, which is how a safety rule becomes a rule people
 * work around.
 *
 * The bucket settles it. A class missing locally is only dangerous if the bucket
 * holds objects under its prefix; if neither side has it, the absence is
 * consistent and there is nothing to mistake for an orphan.
 *
 * Map and terrain are the exception, and stay strict: they share the site root,
 * so there is no prefix that would tell us whether the remote objects at the
 * root belong to the one that is missing.
 */
const { absent } = presentClasses(site);
const blocking = absent.filter((c) => {
  /*
   * An archive class is *meant* to be absent locally. `source/` holds the raw
   * delivery precisely so the folder on this machine can be deleted, so its
   * absence carries no information about whether the remote objects are
   * orphaned — it is the expected state, not a half-populated one. Treating it
   * like working data would make every site unprunable the moment the archive
   * did its job.
   *
   * It is also never pruned *from*: nothing local corresponds to it, so every
   * object under the prefix would look orphaned. Skipped on both counts below.
   */
  if (c.archive) return false;
  if (c.prefix === "") return true; // shares the site root; cannot be reasoned about
  return remote.some((key) => key.startsWith(`${prefix}${c.prefix}/`));
});

if (blocking.length > 0) {
  console.error(`\nrefusing to prune ${site}: ${blocking.length} data class(es) not on this machine\n`);
  for (const c of blocking) {
    const n = remote.filter((k) => k.startsWith(`${prefix}${c.prefix}/`)).length;
    console.error(
      `  ${c.name.padEnd(10)} nothing at ${c.dir(site)}` +
        (c.prefix ? `, but ${n} objects under ${prefix}${c.prefix}/` : ", and it shares the site root"),
    );
  }
  console.error(`
Every object under sites/${site}/ whose local file is missing would look
orphaned. Fetch the missing classes, or prune from the machine that has them.
`);
  process.exit(1);
}

for (const c of absent) {
  console.log(`  ${c.name.padEnd(10)} absent locally and in the bucket — this site has none`);
}

const local = new Set(localObjects(site).map((o) => o.key));

/*
 * Belt and braces on the prefix.
 *
 * `listKeys` was asked for this prefix and R2 has no reason to return anything
 * else, but this is the check that stands between a bug anywhere above and
 * deleting another client's survey, so it is made explicitly rather than
 * assumed.
 */
/**
 * Prefixes this tool will not delete from, whatever the local disk says.
 *
 * An archive class holds the raw delivery so the local folder can be *deleted*,
 * so every object under it has no local counterpart by design. Passing those
 * through the orphan test would delete the entire archive on the first run
 * after it started working — the tool doing exactly what it was told, and
 * destroying the one copy the pipeline cannot regenerate.
 *
 * Excluded here rather than by fixing up `local`, so the reason is stated at
 * the point of deletion rather than inferred from an absence somewhere else.
 */
const archived = CLASSES.filter((c) => c.archive).map((c) => `${prefix}${c.prefix}/`);

const orphans = remote.filter((key) => {
  if (!key.startsWith(prefix)) {
    throw new Error(`listing returned ${key}, which is outside ${prefix}. Refusing to continue.`);
  }
  if (archived.some((a) => key.startsWith(a))) return false;
  return !local.has(key);
});

console.log(`\n${site}`);
console.log(`  local   ${local.size} objects across ${CLASSES.length - absent.length} classes`);
console.log(`  remote  ${remote.length} objects under ${prefix}`);
console.log(`  orphan  ${orphans.length}`);
if (archived.length > 0) {
  const kept = remote.filter((k) => archived.some((a) => k.startsWith(a))).length;
  console.log(`  archive ${kept} objects under ${archived.join(", ")} — never pruned`);
}
console.log();

if (orphans.length === 0) {
  console.log("Nothing to prune.\n");
  process.exit(0);
}

/** Grouped, because 741 individual lines is not a thing anyone reads. */
const groups = new Map();
for (const key of orphans) {
  const rest = key.slice(prefix.length);
  const head = rest.includes("/") ? `${rest.split("/")[0]}/` : rest;
  groups.set(head, (groups.get(head) ?? 0) + 1);
}
for (const [head, n] of [...groups].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${prefix}${head}`);
}

if (!confirmed) {
  console.log(`\nNothing deleted. Re-run with --yes to delete these ${orphans.length} objects.\n`);
  process.exit(0);
}

console.log(`\nDeleting ${orphans.length} objects...\n`);

let deleted = 0;
let failed = 0;
const queue = [...orphans];
async function worker() {
  for (;;) {
    const key = queue.shift();
    if (!key) return;
    try {
      await deleteKey(client, key);
      deleted += 1;
      if (deleted % 100 === 0) console.log(`  ${deleted}/${orphans.length}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${key}: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

console.log(`\n${deleted} deleted, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
