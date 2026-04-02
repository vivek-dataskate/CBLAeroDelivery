import { NextRequest, NextResponse } from "next/server";

import { authorizeAccess, validateActiveSession } from "@/modules/auth";
import { recordImportBatchAccessEvent } from "@/modules/audit";
import {
  getSupabaseAdminClient,
  shouldUseInMemoryPersistenceForTests,
} from "@/modules/persistence";
import {
  type CanonicalField,
  CANONICAL_FIELDS,
  EMAIL_REGEX,
  FIELD_ALIASES,
  inferFieldForHeader,
  normalizeHeaderKey,
  parseCsv,
} from "@/modules/csv";

import {
  appendInMemoryCsvErrors,
  createInMemoryCsvBatch,
  CSV_PROCESSING_CHUNK_SIZE,
  finalizeInMemoryCsvBatch,
  listCsvUploadBatchesForTest,
  listCsvCandidatesForTest,
  listCsvUploadErrorsForTest,
  markInMemoryCsvBatchRunning,
  MAX_EXTRA_ATTRIBUTE_BYTES,
  MAX_EXTRA_ATTRIBUTE_KEYS,
  MAX_RECRUITER_CSV_ROWS,
  toBatchStatusPayload,
  upsertInMemoryCandidates,
  clearCsvUploadStoreForTest,
  toErrorCode,
  extractSessionToken,
  type CsvCandidateRow,
} from "./shared";

type ColumnMap = Record<string, CanonicalField>;

type PreparedCandidate = CsvCandidateRow & {
  rowNumber: number;
  rawData: Record<string, string>;
};

type PreparedErrorRow = {
  rowNumber: number;
  rawData: Record<string, string>;
  errorCode: string;
  errorDetail: string;
};

const BLOCKED_EXTRA_ATTRIBUTE_KEYS = new Set(["password", "token", "secret", "api_key"]);

function parseColumnMap(input: string | null): ColumnMap {
  if (!input) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("invalid_column_map");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_column_map");
  }

  const map: ColumnMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("invalid_column_map");
    }

    if (!CANONICAL_FIELDS.has(value as CanonicalField)) {
      throw new Error("invalid_column_map");
    }

    map[key] = value as CanonicalField;
  }

  return map;
}

function normalizeAvailabilityStatus(value: string): "active" | "passive" | "unavailable" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "passive" || normalized === "unavailable") {
    return normalized;
  }

  return "passive";
}

function parseSkills(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  const parts = value
    .split(/[;,|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return [...new Set(parts)];
}

function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length < 7) {
    return null;
  }

  return digits;
}

function toEffectiveMapping(headers: string[], columnMap: ColumnMap): ColumnMap {
  const effective: ColumnMap = {};
  for (const header of headers) {
    effective[header] = columnMap[header] ?? inferFieldForHeader(header);
  }
  return effective;
}

