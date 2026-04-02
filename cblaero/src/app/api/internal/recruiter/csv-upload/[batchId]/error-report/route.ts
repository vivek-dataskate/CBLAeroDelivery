import { NextRequest, NextResponse } from "next/server";

import { authorizeAccess, validateActiveSession } from "@/modules/auth";
import { recordImportBatchAccessEvent } from "@/modules/audit";
import { getSupabaseAdminClient, shouldUseInMemoryPersistenceForTests } from "@/modules/persistence";

import { extractSessionToken, findCsvUploadBatchForTenant, listCsvUploadErrorsForBatch, toErrorCode } from "../../shared";

type ImportRowErrorRow = {
  row_number: number;
  error_code: string;
  error_detail: string | null;
  raw_data: Record<string, string>;
};

function escapeCsvValue(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function toCsv(errors: ImportRowErrorRow[]): string {
  const header = "row_number,error_code,error_detail,raw_data";
  if (errors.length === 0) {
    return `${header}\n`;
  }

  const lines = errors.map((error) => {
    const rawData = JSON.stringify(error.raw_data ?? {});
    return [
      String(error.row_number),
      escapeCsvValue(error.error_code),
      escapeCsvValue(error.error_detail ?? ""),
      escapeCsvValue(rawData),
    ].join(",");
  });

  return [header, ...lines].join("\n");
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
          message: "Access denied. CSV error report requires recruiter, delivery-head, or admin role.",
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

  let errors: ImportRowErrorRow[] = [];

  if (shouldUseInMemoryPersistenceForTests()) {
    const batch = findCsvUploadBatchForTenant(batchId, tenantId);
    if (!batch) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Import batch not found." } },
        { status: 404 },
      );
    }

    errors = listCsvUploadErrorsForBatch(batchId).map((error) => ({
      row_number: error.row_number,
      error_code: error.error_code,
      error_detail: error.error_detail,
      raw_data: error.raw_data,
    }));
  } else {
    const client = getSupabaseAdminClient();
    const { data: batchData, error: batchError } = await client
      .from("import_batch")
      .select("id")
      .eq("id", batchId)
      .eq("tenant_id", tenantId)
      .single();

    if (batchError || !batchData) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Import batch not found." } },
        { status: 404 },
      );
    }

    const { data: errorRows, error: rowError } = await client
      .from("import_row_error")
      .select("row_number, error_code, error_detail, raw_data")
      .eq("batch_id", batchId)
      .order("row_number", { ascending: true });

    if (rowError) {
      return NextResponse.json(
        { error: { code: "database_error", message: "Failed to load import row errors." } },
        { status: 500 },
      );
    }

    errors = (errorRows ?? []) as ImportRowErrorRow[];
  }

  try {
    await recordImportBatchAccessEvent({
      traceId,
      actorId: session.actorId,
      tenantId,
      batchId,
      action: "download_csv_error_report",
    });
  } catch (error) {
    console.error("[recruiter/csv-upload/:batchId/error-report] failed to persist audit event", {
      traceId,
      batchId,
      tenantId,
      actorId: session.actorId,
      error,
    });
  }

  const csv = toCsv(errors);
  const fileName = `error-report-${batchId.slice(0, 8)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename=\"${fileName}\"`,
      "cache-control": "no-store",
    },
  });
}
