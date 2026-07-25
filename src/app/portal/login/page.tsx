import Link from "next/link";
import { redirect } from "next/navigation";
import Logo from "@/components/Logo";
import LoginForm from "@/components/portal/LoginForm";
import { getSession } from "@/lib/portal/auth";
import { siteConfig } from "@/lib/site";

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/portal");

  const { next } = await searchParams;
  // Only accept internal paths, so ?next= cannot bounce a signed in user off site.
  const safeNext = next && next.startsWith("/portal") ? next : "/portal";

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

        <div className="surface p-6 sm:p-8">
          <LoginForm next={safeNext} />
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-ink/60">
          Access is provisioned by Sudaan Geo-Analytics. If you need a login or a
          password reset, contact{" "}
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