function prepareRows(input: {
  headers: string[];
  rows: Array<Record<string, string>>;
  tenantId: string;
  batchId: string;
  actorId: string;
  mapping: ColumnMap;
}): {
  candidates: PreparedCandidate[];
  errors: PreparedErrorRow[];
} {
  const candidates: PreparedCandidate[] = [];
  const errors: PreparedErrorRow[] = [];

  for (let index = 0; index < input.rows.length; index += 1) {
    const rawData = input.rows[index];
    const rowNumber = index + 2;

    const mappedValues: Partial<Record<Exclude<CanonicalField, "(ignore)">, string>> = {};
    const extraAttributes: Record<string, string> = {};

    for (const header of input.headers) {
      const value = (rawData[header] ?? "").trim();
      const mappedField = input.mapping[header] ?? "(ignore)";
      if (mappedField !== "(ignore)") {
        mappedValues[mappedField] = value;
      }
    }

    for (const header of input.headers) {
      const mappedField = input.mapping[header] ?? "(ignore)";
      if (mappedField !== "(ignore)") {
        continue;
      }

      const value = (rawData[header] ?? "").trim();
      if (!value) {
        continue;
      }

      const normalizedKey = normalizeHeaderKey(header);
      if (!normalizedKey || BLOCKED_EXTRA_ATTRIBUTE_KEYS.has(normalizedKey)) {
        continue;
      }

      extraAttributes[normalizedKey] = value;
    }

    const extraAttributeKeys = Object.keys(extraAttributes);
    if (extraAttributeKeys.length > MAX_EXTRA_ATTRIBUTE_KEYS) {
      errors.push({
        rowNumber,
        rawData,
        errorCode: "invalid_format",
        errorDetail: `extra_attributes exceeds ${MAX_EXTRA_ATTRIBUTE_KEYS} keys`,
      });
      continue;
    }

    if (Buffer.byteLength(JSON.stringify(extraAttributes), "utf8") > MAX_EXTRA_ATTRIBUTE_BYTES) {
      errors.push({
        rowNumber,
        rawData,
        errorCode: "invalid_format",
        errorDetail: `extra_attributes exceeds ${MAX_EXTRA_ATTRIBUTE_BYTES} bytes`,
      });
      continue;
    }

    const firstName = (mappedValues.first_name ?? "").trim();
    const lastName = (mappedValues.last_name ?? "").trim();
    const email = (mappedValues.email ?? "").trim().toLowerCase();
    const mobile = normalizePhone(mappedValues.mobile ?? "");

    if (!firstName || !lastName || (!email && !mobile)) {
      errors.push({
        rowNumber,
        rawData,
        errorCode: "missing_identity",
        errorDetail: "Row must include first_name, last_name, and at least one of email or mobile.",
      });
      continue;
    }

    if (email && !EMAIL_REGEX.test(email)) {
      errors.push({
        rowNumber,
        rawData,
        errorCode: "invalid_format",
        errorDetail: "Email format is invalid.",
      });
      continue;
    }

    const alternateEmail = (mappedValues.alternate_email ?? "").trim().toLowerCase();
    if (alternateEmail && !EMAIL_REGEX.test(alternateEmail)) {
      errors.push({
        rowNumber,
        rawData,
        errorCode: "invalid_format",
        errorDetail: "Alternate email format is invalid.",
      });
      continue;
    }

    if ((mappedValues.mobile ?? "").trim().length > 0 && !mobile) {
      errors.push({
        rowNumber,
        rawData,
        errorCode: "invalid_format",
        errorDetail: "Mobile phone format is invalid.",
      });
      continue;
    }

    const homePhone = normalizePhone(mappedValues.home_phone ?? "");
    const workPhone = normalizePhone(mappedValues.work_phone ?? "");

    candidates.push({
      rowNumber,
      rawData,
      tenant_id: input.tenantId,
      email: email || null,
      phone: mobile,
      first_name: firstName,
      last_name: lastName,
      middle_name: (mappedValues.middle_name ?? "").trim() || null,
      home_phone: homePhone,
      work_phone: workPhone,
      location: null,
      address: (mappedValues.address ?? "").trim() || null,
      city: (mappedValues.city ?? "").trim() || null,
      state: (mappedValues.state ?? "").trim() || null,
      country: (mappedValues.country ?? "").trim() || null,
      postal_code: (mappedValues.postal_code ?? "").trim() || null,
      current_company: (mappedValues.current_company ?? "").trim() || null,
      job_title: (mappedValues.job_title ?? "").trim() || null,
      alternate_email: alternateEmail || null,
      skills: parseSkills(mappedValues.skills ?? ""),
      availability_status: normalizeAvailabilityStatus(mappedValues.availability_status ?? ""),
      ingestion_state: "pending_enrichment",
      source: "csv_upload",
      source_batch_id: input.batchId,
      created_by_actor_id: input.actorId,
      extra_attributes: extraAttributes,
    });
  }

  return { candidates, errors };
}

function isCsvFile(file: File): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return type.includes("csv") || name.endsWith(".csv");
}

async function processSupabaseBatch(input: {
  batchId: string;
  candidates: PreparedCandidate[];
  errors: PreparedErrorRow[];
}): Promise<{ imported: number; skipped: number; errors: number }> {
  const client = getSupabaseAdminClient();

  const toRpcCandidate = (candidate: PreparedCandidate) => ({
    row_number: candidate.rowNumber,
    raw_data: candidate.rawData,
    tenant_id: candidate.tenant_id,
    email: candidate.email,
    phone: candidate.phone,
    first_name: candidate.first_name,
    last_name: candidate.last_name,
    middle_name: candidate.middle_name,
    home_phone: candidate.home_phone,
    work_phone: candidate.work_phone,
    location: candidate.location,
    address: candidate.address,
    city: candidate.city,
    state: candidate.state,
    country: candidate.country,
    postal_code: candidate.postal_code,
    current_company: candidate.current_company,
    job_title: candidate.job_title,
    alternate_email: candidate.alternate_email,
    skills: candidate.skills,
    availability_status: candidate.availability_status,
    ingestion_state: candidate.ingestion_state,
    source: candidate.source,
    source_batch_id: candidate.source_batch_id,
    created_by_actor_id: candidate.created_by_actor_id,
    extra_attributes: candidate.extra_attributes,
  });

  const toRpcError = (error: PreparedErrorRow) => ({
    row_number: error.rowNumber,
    raw_data: error.rawData,
    error_code: error.errorCode,
    error_detail: error.errorDetail,
  });

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const allCandidates = input.candidates.map(toRpcCandidate);
  const allErrors = input.errors.map(toRpcError);

  for (let start = 0; start < Math.max(allCandidates.length, 1); start += CSV_PROCESSING_CHUNK_SIZE) {
    const candidateChunk = allCandidates.slice(start, start + CSV_PROCESSING_CHUNK_SIZE);
    const errorChunk = start === 0 ? allErrors : [];

    const { data, error } = await client.rpc("process_import_chunk", {
      p_batch_id: input.batchId,
      p_candidates: candidateChunk,
      p_error_rows: errorChunk,
      p_total_imported: imported,
      p_total_skipped: skipped,
      p_total_errors: errors,
    });

    if (error) {
      throw new Error(`Failed to process import chunk: ${error.message}`);
    }

    const rpcResult = Array.isArray(data) ? data[0] : null;
    if (!rpcResult) {
      throw new Error("process_import_chunk RPC returned no result");
    }
    imported += Number(rpcResult.imported);
    skipped += Number(rpcResult.skipped);
    errors += Number(rpcResult.errors);
  }

  return { imported, skipped, errors };
}

