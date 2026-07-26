/**
 * Best effort client IP, for throttling only.
 *
 * Never use this for authorisation. x-forwarded-for is a client supplied header
 * that the platform overwrites; on Vercel the value can be trusted, but this
 * code also runs locally and could run behind another proxy one day, so treat it
 * as a hint that makes abuse more expensive rather than as an identity.
 *
 * The last entry is taken, not the first. Proxies append, so the final hop is
 * the one written by infrastructure we control; the leading entries are whatever
 * the caller chose to send. Reading the first is the standard way this check
 * gets bypassed by rotating a spoofed header.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
