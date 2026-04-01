import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";
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

export type ImportBatchSummary = {
  id: string;
  tenantId: string;
  source: string;
  status: string;
  totalRows: number;
  imported: number;
  skipped: number;
  errors: number;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
};

function toErrorCode(reason: "unauthenticated" | "forbidden_role" | "tenant_mismatch"): string {
  if (reason === "unauthenticated") return "unauthenticated";
  if (reason === "tenant_mismatch") return "tenant_forbidden";
  return "forbidden";
}

function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

function toSummary(row: ImportBatchRow): ImportBatchSummary {
  const startedMs = new Date(row.started_at).getTime();
  const completedMs = row.completed_at ? new Date(row.completed_at).getTime() : null;
  const elapsedMs = completedMs !== null ? completedMs - startedMs : Date.now() - startedMs;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    source: row.source,
    status: row.status,
    totalRows: row.total_rows,
    imported: row.imported,
    skipped: row.skipped,
    errors: row.errors,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    elapsedMs,
  };
}

// In-memory store for tests (mirrors the pattern from other route modules)
const inMemoryBatches: ImportBatchRow[] = [];

export function seedImportBatchForTest(batch: ImportBatchRow): void {
  inMemoryBatches.push(batch);
}

export function clearImportBatchesForTest(): void {
  inMemoryBatches.length = 0;
}

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
  const offset = (page - 1) * pageSize;

  if (shouldUseInMemoryPersistenceForTests()) {
    const tenantBatches = inMemoryBatches.filter((b) => b.tenant_id === session.tenantId);
    const paginated = tenantBatches.slice(offset, offset + pageSize);
    return NextResponse.json({
      data: paginated.map(toSummary),
      meta: { page, pageSize, total: tenantBatches.length },
    });
  }

  const client = getSupabaseAdminClient();
  const { data, error, count } = await client
    .from("import_batch")
    .select("*", { count: "exact" })
    .eq("tenant_id", session.tenantId)
    .order("started_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (error) {
    return NextResponse.json(
      { error: { code: "database_error", message: "Failed to load import batches." } },
      { status: 500 },
    );
  }

  return NextResponse.json({
    data: (data ?? []).map((row) => toSummary(row as ImportBatchRow)),
    meta: { page, pageSize, total: count ?? 0 },
  });
}
