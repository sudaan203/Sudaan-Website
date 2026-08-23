/**
 * Tools 19, 20, 21 and 16: everything measured along a drawn alignment.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/alignment-api-test.mjs
 *
 * These four engines were written and tested weeks before anything could reach
 * them. `engineering-test.mjs` already checks their arithmetic against analytic
 * surfaces; this checks the half that was missing — that the route accepts a
 * drawn line, projects it, windows the right piece of raster, and hands back
 * something a map can draw.
 *
 * Everything here is a *relationship* between independently computed values
 * rather than a shape. A section that is not perpendicular to the alignment
 * still looks like a section; a station whose lon/lat disagrees with its
 * easting still plots somewhere plausible. Only arithmetic catches those.
 */

import { SignJWT } from "jose";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { lonLatToUtm, utmToLonLat } from "../src/lib/geo/projection.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SITE = process.env.SITE ?? "kotba-survey";
const ZONE = 43;
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) => ENV.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const sql = postgres(val("DATABASE_URL"), { prepare: false, fetch_types: false, max: 2, onnotice() {} });
const [owner] = await sql`select id, email, full_name from users where role = 'owner' order by created_at limit 1`;
await sql.end({ timeout: 3 });

const token = await new SignJWT({
  userId: owner.id, email: owner.email, fullName: owner.full_name ?? owner.email,
  role: "owner", clientId: null, via: "google",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h")
  .sign(new TextEncoder().encode(val("PORTAL_AUTH_SECRET")));

/** A line across Kotba, chosen to stay on the survey for its whole length. */
const LINE = [
  [73.72949, 20.84199],
  [73.73042, 20.84268],
  [73.73101, 20.84322],
];

async function ask(op, body = {}) {
  const response = await fetch(`${BASE}/api/portal/sites/${SITE}/analysis`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: `sga_portal_session=${token}` },
    body: JSON.stringify({ op, line: LINE, crs: "lonlat", surface: "dtm", ...body }),
  });
  return { status: response.status, body: await response.json() };
}

/** Planar metres between two lon/lat points, through the survey's own CRS. */
function metresApart(a, b) {
  const [ax, ay] = lonLatToUtm(a[0], a[1], ZONE, true);
  const [bx, by] = lonLatToUtm(b[0], b[1], ZONE, true);
  return Math.hypot(bx - ax, by - ay);
}
function bearing(a, b) {
  const [ax, ay] = lonLatToUtm(a[0], a[1], ZONE, true);
  const [bx, by] = lonLatToUtm(b[0], b[1], ZONE, true);
  return Math.atan2(by - ay, bx - ax);
}

console.log("\nTool 19: chainage");
let alignmentLength = 0;
{
  const { status, body } = await ask("chainage", { interval: 25 });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  const r = body.result;
  alignmentLength = r.length;

  check("it reports the length of the line drawn", r.length > 100 && r.length < 400,
    `${r.length.toFixed(1)} m`);
  check("stations start at zero and end at the length",
    r.stations[0].chainage === 0 &&
      near(r.stations[r.stations.length - 1].chainage, r.length, 1e-6),
    `${r.stations[0].chainage} .. ${r.stations[r.stations.length - 1].chainage.toFixed(3)}`);
  check("chainage increases strictly",
    r.stations.every((s, i) => i === 0 || s.chainage > r.stations[i - 1].chainage));

  // The count follows from the interval and the length, so it is derivable
  // rather than something to eyeball.
  const expected = Math.floor(r.length / 25) + 1 + (r.length % 25 === 0 ? 0 : 1);
  check("the number of stations follows from the interval",
    r.stations.length === expected, `${r.stations.length}, expected ${expected}`);

  check("the first station sits exactly on the first point drawn",
    metresApart(r.stations[0].lonlat, LINE[0]) < 0.01,
    `${metresApart(r.stations[0].lonlat, LINE[0]).toFixed(4)} m away`);
  check("and the last on the last",
    metresApart(r.stations[r.stations.length - 1].lonlat, LINE[LINE.length - 1]) < 0.01);

  /*
   * The lon/lat the route adds must be the same point as the easting and
   * northing the engine computed. They are produced by different code and a
   * disagreement would put every station on the map slightly off the line it
   * belongs to, which looks like drafting sloppiness rather than a bug.
   */
  const worst = Math.max(
    ...r.stations.map((s) => {
      const [x, y] = lonLatToUtm(s.lonlat[0], s.lonlat[1], ZONE, true);
      return Math.hypot(x - s.easting, y - s.northing);
    }),
  );
  check("every station's lon/lat is the same point as its easting and northing",
    worst < 0.001, `worst disagreement ${(worst * 1000).toFixed(3)} mm`);

  check("consecutive stations really are one interval apart on the ground",
    r.stations.slice(1, -1).every((s, i) => near(metresApart(r.stations[i].lonlat, s.lonlat), 25, 0.6)),
    "within 0.6 m, allowing for the bend in the line");

  const grades = r.stations.map((s) => s.gradePercent).filter((g) => g !== null);
  check("the steepest grade is the steepest of the grades reported",
    near(r.maxGradePercent, Math.max(...grades.map(Math.abs)), 1e-9),
    `${r.maxGradePercent?.toFixed(2)}%`);
  check("the first station has no grade, having nothing behind it",
    r.stations[0].gradePercent === null);
  check("chainage is labelled the way a drawing labels it",
    /^\d+\+\d{3}\.\d{3}$/.test(r.stations[1].label), r.stations[1].label);
}

