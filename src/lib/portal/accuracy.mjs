/**
 * What the portal is allowed to say about a survey's vertical accuracy.
 *
 * ## Why this file exists
 *
 * Every elevation, volume, cut and fill, spot level and cross section the portal
 * has ever shown a client carried "±4 cm", and until now that number came from
 * `PORTAL_SURVEY_RMSE_Z` with a hardcoded 0.04 default, applied to every survey
 * ever published, while the wording around it said it came from "the survey's
 * own checkpoint report". It did not. 3 to 4 cm is Sudaan's advertised figure
 * for this class of work. Kotba, Aektanagar and Kiru were flown on different
 * days with different equipment over different terrain and they cannot all be
 * accurate to the same centimetre.
 *
 * A client asked where the number came from. That question has to be answerable
 * from the portal, in the portal's own words, and the same way everywhere — so
 * the wording lives here rather than being retyped in five panels that would
 * drift apart within a release.
 *
 * ## The rule the rest of the code follows
 *
 * There are exactly three states and they are never blurred:
 *
 *   measured  this survey's own checkpoint report gave us a figure. Say so, say
 *             what it is, say what it was measured against.
 *   typical   we have no report for this survey. A figure may still be shown,
 *             but only labelled as the company's typical result and never as
 *             this survey's. `accuracyBand` deliberately returns null here, so
 *             a bare "±4 cm" cannot be attached to an individual number where
 *             there is no room for the qualifier.
 *   none      no figure at all is stated.
 *
 * Plain JavaScript with JSDoc types, no imports and no environment access, so
 * the same rules run in the route handler, in the browser bundle and in
 * `scripts/accuracy-test.mjs` without a build step. Reading `process.env` here
 * would put the fallback back in the middle of the wording, which is the shape
 * of the original bug.
 */

/**
 * Sudaan's advertised vertical accuracy for this class of survey.
 *
 * This is a marketing figure and this module's whole job is to stop it being
 * presented as a measurement. It is the default fallback because showing a
 * client nothing at all invites them to read a level as exact, which over a
 * hectare it is not — but it is only ever labelled "typical".
 */
export const TYPICAL_RMSE_Z = 0.04;

/**
 * @typedef {"rmse" | "ci95"} AccuracyBasis
 *   What a vertical accuracy figure actually is. RMSE(z) and a 95% confidence
 *   interval describe the same survey and differ by a factor of about 1.96, so
 *   a figure without its basis cannot be quoted safely.
 */

/**
 * A figure that came from a survey's own checkpoint report.
 *
 * @typedef {object} SiteVerticalAccuracy
 * @property {number} rmseZ Metres. Always > 0.
 * @property {AccuracyBasis} basis
 * @property {number | null} checkpoints How many independent checkpoints.
 * @property {string | null} assessedOn ISO date the check was made, which is
 *   not the flight date.
 * @property {string | null} method How it was checked, in the surveyor's words.
 * @property {string | null} source The document it can be read out of.
 */

/**
 * The resolved answer to "what may we say about this survey's accuracy".
 *
 * @typedef {object} SurveyAccuracy
 * @property {"measured" | "typical" | "none"} provenance
 * @property {number | null} rmseZ Metres, or null when nothing is stated. Fed
 *   to the volume arithmetic, which already treats null as "no ± band".
 * @property {AccuracyBasis | null} basis
 * @property {number | null} checkpoints
 * @property {string | null} assessedOn
 * @property {string | null} method
 * @property {string | null} source
 * @property {boolean} measured True only for `provenance === "measured"`. The
 *   one flag the UI branches on, so "did this come from a checkpoint report"
 *   never has to be re-derived from the other fields.
 * @property {string} statement One plain sentence for a client, ready to render.
 * @property {string} label A few words, for a table cell or a chip.
 */

/**
 * Decide what may be said, from what the survey recorded and what is configured.
 *
 * The recorded figure always wins. The fallback is a fallback: it is used only
 * when the survey has nothing of its own, and the result says so in every field
 * that matters. Passing `null` as the fallback means "state no figure at all",
 * which is what `PORTAL_SURVEY_RMSE_Z=none` asks for.
 *
 * @param {SiteVerticalAccuracy | null | undefined} recorded
 * @param {number | null} fallbackRmseZ
 * @returns {SurveyAccuracy}
 */
