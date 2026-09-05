#!/usr/bin/env node
/**
 * Records, shows and clears a survey's own measured vertical accuracy.
 *
 * ## Why this script exists
 *
 * drizzle/0003_survey_accuracy.sql took "±4 cm" off every elevation in the
 * portal and replaced it, where nothing has been measured, with a sentence that
 * says so. That is honest but it is only half a fix: all three sites read null,
 * and until there is a way to put a real checkpoint report into the database
 * they will keep reading null, and the portal will keep telling clients we have
 * not measured surveys we have in fact measured. This is that way.
 *
 * ## What it insists on, and why
 *
 * The database refuses a figure that arrives without its basis, its checkpoint
 * count and its assessment date. This script refuses the same things earlier and
 * says what to do about it, because a check constraint violation printed by the
 * driver names a constraint and not a mistake.
 *
 * Two of those are easy to get wrong in a way nothing downstream can detect:
 *
 *   basis        RMSE(z) and a 95% confidence interval differ by about 1.96x.
 *                So there is no --value flag and no --basis flag: the figure is
 *                carried BY --rmse or BY --ci95, and typing a number without
 *                saying which one it is is not expressible. A --value flag would
 *                let somebody paste "0.04" out of a report and decide later
 *                which it was, which is exactly how a 4 cm RMSE gets quoted to a
 *                contractor as a 4 cm worst case.
 *
 *   assessed-on  is NOT the flight date. A model reprocessed a year later has a
 *                new accuracy figure against the same flight. The tool prints
 *                the site's flight dates next to the date you gave and refuses a
 *                date before the last flight, so the mix-up shows up here rather
 *                than as a plausible looking date in front of a client.
 *
 * ## Usage
 *
 *   DATABASE_URL=postgres://... node scripts/portal-survey-accuracy.mjs show
 *   DATABASE_URL=postgres://... node scripts/portal-survey-accuracy.mjs show kotba-survey
 *
 *   DATABASE_URL=postgres://... node scripts/portal-survey-accuracy.mjs set kotba-survey \
 *     --rmse 0.031 --checkpoints 27 --assessed-on 2026-03-12 \
 *     --method "27 DGPS checkpoints, independent of the control network" \
 *     --source "Kotba topographic survey report, section 4"
 *
 *   DATABASE_URL=postgres://... node scripts/portal-survey-accuracy.mjs clear kotba-survey
 *
 * --dry-run on any of them prints what would change and writes nothing.
 *
 * The pure functions and `run()` are exported so scripts/accuracy-test.mjs can
 * drive the whole tool against a throwaway PGlite database. Nothing outside
 * main() reads the environment, so a test never has to set one.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  TYPICAL_RMSE_Z,
  centimetres,
  parseFallbackRmseZ,
  resolveAccuracy,
} from "../src/lib/portal/accuracy.mjs";

export const HELP = `Record a survey's measured vertical accuracy, or show what is recorded.

  show  [<site-slug>]        what the portal will say about one site, or all of them
  set   <site-slug>  ...     record a checkpoint report against a site
  clear <site-slug>          remove a recorded figure, back to "not measured"

Recording a figure. All three of these are required — the database refuses a
figure that arrives without them:

  --rmse <metres>      the figure IS an RMSE(z)          } exactly one of these,
  --ci95 <metres>      the figure IS a 95% interval      } and never both

      RMSE(z) and a 95% confidence interval describe the same survey and differ
      by a factor of about 1.96 — a 3 cm RMSE is roughly a 6 cm 95% interval.
      Read which one your checkpoint report states off the report; do not
      convert one into the other here. Metres, so 3.1 cm is 0.031.

  --checkpoints <n>    how many independent checkpoints the figure was measured
                       against. An RMSE over 5 points and one over 60 are not
                       the same evidence, and "how do you know" is usually
                       asking this.

  --assessed-on <YYYY-MM-DD>
                       when the accuracy was ASSESSED. This is not the flight
                       date — surveys.flown_on already holds that. A model
                       reprocessed a year later has a new figure against the
                       same flight, and dating it to the flight would attach the
                       new number to the old work.

Strongly recommended, and stored as written:

  --method <text>      how it was checked, in the surveyor's words, e.g.
                       "27 DGPS checkpoints, independent of the control network"
  --source <text>      the document the figure can be read out of, so "where
                       does this come from" is answered with a filename

Other flags:

  --client <slug>      pick between sites of the same slug under two clients
  --dry-run            print what would change, write nothing
  --help

Needs DATABASE_URL (or POSTGRES_URL), the same pooled connection string the
migrations use.`;

/** The columns this tool owns. Written and cleared as one set, never singly. */
const FIELDS = [
  "vertical_rmse_z_m",
  "vertical_accuracy_basis",
  "vertical_accuracy_checkpoints",
  "vertical_accuracy_assessed_on",
  "vertical_accuracy_method",
  "vertical_accuracy_source",
];

