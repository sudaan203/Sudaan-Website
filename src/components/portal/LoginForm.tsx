"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error ?? "Sign in failed. Try again.");
        setBusy(false);
        return;
      }

      // Full navigation so the server layout picks up the new session cookie.
      router.replace(next);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label htmlFor="email" className="mb-2 block text-sm font-semibold text-ink-900">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-xl border border-ink/15 bg-paper px-4 py-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink/40 focus:border-accent-600 focus:ring-2 focus:ring-accent-600/20"
          placeholder="you@company.com"
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-2 block text-sm font-semibold text-ink-900">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-ink/15 bg-paper px-4 py-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink/40 focus:border-accent-600 focus:ring-2 focus:ring-accent-600/20"
          placeholder="Enter your password"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-signal/30 bg-signal/5 px-4 py-3 text-sm text-signal-600"
        >
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-60">
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
