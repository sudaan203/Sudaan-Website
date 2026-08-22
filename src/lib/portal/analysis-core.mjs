/**
 * The parts of the analysis client that are pure logic, and therefore testable.
 *
 * Same reasoning as `tile-grant-core.mjs`: the rules that are easy to get subtly
 * wrong live in a plain module that a node script can import and attack
 * directly, rather than inside a React component where the only way to exercise
 * them is to drive a browser. `analysis-client.ts` is the typed surface over
 * this; `scripts/analysis-core-test.mjs` is the adversary.
 *
 * Nothing here touches the DOM, `fetch`, or React, so it runs anywhere.
 */

/**
 * Map an HTTP status from the analysis route onto the distinction the UI needs.
 *
 * The route's status codes are deliberate and documented in its own header, so
 * this is a translation, not a guess:
 *   401 the session went away underneath a long lived map
 *   404 no such site OR not yours — never distinguished, so a slug is not confirmed
 *   409 the site exists and is yours, there is simply nothing to measure yet
 *   400 refused, with a message the API wrote for the client to read
 */
export function classifyStatus(status) {
  if (status === 401) return "auth";
  if (status === 404) return "not-found";
  if (status === 409) return "no-terrain";
  if (status === 400) return "bad-request";
  return "server";
}

/**
 * Serialise a reference surface for the wire.
 *
 * The server refuses an absent or unrecognised reference rather than defaulting,
 * and this is the only place that spelling is constructed, so the two cannot
 * drift into a state where the UI believes it asked for one thing and the
 * server measured another.
 */
export function referenceToWire(reference) {
  if (!reference || typeof reference !== "object") {
    throw new Error("a reference surface is required");
  }
  switch (reference.kind) {
    case "boundary":
      return "boundary";
    case "plane": {
      const { elevation } = reference;
      if (!Number.isFinite(elevation)) {
        throw new Error("a plane reference needs a finite elevation in metres");
      }
      return `plane:${elevation}`;
    }
    case "surface": {
      if (reference.surface !== "dtm" && reference.surface !== "dsm") {
        throw new Error('a surface reference must be "dtm" or "dsm"');
      }
      return reference.surface;
    }
    default:
      throw new Error(`unknown reference kind "${reference.kind}"`);
  }
}

/** Plain wording for what a volume was measured against. */
export function describeReference(reference) {
  switch (reference.kind) {
    case "boundary":
      return "best fit plane through the polygon boundary";
    case "plane":
      return `a level plane at ${reference.elevation.toFixed(2)} m`;
    case "surface":
      return reference.surface === "dsm"
        ? "the surface model (DSM)"
        : "the terrain model (DTM)";
    default:
      return "an unstated reference";
  }
}

/**
 * Wrap an async call so that only the most recent one can settle.
 *
 * The failure this prevents is invisible on screen and impossible to reproduce
 * on a fast connection: click three points quickly, three requests go out,
 * nothing orders the responses, and a slow first reply landing after a fast
 * third overwrites the newer answer with an older one. The panel then confidently
 * describes geometry that is no longer drawn.
 *
 * Two rules make staleness structural rather than a race a reviewer has to spot:
 *
 * - a superseded call resolves to `null`, never to a value, so the caller's
 *   `if (result === null) return;` is the whole of the correctness argument
 * - a superseded call never throws, because an abort is something *we* did and
 *   surfacing it would flash an error for a request the UI itself cancelled
 *
 * `cancel()` additionally bumps the ticket, so a call that is mid-await when the
 * measurement is cleared cannot resolve into an empty panel.
 */
export function latest(work) {
  let controller = null;
  let ticket = 0;

  return {
    async call(...args) {
      controller?.abort();
      const mine = (ticket += 1);
      const own = new AbortController();
      controller = own;

      try {
        const value = await work(own.signal, ...args);
        return mine === ticket ? value : null;
      } catch (error) {
        if (own.signal.aborted || mine !== ticket) return null;
        throw error;
      } finally {
        if (controller === own) controller = null;
      }
    },
    cancel() {
      controller?.abort();
      controller = null;
      ticket += 1;
    },
    /** Test seam: is anything in flight right now? */
    get pending() {
      return controller !== null;
    },
  };
}
