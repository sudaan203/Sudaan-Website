/**
 * The database timeout ladder, which has to stay in order.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/db-timeout-test.mjs
 *
 * Three timeouts guard a portal query, and each has to fire before the one
 * outside it so the most specific error is the one that surfaces:
 *
 *   connect_timeout  <  statement_timeout  <  the request deadline
 *
 * On 23 Aug 2026 they were inverted — the driver was allowed 10 seconds to
 * connect while the deadline killed the attempt at 7 — so a connection that
 * needed 7 to 10 seconds could never complete, and `queryDb`'s retry handed it
 * the same impossible budget. Both attempts died and the portal rendered its
 * error boundary with nothing in the logs but a generic timeout.
 *
 * That is invisible to every other suite: it needs a slow pooler to show up, and
 * a fast one hides it completely. So it is asserted as arithmetic on the
 * constants instead, read out of the source, which is the only way a
 * relationship this quiet stays true.
 */

import { readFileSync } from "node:fs";

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const source = readFileSync(new URL("../src/lib/portal/db/client.ts", import.meta.url), "utf8");

const deadlineMs = Number(source.match(/const QUERY_TIMEOUT_MS = (\d+)/)?.[1]);
const connectExpr = source.match(/const CONNECT_TIMEOUT_S = (.+);/)?.[1];
const statementExpr = source.match(/statement_timeout: (.+?)\s*\}/)?.[1];

console.log("\nThe constants are where they are expected to be");
check("a request deadline is defined", Number.isFinite(deadlineMs), `${deadlineMs} ms`);
check("a connect timeout is derived from it", Boolean(connectExpr), connectExpr);
check("a statement timeout is derived from it", Boolean(statementExpr), statementExpr);

/*
 * Evaluated rather than pattern-matched, so the check follows the arithmetic
 * instead of the spelling. If someone writes the derivation differently but
 * keeps it correct, this should still pass; if they keep the spelling and break
 * the arithmetic, it should not.
 */
const QUERY_TIMEOUT_MS = deadlineMs;
const connectS = Function("QUERY_TIMEOUT_MS", `return ${connectExpr}`)(QUERY_TIMEOUT_MS);
const statementMs = Function("QUERY_TIMEOUT_MS", `return ${statementExpr}`)(QUERY_TIMEOUT_MS);
const connectMs = connectS * 1000;

console.log("\nThe ladder is in order, innermost first");
check("the driver gives up connecting before the server gives up querying",
  connectMs < statementMs, `connect ${connectMs} ms < statement ${statementMs} ms`);
check("the server gives up querying before the request deadline",
  statementMs < deadlineMs, `statement ${statementMs} ms < deadline ${deadlineMs} ms`);
check("so a connect failure is reported as a connect failure, not as our timeout",
  connectMs < deadlineMs, `connect ${connectMs} ms < deadline ${deadlineMs} ms`);

console.log("\nAnd the budget stays inside a serverless function's lifetime");
/*
 * `queryDb` retries once on a connection fault, so the worst case a request can
 * cost is two full deadlines. Vercel's default ceiling is 10 s on Hobby and 15 s
 * on Pro; anything past that is killed as a gateway timeout, which is a worse
 * failure than the one being guarded against because the page never renders at
 * all.
 */
check("two attempts fit inside 15 seconds", deadlineMs * 2 <= 15_000,
  `${(deadlineMs * 2) / 1000} s worst case`);
check("and a connect failure costs far less than that, so the retry is real",
  connectMs * 2 < deadlineMs * 2,
  `${(connectMs * 2) / 1000} s for two failed connects`);

console.log("\nThe retry exists and is conditional");
check("queryDb retries exactly once", /reconnecting and retrying once/.test(source));
check("and only on a connection fault, not on a query that legitimately failed",
  /if \(!isConnectionFault\(err\)\) throw err;/.test(source));
check("resetting the pool before it, so the retry is not on the dead socket",
  /await resetDb\(\);/.test(source));

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
