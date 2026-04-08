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
import AiCostDashboard from "./AiCostDashboard";
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
  if (requested.length > 0 && allowed.has(requested)) return requested;
  return session.tenantId;
}

async function requireAdminSession() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  const session = await validateActiveSession(sessionToken);

  if (!session) {
    await authorizeAccess({ session: null, action: "dashboard:admin", path: "/dashboard/admin", method: "GET" });
    redirect("/api/auth/login?next=%2Fdashboard%2Fadmin");
  }

  const authz = await authorizeAccess({ session, action: "dashboard:admin", path: "/dashboard/admin", method: "GET" });
  if (!authz.allowed) redirect("/dashboard?error=admin-forbidden");
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
  let syncErrors: Awaited<ReturnType<typeof listRecentSyncErrors>> = [];
  try {
    syncErrors = await listRecentSyncErrors();
  } catch (err) {
    console.error('[AdminDashboard] Failed to load sync errors:', err instanceof Error ? err.message : err);
  }

  const traceId = crypto.randomUUID();
  const auditCount = adminActions.length + stepUpAttempts.length;

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-5 text-gray-800 md:px-8">
      <main className="mx-auto w-full max-w-5xl">

        {/* Compact header */}
        <header className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-gray-900">Admin Console</h1>
            <span className="text-[10px] text-gray-400">{session.email} &middot; {session.role}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            {allowedClientIds.length > 1 && allowedClientIds.map((cid) => (
              <Link
                key={cid}
                href={`/dashboard/admin?activeClientId=${encodeURIComponent(cid)}`}
                className={`rounded-full border px-2 py-px ${cid === activeClientId ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-400"}`}
              >{cid}</Link>
            ))}
            <Link href={`/dashboard?activeClientId=${encodeURIComponent(activeClientId)}`} className="text-blue-500 hover:text-blue-700">Dashboard</Link>
          </div>
        </header>

        {/* Quick links row */}
        <div className="flex items-center gap-3 border-y border-gray-200 py-2 text-[11px]">
          <Link href="/dashboard/recruiter/candidates" className="text-blue-600 hover:text-blue-800">Candidates</Link>
          <span className="text-gray-300">|</span>
          <Link href="/dashboard/admin/dedup" className="text-blue-600 hover:text-blue-800">Dedup Review</Link>
          <span className="text-gray-300">|</span>
          <AuditLink count={auditCount} adminActions={adminActions} stepUpAttempts={stepUpAttempts} />
          <span className="flex-1" />
          <span className="text-gray-400">
            {syncErrors.length > 0 ? <span className="text-red-500">{syncErrors.length} sync errors</span> : <span className="text-green-500">No errors</span>}
          </span>
        </div>

        {/* Two-column: Errors + AI costs */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Card>
            <SyncErrorStatusCard errors={syncErrors} />
          </Card>
          <Card>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">AI Costs</h3>
            <AiCostDashboard />
          </Card>
        </div>

        {/* User governance — the primary admin tool */}
        <div className="mt-3">
          <Card>
            <AdminGovernanceConsole
              tenantId={activeClientId}
              initialPayload={{ users, invitations, adminActions, stepUpAttempts }}
            />
          </Card>
        </div>

      </main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-lg border border-gray-200 bg-white p-3">{children}</section>;
}

function AuditLink({ count, adminActions, stepUpAttempts }: { count: number; adminActions: unknown[]; stepUpAttempts: unknown[] }) {
  return (
    <details className="relative inline-block">
      <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
        Audit Trail ({count})
      </summary>
      <div className="absolute left-0 top-6 z-50 w-80 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
        <p className="text-[10px] font-semibold text-gray-500 mb-1">Recent Admin Actions ({adminActions.length})</p>
        {adminActions.length === 0 ? (
          <p className="text-[10px] text-gray-400">None</p>
        ) : (
          <ul className="space-y-0.5 text-[10px] text-gray-600">
            {(adminActions as Array<{ action: string; actorId: string; occurredAt: string }>).slice(0, 10).map((a, i) => (
              <li key={i}><span className="text-gray-400">{a.occurredAt?.slice(5, 16).replace("T", " ")}</span> {a.action} <span className="text-gray-400">by {a.actorId?.slice(0, 12)}</span></li>
            ))}
          </ul>
        )}
        <p className="text-[10px] font-semibold text-gray-500 mt-2 mb-1">Step-Up Attempts ({stepUpAttempts.length})</p>
        {stepUpAttempts.length === 0 ? (
          <p className="text-[10px] text-gray-400">None</p>
        ) : (
          <ul className="space-y-0.5 text-[10px] text-gray-600">
            {(stepUpAttempts as Array<{ method: string; actorId: string; occurredAt: string; success: boolean }>).slice(0, 10).map((a, i) => (
              <li key={i}>
                <span className="text-gray-400">{a.occurredAt?.slice(5, 16).replace("T", " ")}</span>{" "}
                {a.method} {a.success ? <span className="text-green-500">ok</span> : <span className="text-red-500">fail</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
