import { NextResponse } from "next/server";
import postgres from "postgres";
import { connectionString } from "@/lib/portal/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * Says whether the portal can reach its database, and how it is configured.
 *
 * Exists because a hanging page in production tells you nothing, and reading
 * Vercel logs is a slow loop. Returns no credentials: the host, the port and
 * which environment variable was used are all deducible from the Supabase
 * dashboard anyway, and the password never leaves the environment.
 */
export async function GET() {
  const source = process.env.DATABASE_URL
    ? "DATABASE_URL"
    : process.env.POSTGRES_URL
      ? "POSTGRES_URL"
      : null;

  const raw = connectionString();
  if (!raw || !source) {
    return NextResponse.json(
      { ok: false, backend: "seed", reason: "no connection string configured" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  let host = "unparseable";
  let port = "";
  try {
    const url = new URL(raw);
    host = url.hostname;
    port = url.port || "5432";
  } catch {
    // keep the placeholder
  }

  const directHost = /^db\.[a-z0-9]+\.supabase\.co$/.test(host);
  const started = Date.now();

  try {
    const sql = postgres(raw, {
      prepare: false,
      fetch_types: false,
      max: 1,
      connect_timeout: 8,
      idle_timeout: 2,
    });
    const [row] = await sql`select 1 as ok`;
    const [sites] = await sql`select count(*)::int as n from sites`;
    await sql.end({ timeout: 3 });

    return NextResponse.json(
      {
        ok: row.ok === 1,
        source,
        host,
        port,
        directHost,
        sites: sites.n,
        ms: Date.now() - started,
        hint: directHost
          ? "This is the direct Supabase host, which is IPv6 only. Use the pooler host instead."
          : undefined,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return NextResponse.json(
      {
        ok: false,
        source,
        host,
        port,
        directHost,
        ms: Date.now() - started,
        code: e.code ?? null,
        error: (e.message ?? "unknown").slice(0, 200),
        hint: directHost
          ? "This is the direct Supabase host, which is IPv6 only from Vercel. Set DATABASE_URL to the pooler host."
          : undefined,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