export function resolveAccuracy(recorded, fallbackRmseZ) {
  /*
   * A recorded figure is only usable with its basis. Without it the number
   * cannot be interpreted, and rendering it anyway would recreate the bare
   * "±4 cm" this module exists to remove — so an incomplete row degrades to the
   * fallback rather than being dressed up as a measurement. The database
   * constraint in drizzle/0003_survey_accuracy.sql is the real guard; this is
   * the seed store, a hand edited row, and whatever writes these next.
   */
  const usable =
    recorded &&
    typeof recorded.rmseZ === "number" &&
    Number.isFinite(recorded.rmseZ) &&
    recorded.rmseZ > 0 &&
    (recorded.basis === "rmse" || recorded.basis === "ci95");

  if (usable) {
    const measured = /** @type {SiteVerticalAccuracy} */ (recorded);
    return {
      provenance: "measured",
      rmseZ: measured.rmseZ,
      basis: measured.basis,
      checkpoints: measured.checkpoints ?? null,
      assessedOn: measured.assessedOn ?? null,
      method: measured.method ?? null,
      source: measured.source ?? null,
      measured: true,
      statement: measuredStatement(measured),
      label: `±${centimetres(measured.rmseZ)} ${basisWord(measured.basis)}, measured for this survey`,
    };
  }

  if (typeof fallbackRmseZ === "number" && Number.isFinite(fallbackRmseZ) && fallbackRmseZ > 0) {
    return {
      provenance: "typical",
      rmseZ: fallbackRmseZ,
      basis: null,
      checkpoints: null,
      assessedOn: null,
      method: null,
      source: null,
      measured: false,
      statement:
        `No checkpoint report has been supplied for this survey, so its vertical accuracy has ` +
        `not been measured. The ±${centimetres(fallbackRmseZ)} quoted here is Sudaan's typical ` +
        `figure for this kind of work, not a result for this ground. Ask us for the checkpoint ` +
        `report before relying on these levels where the tolerance matters.`,
      label: `±${centimetres(fallbackRmseZ)} typical, not measured for this survey`,
    };
  }

  return {
    provenance: "none",
    rmseZ: null,
    basis: null,
    checkpoints: null,
    assessedOn: null,
    method: null,
    source: null,
    measured: false,
    statement:
      `No checkpoint report has been supplied for this survey, so no vertical accuracy is ` +
      `stated with these figures. Levels are read from the delivered model at full resolution; ` +
      `ask us for the checkpoint report before relying on them where the tolerance matters.`,
    label: "not measured for this survey",
  };
}

/**
 * Read `PORTAL_SURVEY_RMSE_Z` into a fallback figure.
 *
 * Takes the raw string rather than reading the environment itself, so the rule
 * stays testable in plain Node and this module keeps its "no environment
 * access" property. `terrain-source.ts` does the reading.
 *
 * Three traps, all of which fail silently if got wrong:
 *
 * - `Number("")` is 0 and finite. Every other terrain setting in .env.example
 *   ships as an empty line, so an empty value has to mean "unset" and not
 *   "zero". This is the same coercion trap numbers.ts exists to centralise.
 * - A value that is not a number at all must not become NaN and disappear into
 *   a comparison. It falls back to the advertised figure and reports a warning
 *   for the caller to log, because a silently ignored setting is a setting
 *   somebody believes is in effect.
 * - "none" is the deliberate opt out: quote no figure anywhere one has not been
 *   measured. It has to be distinguishable from "unset", which is why it is a
 *   word rather than a 0.
 *
 * @param {string | undefined | null} raw
 * @returns {{ rmseZ: number | null, warning: string | null }}
 */
