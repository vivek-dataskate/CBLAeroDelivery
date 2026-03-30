import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";
import { registerOrSyncUserFromSession, resolveEffectiveRole } from "@/modules/admin";

type DashboardSearchParams = {
  activeClientId?: string | string[];
};

function getAllowedClientIds(session: Awaited<ReturnType<typeof requireSession>>): string[] {
  const unique = new Set(session.clientIds ?? [session.tenantId]);
  unique.add(session.tenantId);
  return [...unique];
}

function pickActiveClientId(
  session: Awaited<ReturnType<typeof requireSession>>,
  searchParams: DashboardSearchParams,
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

async function requireSession() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  const session = await validateActiveSession(sessionToken);

  if (!session) {
    await authorizeAccess({
      session: null,
      action: "dashboard:view",
      path: "/dashboard",
      method: "GET",
    });
    redirect("/api/auth/login?next=%2Fdashboard");
  }

  const authz = await authorizeAccess({
    session,
    action: "dashboard:view",
    path: "/dashboard",
    method: "GET",
  });

  if (!authz.allowed) {
    redirect("/?error=forbidden");
  }

  return session;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<DashboardSearchParams>;
}) {
  const session = await requireSession();
  const resolvedSearchParams = (await searchParams) ?? {};
  const activeClientId = pickActiveClientId(session, resolvedSearchParams);
  const allowedClientIds = getAllowedClientIds(session);

  await registerOrSyncUserFromSession(session);
  const effectiveRole = await resolveEffectiveRole(session.actorId, session.role);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100 md:px-10">
      <main className="mx-auto w-full max-w-5xl rounded-3xl border border-emerald-300/20 bg-slate-900/60 p-8 md:p-12">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-200">CBL AERO</p>
            <h1 className="mt-2 text-3xl font-semibold text-white">Operations Dashboard</h1>
          </div>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="rounded-xl border border-emerald-200/45 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-100 hover:bg-emerald-500/10"
            >
              Sign Out
            </button>
          </form>
        </header>

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <article className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Email</p>
            <p className="mt-2 text-sm text-white">{session.email}</p>
          </article>
          <article className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Role</p>
            <p className="mt-2 text-sm text-white">{effectiveRole}</p>
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
                  href={`/dashboard?activeClientId=${encodeURIComponent(clientId)}`}
                  className={`rounded-full border px-3 py-1 transition ${
                    clientId === activeClientId
                      ? "border-emerald-200/70 bg-emerald-500/20 text-emerald-100"
                      : "border-white/20 text-slate-200 hover:border-emerald-200/50 hover:text-emerald-100"
                  }`}
                >
                  {clientId}
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-8 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-5 text-sm text-emerald-50">
          Enterprise access is active. Continue to module workflows and API operations from
          this protected workspace.
        </div>

        <div className="mt-6">
          <div className="flex flex-wrap gap-5 text-sm font-medium">
            <Link href="/" className="text-emerald-200 hover:text-emerald-100">
              Return to Home
            </Link>
            {effectiveRole === "admin" ? (
              <Link
                href={`/dashboard/admin?activeClientId=${encodeURIComponent(activeClientId)}`}
                className="text-emerald-200 hover:text-emerald-100"
              >
                Open Admin Console
              </Link>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}