/**
 * Access logging.
 *
 * Vercel has a read only filesystem, and v1 has no database, so events go to
 * stdout and are readable in the Vercel logs. When Postgres lands these calls
 * become inserts into the access_log table (docs/client-portal-plan.md, 5).
 * Keep the call sites unchanged, only this function changes.
 */

type PortalEvent =
  | "login"
  | "login_failed"
  | "login_rate_limited"
  | "logout"
  | "view_site"
  | "view_asset"
  | "denied";

export function logPortalEvent(event: PortalEvent, detail: Record<string, unknown>) {
  const line = { at: new Date().toISOString(), event, ...detail };
  console.log(`[portal] ${JSON.stringify(line)}`);
}