function processInMemoryBatch(input: {
  batchId: string;
  candidates: PreparedCandidate[];
  errors: PreparedErrorRow[];
}): { imported: number; skipped: number; errors: number } {
  appendInMemoryCsvErrors(
    input.batchId,
    input.errors.map((error) => ({
      rowNumber: error.rowNumber,
      rawData: error.rawData,
      errorCode: error.errorCode,
      errorDetail: error.errorDetail,
    })),
  );

  const { inserted, updated } = upsertInMemoryCandidates(
    input.candidates.map((candidate) => ({
      tenant_id: candidate.tenant_id,
      email: candidate.email,
      phone: candidate.phone,
      first_name: candidate.first_name,
      last_name: candidate.last_name,
      middle_name: candidate.middle_name,
      home_phone: candidate.home_phone,
      work_phone: candidate.work_phone,
      location: candidate.location,
      address: candidate.address,
      city: candidate.city,
      state: candidate.state,
      country: candidate.country,
      postal_code: candidate.postal_code,
      current_company: candidate.current_company,
      job_title: candidate.job_title,
      alternate_email: candidate.alternate_email,
      skills: candidate.skills,
      availability_status: candidate.availability_status,
      ingestion_state: candidate.ingestion_state,
      source: candidate.source,
      source_batch_id: candidate.source_batch_id,
      created_by_actor_id: candidate.created_by_actor_id,
      extra_attributes: candidate.extra_attributes,
    })),
  );

  return {
    imported: inserted,
    skipped: updated,
    errors: input.errors.length,
  };
}

