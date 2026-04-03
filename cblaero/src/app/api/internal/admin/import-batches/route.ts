import { NextRequest, NextResponse } from "next/server";

import { authorizeAccess, extractSessionToken, toErrorCode, validateActiveSession } from "@/modules/auth";
import { recordImportBatchAccessEvent } from "@/modules/audit";
import {
  listImportBatchesByTenant,
} from "@/features/candidate-management/infrastructure/import-batch-repository";

export async function GET(request: NextRequest) {
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
          message: "Access denied. Admin role required to view import batches.",
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
      batchId: null,
      action: "list_import_batches",
    });
  } catch (error) {
    console.error("[admin/import-batches] failed to persist audit event; continuing response", {
      traceId,
      actorId: session.actorId,
      tenantId: session.tenantId,
      error,
    });
  }

  const pageStr = request.nextUrl.searchParams.get("page") ?? "1";
  const page = Math.max(1, Number.parseInt(pageStr, 10) || 1);
  const pageSize = 20;

  try {
    const result = await listImportBatchesByTenant(session.tenantId, page, pageSize);

    return NextResponse.json({
      data: result.items.map((batch) => {
        const startedMs = new Date(batch.startedAt).getTime();
        const completedMs = batch.completedAt ? new Date(batch.completedAt).getTime() : null;
        const elapsedMs = completedMs !== null ? completedMs - startedMs : Date.now() - startedMs;

        return {
          id: batch.id,
          tenantId: batch.tenantId,
          source: batch.source,
          status: batch.status,
          totalRows: batch.totalRows,
          imported: batch.imported,
          skipped: batch.skipped,
          errors: batch.errors,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt,
          elapsedMs,
        };
      }),
      meta: { page, pageSize, total: result.total },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "database_error", message: "Failed to load import batches." } },
      { status: 500 },
    );
  }
}
