import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice(){} });
const [s] = await sql`show statement_timeout`;
const [i] = await sql`show idle_in_transaction_session_timeout`;
console.log("statement_timeout:", s.statement_timeout, "| idle_in_tx_timeout:", i.idle_in_transaction_session_timeout);
console.log("timing the exact query that failed, 6 times:");
for (let n = 1; n <= 6; n++) {
  const t = Date.now();
  try {
    const rows = await sql`select id, slug, name from sites where true order by name asc`;
    console.log(`  run ${n}: ${Date.now() - t}ms, ${rows.length} rows`);
  } catch (e) {
    console.log(`  run ${n}: ${Date.now() - t}ms FAILED ${e.code} ${e.message.slice(0, 60)}`);
  }
}
console.log("four in parallel (what the console page does):");
const t = Date.now();
try {
  await Promise.all([
    sql`select count(*) from clients`, sql`select count(*) from users`,
    sql`select count(*) from sites`, sql`select count(*) from access_changes`,
  ]);
  console.log(`  parallel: ${Date.now() - t}ms`);
} catch (e) { console.log(`  parallel FAILED after ${Date.now() - t}ms: ${e.code} ${e.message.slice(0,60)}`); }
await sql.end({ timeout: 5 });
