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

import AdminGovernanceConsole from "./AdminGovernanceConsole";

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

export default async function AdminDashboardPage() {
  const session = await requireAdminSession();
  await registerOrSyncUserFromSession(session);

  const users = await listManagedUsersByTenant(session.tenantId);
  const invitations = await listInvitationsByTenant(session.tenantId);
  const adminActions = (await listAdminActionEvents())
    .filter((event) => event.tenantId === session.tenantId)
    .slice(-50)
    .reverse();
  const stepUpAttempts = (await listStepUpAttemptEvents())
    .filter((event) => event.tenantId === session.tenantId)
    .slice(-50)
    .reverse();

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
            <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Tenant</p>
            <p className="mt-2 text-sm text-white">{session.tenantId}</p>
          </article>
        </section>

        <div className="mt-8 rounded-2xl border border-cyan-300/20 bg-cyan-500/10 p-5 text-sm text-cyan-50">
          This route is protected by role-based authorization checks and now includes
          user invitation, role transition governance, and team assignment controls with
          auditable action tracking.
        </div>

        <AdminGovernanceConsole
          tenantId={session.tenantId}
          initialPayload={{
            users,
            invitations,
            adminActions,
            stepUpAttempts,
          }}
        />

        <div className="mt-6 text-sm font-medium">
          <Link href="/dashboard" className="text-cyan-200 hover:text-cyan-100">
            Return to Dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}