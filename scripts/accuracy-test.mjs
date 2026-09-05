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

// ---------------------------------------------------------------------------
console.log("\nRecording a checkpoint report with scripts/portal-survey-accuracy.mjs");
// ---------------------------------------------------------------------------
/*
 * The migration made the honest state possible; this script is what gets a
 * survey out of it. So the thing under test is not that the tool writes a row —
 * it is that every way of writing a WRONG row is refused in words, before the
 * constraint, and that the row it does write reads back through resolveAccuracy
 * as a measurement.
 *
 * Driven through the exported `run()` against PGlite rather than by spawning the
 * CLI: the same code path, the same SQL, no server, and no possibility of a test
 * finding a DATABASE_URL and touching a real database.
 */
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
    const { run, parseArgs, validateSet } = await import("./portal-survey-accuracy.mjs");

    const db = await PGlite.create();
    const dir = path.join(process.cwd(), "drizzle");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(path.join(dir, file), "utf8"));
    }

    const ALPHA = "a1111111-1111-4111-8111-111111111111";
    const BETA = "b2222222-2222-4222-8222-222222222222";
    await db.exec(`
      insert into clients (id, slug, name) values
        ('${ALPHA}', 'alpha', 'Alpha Infra'),
        ('${BETA}',  'beta',  'Beta Mining');
      insert into sites (client_id, slug, name) values
        ('${ALPHA}', 'kotba-survey', 'Kotba'),
        ('${ALPHA}', 'shared',       'Alpha shared'),
        ('${BETA}',  'shared',       'Beta shared');
      insert into surveys (site_id, label, flown_on)
        select id, 'Flight 1', date '2026-02-20' from sites where slug = 'kotba-survey';
    `);

    /** The adapter the CLI builds over postgres.js, built here over PGlite. */
    const tool = { query: async (text, params = []) => (await db.query(text, params)).rows };

    /** Run the tool and collect what a person would have seen. */
    const call = async (argv) => {
      const out = [];
      const err = [];
      const code = await run(tool, argv, {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        fallbackRmseZ: TYPICAL_RMSE_Z,
        // Pinned so "is this date in the future" does not depend on the day the suite runs.
        today: "2026-09-05",
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };

    const kotba = async () =>
      (
        await db.query(
          `select vertical_rmse_z_m, vertical_accuracy_basis, vertical_accuracy_checkpoints,
                  to_char(vertical_accuracy_assessed_on, 'YYYY-MM-DD') as assessed_on,
                  vertical_accuracy_method, vertical_accuracy_source
             from sites where slug = 'kotba-survey'`,
        )
      ).rows[0];

    const COMPLETE = [
      "set", "kotba-survey",
      "--rmse", "0.031",
      "--checkpoints", "27",
      "--assessed-on", "2026-03-12",
      "--method", "27 DGPS checkpoints, independent of the control network",
      "--source", "Kotba topographic survey report, section 4",
    ];
    /** COMPLETE with one flag dropped, for the "the tool refuses first" sweep. */
    const without = (flag) => {
      const i = COMPLETE.indexOf(flag);
      return [...COMPLETE.slice(0, i), ...COMPLETE.slice(i + 2)];
    };

    // -- The basis cannot be skipped -----------------------------------------
    /*
     * The single most important property of this tool. A --value flag, or a
     * --basis flag that could be forgotten, recreates the original bug in a new
     * place: a number recorded now and interpreted later, wrong, by somebody
     * quoting it to a contractor.
     */
    {
      const noBasis = await call(without("--rmse"));
      check(
        "a figure with no --rmse or --ci95 is refused",
        noBasis.code === 1 && /--rmse|--ci95/.test(noBasis.err),
        noBasis.err.split("\n")[0],
      );
      check(
        "and the refusal explains that the two differ by about 1.96x",
        /1\.96/.test(noBasis.err),
        noBasis.err.split("\n")[0],
      );

      const bothWays = await call([...COMPLETE, "--ci95", "0.061"]);
      check(
        "giving both --rmse and --ci95 is refused rather than one silently winning",
        bothWays.code === 1 && /not both/.test(bothWays.err),
        bothWays.err.split("\n")[0],
      );

      const habit = parseArgs(["set", "s", "--basis", "rmse", "--value", "0.04"]);
      check(
        "--basis and --value do not exist, and say what to use instead",
        habit.errors.length === 2 && habit.errors.every((e) => /--rmse 0\.031/.test(e)),
        habit.errors.join(" | "),
      );
      check(
        "--rmse and --ci95 land on different bases, not on a shared default",
        validateSet(parseArgs(["set", "s", "--rmse", "0.04"])).values.vertical_accuracy_basis ===
          "rmse" &&
          validateSet(parseArgs(["set", "s", "--ci95", "0.04"])).values.vertical_accuracy_basis ===
            "ci95",
      );
    }

    // -- Everything the constraint would refuse is refused earlier, in words --
    /*
     * "Fails before the constraint" is the requirement, and the way to test it
     * is that the message names a flag and never a constraint: a person reading
     * `sites_vertical_accuracy_has_provenance` learns nothing they can act on.
     */
    {
      const refusals = [
        ["a figure with no --checkpoints", without("--checkpoints"), "--checkpoints"],
        ["a figure with no --assessed-on", without("--assessed-on"), "--assessed-on"],
        ["an empty --rmse, which Number() would read as a finite 0", ["set", "kotba-survey", "--rmse", "", "--checkpoints", "27", "--assessed-on", "2026-03-12"], "--rmse"],
        ["a non numeric --rmse", ["set", "kotba-survey", "--rmse", "four cm", "--checkpoints", "27", "--assessed-on", "2026-03-12"], "--rmse"],
        ["--checkpoints 0", ["set", "kotba-survey", "--rmse", "0.031", "--checkpoints", "0", "--assessed-on", "2026-03-12"], "--checkpoints"],
        ["a date that does not exist", ["set", "kotba-survey", "--rmse", "0.031", "--checkpoints", "27", "--assessed-on", "2026-02-31"], "--assessed-on"],
        ["a date in the future", ["set", "kotba-survey", "--rmse", "0.031", "--checkpoints", "27", "--assessed-on", "2027-01-01"], "--assessed-on"],
      ];
      for (const [label, argv, flag] of refusals) {
        const r = await call(argv);
        check(
          `${label} is refused`,
          r.code === 1 && r.err.includes(flag) && !/constraint/i.test(r.err),
          r.err.split("\n")[0],
        );
      }

      /*
       * Centimetres typed into a metres field. The database accepts 3.1 happily
       * — numeric(6,3) has room for it — and the portal would print "±310 cm"
       * beside every level without anything looking broken.
       */
      const cm = await call(["set", "kotba-survey", "--rmse", "3.1", "--checkpoints", "27", "--assessed-on", "2026-03-12"]);
      check(
        "a figure in centimetres is refused, with the metres value to use",
        cm.code === 1 && cm.err.includes("0.031"),
        cm.err.split("\n")[0],
      );

      check(
        "no refusal wrote anything: the site is still unmeasured",
        (await kotba()).vertical_rmse_z_m === null,
      );
    }

    // -- assessed_on is not the flight date ----------------------------------
    {
      const flightDate = await call([
        "set", "kotba-survey", "--rmse", "0.031", "--checkpoints", "27",
        "--assessed-on", "2026-01-05",
      ]);
      check(
        "an assessment dated before the site's last flight is refused",
        flightDate.code === 1 && flightDate.err.includes("2026-02-20"),
        flightDate.err.split("\n")[0],
      );
      check("and it wrote nothing", (await kotba()).vertical_rmse_z_m === null);

      const dry = await call([...COMPLETE, "--dry-run"]);
      check(
        "the flight dates are shown next to the date being recorded",
        dry.out.includes("2026-02-20") && dry.out.includes("2026-03-12"),
        (dry.out.split("\n").find((l) => l.startsWith("  Flown")) ?? "").trim(),
      );
    }

    // -- Dry run -------------------------------------------------------------
    {
      const dry = await call([...COMPLETE, "--dry-run"]);
      check(
        "--dry-run reports what the portal would then say",
        dry.code === 0 && dry.out.includes("Would be") && dry.out.includes("measured for this survey"),
        (dry.out.split("\n").find((l) => l.includes("Would be")) ?? "").trim(),
      );
      check("--dry-run writes nothing", (await kotba()).vertical_rmse_z_m === null);
    }

    // -- The happy path ------------------------------------------------------
    {
      const set = await call(COMPLETE);
      check("a complete checkpoint report is recorded", set.code === 0, set.err);

      const row = await kotba();
      check("the figure is stored to the millimetre", Number(row.vertical_rmse_z_m) === 0.031, String(row.vertical_rmse_z_m));
      check("the basis is stored as rmse", row.vertical_accuracy_basis === "rmse");
      check("the checkpoint count is stored", row.vertical_accuracy_checkpoints === 27);
      check("the assessment date is stored, and is not the flight date", row.assessed_on === "2026-03-12", row.assessed_on);
      check("the method is stored as written", row.vertical_accuracy_method?.startsWith("27 DGPS"), row.vertical_accuracy_method ?? "");
      check("the source names a document", row.vertical_accuracy_source?.includes("section 4"), row.vertical_accuracy_source ?? "");

      /*
       * The loop this task exists to close: what the tool wrote is what the
       * portal reads, and what the portal reads is a measurement.
       */
      const shown = resolveAccuracy(
        {
          rmseZ: Number(row.vertical_rmse_z_m),
          basis: row.vertical_accuracy_basis,
          checkpoints: row.vertical_accuracy_checkpoints,
          assessedOn: row.assessed_on,
          method: row.vertical_accuracy_method,
          source: row.vertical_accuracy_source,
        },
        TYPICAL_RMSE_Z,
      );
      check("and the portal now reports it as measured for this survey", shown.measured === true, shown.provenance);
      check("with the survey's figure, not the company's", shown.rmseZ === 0.031 && shown.rmseZ !== TYPICAL_RMSE_Z);
      check("and a ± band may now be printed against a number", accuracyBand(shown) === 0.031);

      const showOne = await call(["show", "kotba-survey"]);
      check(
        "show prints the portal's own wording back",
        showOne.out.includes(shown.label),
        shown.label,
      );

      // Re-recording, e.g. after a reprocess: a new figure with a new date.
      const again = await call([
        "set", "kotba-survey", "--ci95", "0.061", "--checkpoints", "31",
        "--assessed-on", "2026-08-01", "--source", "Reprocessed model, report rev B",
      ]);
      const reassessed = await kotba();
      check(
        "a reassessment replaces the figure and its basis together",
        again.code === 0 &&
          reassessed.vertical_accuracy_basis === "ci95" &&
          Number(reassessed.vertical_rmse_z_m) === 0.061 &&
          reassessed.assessed_on === "2026-08-01",
        `${reassessed.vertical_accuracy_basis} ${reassessed.vertical_rmse_z_m} ${reassessed.assessed_on}`,
      );
      check(
        "and the replaced method is not left behind describing the old check",
        reassessed.vertical_accuracy_method === null,
        reassessed.vertical_accuracy_method ?? "null",
      );
      const figureLine = again.out.split("\n").find((l) => l.startsWith("  Figure")) ?? "";
      check(
        "a 95% interval is described as one, never as an RMSE",
        figureLine.includes("95% confidence interval") && !figureLine.includes("RMSE"),
        figureLine,
      );
      check(
        "a missing --method is noted rather than passed over",
        again.out.includes("No --method given"),
        again.out.split("\n").find((l) => l.startsWith("Note:")) ?? "no note printed",
      );
    }

    // -- Clearing ------------------------------------------------------------
    {
      const dry = await call(["clear", "kotba-survey", "--dry-run"]);
      check("clear --dry-run writes nothing", dry.code === 0 && (await kotba()).vertical_rmse_z_m !== null);

      const cleared = await call(["clear", "kotba-survey"]);
      const row = await kotba();
      check("clear removes the figure", cleared.code === 0 && row.vertical_rmse_z_m === null);
      check(
        "and every field of its provenance with it, so no orphan survives the constraint",
        row.vertical_accuracy_basis === null &&
          row.vertical_accuracy_checkpoints === null &&
          row.assessed_on === null &&
          row.vertical_accuracy_method === null &&
          row.vertical_accuracy_source === null,
      );
      check(
        "and the portal goes back to saying it was not measured",
        resolveAccuracy(null, TYPICAL_RMSE_Z).label.includes("not measured for this survey"),
      );

      const twice = await call(["clear", "kotba-survey"]);
      check("clearing a site with nothing recorded is not an error", twice.code === 0, twice.err);
    }

    // -- Picking the right site ----------------------------------------------
    /*
     * Slugs are unique per client, not globally. Putting one client's checkpoint
     * report on another client's survey is the worst outcome available here, so
     * the ambiguity is an error rather than a first match.
     */
    {
      const ambiguous = await call(["set", "shared", "--rmse", "0.031", "--checkpoints", "27", "--assessed-on", "2026-03-12"]);
      check(
        "a slug held by two clients is refused, not resolved to the first",
        ambiguous.code === 1 && ambiguous.err.includes("--client"),
        ambiguous.err.split("\n")[0],
      );

      const picked = await call(["set", "shared", "--client", "beta", "--rmse", "0.031", "--checkpoints", "27", "--assessed-on", "2026-03-12"]);
      const rows = (
        await db.query(
          `select c.slug as client, s.vertical_rmse_z_m from sites s join clients c on c.id = s.client_id
            where s.slug = 'shared' order by c.slug`,
        )
      ).rows;
      check(
        "--client writes to exactly one of them",
        picked.code === 0 && rows[0].vertical_rmse_z_m === null && rows[1].vertical_rmse_z_m !== null,
        rows.map((r) => `${r.client}=${r.vertical_rmse_z_m}`).join(" "),
      );

      const missing = await call(["set", "no-such-site", "--rmse", "0.031", "--checkpoints", "27", "--assessed-on", "2026-03-12"]);
      check("an unknown slug is an error, not a silent no-op", missing.code === 1 && /no site/i.test(missing.err), missing.err.split("\n")[0]);
    }

    // -- show ----------------------------------------------------------------
    {
      const all = await call(["show"]);
      check(
        "show with no site lists every site",
        all.code === 0 && all.out.includes("alpha/kotba-survey") && all.out.includes("beta/shared"),
        all.out.split("\n")[0],
      );
      check(
        "and counts the ones still carrying no checkpoint report",
        all.out.includes("2 of 3 site(s) have no checkpoint report"),
        all.out.split("\n").at(-1) ?? "",
      );
      check(
        "an unmeasured site is shown with the qualified wording, never a bare figure",
        all.out.includes("typical, not measured for this survey"),
        (all.out.split("\n").find((l) => l.includes("Portal says")) ?? "").trim(),
      );
    }

    await db.close();
  }
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);