export function parseFallbackRmseZ(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { rmseZ: TYPICAL_RMSE_Z, warning: null };
  if (text.toLowerCase() === "none") return { rmseZ: null, warning: null };

  const value = Number(text);
  if (Number.isFinite(value) && value > 0) return { rmseZ: value, warning: null };

  return {
    rmseZ: TYPICAL_RMSE_Z,
    warning:
      `PORTAL_SURVEY_RMSE_Z="${text}" is not a positive number of metres or "none". Falling ` +
      `back to the advertised ${TYPICAL_RMSE_Z} m, which is only ever shown as typical.`,
  };
}

/**
 * The ± band that may be printed against an individual number.
 *
 * Null unless the figure was measured. This is the whole honesty rule in one
 * function: "123.45 m ±4 cm" in a table row has nowhere to carry "but that is
 * the company's typical figure, not this survey's", so where the qualifier
 * cannot travel with the number the band is omitted and the panel states the
 * position in prose instead.
 *
 * @param {SurveyAccuracy | null | undefined} accuracy
 * @returns {number | null}
 */
export function accuracyBand(accuracy) {
  return accuracy && accuracy.measured ? accuracy.rmseZ : null;
}

/**
 * How a derived ± band — a volume's `rmseZ × area`, say — must be described.
 *
 * A volume is quoted as "12,400 ±400 m³" and the band is large enough that
 * dropping it would be worse than qualifying it, so unlike `accuracyBand` this
 * does not withhold the number. It insists on the qualifier instead: the band on
 * an unmeasured survey is an estimate built from a typical figure and the
 * sentence says so.
 *
 * @param {SurveyAccuracy | null | undefined} accuracy
 * @param {string} over Human description of the area, e.g. "1.24 ha".
 * @returns {string} A clause beginning with a space-less lead-in, or "".
 */
export function bandClause(accuracy, over) {
  if (!accuracy || accuracy.rmseZ === null) return "";
  const band = `±${centimetres(accuracy.rmseZ)}`;
  if (accuracy.measured) {
    return `The ± band is this survey's own measured ${band} vertical accuracy across ${over}.`;
  }
  return (
    `The ± band is Sudaan's typical ${band} vertical accuracy across ${over}. This survey has ` +
    `no checkpoint report, so treat that band as indicative rather than measured.`
  );
}

/** 0.04 as "4 cm", 0.035 as "3.5 cm". Never rounds a 3.5 down to a flattering 3. */
export function centimetres(metres) {
  const cm = metres * 100;
  return `${Number.isInteger(cm) ? cm.toFixed(0) : cm.toFixed(1)} cm`;
}

/** @param {AccuracyBasis} basis */
function basisWord(basis) {
  return basis === "ci95" ? "at 95% confidence" : "RMSE";
}

/**
 * The sentence for a survey that does have a report.
 *
 * Built from whatever provenance the row carries rather than assuming all of it:
 * the database requires basis, checkpoint count and date together, but the seed
 * store and any future backend may not, and a missing clause must shorten the
 * sentence rather than print "against null checkpoints".
 *
 * @param {SiteVerticalAccuracy} a
 */
function measuredStatement(a) {
  const parts = [
    `Vertical accuracy ±${centimetres(a.rmseZ)} ${basisWord(a.basis)}, measured for this survey`,
  ];
  if (a.checkpoints) parts.push(` against ${a.checkpoints} independent checkpoints`);
  if (a.assessedOn) parts.push(` on ${formatDate(a.assessedOn)}`);
  let sentence = `${parts.join("")}.`;
  if (a.method) sentence += ` ${trimFullStop(a.method)}.`;
  if (a.source) sentence += ` Stated in ${trimFullStop(a.source)}.`;
  return sentence;
}

/**
 * An ISO date as "12 March 2026".
 *
 * Locale and time zone are both pinned. This string is rendered on the server
 * for the project summary and in the browser for the measurement panels, and an
 * unpinned time zone shifts an accuracy date by a day between the two, which
 * React reports as a hydration mismatch and a reader reports as the portal
 * disagreeing with itself.
 *
 * @param {string} iso
 */
function formatDate(iso) {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** @param {string} text */
function trimFullStop(text) {
  return text.trim().replace(/\.+$/, "");
}
