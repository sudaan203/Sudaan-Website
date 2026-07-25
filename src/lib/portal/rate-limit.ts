/**
 * Login throttling: 5 failures per key per 15 minutes.
 *
 * In memory, so the window is per serverless instance rather than global. That
 * is a real limitation and it is deliberate for v1: it stops casual password
 * guessing without adding Redis. A shared limiter arrives with the database.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const failures = new Map<string, { count: number; firstAt: number }>();

export function isRateLimited(key: string): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

export function recordFailure(key: string) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearFailures(key: string) {
  failures.delete(key);
}
