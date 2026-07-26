import Link from "next/link";
import Logo from "@/components/Logo";
import { LinkSpinner } from "@/components/Pending";
import SignOutButton from "@/components/portal/SignOutButton";
import { getClient } from "@/lib/portal/store";
import { isOwnerRole, type PortalSession } from "@/lib/portal/types";

export default async function PortalHeader({ session }: { session: PortalSession }) {
  const isOwner = isOwnerRole(session.role);
  const client = session.clientId ? await getClient(session.clientId) : null;
  // Owners are not tied to a client, so labelling them "Client" was misleading.
  const org = isOwner ? "Sudaan owner, all clients" : (client?.name ?? "Your account");

  return (
    <header className="sticky top-0 z-40 border-b border-ink/[0.08] bg-panel/95 backdrop-blur">
      <div className="container-px flex h-16 items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/portal" className="flex items-center" aria-label="Client portal home">
            <Logo asLink={false} />
          </Link>
          <span className="hidden text-xs font-semibold uppercase tracking-[0.18em] text-accent-600 sm:inline">
            Client Portal
          </span>
        </div>

        <div className="flex items-center gap-3 sm:gap-5">
          {isOwner ? (
            <Link
              href="/portal/admin"
              className="inline-flex items-center gap-2 rounded-full border border-accent-600/30 px-4 py-2 text-xs font-semibold text-accent-600 transition-colors hover:border-accent-600 hover:bg-accent-50"
            >
              {/* The console is the slowest page in the portal, so the button
                  itself has to acknowledge the click. */}
              <LinkSpinner className="h-3.5 w-3.5" />
              Owner console
            </Link>
          ) : null}
          <div className="hidden text-right sm:block">
            <p className="text-sm font-semibold leading-tight text-ink-900">{org}</p>
            <p className="text-xs leading-tight text-ink/60">{session.email}</p>
          </div>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
