import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";

import CsvUploadWizard from "./CsvUploadWizard";

async function requireCsvUploadSession() {
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
  const session = await requireCsvUploadSession();

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100 md:px-10">
      <main className="mx-auto w-full max-w-5xl rounded-3xl border border-cyan-300/20 bg-slate-900/60 p-8 md:p-12">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">CBL AERO</p>
            <h1 className="mt-2 text-3xl font-semibold text-white">Recruiter CSV Upload</h1>
            <p className="mt-2 text-sm text-slate-300">
              Signed in as {session.email}. Upload candidate CSV files and review row-level errors.
            </p>
          </div>
          <Link href="/dashboard" className="text-sm text-cyan-200 hover:text-cyan-100">
            Return to Dashboard
          </Link>
        </header>

        <div className="mt-8">
          <CsvUploadWizard />
        </div>
      </main>
    </div>
  );
}
