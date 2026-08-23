import type { SiteSummary, SummaryFigure } from "@/lib/portal/site-summary";

/**
 * Tool 40: the project summary a client sees first.
 *
 * ## The design brief this answers
 *
 * A dashboard's first screen has one job: tell someone what they are looking at
 * in the time it takes to glance. So the four figures that describe the *site*
 * are large and unlabelled-by-a-heading; the rest are a quiet table below; and
 * the two Malhar asked for that cannot be answered site-wide are shown as what
 * they are — a pointer to the tool that answers them — rather than omitted.
 *
 * ## Why an absent figure looks different from a zero
 *
 * "0 ha" and "we have not computed this" are different statements and a
 * dashboard that renders them identically is worse than one that omits the row.
 * Every value here is nullable, and a null prints its own sentence.
 */

const nf = (value: number, decimals = 0) =>
  value.toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/** Big numbers stay readable: 50,183,644 becomes 50.2M. */
function compact(value: number, decimals = 0): string {
  if (Math.abs(value) >= 1_000_000) return `${nf(value / 1_000_000, 1)}M`;
  if (Math.abs(value) >= 10_000) return nf(Math.round(value));
  return nf(value, decimals);
}

function figureText(f: SummaryFigure): { value: string; muted: boolean } {
  if (f.value === null) return { value: f.absent ?? "Not available", muted: true };
  return { value: `${compact(f.value, f.decimals ?? 0)}${f.unit ? ` ${f.unit}` : ""}`, muted: false };
}

const HEADLINE = ["Area surveyed", "Relief", "Average slope", "Vertical accuracy"];

export default function SiteSummaryPanel({ summary }: { summary: SiteSummary }) {
  const headline = HEADLINE.map((label) => summary.figures.find((f) => f.label === label)).filter(
    (f): f is SummaryFigure => Boolean(f),
  );
  const rest = summary.figures.filter((f) => !HEADLINE.includes(f.label));

  const held = Object.entries(summary.has).filter(([, yes]) => yes);
  const HOLD_LABELS: Record<string, string> = {
    terrain: "Terrain model",
    surface: "Surface model",
    orthomosaic: "Orthomosaic",
    contours: "Contours",
    hydrology: "Hydrology",
    pointCloud: "LiDAR point cloud",
  };

  return (
    <section className="surface overflow-hidden" aria-label="Project summary">
      <div className="border-b border-ink/[0.06] px-6 py-5 sm:px-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-ink-900">Project summary</h2>
          {summary.flownOn ? (
            <p className="text-xs text-ink/55">
              {summary.flightLabel ? `${summary.flightLabel}, ` : ""}
              flown{" "}
              <time dateTime={summary.flownOn} className="font-medium text-ink/75">
                {new Date(summary.flownOn).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </time>
              {summary.crs ? <span className="text-ink/40"> · {summary.crs}</span> : null}
            </p>
          ) : null}
        </div>
      </div>

      {/* The glance layer. Four numbers, large, no chrome around them. */}
      <dl className="grid grid-cols-2 gap-px bg-ink/[0.06] lg:grid-cols-4">
        {headline.map((f) => {
          const { value, muted } = figureText(f);
          return (
            <div key={f.label} className="bg-panel px-6 py-5 sm:px-8">
              <dt className="text-[11px] font-medium uppercase tracking-wider text-ink/45">
                {f.label}
              </dt>
              <dd
                className={
                  muted
                    ? "mt-1.5 text-[13px] leading-snug text-ink/45"
                    : "mt-1.5 text-2xl font-semibold tracking-tight text-ink-900 tabular-nums"
                }
              >
                {value}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="px-6 py-6 sm:px-8">
        <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-ink/45">
            What we hold
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {held.map(([key]) => (
              <li
                key={key}
                className="rounded-full border border-ink/10 bg-paper px-2.5 py-1 text-[11px] font-medium text-ink/70"
              >
                {HOLD_LABELS[key] ?? key}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-ink/45">
            Everything measured
          </h3>
          {/*
            Two columns on a wide screen. One column left an empty half-page of
            white beside a list of ten rows, which reads as something failing to
            load rather than as restraint.
          */}
          <dl className="mt-3 grid gap-x-10 lg:grid-cols-2">
            {rest.map((f) => {
              const { value, muted } = figureText(f);
              return (
                <div
                  key={f.label}
                  className="flex items-baseline justify-between gap-4 border-b border-ink/[0.05] py-2 last:border-0"
                >
                  <dt className="text-[13px] text-ink/70">
                    {f.label}
                    {/*
                      Provenance, on the row it belongs to. A client asking where
                      a number came from should not have to ask us.
                    */}
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink/40">
                      {f.source}
                    </span>
                  </dt>
                  <dd
                    className={
                      muted
                        ? "max-w-[14rem] text-right text-[11px] leading-snug text-ink/45"
                        : "shrink-0 font-mono text-[13px] font-medium text-ink-900 tabular-nums"
                    }
                  >
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>

        <div>
          <p className="mt-5 max-w-2xl text-[12px] leading-relaxed text-ink/55">
            Every figure above is measured in the survey&apos;s own projected
            coordinate system, never in degrees. Areas and volumes computed in
            longitude and latitude are wrong by about 16% at this latitude, which
            is the sort of error that looks entirely plausible on a report.
          </p>
        </div>
      </div>
    </section>
  );
}
