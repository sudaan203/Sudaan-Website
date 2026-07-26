"use client";

import { useActionState } from "react";
import { Spinner } from "@/components/Pending";
import type { ActionResult } from "@/lib/portal/admin-actions";

type Action = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * Wraps a server action so the result message appears next to the form instead
 * of vanishing. Used for both the create forms and the one click toggles.
 */
export default function ActionForm({
  action,
  hidden,
  submitLabel,
  variant = "primary",
  confirm,
  children,
  className = "",
}: {
  action: Action;
  hidden?: Record<string, string>;
  submitLabel: string;
  variant?: "primary" | "ghost" | "danger";
  confirm?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);

  const focusRing =
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 focus-visible:ring-offset-2 focus-visible:ring-offset-panel";
  const buttonClass =
    variant === "primary"
      ? `btn-primary w-full disabled:cursor-wait disabled:opacity-60`
      : variant === "danger"
        ? `inline-flex items-center gap-1.5 rounded-full border border-signal/40 px-3 py-1.5 text-xs font-semibold text-signal-600 transition-colors hover:bg-signal/10 disabled:cursor-wait disabled:opacity-60 ${focusRing}`
        : `inline-flex items-center gap-1.5 rounded-full border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink-900 transition-colors hover:border-accent/50 hover:bg-accent-50 disabled:cursor-wait disabled:opacity-60 ${focusRing}`;

  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {children}

      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? (
          <>
            <Spinner className={variant === "primary" ? "" : "h-3.5 w-3.5"} />
            Saving
          </>
        ) : (
          submitLabel
        )}
      </button>

      {result ? (
        <p
          role="status"
          className={`mt-2 flex items-start gap-1.5 text-xs leading-relaxed ${
            result.ok ? "text-accent-700" : "text-signal-600"
          }`}
        >
          {/* A tick or a cross, so the outcome is readable at a glance and does
              not depend on telling two similar colours apart. */}
          <span aria-hidden className="mt-px font-bold">
            {result.ok ? "✓" : "✗"}
          </span>
          {result.message}
        </p>
      ) : null}
    </form>
  );
}

/** Shared field styling so the console forms look like the rest of the site. */
export function Field({
  label,
  name,
  type = "text",
  required,
  placeholder,
  options,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
}) {
  const shared =
    "w-full rounded-xl border border-ink/15 bg-paper px-4 py-2.5 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink/40 focus:border-accent-600 focus:ring-2 focus:ring-accent-600/20";
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-xs font-semibold text-ink-900">{label}</span>
      {options ? (
        <select name={name} required={required} className={shared} defaultValue="">
          <option value="" disabled>
            Choose one
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          placeholder={placeholder}
          className={shared}
        />
      )}
    </label>
  );
}
