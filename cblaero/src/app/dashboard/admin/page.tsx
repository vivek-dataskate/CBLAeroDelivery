import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";
import {
  listInvitationsByTenant,
  listManagedUsersByTenant,
  registerOrSyncUserFromSession,
} from "@/modules/admin";
import { listAdminActionEvents, listStepUpAttemptEvents } from "@/modules/audit";

import { listRecentSyncErrors } from "@/modules/ingestion";

import AdminGovernanceConsole from "./AdminGovernanceConsole";
import MigrationStatusCard from "./MigrationStatusCard";
import SyncErrorStatusCard from "./SyncErrorStatusCard";

type AdminDashboardSearchParams = {
  activeClientId?: string | string[];
};

function getAllowedClientIds(session: Awaited<ReturnType<typeof requireAdminSession>>): string[] {
  const unique = new Set(session.clientIds ?? [session.tenantId]);
  unique.add(session.tenantId);
  return [...unique];
}

function pickActiveClientId(
  session: Awaited<ReturnType<typeof requireAdminSession>>,
  searchParams: AdminDashboardSearchParams,
): string {
  const allowed = new Set(getAllowedClientIds(session));
  const requestedRaw = Array.isArray(searchParams.activeClientId)
    ? searchParams.activeClientId[0]
    : searchParams.activeClientId;
  const requested = typeof requestedRaw === "string" ? requestedRaw.trim() : "";

  if (requested.length > 0 && allowed.has(requested)) {
    return requested;
  }

  return session.tenantId;
}

async function requireAdminSession() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  const session = await validateActiveSession(sessionToken);

  if (!session) {
    await authorizeAccess({
      session: null,
      action: "dashboard:admin",
      path: "/dashboard/admin",
      method: "GET",
    });
    redirect("/api/auth/login?next=%2Fdashboard%2Fadmin");
  }

  const authz = await authorizeAccess({
    session,
    action: "dashboard:admin",
    path: "/dashboard/admin",
    method: "GET",
  });

  if (!authz.allowed) {
    redirect("/dashboard?error=admin-forbidden");
  }

  return session;
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<AdminDashboardSearchParams>;
}) {
  const session = await requireAdminSession();
  const resolvedSearchParams = (await searchParams) ?? {};
  const activeClientId = pickActiveClientId(session, resolvedSearchParams);
  const allowedClientIds = getAllowedClientIds(session);

  await registerOrSyncUserFromSession(session);

  const users = await listManagedUsersByTenant(activeClientId);
  const invitations = await listInvitationsByTenant(activeClientId);
  const adminActions = (await listAdminActionEvents())
    .filter((event) => event.tenantId === activeClientId)
    .slice(-50)
    .reverse();
  const stepUpAttempts = (await listStepUpAttemptEvents())
    .filter((event) => event.tenantId === activeClientId)
    .slice(-50)
    .reverse();
  const syncErrors = await listRecentSyncErrors();

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100 md:px-10">
      <main className="mx-auto w-full max-w-5xl rounded-3xl border border-cyan-300/20 bg-slate-900/60 p-8 md:p-12">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">CBL AERO</p>
            <h1 className="mt-2 text-3xl font-semibold text-white">Admin Authorization Zone</h1>
          </div>
          <span className="rounded-full border border-cyan-200/40 px-3 py-1 text-xs text-cyan-100">
            Admin Only
          </span>
        </header>

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <article className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Actor</p>
            <p className="mt-2 text-sm text-white">{session.email}</p>
          </article>
          <article className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Role</p>
            <p className="mt-2 text-sm text-white">{session.role}</p>
          </article>
          <article className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Active Client</p>
            <p className="mt-2 text-sm text-white">{activeClientId}</p>
          </article>
        </section>

        {allowedClientIds.length > 1 ? (
          <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/65 p-4">
            <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Switch Active Client</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {allowedClientIds.map((clientId) => (
                <Link
                  key={clientId}
                  href={`/dashboard/admin?activeClientId=${encodeURIComponent(clientId)}`}
                  className={`rounded-full border px-3 py-1 transition ${
                    clientId === activeClientId
                      ? "border-cyan-200/70 bg-cyan-500/20 text-cyan-100"
                      : "border-white/20 text-slate-200 hover:border-cyan-200/50 hover:text-cyan-100"
                  }`}
                >
                  {clientId}
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-8 rounded-2xl border border-cyan-300/20 bg-cyan-500/10 p-5 text-sm text-cyan-50">
          This route is protected by role-based authorization checks and now includes
          user invitation, role transition governance, and team assignment controls with
          auditable action tracking.
        </div>

        <SyncErrorStatusCard errors={syncErrors} />
        <MigrationStatusCard tenantId={activeClientId} actorId={session.actorId} />

        <AdminGovernanceConsole
          tenantId={activeClientId}
          initialPayload={{
            users,
            invitations,
            adminActions,
            stepUpAttempts,
          }}
        />

        <div className="mt-6 text-sm font-medium">
          <Link
            href={`/dashboard?activeClientId=${encodeURIComponent(activeClientId)}`}
            className="text-cyan-200 hover:text-cyan-100"
          >
            Return to Dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}