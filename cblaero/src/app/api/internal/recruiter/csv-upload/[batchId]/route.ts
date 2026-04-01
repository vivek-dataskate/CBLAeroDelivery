import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";
import { getSupabaseAdminClient, shouldUseInMemoryPersistenceForTests } from "@/modules/persistence";

import { findCsvUploadBatchForTenant, toBatchStatusPayload, type CsvUploadBatchRow } from "../shared";

function toErrorCode(reason: "unauthenticated" | "forbidden_role" | "tenant_mismatch"): string {
  if (reason === "unauthenticated") return "unauthenticated";
  if (reason === "tenant_mismatch") return "tenant_forbidden";
  return "forbidden";
}

function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const session = await validateActiveSession(extractSessionToken(request));
  const requestedTenantId = request.headers.get("x-active-client-id")?.trim() || session?.tenantId || null;

  const authz = await authorizeAccess({
    session,
    action: "recruiter:csv-upload",
    path: request.nextUrl.pathname,
    method: request.method,
    requestedTenantId,
    traceId,
  });

  if (!authz.allowed) {
    return NextResponse.json(
      {
        error: {
          code: toErrorCode(authz.reason),
          message: "Access denied. CSV upload status requires recruiter, delivery-head, or admin role.",
        },
      },
      { status: authz.status },
    );
  }

  // TypeScript type narrowing: authorizeAccess() only returns allowed:true when session is
  // non-null (see authorization.ts:105-107). This guard satisfies the type checker only.
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Authentication required." } },
      { status: 401 },
    );
  }

  const tenantId = requestedTenantId ?? session.tenantId;

  if (shouldUseInMemoryPersistenceForTests()) {
    const batch = findCsvUploadBatchForTenant(batchId, tenantId);
    if (!batch) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Import batch not found." } },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: toBatchStatusPayload(batch), meta: {} });
  }

  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("import_batch")
    .select("id, tenant_id, status, imported, skipped, errors, total_rows, started_at, completed_at")
    .eq("id", batchId)
    .eq("tenant_id", tenantId)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Import batch not found." } },
      { status: 404 },
    );
  }

  const batchRow: CsvUploadBatchRow = {
    id: String(data.id),
    tenant_id: String(data.tenant_id),
    source: "csv_upload",
    status: data.status as CsvUploadBatchRow["status"],
    total_rows: Number(data.total_rows),
    imported: Number(data.imported),
    skipped: Number(data.skipped),
    errors: Number(data.errors),
    error_threshold_pct: 5,
    created_by_actor_id: null,
    started_at: String(data.started_at),
    completed_at: data.completed_at ? String(data.completed_at) : null,
  };

  return NextResponse.json({ data: toBatchStatusPayload(batchRow), meta: {} });
}
