/**
 * Known-answer checks for the analysis client's pure logic.
 *
 *   node scripts/analysis-core-test.mjs
 *
 * Written as attacks rather than as features, in the same spirit as
 * `portal-tile-grant-test.mjs`. The interesting failure for a request
 * sequencer is not "does it return the answer" but "can an old answer ever win",
 * and that one does not reproduce on a fast connection, does not throw, and
 * leaves no trace on screen except a panel quietly describing geometry the
 * client already replaced. So the tests here deliberately make the *first*
 * request the slow one and assert that its value never lands.
 */

import {
  classifyStatus,
  describeReference,
  latest,
  referenceToWire,
} from "../src/lib/portal/analysis-core.mjs";

let failures = 0;
let checks = 0;

function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), Object.is(actual, expected) ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throws(label, fn, pattern) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (error) {
    check(label, pattern.test(error.message), `threw "${error.message}"`);
  }
}

console.log("\nStatus classification");

eq("401 is an auth problem", classifyStatus(401), "auth");
eq("404 is not-found", classifyStatus(404), "not-found");
eq("409 is no-terrain, not an error the client caused", classifyStatus(409), "no-terrain");
eq("400 is a refusal carrying a readable message", classifyStatus(400), "bad-request");
eq("500 falls through to server", classifyStatus(500), "server");
eq("502 falls through to server", classifyStatus(502), "server");
// 403 must not be special cased into something reassuring: the analysis route
// never issues one, so meeting a 403 means a proxy or an edge rule intervened
// and the honest answer is "server", not "you are not allowed".
eq("403 is not mistaken for an auth prompt", classifyStatus(403), "server");

console.log("\nReference surfaces, which are never defaulted");

eq("boundary", referenceToWire({ kind: "boundary" }), "boundary");
eq("a level plane", referenceToWire({ kind: "plane", elevation: 364.5 }), "plane:364.5");
eq("a plane at zero is still a plane", referenceToWire({ kind: "plane", elevation: 0 }), "plane:0");
eq("a negative plane survives", referenceToWire({ kind: "plane", elevation: -3.25 }), "plane:-3.25");
eq("the terrain model", referenceToWire({ kind: "surface", surface: "dtm" }), "dtm");
eq("the surface model", referenceToWire({ kind: "surface", surface: "dsm" }), "dsm");

throws("no reference at all is refused", () => referenceToWire(null), /required/i);
throws("an unknown kind is refused", () => referenceToWire({ kind: "sea-level" }), /unknown/i);
throws(
  "a plane with no elevation is refused rather than sent as plane:undefined",
  () => referenceToWire({ kind: "plane" }),
  /finite elevation/i,
);
throws(
  "a plane at NaN is refused",
  () => referenceToWire({ kind: "plane", elevation: NaN }),
  /finite elevation/i,
);
throws(
  "a surface reference to something that is not a survey grid is refused",
  () => referenceToWire({ kind: "surface", surface: "contours" }),
  /dtm.*dsm/i,
);

check(
  "every reference describes itself in words a client can check",
  describeReference({ kind: "plane", elevation: 364.5 }).includes("364.50") &&
    describeReference({ kind: "boundary" }).includes("boundary") &&
    describeReference({ kind: "surface", surface: "dsm" }).includes("DSM"),
);

console.log("\nRequest sequencing: an old answer must never win");

{
  const seq = latest(async (_signal, value) => {
    await sleep(5);
    return value;
  });
  const only = await seq.call("alone");
  eq("a single call resolves to its own value", only, "alone");
  eq("nothing is left in flight afterwards", seq.pending, false);
}

