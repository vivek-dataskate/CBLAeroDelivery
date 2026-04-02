import { NextRequest, NextResponse } from 'next/server';
import { authorizeAccess, validateActiveSession } from '@/modules/auth';
import { recordImportBatchAccessEvent } from '@/modules/audit';
import { getSupabaseAdminClient } from '@/modules/persistence';
import { mapToCandidateRow } from '@/modules/ingestion';
import {
  extractSessionToken,
  finalizeInMemoryResumeBatch,
  getInMemoryResumeBatch,
  isInMemoryMode,
  toErrorCode,
} from '../../shared';

interface ConfirmedCandidate {
  submissionId: string;
  edits?: Record<string, unknown>;
}

interface ConfirmPayload {
  confirmed: ConfirmedCandidate[];
  rejected: string[];
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params;
  const traceId = request.headers.get('x-trace-id') ?? crypto.randomUUID();
  const session = await validateActiveSession(extractSessionToken(request));
  const requestedTenantId =
    request.headers.get('x-active-client-id')?.trim() || session?.tenantId || null;

  const authz = await authorizeAccess({
    session,
    action: 'recruiter:csv-upload',
    path: request.nextUrl.pathname,
    method: request.method,
    requestedTenantId,
    traceId,
  });

  if (!authz.allowed) {
    return NextResponse.json(
      { error: { code: toErrorCode(authz.reason), message: 'Access denied.' } },
      { status: authz.status }
    );
  }

  if (!session) {
    return NextResponse.json(
      { error: { code: 'unauthenticated', message: 'Authentication required.' } },
      { status: 401 }
    );
  }

  const tenantId = requestedTenantId ?? session.tenantId;

