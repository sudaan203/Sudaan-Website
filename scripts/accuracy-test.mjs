/**
 * What the portal is allowed to say about a survey's vertical accuracy.
 *
 * These are honesty tests rather than arithmetic tests, and they exist because
 * the failure they guard against is invisible on screen: "±4 cm" beside a level
 * looks identical whether it came from that survey's checkpoint report or from
 * the company's brochure. It came from the brochure, on every survey, for the
 * whole life of the portal, while the wording said the opposite.
 *
 * So the thing under test is not a number. It is the pairing of a number with a
 * claim about where it came from, and the invariant is one sentence: **a figure
 * we did not measure is never presented as one we did.**
 *
 * Run:
 *   node scripts/accuracy-test.mjs
 *
 * The last block applies drizzle/ to a throwaway Postgres and checks the
 * constraints actually refuse a bare number. It needs PGlite, which is not a
 * project dependency, and is skipped with a note when it is not installed:
 *   npm install --no-save @electric-sql/pglite
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  TYPICAL_RMSE_Z,
  accuracyBand,
  bandClause,
  centimetres,
  parseFallbackRmseZ,
  resolveAccuracy,
} from "../src/lib/portal/accuracy.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

/** A survey whose checkpoint report we actually hold. */
const REPORTED = {
  rmseZ: 0.031,
  basis: "rmse",
  checkpoints: 27,
  assessedOn: "2026-03-12",
  method: "27 DGPS checkpoints, independent of the control network",
  source: "Kotba topographic survey report, section 4",
};

/**
 * Phrases that assert this survey was checked. None of them may appear in
 * anything the portal says about a survey that was not.
 *
 * Written as a list rather than as one assertion per test because the failure
 * mode is somebody adding a fourth branch of wording months from now, and the
 * list catches that branch without anyone remembering to write a test for it.
 */
const CLAIMS_MEASUREMENT = [
  "measured for this survey",
  "this survey's own",
  "the survey's own",
  "its own checkpoint report",
];

const claimsMeasurement = (text) =>
  CLAIMS_MEASUREMENT.filter((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));

// ---------------------------------------------------------------------------
console.log("\nA survey with a checkpoint report reports its own figure");
// ---------------------------------------------------------------------------
{
  const a = resolveAccuracy(REPORTED, TYPICAL_RMSE_Z);

  check("provenance is measured", a.provenance === "measured", a.provenance);
  check("measured flag is set", a.measured === true);
  check(
    "the figure is the survey's, not the configured fallback",
    a.rmseZ === 0.031,
    `${a.rmseZ} m, fallback was ${TYPICAL_RMSE_Z} m`,
  );
  check("the basis travels with it", a.basis === "rmse");
  check("so does the checkpoint count", a.checkpoints === 27);
  check(
    "the statement says it was measured for this survey",
    a.statement.includes("measured for this survey"),
    a.statement,
  );
  check(
    "and says what against, and when",
    a.statement.includes("27 independent checkpoints") && a.statement.includes("12 March 2026"),
    a.statement,
  );
  check(
    "and names the document it can be read out of",
    a.statement.includes("Kotba topographic survey report"),
  );
  check("the ± band may be printed against a number", accuracyBand(a) === 0.031);

  /*
   * RMSE and a 95% interval differ by about 1.96x. Quoting one as the other is
   * the difference between "typically within 3 cm" and "within 3 cm nineteen
   * times out of twenty", and a contractor plans to the second.
   */
  const ci = resolveAccuracy({ ...REPORTED, basis: "ci95" }, TYPICAL_RMSE_Z);
  check(
    "a 95% interval is not described as an RMSE",
    ci.statement.includes("at 95% confidence") && !ci.statement.includes("RMSE"),
    ci.statement,
  );
}

