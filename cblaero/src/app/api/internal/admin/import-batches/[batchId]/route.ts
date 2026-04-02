import { NextRequest, NextResponse } from "next/server";

import { authorizeAccess, extractSessionToken, toErrorCode, validateActiveSession } from "@/modules/auth";
import { recordImportBatchAccessEvent } from "@/modules/audit";
import {
  getSupabaseAdminClient,
  shouldUseInMemoryPersistenceForTests,
} from "@/modules/persistence";

type ImportBatchRow = {
  id: string;
  tenant_id: string;
  source: string;
  status: string;
  total_rows: number;
  imported: number;
  skipped: number;
  errors: number;
  error_threshold_pct: number;
  created_by_actor_id: string | null;
  started_at: string;
  completed_at: string | null;
};

type ImportRowErrorRow = {
  id: number;
  batch_id: string;
  row_number: number;
  error_code: string;
  error_detail: string | null;
  occurred_at: string;
};

export type ImportBatchDetail = {
  id: string;
  tenantId: string;
  source: string;
  status: string;
  totalRows: number;
  imported: number;
  skipped: number;
  errors: number;
  errorThresholdPct: number;
  createdByActorId: string | null;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  recentErrors: Array<{
    id: number;
    rowNumber: number;
    errorCode: string;
    errorDetail: string | null;
    occurredAt: string;
  }>;
};

function toDetail(batch: ImportBatchRow, errors: ImportRowErrorRow[]): ImportBatchDetail {
  const startedMs = new Date(batch.started_at).getTime();
  const completedMs = batch.completed_at ? new Date(batch.completed_at).getTime() : null;
  const elapsedMs = completedMs !== null ? completedMs - startedMs : Date.now() - startedMs;

  return {
    id: batch.id,
    tenantId: batch.tenant_id,
    source: batch.source,
    status: batch.status,
    totalRows: batch.total_rows,
    imported: batch.imported,
    skipped: batch.skipped,
    errors: batch.errors,
    errorThresholdPct: batch.error_threshold_pct,
    createdByActorId: batch.created_by_actor_id,
    startedAt: batch.started_at,
    completedAt: batch.completed_at,
    elapsedMs,
    recentErrors: errors.map((e) => ({
      id: e.id,
      rowNumber: e.row_number,
      errorCode: e.error_code,
      errorDetail: e.error_detail,
      occurredAt: e.occurred_at,
    })),
  };
}

// In-memory store for tests
const inMemoryBatches: ImportBatchRow[] = [];
const inMemoryRowErrors: ImportRowErrorRow[] = [];

export function seedImportBatchDetailForTest(
  batch: ImportBatchRow,
  errors: ImportRowErrorRow[] = [],
): void {
  inMemoryBatches.push(batch);
  inMemoryRowErrors.push(...errors);
}

export function clearImportBatchDetailForTest(): void {
  inMemoryBatches.length = 0;
  inMemoryRowErrors.length = 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const session = await validateActiveSession(extractSessionToken(request));

  const authz = await authorizeAccess({
    session,
    action: "admin:read-import-batches",
    path: request.nextUrl.pathname,
    method: request.method,
    traceId,
  });

  if (!authz.allowed) {
    return NextResponse.json(
      {
        error: {
          code: toErrorCode(authz.reason),
          message: "Access denied. Admin role required to view import batch details.",
        },
      },
      { status: authz.status },
    );
  }

  // Defensive narrowing for TypeScript; authorizeAccess already rejects null sessions.
  if (!session) {
    return NextResponse.json(
      {
        error: {
          code: "unauthenticated",
          message: "Authentication required.",
        },
      },
      { status: 401 },
    );
  }

  try {
    await recordImportBatchAccessEvent({
      traceId,
      actorId: session.actorId,
      tenantId: session.tenantId,
      batchId,
      action: "read_import_batch_detail",
    });
  } catch (error) {
    console.error("[admin/import-batches/:batchId] failed to persist audit event; continuing response", {
      traceId,
      actorId: session.actorId,
      tenantId: session.tenantId,
      batchId,
      error,
    });
  }

  if (shouldUseInMemoryPersistenceForTests()) {
    const batch = inMemoryBatches.find(
      (b) => b.id === batchId && b.tenant_id === session.tenantId,
    );
    if (!batch) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Import batch not found." } },
        { status: 404 },
      );
    }
    const errors = inMemoryRowErrors.filter((e) => e.batch_id === batchId).slice(0, 50);
    return NextResponse.json({ data: toDetail(batch, errors) });
  }

  const client = getSupabaseAdminClient();

  const { data: batchData, error: batchError } = await client
    .from("import_batch")
    .select("*")
    .eq("id", batchId)
    .eq("tenant_id", session.tenantId)
    .single();

  if (batchError || !batchData) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Import batch not found." } },
      { status: 404 },
    );
  }

  const { data: errorData } = await client
    .from("import_row_error")
    .select("id, batch_id, row_number, error_code, error_detail, occurred_at")
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true })
    .limit(50);

  return NextResponse.json({
    data: toDetail(batchData as ImportBatchRow, (errorData ?? []) as ImportRowErrorRow[]),
  });
}
