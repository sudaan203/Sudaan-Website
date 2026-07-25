import Link from "next/link";
import { redirect } from "next/navigation";
import Logo from "@/components/Logo";
import LoginForm from "@/components/portal/LoginForm";
import GoogleSignInButton from "@/components/portal/GoogleSignInButton";
import { getSession } from "@/lib/portal/auth";
import { googleConfigured } from "@/lib/portal/google";
import { passwordLoginAvailable } from "@/lib/portal/users";
import { siteConfig } from "@/lib/site";

/**
 * Messages are deliberately specific about invitations but never about accounts:
 * "not invited" is safe to say because it reveals nothing beyond what the person
 * already knows, while a wrong password stays generic (see the login route).
 */
const ERRORS: Record<string, string> = {
  not_invited:
    "That Google account is not on the access list for this portal. Ask your Sudaan Geo-Analytics contact to invite it.",
  deactivated: "Access for that account has been turned off. Contact your project manager.",
  unverified_email: "That Google account has an unverified email address, so we cannot use it to sign in.",
  no_database: "Sign in is temporarily unavailable. Please try again shortly.",
  google_unavailable: "Google sign in is not configured yet. Please contact us.",
  google_error: "Google could not complete the sign in. Please try again.",
  cancelled: "Sign in was cancelled.",
  expired: "That sign in attempt expired. Please try again.",
};

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/portal");

  const { next, error } = await searchParams;
  // Only accept internal paths, so ?next= cannot bounce a signed in user off site.
  const safeNext = next && next.startsWith("/portal") ? next : "/portal";
  const message = error ? (ERRORS[error] ?? ERRORS.google_error) : null;

  // The password form is a transitional fallback for Sudaan staff, so a Google
  // outage cannot lock the owners out of their own console. Remove it by clearing
  // PORTAL_USERS (and portal-data/users.json locally) once Google is proven.
  const passwordLoginEnabled = passwordLoginAvailable();

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link href="/" className="mb-6 inline-flex">
            <Logo />
          </Link>
          <span className="eyebrow">Client Portal</span>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink-900">
            Sign in to your dashboard
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink/70">
            View the survey deliverables we have processed for your sites.
          </p>
        </div>

        {message ? (
          <p
            role="alert"
            className="mb-6 rounded-xl border border-signal/30 bg-signal/5 px-4 py-3 text-sm leading-relaxed text-signal-600"
          >
            {message}
          </p>
        ) : null}

        <div className="surface p-6 sm:p-8">
          {googleConfigured() ? (
            <>
              <GoogleSignInButton next={safeNext} />
              <p className="mt-4 text-center text-xs leading-relaxed text-ink/55">
                Use the Google account your Sudaan Geo-Analytics contact invited.
              </p>
            </>
          ) : (
            <p className="text-center text-sm text-ink/70">
              Google sign in is not configured yet.
            </p>
          )}

          {passwordLoginEnabled ? (
            <details className="mt-6 border-t border-ink/[0.08] pt-5">
              <summary className="cursor-pointer text-xs font-semibold text-ink/60 hover:text-accent-600">
                Sudaan staff sign in
              </summary>
              <div className="mt-4">
                <LoginForm next={safeNext} />
              </div>
            </details>
          ) : null}
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-ink/60">
          Access is provisioned by Sudaan Geo-Analytics. If you need a login,
          contact{" "}
          <a
            className="font-semibold text-accent-600 hover:text-accent-700"
            href={`mailto:${siteConfig.email}`}
          >
            {siteConfig.email}
          </a>
          .
        </p>
        <p className="mt-4 text-center text-xs text-ink/50">
          <Link href="/" className="hover:text-accent-600">
            Back to sudaangeo.in
          </Link>
        </p>
      </div>
    </div>
  );
}
