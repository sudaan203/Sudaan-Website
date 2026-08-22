/**
 * Reading numbers from things that are not numbers.
 *
 * ## Why this exists
 *
 * JavaScript's numeric coercion turns two very common "absent" values into a
 * perfectly finite zero:
 *
 *   Number(null)  === 0     // a query parameter that was not supplied
 *   Number("")    === 0     // an input box the client has not filled in
 *   Number("  ")  === 0     // and one they typed a space into
 *
 * so the obvious guard, `Number.isFinite(Number(raw))`, is true in exactly the
 * cases it is meant to catch. That has now caused three separate defects in this
 * codebase, each of which produced a plausible result rather than an error:
 *
 * - a flood tool asked the server to inundate a survey sitting at 340 m to sea
 *   level, because the level box was empty
 * - every rendered tile came back fully transparent, because an absent
 *   `opacity` parameter read as 0 and the alpha channel was multiplied by it
 * - a colour stretch defaulted to the range 0..0 rather than to the data
 *
 * The third was invisible because a second bug cancelled it, which is the usual
 * way with this class.
 *
 * So: parse in one place, treat absent and blank as absent, and return null
 * rather than a number the caller has to second-guess.
 */

/**
 * A finite number, or null.
 *
 * `null`, `undefined`, an empty or whitespace-only string, and anything that
 * does not parse are all null. A real 0 passes through, because 0 is a
 * legitimate elevation, opacity and threshold.
 */
export function finiteOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The same, with a fallback for callers that always need a number. */
export function finiteOr(raw: unknown, fallback: number): number {
  return finiteOrNull(raw) ?? fallback;
}

/**
 * A query parameter as a finite number, or null when it was not supplied.
 *
 * This is the shape that keeps the caller honest: `?opacity=0` and no `opacity`
 * at all are different requests, and only a nullable return can tell them apart.
 */
export function numberParam(params: URLSearchParams, key: string): number | null {
  return finiteOrNull(params.get(key));
}

/**
 * A number constrained to a range, or the fallback.
 *
 * Clamps rather than rejects, because these come from a URL a client can edit
 * and the useful behaviour for `?opacity=5` is a fully opaque tile, not a 400.
 */
export function clampedParam(
  params: URLSearchParams,
  key: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const value = numberParam(params, key);
  if (value === null) return fallback;
  return Math.min(max, Math.max(min, value));
}