{
  // The whole point. The first request is the slow one and it deliberately
  // ignores the abort signal, so it *does* settle, and it settles last. Only
  // the ticket check can catch it.
  const seq = latest(async (_signal, { value, delay }) => {
    await sleep(delay);
    return value;
  });

  const slow = seq.call({ value: "stale", delay: 60 });
  await sleep(1);
  const fast = seq.call({ value: "current", delay: 5 });

  const [slowResult, fastResult] = await Promise.all([slow, fast]);
  eq("the superseded call resolves to null even though it settled last", slowResult, null);
  eq("the current call resolves to its value", fastResult, "current");
}

{
  // Three in flight, resolving in reverse order. Only the last may survive.
  const seq = latest(async (_signal, { value, delay }) => {
    await sleep(delay);
    return value;
  });
  const a = seq.call({ value: "a", delay: 40 });
  await sleep(1);
  const b = seq.call({ value: "b", delay: 25 });
  await sleep(1);
  const c = seq.call({ value: "c", delay: 5 });
  const results = await Promise.all([a, b, c]);
  eq("of three overlapping calls the first is discarded", results[0], null);
  eq("of three overlapping calls the second is discarded", results[1], null);
  eq("of three overlapping calls only the newest survives", results[2], "c");
}

{
  // A well behaved worker that *does* honour the signal must not surface the
  // abort as an error. Aborting is something we did.
  const seq = latest(
    (signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 50);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  );

  const first = seq.call();
  await sleep(1);
  const second = seq.call();
  let threw = false;
  const firstResult = await first.catch((error) => {
    threw = true;
    return error;
  });
  check("an aborted call does not reject", !threw, threw ? String(firstResult) : "");
  eq("an aborted call resolves to null", firstResult, null);
  eq("the replacement still resolves", await second, "done");
}

{
  const seq = latest(async (signal) => {
    await sleep(30);
    return signal.aborted ? "aborted" : "finished";
  });
  const inFlight = seq.call();
  await sleep(1);
  check("a call is reported as in flight", seq.pending);
  seq.cancel();
  eq("cancel makes an in-flight call resolve to null", await inFlight, null);
  eq("cancel leaves nothing in flight", seq.pending, false);
}

{
  // The signal really is wired through, so a worker that honours it can stop
  // work rather than merely having its result discarded.
  let sawAbort = false;
  const seq = latest(async (signal) => {
    signal.addEventListener("abort", () => {
      sawAbort = true;
    });
    await sleep(30);
    return "value";
  });
  void seq.call();
  await sleep(1);
  void seq.call();
  await sleep(1);
  check("superseding a call aborts its signal", sawAbort);
}

{
  const seq = latest(async () => {
    await sleep(5);
    throw new Error("the server said no");
  });
  let message = "";
  await seq.call().catch((error) => {
    message = error.message;
  });
  eq("a failure on the current call reaches the caller", message, "the server said no");
}

{
  // A superseded call that fails must stay silent: the UI has already moved on,
  // and an error toast for a request nobody is waiting for is noise at best and
  // misleading at worst.
  const seq = latest(async (_signal, { fail, delay }) => {
    await sleep(delay);
    if (fail) throw new Error("stale failure");
    return "current";
  });
  const doomed = seq.call({ fail: true, delay: 40 });
  await sleep(1);
  const good = seq.call({ fail: false, delay: 5 });

  let leaked = null;
  const doomedResult = await doomed.catch((error) => {
    leaked = error.message;
    return "threw";
  });
  eq("a superseded failure does not reach the caller", leaked, null);
  eq("a superseded failure resolves to null", doomedResult, null);
  eq("the call that replaced it still succeeds", await good, "current");
}

{
  // Sequential, non overlapping calls must each win. An over eager ticket bump
  // would break the ordinary case while passing every race test above.
  const seq = latest(async (_signal, value) => {
    await sleep(2);
    return value;
  });
  const first = await seq.call("one");
  const second = await seq.call("two");
  const third = await seq.call("three");
  check(
    "calls that do not overlap each resolve normally",
    first === "one" && second === "two" && third === "three",
    `${first}/${second}/${third}`,
  );
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
