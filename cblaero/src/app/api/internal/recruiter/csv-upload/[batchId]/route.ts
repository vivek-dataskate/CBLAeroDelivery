import { NextRequest, NextResponse } from "next/server";

import { authorizeAccess, validateActiveSession } from "@/modules/auth";
import { recordImportBatchAccessEvent } from "@/modules/audit";
import { shouldUseInMemoryPersistenceForTests } from "@/modules/persistence";
import { getImportBatchById } from "@/features/candidate-management/infrastructure/import-batch-repository";

import { extractSessionToken, findCsvUploadBatchForTenant, toErrorCode, toBatchStatusPayload, type CsvUploadBatchRow } from "../shared";

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

    try {
      await recordImportBatchAccessEvent({
        traceId,
        actorId: session.actorId,
        tenantId,
        batchId,
        action: "read_import_batch_detail",
      });
    } catch {
      // Audit is best-effort — do not block status reads
    }

    return NextResponse.json({ data: toBatchStatusPayload(batch), meta: {} });
  }

  const batch = await getImportBatchById(batchId, tenantId);

  if (!batch) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Import batch not found." } },
      { status: 404 },
    );
  }

  const batchRow: CsvUploadBatchRow = {
    id: batch.id,
    tenant_id: batch.tenantId,
    source: "csv_upload",
    status: batch.status as CsvUploadBatchRow["status"],
    total_rows: batch.totalRows,
    imported: batch.imported,
    skipped: batch.skipped,
    errors: batch.errors,
    error_threshold_pct: batch.errorThresholdPct,
    created_by_actor_id: batch.createdByActorId,
    started_at: batch.startedAt,
    completed_at: batch.completedAt,
  };

  try {
    await recordImportBatchAccessEvent({
      traceId,
      actorId: session.actorId,
      tenantId,
      batchId,
      action: "read_import_batch_detail",
    });
  } catch {
    // Audit is best-effort — do not block status reads
  }

  return NextResponse.json({ data: toBatchStatusPayload(batchRow), meta: {} });
}