console.log("\n  and the interval is a real control");
{
  const coarse = (await ask("chainage", { interval: 50 })).body.result;
  const fine = (await ask("chainage", { interval: 5 })).body.result;
  check("halving the interval does not change the length",
    near(coarse.length, fine.length, 1e-6), `${coarse.length.toFixed(3)} m both`);
  check("but a finer interval finds more stations",
    fine.stations.length > coarse.stations.length * 5,
    `${fine.stations.length} at 5 m vs ${coarse.stations.length} at 50 m`);
  /*
   * The point of offering the control: a coarse chainage walks past the crest a
   * fine one lands on, so the steepest grade is not interval-independent. If
   * these ever came out equal the sampling would not be doing anything.
   */
  check("and a steeper maximum grade, because it lands on ground the coarse one steps over",
    fine.maxGradePercent > coarse.maxGradePercent,
    `${fine.maxGradePercent.toFixed(1)}% at 5 m vs ${coarse.maxGradePercent.toFixed(1)}% at 50 m`);
}

console.log("\nTool 21: automatic cross sections");
{
  const halfWidth = 12;
  const { status, body } = await ask("cross-sections", { interval: 25, halfWidth });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  const r = body.result;

  check("it echoes what it was asked for", r.interval === 25 && r.halfWidth === halfWidth);
  check("sections are cut at the same stations chainage uses",
    r.sections.length === Math.floor(alignmentLength / 25) + 2 ||
      r.sections.length === Math.floor(alignmentLength / 25) + 1,
    `${r.sections.length} sections over ${alignmentLength.toFixed(1)} m`);
  check("samples run left to right through zero",
    r.sections[0].samples[0].offset === -halfWidth &&
      r.sections[0].samples[r.sections[0].samples.length - 1].offset <= halfWidth);
  check("sampled at the raster's own cell size",
    near(r.sampleSpacing, body.cellSize, 1e-9), `${r.sampleSpacing.toFixed(4)} m`);

  const ends = r.sections.map((s) => s.endsLonLat).filter(Boolean);
  check("every section carries the two ends it was cut between", ends.length === r.sections.length);
  check("and those ends are the full width apart",
    ends.every((e) => near(metresApart(e[0], e[1]), 2 * halfWidth, 0.5)),
    `${metresApart(ends[0][0], ends[0][1]).toFixed(2)} m vs ${2 * halfWidth} m`);

  /*
   * The check that matters, and the one a picture cannot make. A section cut
   * along the grid axes instead of across the alignment is wider than the road
   * by one over the cosine of the bearing and looks entirely reasonable drawn on
   * a plan. Only the angle catches it.
   */
  const middle = r.sections[Math.floor(r.sections.length / 2)];
  const alignmentBearing = bearing(LINE[0], LINE[1]);
  const sectionBearing = bearing(middle.endsLonLat[0], middle.endsLonLat[1]);
  let between = Math.abs(alignmentBearing - sectionBearing) * (180 / Math.PI);
  between = Math.abs(((between + 180) % 360) - 180);
  check("sections are cut perpendicular to the alignment",
    near(between, 90, 2), `${between.toFixed(2)}° between the alignment and the section`);

  check("the centre of a section is on the alignment, between its two ends",
    near(
      metresApart(middle.endsLonLat[0], middle.centreLonLat) +
        metresApart(middle.centreLonLat, middle.endsLonLat[1]),
      metresApart(middle.endsLonLat[0], middle.endsLonLat[1]),
      0.05,
    ));
}

