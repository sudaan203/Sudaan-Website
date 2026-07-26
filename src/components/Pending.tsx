"use client";

import { useLinkStatus } from "next/link";
import { useFormStatus } from "react-dom";

/**
 * Small pending indicators, so the control you actually clicked reacts.
 *
 * The top progress bar tells you the page is coming; it does not tell you which
 * of two buttons registered the click. Both of these read their state from the
 * platform rather than from a hand rolled useState, so they cannot fall out of
 * step with the navigation or the form submission they describe.
 */

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        className="opacity-90"
      />
    </svg>
  );
}

/**
 * Renders a spinner while the enclosing <Link> is fetching its destination.
 * Must be a child of that Link: useLinkStatus reads the nearest one.
 */
export function LinkSpinner({ className = "" }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Spinner className={className} />;
}

/**
 * Submit button that disables itself and says what it is doing while the server
 * action runs. useFormStatus is read from inside the form, which is why this is
 * a separate component rather than a prop on the form.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className} {...rest}>
      {pending ? (
        <>
          <Spinner />
          {pendingLabel ?? "Working"}
        </>
      ) : (
        children
      )}
    </button>
  );
}
