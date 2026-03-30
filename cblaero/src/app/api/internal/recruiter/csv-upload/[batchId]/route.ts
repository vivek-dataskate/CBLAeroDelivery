import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";
import { getSupabaseAdminClient, shouldUseInMemoryPersistenceForTests } from "@/modules/persistence";

import { findCsvUploadBatchForTenant, toBatchStatusPayload } from "../shared";

type ImportBatchRow = {
  id: string;
  tenant_id: string;
  status: "validating" | "running" | "paused_on_error_threshold" | "complete" | "rolled_back";
  imported: number;
  skipped: number;
  errors: number;
  total_rows: number;
  started_at: string;
  completed_at: string | null;
};

function toErrorCode(reason: "unauthenticated" | "forbidden_role" | "tenant_mismatch"): string {
  if (reason === "unauthenticated") return "unauthenticated";
  if (reason === "tenant_mismatch") return "tenant_forbidden";
  return "forbidden";
}

function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

function toResponsePayload(batch: ImportBatchRow) {
  const startedMs = new Date(batch.started_at).getTime();
  const completedMs = batch.completed_at ? new Date(batch.completed_at).getTime() : Date.now();

  return {
    batchId: batch.id,
    status: batch.status,
    imported: batch.imported,
    skipped: batch.skipped,
    errors: batch.errors,
    totalRows: batch.total_rows,
    startedAt: batch.started_at,
    completedAt: batch.completed_at,
    elapsedMs:
      Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? Math.max(0, completedMs - startedMs)
        : null,
  };
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

  return NextResponse.json({ data: toResponsePayload(data as ImportBatchRow), meta: {} });
}
