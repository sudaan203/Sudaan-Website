import type { ReactNode } from "react";
import Reveal from "./Reveal";

export default function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  const center = align === "center";
  return (
    <Reveal
      className={`${center ? "mx-auto text-center" : ""} max-w-3xl ${className}`}
    >
      {eyebrow && (
        <span className="eyebrow">
          <span className="h-px w-6 bg-accent-400" />
          {eyebrow}
        </span>
      )}
      <h2 className="heading-lg mt-4">{title}</h2>
      {description && <p className="lead mt-5">{description}</p>}
    </Reveal>
  );
}
