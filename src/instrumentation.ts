/**
 * Puts the real server error in the Vercel log.
 *
 * In a production build Next replaces the message of anything thrown during a
 * Server Components render with "the specific message is omitted", leaving only
 * a digest. That is right for the browser and useless for us: the owner console
 * failed for days behind a digest, and the cause turned out to be four database
 * reads hanging on the connection pooler.
 *
 * onRequestError sees the untouched error, so one look at the log now says what
 * broke, on which route, and with which digest to match the screenshot someone
 * sends us.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string },
) {
  const parts: string[] = [];
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth += 1) {
    const err = cursor as { message?: string; code?: string; cause?: unknown };
    const message = String(err.message ?? cursor).split("\n")[0].slice(0, 200);
    parts.push(err.code ? `${message} [${err.code}]` : message);
    cursor = err.cause;
  }

  console.error(
    `[portal] ${request.method} ${request.path} failed` +
      `${context.routeType ? ` (${context.routeType})` : ""}: ${parts.join(" <- ")}`,
    (error as { digest?: string })?.digest ? `digest ${(error as { digest?: string }).digest}` : "",
    (error as Error)?.stack?.split("\n").slice(1, 6).join("\n") ?? "",
  );
}
