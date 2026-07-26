/**
 * In memory throttling.
 *
 * The window is per serverless instance rather than global, which is a real
 * limitation and a deliberate one for v1: it stops casual abuse without adding
 * Redis. Someone determined can spread requests across instances. A shared
 * limiter is the upgrade when there is a reason to pay for one.
 *
 * Two shapes are used:
 *   recordFailure/isRateLimited  count only failures, so a legitimate user
 *                                signing in correctly is never throttled.
 *   hit                          counts every request, for endpoints where the
 *                                request itself is the cost (sending mail).
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

/**
 * Bounded so a flood of distinct keys cannot grow this without limit. An
 * attacker rotating addresses would otherwise sit in a long lived function
 * instance's memory indefinitely.
 */
const MAX_KEYS = 5000;

type Entry = { count: number; firstAt: number };
const buckets = new Map<string, Entry>();

/** Drops entries whose window has passed, and the oldest if still over budget. */
function prune(now: number) {
  for (const [key, entry] of buckets) {
    if (now - entry.firstAt > WINDOW_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_KEYS) return;
  // Map preserves insertion order, so the front is the oldest.
  const excess = buckets.size - MAX_KEYS;
  let removed = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (++removed >= excess) break;
  }
}

function current(key: string, now: number): Entry | undefined {
  const entry = buckets.get(key);
  if (!entry) return undefined;
  if (now - entry.firstAt > WINDOW_MS) {
    buckets.delete(key);
    return undefined;
  }
  return entry;
}

export function isRateLimited(key: string, max = MAX_FAILURES): boolean {
  const entry = current(key, Date.now());
  return entry ? entry.count >= max : false;
}

export function recordFailure(key: string) {
  const now = Date.now();
  const entry = current(key, now);
  if (!entry) {
    prune(now);
    buckets.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

export function clearFailures(key: string) {
  buckets.delete(key);
}

/**
 * Counts this request against the key and says whether the caller is over the
 * limit. Use where every request costs something, not just the failures.
 */
export function hit(key: string, max: number, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now - entry.firstAt > windowMs) {
    prune(now);
    buckets.set(key, { count: 1, firstAt: now });
    return false;
  }

  entry.count += 1;
  return entry.count > max;
}