// ---------------------------------------------------------------------------
console.log("\nA survey with no report falls back, and says so");
// ---------------------------------------------------------------------------
{
  const a = resolveAccuracy(null, TYPICAL_RMSE_Z);

  check("provenance is typical", a.provenance === "typical", a.provenance);
  check("measured flag is NOT set", a.measured === false);
  check("the fallback figure is what gets used", a.rmseZ === TYPICAL_RMSE_Z, `${a.rmseZ} m`);
  check(
    "the statement says plainly that it was not measured",
    a.statement.includes("has not been measured"),
    a.statement,
  );
  check(
    "and names it as Sudaan's typical figure, not this survey's",
    a.statement.includes("typical") && a.statement.includes("not a result for this ground"),
    a.statement,
  );
  check("and says what to do next", a.statement.includes("Ask us for the checkpoint report"));
  check(
    "it claims no measurement anywhere in its wording",
    claimsMeasurement(a.statement).length === 0,
    claimsMeasurement(a.statement).join(", "),
  );

  /*
   * The core of the fix. A "±4 cm" in a table row or a hover readout has nowhere
   * to carry the qualifier, so where the qualifier cannot travel with the number
   * the number does not appear either.
   */
  check("no ± band may be printed against an individual number", accuracyBand(a) === null);

  // No provenance and no fallback at all: PORTAL_SURVEY_RMSE_Z=none.
  const silent = resolveAccuracy(null, null);
  check("with no fallback configured, provenance is none", silent.provenance === "none");
  check("and there is no figure at all", silent.rmseZ === null);
  check("and still no band", accuracyBand(silent) === null);
  check(
    "and the wording states that nothing is claimed",
    silent.statement.includes("no vertical accuracy is stated") &&
      claimsMeasurement(silent.statement).length === 0,
    silent.statement,
  );
}

// ---------------------------------------------------------------------------
console.log("\nThe fallback is never presented as a measurement");
// ---------------------------------------------------------------------------
{
  /*
   * A volume's ± band is the one place the number is kept even when unmeasured:
   * "12,400 m³" with no band reads as good to the cubic metre, which is a worse
   * error than an indicative band. So the band stays and the sentence carries
   * the qualifier instead.
   */
  const measured = bandClause(resolveAccuracy(REPORTED, TYPICAL_RMSE_Z), "1.24 ha");
  const typical = bandClause(resolveAccuracy(null, TYPICAL_RMSE_Z), "1.24 ha");

  check(
    "a measured survey's volume band is described as measured",
    measured.includes("this survey's own measured"),
    measured,
  );
  check(
    "an unmeasured survey's volume band is described as typical",
    typical.includes("Sudaan's typical") && typical.includes("no checkpoint report"),
    typical,
  );
  check(
    "and the unmeasured band never claims to be this survey's",
    claimsMeasurement(typical).length === 0,
    claimsMeasurement(typical).join(", "),
  );
  check(
    "with no figure at all there is no band clause to print",
    bandClause(resolveAccuracy(null, null), "1.24 ha") === "",
  );

  /*
   * Sweep every state at once. This is the invariant the whole task exists for,
   * and asserting it in a loop means a fourth provenance added later is covered
   * the day it is added rather than the day somebody notices.
   */
  const states = [
    ["measured", resolveAccuracy(REPORTED, TYPICAL_RMSE_Z)],
    ["typical", resolveAccuracy(null, TYPICAL_RMSE_Z)],
    ["none", resolveAccuracy(null, null)],
  ];
  const violations = states.filter(
    ([, a]) =>
      !a.measured && (accuracyBand(a) !== null || claimsMeasurement(a.statement).length > 0),
  );
  check(
    "across every state, only a measured survey gets a band or a measurement claim",
    violations.length === 0,
    violations.map(([name]) => name).join(", "),
  );
}

