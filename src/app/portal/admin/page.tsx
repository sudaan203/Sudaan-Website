import Link from "next/link";
import { requireOwner } from "@/lib/portal/auth";
import {
  listAdminClients,
  listAdminSites,
  listAdminUsers,
  listRecentAccessChanges,
} from "@/lib/portal/admin-db";
import {
  createClientAction,
  createSiteAction,
  inviteUserAction,
  setSitePublishedAction,
  setUserActiveAction,
  toggleGrantAction,
} from "@/lib/portal/admin-actions";
import { isDatabaseConfigured, queryDb } from "@/lib/portal/db/client";
import { ownerEmails } from "@/lib/portal/users-db";
import ActionForm, { Field } from "@/components/portal/admin/ActionForm";

export const metadata = { title: "Owner console" };

/**
 * Fail fast rather than sitting at Vercel's 300 second ceiling. If the database
 * is unreachable this page should error in half a minute so the person can retry,
 * not hang for five minutes with a spinner.
 */
export const maxDuration = 30;

function when(date: Date | null) {
  if (!date) return "never";
  return new Date(date).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function OwnerConsole() {
  const session = await requireOwner();

  if (!isDatabaseConfigured()) {
    return (
      <div className="container-px py-12">
        <h1 className="heading-md">Owner console</h1>
        <div className="surface mt-6 p-6">
          <p className="text-sm leading-relaxed text-ink/75">
            The console needs a database. Set <code>DATABASE_URL</code> to the Supabase
            transaction pooler connection string, run{" "}
            <code>node scripts/portal-db-migrate.mjs</code>, and reload. Until then the
            portal runs on the built in sample catalogue.
          </p>
        </div>
      </div>
    );
  }

  // One retry point for the whole page. A warm Vercel instance can wake up
  // holding a pooled socket Supabase already dropped, and these four reads then
  // fail together with "Connection closed"; queryDb reconnects and runs them
  // again rather than leaving an owner staring at an error page.
  const [clients, users, sites, activity] = await queryDb("owner console", () =>
    Promise.all([
      listAdminClients(),
      listAdminUsers(),
      listAdminSites(),
      listRecentAccessChanges(),
    ]),
  );

  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));

  return (
    <div className="container-px space-y-10 py-10">
      <header>
        <span className="eyebrow">Owner console</span>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink-900">Access control</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink/70">
          Signed in as {session.email}. Invite people, decide which client they belong
          to, and publish sites when the deliverables are ready. Clients only ever see
          published sites belonging to their own organisation.
        </p>
      </header>

      {/* ---------------- Clients ---------------- */}
      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="surface overflow-hidden">
          <h2 className="border-b border-ink/[0.08] px-5 py-3 text-sm font-semibold text-ink-900">
            Clients
          </h2>
          {clients.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink/60">No clients yet. Create the first one.</p>
          ) : (
            <ul className="divide-y divide-ink/[0.08]">
              {clients.map((client) => (
                <li key={client.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{client.name}</p>
                    <p className="text-xs text-ink/55">{client.slug}</p>
                  </div>
                  <p className="text-xs text-ink/55">
                    {client.siteCount} site{client.siteCount === 1 ? "" : "s"}, {client.userCount}{" "}
                    {client.userCount === 1 ? "person" : "people"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="surface p-5">
          <h3 className="mb-4 text-sm font-semibold text-ink-900">Add a client</h3>
          <ActionForm action={createClientAction} submitLabel="Create client">
            <Field label="Name" name="name" required placeholder="Reliance Industries" />
            <Field label="Slug (optional)" name="slug" placeholder="reliance" />
          </ActionForm>
        </div>
      </section>

      {/* ---------------- People ---------------- */}
      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="surface overflow-hidden">
          <h2 className="border-b border-ink/[0.08] px-5 py-3 text-sm font-semibold text-ink-900">
            People
          </h2>
          {users.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink/60">
              Nobody has been invited yet. Owner accounts appear here after their first sign in.
            </p>
          ) : (
            <ul className="divide-y divide-ink/[0.08]">
              {users.map((user) => {
                const theirSites = sites.filter((s) => s.clientId === user.clientId);
                return (
                  <li key={user.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink-900">
                          {user.email}
                          {user.role === "client" && !user.clientId ? (
                            <span className="ml-2 rounded-full bg-accent-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-700">
                              Waiting for access
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-ink/55">
                          {user.role === "owner"
                            ? "Sudaan owner"
                            : (user.clientName ?? "signed in, no access yet")}
                          {" | last signed in "}
                          {when(user.lastLoginAt)}
                          {user.isActive ? "" : " | deactivated"}
                        </p>
                      </div>
                      {user.role === "owner" ? null : (
                        <ActionForm
                          action={setUserActiveAction}
                          hidden={{ userId: user.id, active: String(!user.isActive) }}
                          submitLabel={user.isActive ? "Deactivate" : "Reactivate"}
                          variant={user.isActive ? "danger" : "ghost"}
                          confirm={
                            user.isActive
                              ? `Stop ${user.email} from signing in?`
                              : undefined
                          }
                        />
                      )}
                    </div>

                    {user.role === "client" && !user.clientId && clients.length > 0 ? (
                      // Anyone can sign in, so this is where an owner turns a
                      // signed in stranger into a client user with real access.
                      <div className="mt-3 rounded-xl bg-paper p-3">
                        <p className="mb-2 text-xs leading-relaxed text-ink/60">
                          This person signed in and can see nothing. Choose the client
                          they belong to, or leave them as they are.
                        </p>
                        <ActionForm
                          action={inviteUserAction}
                          hidden={{ email: user.email }}
                          submitLabel="Give access"
                          variant="ghost"
                          className="flex flex-wrap items-end gap-2"
                        >
                          <Field label="Client" name="clientId" required options={clientOptions} />
                        </ActionForm>
                      </div>
                    ) : null}

                    {user.role === "client" && user.clientId && theirSites.length > 0 ? (
                      <div className="mt-3 rounded-xl bg-paper p-3">
                        <p className="mb-2 text-xs leading-relaxed text-ink/60">
                          {user.grantedSiteIds.length === 0
                            ? "Sees every published site of this client. Tick a site to restrict them to just that one."
                            : "Restricted to the ticked sites only."}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {theirSites.map((site) => {
                            const granted = user.grantedSiteIds.includes(site.id);
                            return (
                              <ActionForm
                                key={site.id}
                                action={toggleGrantAction}
                                hidden={{
                                  userId: user.id,
                                  siteId: site.id,
                                  grant: String(!granted),
                                }}
                                submitLabel={`${granted ? "Remove" : "Restrict to"} ${site.name}`}
                                variant="ghost"
                                className="inline-block"
                              />
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="surface p-5">
          <h3 className="mb-4 text-sm font-semibold text-ink-900">Invite someone</h3>
          {clients.length === 0 ? (
            <p className="text-xs text-ink/60">Create a client first.</p>
          ) : (
            <ActionForm action={inviteUserAction} submitLabel="Invite">
              <Field label="Google email" name="email" type="email" required placeholder="person@client.com" />
              <Field label="Name (optional)" name="fullName" placeholder="Full name" />
              <Field label="Client" name="clientId" required options={clientOptions} />
            </ActionForm>
          )}
          <p className="mt-3 text-xs leading-relaxed text-ink/55">
            No email is sent. Tell them to open{" "}
            <span className="font-semibold">sudaangeo.in/portal</span> and continue with
            that Google account.
          </p>
          {ownerEmails().length > 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-ink/45">
              Owner addresses: {ownerEmails().join(", ")}
            </p>
          ) : null}
        </div>
      </section>

      {/* ---------------- Sites ---------------- */}
      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="surface overflow-hidden">
          <h2 className="border-b border-ink/[0.08] px-5 py-3 text-sm font-semibold text-ink-900">
            Sites
          </h2>
          {sites.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink/60">No sites yet.</p>
          ) : (
            <ul className="divide-y divide-ink/[0.08]">
              {sites.map((site) => (
                <li key={site.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink-900">
                      {site.name}{" "}
                      <span className="font-normal text-ink/50">for {site.clientName}</span>
                    </p>
                    <p className="text-xs text-ink/55">
                      {site.slug} | {site.assetCount} file{site.assetCount === 1 ? "" : "s"}
                      {site.isPublished ? "" : " | hidden from client"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Link
                      href={`/portal/${site.slug}`}
                      className="text-xs font-semibold text-accent-600 hover:text-accent-700"
                    >
                      Preview
                    </Link>
                    <ActionForm
                      action={setSitePublishedAction}
                      hidden={{ siteId: site.id, published: String(!site.isPublished) }}
                      submitLabel={site.isPublished ? "Unpublish" : "Publish"}
                      variant={site.isPublished ? "danger" : "ghost"}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="surface p-5">
          <h3 className="mb-4 text-sm font-semibold text-ink-900">Add a site</h3>
          {clients.length === 0 ? (
            <p className="text-xs text-ink/60">Create a client first.</p>
          ) : (
            <ActionForm action={createSiteAction} submitLabel="Create site">
              <Field label="Client" name="clientId" required options={clientOptions} />
              <Field label="Name" name="name" required placeholder="Kotba Site Survey" />
              <Field label="Slug (optional)" name="slug" placeholder="kotba-survey" />
              <Field label="Location" name="location" placeholder="Kotba, Gujarat" />
              <Field label="Summary" name="summary" placeholder="What was surveyed" />
            </ActionForm>
          )}
          <p className="mt-3 text-xs leading-relaxed text-ink/55">
            New sites start hidden. Files are still added by the developer until
            uploads land in the next phase.
          </p>
        </div>
      </section>

      {/* ---------------- Activity ---------------- */}
      <section className="surface overflow-hidden">
        <h2 className="border-b border-ink/[0.08] px-5 py-3 text-sm font-semibold text-ink-900">
          Recent access changes
        </h2>
        {activity.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink/60">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-ink/[0.08]">
            {activity.map((row) => (
              <li key={row.id} className="flex flex-wrap gap-x-3 px-5 py-2.5 text-xs text-ink/70">
                <span className="font-semibold text-ink-900">{row.action.replace(/_/g, " ")}</span>
                <span>{row.subject}</span>
                <span className="text-ink/45">
                  by {row.actorEmail ?? "unknown"} on {when(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
