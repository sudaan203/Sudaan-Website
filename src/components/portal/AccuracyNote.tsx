import type { SurveyAccuracy } from "@/lib/portal/analysis-client";

/**
 * What the portal is prepared to say about this survey's vertical accuracy.
 *
 * One component, used by every panel that shows a height, because the alternative
 * is five slightly different sentences that drift apart and one of them ends up
 * being the one a client quotes back at us. The words themselves come from
 * `accuracy.statement` in accuracy.mjs — this file only decides where they sit.
 *
 * ## Why it is a quiet line and not a warning box
 *
 * Every survey published today is unmeasured, so this renders on every
 * measurement anyone takes. A red box on every measurement is a red box nobody
 * reads within a week, and the fact is not an error: it is provenance, the same
 * register as "read from the terrain model at its native 0.24 m cell, in
 * EPSG:32643". The coloured treatment in these panels is reserved for something
 * that makes a specific number wrong — a polygon half off the survey — and
 * spending it here would devalue it there.
 *
 * It is never omitted, though. An absent accuracy line reads as an accurate
 * survey, which is precisely the reading that has to stop.
 */
export function AccuracyNote({ accuracy }: { accuracy: SurveyAccuracy | null }) {
  // Null before the first response has come back. Saying anything at that point
  // would be guessing, and the panel it sits in has no numbers in it yet either.
  if (!accuracy) return null;

  return (
    <p className="text-[11px] leading-snug text-ink/55">
      {accuracy.statement}
    </p>
  );
}