// ---------------------------------------------------------------------------
console.log("\nA figure that cannot be interpreted is not a measurement");
// ---------------------------------------------------------------------------
{
  /*
   * The database refuses these; this is what happens if one reaches the code
   * anyway, through the seed store, a hand edited row, or a backend written
   * after this one. Degrading to the fallback is the safe direction: the client
   * is told less than we know, never more.
   */
  const bad = [
    ["a figure with no basis", { rmseZ: 0.04 }],
    ["a figure with an unknown basis", { rmseZ: 0.04, basis: "vibes" }],
    ["a zero figure", { rmseZ: 0, basis: "rmse" }],
    ["a negative figure", { rmseZ: -0.04, basis: "rmse" }],
    ["a non numeric figure", { rmseZ: "0.04", basis: "rmse" }],
    ["a NaN figure", { rmseZ: Number.NaN, basis: "rmse" }],
  ];
  for (const [label, row] of bad) {
    const a = resolveAccuracy(row, TYPICAL_RMSE_Z);
    check(`${label} is not reported as measured`, a.measured === false, a.provenance);
  }

  // Provenance the constraint requires but a lesser backend might not carry.
  const sparse = resolveAccuracy({ rmseZ: 0.05, basis: "rmse" }, TYPICAL_RMSE_Z);
  check(
    "a measured figure missing its checkpoint count still reports, without inventing one",
    sparse.measured === true &&
      !sparse.statement.includes("null") &&
      !sparse.statement.includes("undefined"),
    sparse.statement,
  );
}