  let payload: ConfirmPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Expected JSON body with confirmed and rejected arrays.' } },
      { status: 400 }
    );
  }

  if (!Array.isArray(payload.confirmed) || !Array.isArray(payload.rejected)) {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Body must include confirmed[] and rejected[] arrays.' } },
      { status: 400 }
    );
  }

  if (isInMemoryMode()) {
    const batch = getInMemoryResumeBatch(batchId, tenantId);
    if (!batch) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Batch not found.' } },
        { status: 404 }
      );
    }

    if (batch.status === 'complete') {
      return NextResponse.json(
        { error: { code: 'already_confirmed', message: 'This batch has already been confirmed.' } },
        { status: 409 }
      );
    }

    const imported = payload.confirmed.length;
    const skipped = payload.rejected.length;
    const errors = batch.files.filter((f) => f.status === 'failed').length;

    finalizeInMemoryResumeBatch(batchId, tenantId, { imported, skipped, errors });

    await recordImportBatchAccessEvent({
      traceId,
      actorId: session.actorId,
      tenantId,
      batchId,
      action: 'resume_confirm_access',
    });

    return NextResponse.json({
      data: { batchId, status: 'complete', imported, skipped, errors },
      meta: {},
    });
  }

  // Supabase mode
  const db = getSupabaseAdminClient();

  const { data: batch, error: batchErr } = await db
    .from('import_batch')
    .select('id, status')
    .eq('id', batchId)
    .eq('tenant_id', tenantId)
    .single();

  if (batchErr || !batch) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Batch not found.' } },
      { status: 404 }
    );
  }

  if (batch.status === 'complete') {
    return NextResponse.json(
      { error: { code: 'already_confirmed', message: 'This batch has already been confirmed.' } },
      { status: 409 }
    );
  }

  const skipped = payload.rejected.length;

  // Batch-fetch all confirmed submissions in one query
  const confirmedIds = payload.confirmed.map((c) => c.submissionId);
  const editsMap = new Map(
    payload.confirmed.filter((c) => c.edits).map((c) => [c.submissionId, c.edits!])
  );

  const { data: submissions } = confirmedIds.length > 0
    ? await db
        .from('candidate_submissions')
        .select('id, extracted_data, attachments')
        .in('id', confirmedIds)
        .eq('tenant_id', tenantId)
        .eq('import_batch_id', batchId)
    : { data: [] as Array<{ id: string; extracted_data: unknown; attachments: unknown }> };

  // Whitelist of editable fields to prevent field injection
  const ALLOWED_EDIT_KEYS = new Set([
    'firstName', 'lastName', 'middleName', 'email', 'phone', 'location',
    'jobTitle', 'skills', 'certifications', 'yearsOfExperience',
    'workAuthorization', 'aircraftExperience', 'hasAPLicense', 'clearance',
    'employmentType', 'client', 'currentRate',
  ]);

  const candidateRows: Array<Record<string, unknown>> = [];
  const submissionEmails: Array<{ submissionId: string; email: string | null }> = [];

  let rowNum = 0;
  for (const submission of submissions ?? []) {
    if (!submission.extracted_data) continue;
    rowNum++;

    const extraction = submission.extracted_data as Record<string, unknown>;
    const rawEdits = editsMap.get(submission.id);
    // Only apply whitelisted edit keys
    const safeEdits: Record<string, unknown> = {};
    if (rawEdits) {
      for (const key of Object.keys(rawEdits)) {
        if (ALLOWED_EDIT_KEYS.has(key)) safeEdits[key] = rawEdits[key];
      }
    }
    const merged = Object.keys(safeEdits).length > 0 ? { ...extraction, ...safeEdits } : extraction;

    const baseRow = mapToCandidateRow(
      { ...merged, createdByActorId: session.actorId },
      'resume_upload',
      { ingestion_state: 'pending_enrichment' },
    );
    const email = baseRow.email;

    candidateRows.push({
      ...baseRow,
      tenant_id: tenantId,
      row_number: rowNum,
      raw_data: merged,
      source_batch_id: batchId,
      extra_attributes: {},
    });

    submissionEmails.push({ submissionId: submission.id, email });
  }

  let imported = 0;

  if (candidateRows.length > 0) {
    const { data: rpcResult, error: rpcError } = await db.rpc('process_import_chunk', {
      p_batch_id: batchId,
      p_candidates: candidateRows,
      p_error_rows: [],
      p_total_imported: 0,
      p_total_skipped: skipped,
      p_total_errors: 0,
    });

    if (rpcError) {
      console.error(`[ResumeConfirm] RPC failed for batch ${batchId}:`, rpcError.message);
    } else {
      const result = Array.isArray(rpcResult) ? rpcResult[0] : null;
      if (result) {
        imported = Number(result.imported);
      }
    }

    // Batch-fetch persisted candidates by email to link submissions
    const emailsToLink = submissionEmails.filter((s) => s.email).map((s) => s.email!);
    if (emailsToLink.length > 0) {
      const { data: candidates } = await db
        .from('candidates')
        .select('id, email')
        .in('email', emailsToLink)
        .eq('tenant_id', tenantId);

      if (candidates && candidates.length > 0) {
        const emailToId = new Map(candidates.map((c: { id: string; email: string }) => [c.email, c.id]));
        const updates = submissionEmails
          .filter((s) => s.email && emailToId.has(s.email))
          .map((s) => ({ submissionId: s.submissionId, candidateId: emailToId.get(s.email!)! }));

        // Batch update submissions grouped by candidate_id (parallel)
        const byCandidateId = new Map<string, string[]>();
        for (const u of updates) {
          const arr = byCandidateId.get(u.candidateId) ?? [];
          arr.push(u.submissionId);
          byCandidateId.set(u.candidateId, arr);
        }
        await Promise.all(
          [...byCandidateId.entries()].map(([candidateId, subIds]) =>
            db
              .from('candidate_submissions')
              .update({ candidate_id: candidateId })
              .in('id', subIds)
          )
        );
      }
    }
  }

  // Count failed extractions (submissions with null extracted_data)
  const { count: errorCount } = await db
    .from('candidate_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('import_batch_id', batchId)
    .eq('tenant_id', tenantId)
    .is('extracted_data', null);
  const errors = errorCount ?? 0;

  await db
    .from('import_batch')
    .update({
      status: 'complete',
      imported,
      skipped,
      errors,
      completed_at: new Date().toISOString(),
    })
    .eq('id', batchId);

  await recordImportBatchAccessEvent({
    traceId,
    actorId: session.actorId,
    tenantId,
    batchId,
    action: 'resume_confirm_access',
  });

  return NextResponse.json({
    data: { batchId, status: 'complete', imported, skipped, errors },
    meta: {},
  });
}
