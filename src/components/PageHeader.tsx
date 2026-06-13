import type { ReactNode } from "react";
import Reveal from "./Reveal";

export default function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden border-b border-ink/[0.06]">
      <div className="absolute inset-0 -z-10 bg-radial-accent" />
      <div className="absolute inset-0 -z-10 grid-overlay opacity-20" />
      <div className="container-px py-20 sm:py-24">
        <Reveal>
          <span className="eyebrow">
            <span className="h-px w-6 bg-accent-400" />
            {eyebrow}
          </span>
        </Reveal>
        <Reveal delay={0.08}>
          <h1 className="heading-xl mt-5 max-w-4xl">{title}</h1>
        </Reveal>
        {description && (
          <Reveal delay={0.16}>
            <p className="lead mt-6 max-w-2xl">{description}</p>
          </Reveal>
        )}
        {children && <div className="mt-8">{children}</div>}
      </div>
    </section>
  );
}