console.log("\nTool 20: corridor analysis");
{
  const { status, body } = await ask("corridor", {
    interval: 25, halfWidth: 12, maxGradePercent: 8, maxCrossfallPercent: 5,
  });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  const r = body.result;

  check("the limits it used are the limits it was given",
    r.limits.maxGradePercent === 8 && r.limits.maxCrossfallPercent === 5,
    JSON.stringify(r.limits));
  check("every station can be placed on the map",
    r.stations.every((s) => Array.isArray(s.lonlat)));

  // The flag must follow from the limits, not from a separate opinion.
  check("a station is flagged exactly when it exceeds one of those limits",
    r.stations.every((s) => {
      const over =
        (s.gradePercent !== null && Math.abs(s.gradePercent) > 8) ||
        (s.crossfallPercent !== null && Math.abs(s.crossfallPercent) > 5);
      return s.unsafe === over;
    }));
  check("and the flagged list is exactly those stations",
    r.unsafeStations.length === r.stations.filter((s) => s.unsafe).length,
    `${r.unsafeStations.length} flagged of ${r.stations.length}`);

  const widths = r.stations.map((s) => s.usableWidth).filter((w) => w !== null);
  check("usable width never exceeds the width sampled",
    widths.every((w) => w <= 24 + 1e-9), `widest ${Math.max(...widths).toFixed(2)} m of 24 m`);
  check("the narrowest reported is the narrowest measured",
    near(r.minUsableWidth, Math.min(...widths), 1e-9));
  check("the mean sits between the narrowest and the widest",
    r.meanUsableWidth >= r.minUsableWidth - 1e-9 &&
      r.meanUsableWidth <= Math.max(...widths) + 1e-9);

  check("how width was derived is stated, because it is not a survey of the edges",
    /derived figure|not a survey/i.test(r.widthMethod));

  // Raising the limits can only ever flag fewer stations.
  const loose = (await ask("corridor", {
    interval: 25, halfWidth: 12, maxGradePercent: 40, maxCrossfallPercent: 40,
  })).body.result;
  check("looser limits flag no more stations than tighter ones",
    loose.unsafeStations.length <= r.unsafeStations.length,
    `${loose.unsafeStations.length} at 40% vs ${r.unsafeStations.length} at 8%`);
}

