import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";

import UploadModeSelector from "./UploadModeSelector";

async function requireUploadSession() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  const session = await validateActiveSession(sessionToken);

  if (!session) {
    await authorizeAccess({
      session: null,
      action: "recruiter:csv-upload",
      path: "/dashboard/recruiter/upload",
      method: "GET",
    });
    redirect("/api/auth/login?next=%2Fdashboard%2Frecruiter%2Fupload");
  }

  const authz = await authorizeAccess({
    session,
    action: "recruiter:csv-upload",
    path: "/dashboard/recruiter/upload",
    method: "GET",
  });

  if (!authz.allowed) {
    redirect("/dashboard?error=recruiter-upload-forbidden");
  }

  return session;
}

export default async function RecruiterUploadPage() {
  const session = await requireUploadSession();

  return (
    <div className="min-h-screen bg-white px-4 py-6 text-slate-700 md:px-8">
      <main className="mx-auto w-full max-w-5xl rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-8">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">CBL AERO</p>
            <h1 className="mt-1 text-xl font-semibold text-slate-800">Candidate Upload</h1>
            <p className="mt-1 text-xs text-slate-500">
              Signed in as {session.email}. Upload candidate data via CSV or PDF resumes.
            </p>
          </div>
          <Link href="/dashboard" className="text-xs text-slate-500 hover:text-slate-700">
            Return to Dashboard
          </Link>
        </header>

        <div className="mt-5">
          <UploadModeSelector />
        </div>
      </main>
    </div>
  );
}
