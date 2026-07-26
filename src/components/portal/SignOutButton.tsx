"use client";

import { SubmitButton } from "@/components/Pending";

/**
 * Sign out posts to a route handler that clears the cookie and redirects, which
 * is a full document navigation. Nothing on the client would otherwise change
 * between the click and the new page, so the button says what it is doing.
 */
export default function SignOutButton() {
  return (
    <form action="/api/portal/logout" method="post">
      <SubmitButton
        pendingLabel="Signing out"
        className="inline-flex items-center gap-2 rounded-full border border-ink/15 bg-panel px-4 py-2 text-xs font-semibold text-ink-900 transition-colors hover:border-accent/50 hover:bg-accent-50 disabled:cursor-wait disabled:opacity-70"
      >
        Sign out
      </SubmitButton>
    </form>
  );
}
