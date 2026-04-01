import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from '@/modules/auth';
import { recordImportBatchAccessEvent } from '@/modules/audit';
import { getSupabaseAdminClient } from '@/modules/persistence';
import {
  finalizeInMemoryResumeBatch,
  getInMemoryResumeBatch,
  isInMemoryMode,
} from '../../shared';

interface ConfirmedCandidate {
  submissionId: string;
  edits?: Record<string, unknown>;
}

interface ConfirmPayload {
  confirmed: ConfirmedCandidate[];
  rejected: string[];
}

function toErrorCode(reason: 'unauthenticated' | 'forbidden_role' | 'tenant_mismatch'): string {
  if (reason === 'unauthenticated') return 'unauthenticated';
  if (reason === 'tenant_mismatch') return 'tenant_forbidden';
  return 'forbidden';
}

function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
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

  const skipped = payload.rejected.length;

  // Build all candidate rows in one pass, then send a single RPC call
  const candidateRows: Array<Record<string, unknown>> = [];
  const submissionEmails: Array<{ submissionId: string; email: string | null }> = [];

  for (let i = 0; i < payload.confirmed.length; i++) {
    const confirmed = payload.confirmed[i];
    const { data: submission } = await db
      .from('candidate_submissions')
      .select('id, extracted_data, attachments')
      .eq('id', confirmed.submissionId)
      .eq('tenant_id', tenantId)
      .eq('import_batch_id', batchId)
      .single();

    if (!submission?.extracted_data) continue;

    const extraction = submission.extracted_data as Record<string, unknown>;
    const merged = confirmed.edits ? { ...extraction, ...confirmed.edits } : extraction;
    const attachments = Array.isArray(submission.attachments) ? submission.attachments : [];
    const resumeUrl = attachments[0]?.url ?? null;

    const str = (key: string) => typeof merged[key] === 'string' ? (merged[key] as string).trim() : null;
    const email = str('email')?.toLowerCase() ?? null;

    candidateRows.push({
      row_number: i + 1,
      raw_data: merged,
      tenant_id: tenantId,
      email,
      phone: str('phone'),
      first_name: str('firstName') ?? '',
      last_name: str('lastName') ?? '',
      middle_name: str('middleName'),
      home_phone: null,
      work_phone: null,
      location: str('location'),
      address: str('address'),
      city: str('city'),
      state: str('state'),
      country: str('country'),
      postal_code: str('zipCode'),
      current_company: str('client'),
      job_title: str('jobTitle'),
      alternate_email: null,
      skills: Array.isArray(merged.skills) ? merged.skills : [],
      availability_status: 'active',
      ingestion_state: 'pending_enrichment',
      source: 'resume_upload',
      source_batch_id: batchId,
      resume_url: resumeUrl,
      extra_attributes: {},
    });

    submissionEmails.push({ submissionId: confirmed.submissionId, email });
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

    // Link candidate_submissions to persisted candidates
    for (const { submissionId, email } of submissionEmails) {
      if (!email) continue;
      const { data: insertedCandidate } = await db
        .from('candidates')
        .select('id')
        .eq('email', email)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (insertedCandidate) {
        await db
          .from('candidate_submissions')
          .update({ candidate_id: insertedCandidate.id })
          .eq('id', submissionId);
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