export async function POST(request: NextRequest) {
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
          message: "Access denied. CSV upload requires recruiter, delivery-head, or admin role.",
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_form_data", message: "Expected multipart/form-data payload." } },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: { code: "missing_file", message: "CSV file is required." } },
      { status: 400 },
    );
  }

  if (!isCsvFile(file)) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_file_type",
          message: "Only CSV files are supported for recruiter uploads.",
        },
      },
      { status: 415 },
    );
  }

  // Guard against memory exhaustion before reading the full file: 50 MB is far more than
  // any legitimate 10,000-row CSV but prevents egregious payloads from consuming server heap.
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error: {
          code: "file_too_large",
          message: "CSV file must be smaller than 50 MB.",
        },
      },
      { status: 413 },
    );
  }

  let columnMap: ColumnMap = {};
  try {
    columnMap = parseColumnMap((formData.get("columnMap") as string | null) ?? null);
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_column_map",
          message: "columnMap must be valid JSON mapping CSV headers to canonical fields.",
        },
      },
      { status: 400 },
    );
  }

  const csv = parseCsv(await file.text());
  if (csv.rows.length > MAX_RECRUITER_CSV_ROWS) {
    return NextResponse.json(
      {
        error: {
          code: "row_limit_exceeded",
          message: `Recruiter CSV uploads are limited to ${MAX_RECRUITER_CSV_ROWS.toLocaleString()} rows.`,
        },
      },
      { status: 422 },
    );
  }

  if (csv.headers.length === 0 || csv.rows.length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "empty_csv",
          message: "CSV must include a header row and at least one data row.",
        },
      },
      { status: 422 },
    );
  }

  const effectiveMapping = toEffectiveMapping(csv.headers, columnMap);

  let batchId = "";
  let startedAtIso = new Date().toISOString();

  if (shouldUseInMemoryPersistenceForTests()) {
    const batch = createInMemoryCsvBatch({
      tenantId,
      totalRows: csv.rows.length,
      createdByActorId: session.actorId,
    });
    batchId = batch.id;
    startedAtIso = batch.started_at;
    markInMemoryCsvBatchRunning(batch.id);
  } else {
    const client = getSupabaseAdminClient();
    const { data: batchRow, error: batchError } = await client
      .from("import_batch")
      .insert({
        tenant_id: tenantId,
        source: "csv_upload",
        status: "validating",
        total_rows: csv.rows.length,
        created_by_actor_id: session.actorId,
      })
      .select("id, started_at")
      .single();

    if (batchError || !batchRow) {
      return NextResponse.json(
        { error: { code: "database_error", message: "Failed to create import batch." } },
        { status: 500 },
      );
    }

    batchId = String(batchRow.id);
    startedAtIso = String(batchRow.started_at);

    const { error: runningError } = await client
      .from("import_batch")
      .update({ status: "running" })
      .eq("id", batchId);

    if (runningError) {
      return NextResponse.json(
        { error: { code: "database_error", message: "Failed to update import batch status." } },
        { status: 500 },
      );
    }
  }

  const prepared = prepareRows({
    headers: csv.headers,
    rows: csv.rows,
    tenantId,
    batchId,
    actorId: session.actorId,
    mapping: effectiveMapping,
  });

  try {
    const processed = shouldUseInMemoryPersistenceForTests()
      ? processInMemoryBatch({
          batchId,
          candidates: prepared.candidates,
          errors: prepared.errors,
        })
      : await processSupabaseBatch({
          batchId,
          candidates: prepared.candidates,
          errors: prepared.errors,
        });

    if (shouldUseInMemoryPersistenceForTests()) {
      const updated = finalizeInMemoryCsvBatch(batchId, {
        status: "complete",
        imported: processed.imported,
        skipped: processed.skipped,
        errors: processed.errors,
      });

      await recordImportBatchAccessEvent({
        traceId,
        actorId: session.actorId,
        tenantId,
        batchId,
        action: "csv_upload_access",
      });

      return NextResponse.json({
        data: {
          ...(updated ? toBatchStatusPayload(updated) : null),
          batchId,
          status: "complete",
          imported: processed.imported,
          skipped: processed.skipped,
          errors: processed.errors,
          totalRows: csv.rows.length,
          startedAt: startedAtIso,
          completedAt: new Date().toISOString(),
        },
        meta: {},
      });
    }

    const client = getSupabaseAdminClient();
    const completedAtIso = new Date().toISOString();
    const { error: completeError } = await client
      .from("import_batch")
      .update({
        status: "complete",
        imported: processed.imported,
        skipped: processed.skipped,
        errors: processed.errors,
        completed_at: completedAtIso,
      })
      .eq("id", batchId);

    if (completeError) {
      throw new Error(`Failed to finalize import batch: ${completeError.message}`);
    }

    await recordImportBatchAccessEvent({
      traceId,
      actorId: session.actorId,
      tenantId,
      batchId,
      action: "csv_upload_access",
    });

    return NextResponse.json({
      data: {
        batchId,
        status: "complete",
        imported: processed.imported,
        skipped: processed.skipped,
        errors: processed.errors,
        totalRows: csv.rows.length,
        startedAt: startedAtIso,
        completedAt: completedAtIso,
      },
      meta: {},
    });
  } catch (error) {
    if (shouldUseInMemoryPersistenceForTests()) {
      finalizeInMemoryCsvBatch(batchId, {
        status: "rolled_back",
        imported: 0,
        skipped: 0,
        errors: prepared.errors.length,
      });
    } else {
      const client = getSupabaseAdminClient();
      // Compensating delete: remove any candidate rows already committed in earlier chunks
      // so they are not picked up by the enrichment worker with a rolled_back batch.
      try {
        await client.from("candidates").delete().eq("source_batch_id", batchId);
      } catch (deleteError) {
        console.error("[recruiter/csv-upload] compensating candidate delete failed", { traceId, batchId, deleteError });
      }
      try {
        await client
          .from("import_batch")
          .update({ status: "rolled_back", completed_at: new Date().toISOString() })
          .eq("id", batchId);
      } catch (rollbackError) {
        console.error("[recruiter/csv-upload] batch rollback status update failed", { traceId, batchId, rollbackError });
      }
    }

    console.error("[recruiter/csv-upload] batch failed", { traceId, batchId, error });

    return NextResponse.json(
      { error: { code: "processing_error", message: "Failed to process CSV upload." } },
      { status: 500 },
    );
  }
}

export { clearCsvUploadStoreForTest, listCsvUploadBatchesForTest, listCsvUploadErrorsForTest, listCsvCandidatesForTest };