console.log("\nTool 16: bench analysis");
{
  const { status, body } = await ask("bench", { benchSlopePercent: 10, minBenchWidth: 2 });
  check("the route answers", status === 200, JSON.stringify(body).slice(0, 160));
  const r = body.result;

  check("it separates flats from faces", Array.isArray(r.benches) && Array.isArray(r.faces));
  check("every bench is flatter than the threshold",
    r.benches.every((b) => b.slopePercent === null || Math.abs(b.slopePercent) <= 10 + 1e-6),
    `steepest bench ${Math.max(0, ...r.benches.map((b) => Math.abs(b.slopePercent ?? 0))).toFixed(2)}%`);
  /*
   * Deliberately not the mirror of the check above, because the guarantee is not
   * symmetric and it took a failing test to see why.
   *
   * A run is classified from the slope of each *segment*, but the slope reported
   * for the run is its net rise over its run length. For a bench that is safe:
   * if every segment is within the threshold, the net cannot exceed it. For a
   * face it is not: a run of steep segments that zigzags up and down has a small
   * net slope, so a face can legitimately be reported flatter than the threshold
   * that made it a face. On noisy natural ground that happens often.
   *
   * So what is asserted is the thing that is actually true and actually useful:
   * faces are steeper than benches, as a population.
   */
  const meanFace =
    r.faces.reduce((s, f) => s + Math.abs(f.slopePercent ?? 0), 0) / (r.faces.length || 1);
  const meanBench =
    r.benches.reduce((s, b) => s + Math.abs(b.slopePercent ?? 0), 0) / (r.benches.length || 1);
  check("faces are steeper than benches", meanFace > meanBench,
    `faces ${meanFace.toFixed(1)}% vs benches ${meanBench.toFixed(1)}%`);
  check("every bench is at least the minimum width asked for",
    r.benches.every((b) => b.width >= 2 - 1e-9));

  /*
   * Every metre of the line has to land in one of the three buckets. This
   * started as "benches and faces account for the line" and failed at 159 m of
   * 209 m: flats too narrow to be benches were being dropped silently, so a
   * quarter of the alignment was reported as nothing at all. The engine now
   * counts them, and separately counts the ends of the line that fall off the
   * survey — which was the remaining 11 m once narrow flats were fixed.
   *
   * All four are computed independently, so their sum matching the length is a
   * real check rather than an identity.
   */
  const b = r.lengthBreakdown;
  check("every metre of the line is accounted for",
    near(b.bench + b.face + b.narrowFlat + b.unsurveyed, b.length, b.length * 0.005),
    `bench ${b.bench.toFixed(1)} + face ${b.face.toFixed(1)} + narrow ${b.narrowFlat.toFixed(1)}` +
      ` + unsurveyed ${b.unsurveyed.toFixed(1)} = ${(b.bench + b.face + b.narrowFlat + b.unsurveyed).toFixed(1)}` +
      ` of ${b.length.toFixed(1)} m`);
  check("and that length is the alignment that was drawn",
    near(b.length, alignmentLength, 0.5), `${b.length.toFixed(1)} m`);
  check("the buckets match the runs reported",
    near(b.bench, r.benches.reduce((s, x) => s + x.width, 0), 1e-9) &&
      near(b.face, r.faces.reduce((s, x) => s + x.width, 0), 1e-9));

  check("the steepest face reported is the steepest face found",
    r.faces.length === 0 ||
      near(r.maxFaceAngleDegrees, Math.max(...r.faces.map((f) => f.angleDegrees)), 1e-9),
    `${r.maxFaceAngleDegrees?.toFixed(1)}°`);

  // A higher threshold calls more of the ground flat, so benches cannot decrease.
  const generous = (await ask("bench", { benchSlopePercent: 40, minBenchWidth: 2 })).body.result;
  const flatAt10 = r.benches.reduce((s, b) => s + b.width, 0);
  const flatAt40 = generous.benches.reduce((s, b) => s + b.width, 0);
  check("a looser threshold calls more of the ground flat",
    flatAt40 >= flatAt10 - 1e-9, `${flatAt40.toFixed(1)} m at 40% vs ${flatAt10.toFixed(1)} m at 10%`);
}

console.log("\nRefusals");
{
  const short = await fetch(`${BASE}/api/portal/sites/${SITE}/analysis`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: `sga_portal_session=${token}` },
    body: JSON.stringify({ op: "chainage", line: [[73.7295, 20.842]], crs: "lonlat" }),
  });
  check("a line of one point is refused", short.status === 400, `status ${short.status}`);

  const anonymous = await fetch(`${BASE}/api/portal/sites/${SITE}/analysis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "bench", line: LINE, crs: "lonlat" }),
  });
  check("no session is refused", anonymous.status === 401, `status ${anonymous.status}`);

  const unknown = await ask("benches");
  check("a misspelled op names the ops that exist",
    unknown.status === 400 && /bench/.test(unknown.body.error), unknown.body.error?.slice(0, 120));
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);