/*
 * Dates are formatted by Postgres rather than handed to the driver as a date it
 * turns into a JS Date. `new Date("2026-03-12")` is midnight UTC, and printing
 * that with local getters in IST gives 11 March. The portal already had to pin
 * this once (see the time zone check in accuracy-test.mjs); a tool whose whole
 * job is dating a measurement must not reintroduce it one layer down.
 */
const SELECT = `
  select s.id,
         s.slug,
         s.name,
         c.slug as client_slug,
         c.name as client_name,
         s.vertical_rmse_z_m,
         s.vertical_accuracy_basis,
         s.vertical_accuracy_checkpoints,
         to_char(s.vertical_accuracy_assessed_on, 'YYYY-MM-DD') as vertical_accuracy_assessed_on,
         s.vertical_accuracy_method,
         s.vertical_accuracy_source,
         (select string_agg(to_char(flown_on, 'YYYY-MM-DD'), ', ' order by flown_on)
            from surveys where site_id = s.id) as flown_on_dates,
         (select to_char(max(flown_on), 'YYYY-MM-DD')
            from surveys where site_id = s.id) as last_flown_on
    from sites s
    join clients c on c.id = s.client_id`;

/**
 * Parse argv into an intent, without touching a database.
 *
 * Collects every complaint rather than returning at the first, so a wrong
 * invocation is fixed in one go instead of one flag per run.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const errors = [];
  const positional = [];
  /** @type {Record<string, string | true>} */
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (eq >= 0) {
      flags[name] = arg.slice(eq + 1);
    } else if (name === "dry-run" || name === "help") {
      flags[name] = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`--${name} needs a value.`);
        flags[name] = "";
      } else {
        flags[name] = next;
        i += 1;
      }
    }
  }

  const known = new Set([
    "rmse",
    "ci95",
    "checkpoints",
    "assessed-on",
    "method",
    "source",
    "client",
    "dry-run",
    "help",
  ]);
  for (const name of Object.keys(flags)) {
    if (known.has(name)) continue;
    // The flags somebody will reach for by habit, and why they deliberately do not exist.
    if (name === "basis" || name === "value" || name === "accuracy") {
      errors.push(
        `There is no --${name}. The figure is carried by the flag that says what it is: ` +
          `--rmse 0.031 or --ci95 0.061. The two differ by about 1.96x, so a number on its own ` +
          `cannot be quoted safely and this tool will not store one.`,
      );
    } else {
      errors.push(`Unknown flag --${name}.`);
    }
  }

  const command = positional[0] ?? (flags.help ? "help" : null);
  const site = positional[1] ?? null;
  if (positional.length > 2) {
    errors.push(`Unexpected extra argument "${positional[2]}". Quote values that contain spaces.`);
  }

  return {
    command,
    site,
    client: typeof flags.client === "string" ? flags.client : null,
    rmse: typeof flags.rmse === "string" ? flags.rmse : null,
    ci95: typeof flags.ci95 === "string" ? flags.ci95 : null,
    checkpoints: typeof flags.checkpoints === "string" ? flags.checkpoints : null,
    assessedOn: typeof flags["assessed-on"] === "string" ? flags["assessed-on"] : null,
    method: typeof flags.method === "string" ? flags.method : null,
    source: typeof flags.source === "string" ? flags.source : null,
    dryRun: flags["dry-run"] === true,
    help: flags.help === true,
    errors,
  };
}

/**
 * Metres from a flag value.
 *
 * `Number("")` is 0 and finite — the coercion trap numbers.ts exists to
 * centralise. Here it would turn an empty `--rmse` into a zero, which the
 * constraint then rejects with a message about a check constraint rather than
 * about an empty flag.
 */
