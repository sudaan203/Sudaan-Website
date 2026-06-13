import type { Service } from "@/data/services";
import ServiceIcon from "./ServiceIcon";
import { StaggerItem } from "./Reveal";

export default function ServiceCard({
  service,
  index,
}: {
  service: Service;
  index: number;
}) {
  return (
    <StaggerItem>
      <article className="surface surface-hover group relative flex h-full flex-col overflow-hidden p-7">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-accent/10 blur-2xl transition-opacity duration-300 group-hover:bg-accent/20" />
        <div className="flex items-center justify-between">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent-700 transition-colors group-hover:border-accent/60 group-hover:text-accent-700">
            <ServiceIcon name={service.icon} />
          </span>
          <span className="text-xs font-mono text-ink/40">
            {String(index + 1).padStart(2, "0")}
          </span>
        </div>

        <h3 className="mt-5 text-lg font-semibold text-ink-900">
          {service.title}
        </h3>
        <p className="mt-2 flex-1 text-sm leading-relaxed text-ink/60">
          {service.short}
        </p>

        <ul className="mt-5 space-y-2 border-t border-ink/[0.06] pt-5">
          {service.outcomes.slice(0, 3).map((o) => (
            <li
              key={o}
              className="flex items-start gap-2 text-xs text-ink/80"
            >
              <svg
                viewBox="0 0 24 24"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {o}
            </li>
          ))}
        </ul>
      </article>
    </StaggerItem>
  );
}
