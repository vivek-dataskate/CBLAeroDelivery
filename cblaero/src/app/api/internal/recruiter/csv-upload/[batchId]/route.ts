import { NextResponse } from "next/server";

import { withAuth } from "@/modules/auth";
import { recordImportBatchAccessEvent } from "@/modules/audit";
import { shouldUseInMemoryPersistenceForTests } from "@/modules/persistence";
import { getImportBatchById } from "@/features/candidate-management/infrastructure/import-batch-repository";

import { findCsvUploadBatchForTenant, toBatchStatusPayload, type CsvUploadBatchRow } from "../shared";

export const GET = withAuth<{ batchId: string }>(async ({ session, params, traceId, request }) => {
  const { batchId } = params;
  const requestedTenantId = request.headers.get("x-active-client-id")?.trim() || null;
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
}, { action: "recruiter:csv-upload" });