// ---------------------------------------------------------------------------
console.log("\nReading the configured fallback");
// ---------------------------------------------------------------------------
{
  /*
   * `Number("")` is 0 and finite, and every other terrain setting in
   * .env.example ships as an empty line, so an empty value that meant "zero"
   * would silently switch the whole portal to quoting nothing. Same coercion
   * trap as numbers.ts.
   */
  const cases = [
    ["unset", undefined, TYPICAL_RMSE_Z, false],
    ["empty", "", TYPICAL_RMSE_Z, false],
    ["whitespace", "   ", TYPICAL_RMSE_Z, false],
    ["a value", "0.025", 0.025, false],
    ["none", "none", null, false],
    ["NONE, any case", "NONE", null, false],
    ["zero", "0", TYPICAL_RMSE_Z, true],
    ["negative", "-1", TYPICAL_RMSE_Z, true],
    ["nonsense", "four centimetres", TYPICAL_RMSE_Z, true],
  ];
  for (const [label, raw, expected, warns] of cases) {
    const got = parseFallbackRmseZ(raw);
    check(
      `${label} resolves to ${expected === null ? "no figure" : `${expected} m`}`,
      got.rmseZ === expected,
      String(got.rmseZ),
    );
    if (warns) {
      check(`${label} is warned about rather than used`, got.warning !== null, got.warning ?? "");
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\nFormatting");
// ---------------------------------------------------------------------------
{
  check("0.04 m reads as 4 cm", centimetres(0.04) === "4 cm", centimetres(0.04));
  check(
    "0.035 m is not rounded down to a flattering 3 cm",
    centimetres(0.035) === "3.5 cm",
    centimetres(0.035),
  );
  /*
   * The date is rendered on the server for the project summary and in the
   * browser for the measurement panels. An unpinned time zone shifts it by a day
   * between the two, which React calls a hydration mismatch and a client calls
   * the portal contradicting itself.
   */
  const a = resolveAccuracy({ ...REPORTED, assessedOn: "2026-01-01" }, null);
  check(
    "an accuracy date does not drift across time zones",
    a.statement.includes("1 January 2026"),
    a.statement,
  );
}

// ---------------------------------------------------------------------------
console.log("\nThe migration, applied to a throwaway database");
// ---------------------------------------------------------------------------
{
  let PGlite = null;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    console.log(
      "  ..  skipped, PGlite is not installed. npm install --no-save @electric-sql/pglite",
    );
  }

  if (PGlite) {
    const db = await PGlite.create();
    const dir = path.join(process.cwd(), "drizzle");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let applied = null;
    try {
      for (const file of files) await db.exec(readFileSync(path.join(dir, file), "utf8"));
    } catch (error) {
      applied = error;
    }
    check(
      `every migration in drizzle/ applies cleanly — ${files.join(", ")}`,
      applied === null,
      applied ? applied.message : "",
    );

    if (applied === null) {
      await db.exec(`
        insert into clients (id, slug, name)
        values ('11111111-1111-4111-8111-111111111111', 'c', 'Client');
      `);
      const site = async (extra) =>
        db.exec(
          `insert into sites (client_id, slug, name${extra.cols})
           values ('11111111-1111-4111-8111-111111111111', '${extra.slug}', 'S'${extra.vals});`,
        );

      /*
       * The state of every survey published so far, and the reason the column is
       * nullable: no report means no figure, not a default.
       */
      let err = null;
      try {
        await site({ slug: "unmeasured", cols: "", vals: "" });
      } catch (error) {
        err = error;
      }
      check("a site may be published with no accuracy recorded", err === null, err?.message ?? "");

      const bare = await (async () => {
        try {
          await site({
            slug: "bare",
            cols: ", vertical_rmse_z_m",
            vals: ", 0.040",
          });
          return null;
        } catch (error) {
          return error;
        }
      })();
      check(
        "a bare number with no provenance is REFUSED",
        bare !== null && /vertical_accuracy_has_provenance/.test(bare.message),
        bare ? bare.message.split("\n")[0] : "it was accepted",
      );

      const orphan = await (async () => {
        try {
          await site({
            slug: "orphan",
            cols: ", vertical_accuracy_checkpoints",
            vals: ", 27",
          });
          return null;
        } catch (error) {
          return error;
        }
      })();
      check(
        "provenance with no figure behind it is REFUSED",
        orphan !== null && /vertical_accuracy_needs_figure/.test(orphan.message),
        orphan ? orphan.message.split("\n")[0] : "it was accepted",
      );

      const junkBasis = await (async () => {
        try {
          await site({
            slug: "junk",
            cols:
              ", vertical_rmse_z_m, vertical_accuracy_basis, vertical_accuracy_checkpoints," +
              " vertical_accuracy_assessed_on",
            vals: ", 0.040, 'about right', 27, date '2026-03-12'",
          });
          return null;
        } catch (error) {
          return error;
        }
      })();
      check(
        "an unrecognised basis is REFUSED",
        junkBasis !== null && /vertical_accuracy_basis_known/.test(junkBasis.message),
        junkBasis ? junkBasis.message.split("\n")[0] : "it was accepted",
      );

      let good = null;
      try {
        await site({
          slug: "measured",
          cols:
            ", vertical_rmse_z_m, vertical_accuracy_basis, vertical_accuracy_checkpoints," +
            " vertical_accuracy_assessed_on, vertical_accuracy_method, vertical_accuracy_source",
          vals: ", 0.031, 'rmse', 27, date '2026-03-12', 'DGPS checkpoints', 'Report s4'",
        });
      } catch (error) {
        good = error;
      }
      check("a complete checkpoint result is accepted", good === null, good?.message ?? "");

      /*
       * The one assertion that catches somebody "helpfully" backfilling the
       * advertised figure in a later migration. Every existing row must still
       * read as unmeasured after the whole of drizzle/ has run.
       */
      const backfilled = await db.query(
        "select count(*)::int as n from sites where vertical_rmse_z_m is not null and slug <> 'measured'",
      );
      check(
        "no migration backfills an accuracy onto an existing site",
        backfilled.rows[0].n === 0,
        `${backfilled.rows[0].n} row(s) carry a figure they were given by a migration`,
      );

      // And the round trip the store makes: numeric arrives as a string.
      const read = await db.query(
        "select vertical_rmse_z_m, vertical_accuracy_basis from sites where slug = 'measured'",
      );
      const row = read.rows[0];
      check(
        "numeric comes back as a string, so the store must coerce it",
        typeof row.vertical_rmse_z_m === "string" && Number(row.vertical_rmse_z_m) === 0.031,
        `${typeof row.vertical_rmse_z_m} ${row.vertical_rmse_z_m}`,
      );
      check(
        "and it survives the round trip as a measurement",
        resolveAccuracy(
          {
            rmseZ: Number(row.vertical_rmse_z_m),
            basis: row.vertical_accuracy_basis,
            checkpoints: 27,
            assessedOn: "2026-03-12",
          },
          TYPICAL_RMSE_Z,
        ).measured === true,
      );
    }

    await db.close();
  }
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
