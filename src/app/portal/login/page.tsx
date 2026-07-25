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
 * Messages are deliberately specific about access but never about accounts:
 * saying an account has no access reveals nothing the person does not already
 * know, while a wrong password stays generic (see the login route).
 */
const ERRORS: Record<string, string> = {
  not_invited:
    "That Google account does not have access yet. Send the address to your Sudaan Geo-Analytics contact and they will enable it.",
  deactivated: "Access for that account has been turned off. Contact your project manager.",
  unverified_email:
    "That Google account has an unverified email address, so we cannot use it to sign in.",
  no_database: "Sign in is temporarily unavailable. Please try again shortly.",
  google_unavailable: "Google sign in is not configured yet. Please contact us.",
  google_error: "Google could not complete the sign in. Please try again.",
  cancelled: "Sign in was cancelled.",
  expired: "That sign in attempt expired. Please try again.",
};

/** What clients get once they are in. Sets expectations before the click. */
const HIGHLIGHTS = [
  {
    title: "Every deliverable in one place",
    body: "Orthomosaics, DSM and DTM previews, contour sheets, survey reports and drawings for each of your sites.",
  },
  {
    title: "Private to your organisation",
    body: "You only ever see the sites we have processed for you, and nothing belonging to any other client.",
  },
  {
    title: "Always the current version",
    body: "When we publish a revision it appears here, so there is no chasing files over email.",
  },
];

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
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-14 sm:py-20">
      {/* Warm wash behind the panel, same family as the marketing pages. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-radial-accent" />

      <div className="relative grid w-full max-w-5xl items-center gap-12 lg:grid-cols-[1.05fr_minmax(0,420px)] lg:gap-16">
        {/* Left: what this is. Hidden on small screens where the form matters most. */}
        <section className="hidden lg:block">
          <Logo />
          <span className="eyebrow mt-8 block">Client Portal</span>
          <h1 className="mt-3 text-4xl font-bold leading-[1.1] tracking-tight text-ink-900">
            Your survey data,
            <br />
            ready when you are.
          </h1>
          <p className="lead mt-5 max-w-lg">
            Sign in to view everything we have processed for your sites, straight
            in the browser.
          </p>

          <ul className="mt-10 space-y-6">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex gap-4">
                <span
                  aria-hidden
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent-600"
                />
                <div>
                  <h2 className="text-sm font-semibold text-ink-900">{item.title}</h2>
                  <p className="mt-1 max-w-md text-sm leading-relaxed text-ink/70">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Right: the actual sign in. */}
        <section className="mx-auto w-full max-w-md">
          <div className="mb-8 flex flex-col items-center text-center lg:hidden">
            <Logo className="mb-6" />
            <span className="eyebrow">Client Portal</span>
          </div>

          <div className="surface p-7 sm:p-9">
            <h2 className="text-center text-2xl font-bold tracking-tight text-ink-900">
              Sign in
            </h2>
            <p className="mt-2 text-center text-sm leading-relaxed text-ink/70">
              Use your Google account to continue.
            </p>

            {message ? (
              <p
                role="alert"
                className="mt-6 rounded-xl border border-signal/25 bg-signal/[0.06] px-4 py-3 text-sm leading-relaxed text-signal-600"
              >
                {message}
              </p>
            ) : null}

            <div className="mt-7">
              {googleConfigured() ? (
                <GoogleSignInButton next={safeNext} />
              ) : (
                <p className="text-center text-sm text-ink/70">
                  Google sign in is not configured yet.
                </p>
              )}
            </div>

            <p className="mt-5 text-center text-xs leading-relaxed text-ink/55">
              New here? Signing in creates your account, then your Sudaan
              Geo-Analytics contact enables access to your sites.
            </p>

            {passwordLoginEnabled ? (
              <details className="mt-7 border-t border-ink/[0.08] pt-5">
                <summary className="cursor-pointer text-xs font-semibold text-ink/55 hover:text-accent-600">
                  Sudaan staff sign in
                </summary>
                <div className="mt-4">
                  <LoginForm next={safeNext} />
                </div>
              </details>
            ) : null}
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-ink/55">
            Need help? Contact{" "}
            <a
              className="font-semibold text-accent-600 hover:text-accent-700"
              href={`mailto:${siteConfig.email}`}
            >
              {siteConfig.email}
            </a>
            <span className="mx-2 text-ink/25">|</span>
            <Link href="/" className="hover:text-accent-600">
              Back to sudaangeo.in
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