function metres(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInteger(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}

/**
 * An ISO date, or null.
 *
 * The round trip through `toISOString` is what rejects 2026-02-31, which `Date`
 * otherwise rolls silently forward into March.
 */
function isoDate(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === text ? text : null;
}

/**
 * Turn parsed args into the row that will be written, or into errors.
 *
 * Everything the database constraint would refuse is refused here first, in
 * words that name the flag to fix. The constraint remains the real guard; this
 * is the part that has to be readable at 6pm with a checkpoint report open in
 * another window.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {{ today?: string }} [options]
 */
export function validateSet(args, options = {}) {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const errors = [];
  const notes = [];

  if (args.rmse !== null && args.ci95 !== null) {
    errors.push(
      "Give --rmse or --ci95, not both. They are two different claims about the same survey; " +
        "record the one the checkpoint report states, and do not convert between them here.",
    );
  }
  if (args.rmse === null && args.ci95 === null) {
    errors.push(
      "No figure. Give --rmse <metres> if the report states an RMSE(z), or --ci95 <metres> if " +
        "it states a 95% confidence interval. They differ by about 1.96x, so which one it is " +
        "has to be recorded with it.",
    );
  }

  const basis = args.rmse !== null ? "rmse" : "ci95";
  const raw = args.rmse !== null ? args.rmse : args.ci95;
  const figure = metres(raw);
  if (raw !== null && figure === null) {
    errors.push(`--${basis} "${raw}" is not a positive number of metres. 3.1 cm is 0.031.`);
  } else if (figure !== null && figure >= 1) {
    /*
     * A vertical accuracy of a metre or worse is not something this portal
     * quotes, so a figure that large is almost always centimetres typed into a
     * metres field — and it would store and display without complaint, three
     * decimal places and all.
     */
    errors.push(
      `--${basis} ${figure} is read as metres, and ${figure} m is not a plausible vertical ` +
        `accuracy for a drone survey. If the report says ${figure} cm, pass ${figure / 100}.`,
    );
  } else if (figure !== null && Number(figure.toFixed(3)) !== figure) {
    // numeric(6, 3) stores to the millimetre. Say so rather than rounding in silence.
    notes.push(
      `${figure} m will be stored as ${figure.toFixed(3)} m: the column holds millimetres.`,
    );
  }

  const checkpoints = positiveInteger(args.checkpoints);
  if (args.checkpoints === null) {
    errors.push(
      "No --checkpoints. The database will not store a figure without the number of " +
        "independent checkpoints behind it: an RMSE over 5 points and one over 60 are not the " +
        "same evidence.",
    );
  } else if (checkpoints === null) {
    errors.push(
      `--checkpoints "${args.checkpoints}" is not a whole number of checkpoints above zero.`,
    );
  }

  const assessedOn = isoDate(args.assessedOn);
  if (args.assessedOn === null) {
    errors.push(
      "No --assessed-on. The database will not store a figure without the date it was " +
        "assessed, and that is the date of the CHECK, not of the flight — a model reprocessed a " +
        "year later has a new figure against the same flight.",
    );
  } else if (assessedOn === null) {
    errors.push(`--assessed-on "${args.assessedOn}" is not a real date in YYYY-MM-DD form.`);
  } else if (assessedOn > today) {
    errors.push(`--assessed-on ${assessedOn} is in the future. Today is ${today}.`);
  }

  if (args.method === null) {
    notes.push(
      "No --method given. Nothing enforces it, but it is the sentence a client reads when they " +
        "ask how the check was made.",
    );
  }
  if (args.source === null) {
    notes.push(
      'No --source given. Without it, "where does this number come from" is answered by a ' +
        "person rather than by a filename.",
    );
  }

  return {
    errors,
    notes,
    values: {
      vertical_rmse_z_m: figure,
      vertical_accuracy_basis: basis,
      vertical_accuracy_checkpoints: checkpoints,
      vertical_accuracy_assessed_on: assessedOn,
      vertical_accuracy_method: args.method,
      vertical_accuracy_source: args.source,
    },
  };
}

/** A row's recorded figure in the shape src/lib/portal/accuracy.mjs expects. */
function recordedAccuracy(row) {
  if (row.vertical_rmse_z_m === null || row.vertical_rmse_z_m === undefined) return null;
  return {
    // numeric arrives as a string from both postgres.js and PGlite.
    rmseZ: Number(row.vertical_rmse_z_m),
    basis: row.vertical_accuracy_basis,
    checkpoints: row.vertical_accuracy_checkpoints,
    assessedOn: row.vertical_accuracy_assessed_on,
    method: row.vertical_accuracy_method,
    source: row.vertical_accuracy_source,
  };
}

/**
 * One site, as a block of lines.
 *
 * Leads with the portal's own words rather than a dump of the columns, because
 * the question being answered is always "what does the client see", and a tool
 * that paraphrases that is a second place for the wording to drift.
 */
export function describeSite(row, fallbackRmseZ) {
  const accuracy = resolveAccuracy(recordedAccuracy(row), fallbackRmseZ);
  const lines = [
    `${row.name}  (${row.client_slug}/${row.slug})`,
    `  Portal says   ${accuracy.label}`,
  ];
  if (accuracy.measured) {
    lines.push(
      `  Figure        ${centimetres(accuracy.rmseZ)} ` +
        `(${accuracy.basis === "ci95" ? "95% confidence interval" : "RMSE(z)"}, ` +
        `${row.vertical_rmse_z_m} m stored)`,
      `  Checkpoints   ${accuracy.checkpoints ?? "not recorded"}`,
      `  Assessed on   ${accuracy.assessedOn ?? "not recorded"}`,
      `  Method        ${accuracy.method ?? "not recorded"}`,
      `  Source        ${accuracy.source ?? "not recorded"}`,
    );
  } else {
    lines.push("  Recorded      nothing. Record a checkpoint report with the set command.");
  }
  lines.push(`  Flown         ${row.flown_on_dates ?? "no surveys recorded"}`);
  return lines;
}

/**
 * Load sites, optionally narrowed to one slug and one client.
 *
 * Slugs are unique per client, not globally (`unique (client_id, slug)`), so a
 * bare slug can match two sites. Writing to the first match would put one
 * client's checkpoint report on another client's survey, which is the one
 * mistake here worse than doing nothing — so an ambiguous slug is an error and
 * never a choice made on the caller's behalf.
 *
 * @param {{ query(text: string, params?: unknown[]): Promise<any[]> }} db
 */
export async function loadSites(db, { site = null, client = null } = {}) {
  const where = [];
  const params = [];
  if (site) {
    params.push(site);
    where.push(`s.slug = $${params.length}`);
  }
  if (client) {
    params.push(client);
    where.push(`c.slug = $${params.length}`);
  }
  const text = `${SELECT}${where.length ? `\n   where ${where.join(" and ")}` : ""}\n   order by c.slug, s.slug`;
  return db.query(text, params);
}

const updateAll = `update sites set ${FIELDS.map((f, i) => `${f} = $${i + 2}`).join(", ")} where id = $1`;

/**
 * Run the tool against an already open database.
 *
 * @param {{ query(text: string, params?: unknown[]): Promise<any[]> }} db
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void,
 *           fallbackRmseZ?: number | null, today?: string }} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function run(db, argv, options = {}) {
  const out = options.out ?? ((line) => console.log(line));
  const err = options.err ?? ((line) => console.error(line));
  const fallbackRmseZ =
    options.fallbackRmseZ === undefined ? TYPICAL_RMSE_Z : options.fallbackRmseZ;

  const args = parseArgs(argv);
  if (args.help || args.command === "help") {
    out(HELP);
    return 0;
  }
  if (args.command === null) {
    err(HELP);
    return 1;
  }
  if (args.errors.length) {
    args.errors.forEach(err);
    return 1;
  }
  if (!["show", "set", "clear"].includes(args.command)) {
    err(`Unknown command "${args.command}". Expected show, set or clear.`);
    return 1;
  }
  if (args.command !== "show" && !args.site) {
    err(`${args.command} needs a site slug, for example: ${args.command} kotba-survey`);
    return 1;
  }

  /*
   * Everything a `set` can be refused for that does not need the database is
   * refused before the first query, so a typo in --assessed-on costs no round
   * trip and cannot leave a half applied write behind it.
   */
  const plan = args.command === "set" ? validateSet(args, { today: options.today }) : null;
  if (plan && plan.errors.length) {
    plan.errors.forEach(err);
    err("\nNothing was written.");
    return 1;
  }

  const matches = await loadSites(db, { site: args.site, client: args.client });

  if (args.command === "show") {
    if (matches.length === 0) {
      err(args.site ? `No site with slug "${args.site}".` : "No sites in this database.");
      return 1;
    }
    matches.forEach((row, i) => {
      if (i > 0) out("");
      describeSite(row, fallbackRmseZ).forEach(out);
    });
    const unmeasured = matches.filter((r) => r.vertical_rmse_z_m === null).length;
    if (unmeasured) {
      out(
        `\n${unmeasured} of ${matches.length} site(s) have no checkpoint report recorded, and ` +
          `the portal says so beside every elevation, volume and cross section it shows for them.`,
      );
    }
    return 0;
  }

  if (matches.length === 0) {
    err(`No site with slug "${args.site}"${args.client ? ` under client "${args.client}"` : ""}.`);
    err("Run `show` with no site to list what is in this database.");
    return 1;
  }
  if (matches.length > 1) {
    err(
      `"${args.site}" matches ${matches.length} sites, under clients ` +
        `${matches.map((r) => r.client_slug).join(" and ")}. Add --client <slug> to say which.`,
    );
    return 1;
  }

  const row = matches[0];
  out(`${row.name}  (${row.client_slug}/${row.slug})`);
  out(`  Now           ${resolveAccuracy(recordedAccuracy(row), fallbackRmseZ).label}`);

  if (args.command === "clear") {
    if (row.vertical_rmse_z_m === null) {
      out("  Nothing is recorded against this site, so there is nothing to clear.");
      return 0;
    }
    out(`  ${args.dryRun ? "Would be" : "Becomes"}       ${resolveAccuracy(null, fallbackRmseZ).label}`);
    if (args.dryRun) {
      out("\nDry run, nothing written.");
      return 0;
    }
    /*
     * All six columns in one statement. The constraint pair refuses a figure
     * without provenance AND provenance without a figure, so clearing them one
     * column at a time cannot succeed in any order — that is the constraint
     * doing its job, not an obstacle to route around.
     */
    await db.query(updateAll, [row.id, ...FIELDS.map(() => null)]);
    out("\nCleared. The portal now states that this survey has no checkpoint report.");
    return 0;
  }

  const values = plan.values;
  // What the row will look like, rendered through the portal's own resolver.
  const after = { ...row, ...values, vertical_rmse_z_m: values.vertical_rmse_z_m.toFixed(3) };
  out(
    `  ${args.dryRun ? "Would be" : "Becomes"}       ${resolveAccuracy(recordedAccuracy(after), fallbackRmseZ).label}`,
  );
  out("");
  // slice(2): the name and the resolved label are already printed above.
  describeSite(after, fallbackRmseZ).slice(2).forEach(out);

  /*
   * The flight dates are printed above and compared here rather than only
   * validated, because the mistake this catches is not a malformed date: it is a
   * correct looking date that happens to be the day of the flight. Refusing one
   * that predates the last flight catches the copy-paste; showing the dates
   * beside it catches the rest.
   */
  if (row.last_flown_on && values.vertical_accuracy_assessed_on < row.last_flown_on) {
    err(
      `\n--assessed-on ${values.vertical_accuracy_assessed_on} is before this site's last ` +
        `flight on ${row.last_flown_on}. An accuracy cannot be assessed before the survey it ` +
        `describes was flown, so this is usually a flight date, or the wrong site.`,
    );
    err("\nNothing was written.");
    return 1;
  }

  plan.notes.forEach((note) => out(`\nNote: ${note}`));

  if (args.dryRun) {
    out("\nDry run, nothing written.");
    return 0;
  }

  await db.query(updateAll, [row.id, ...FIELDS.map((f) => values[f])]);
  out("\nRecorded. The portal now quotes this survey's own figure, with its provenance.");
  return 0;
}

/** So `run` sees the same shape from postgres.js as accuracy-test.mjs gives it from PGlite. */
function adapt(sql) {
  return { query: (text, params = []) => sql.unsafe(text, params) };
}

async function main() {
  // Answered before a connection is opened, so `--help` works with no environment.
  if (process.argv.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }
  if (process.argv.length <= 2) {
    console.error(HELP);
    process.exit(1);
  }

  // POSTGRES_URL is what the Supabase integration for Vercel creates.
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set. Use the same pooled connection string the migrations use.",
    );
    process.exit(1);
  }

  // prepare: false is required for Supabase's transaction mode pooler (port 6543).
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const fallback = parseFallbackRmseZ(process.env.PORTAL_SURVEY_RMSE_Z);
    if (fallback.warning) console.error(`${fallback.warning}\n`);
    process.exitCode = await run(adapt(sql), process.argv.slice(2), {
      fallbackRmseZ: fallback.rmseZ,
    });
  } catch (error) {
    console.error(`\nFailed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) await main();
