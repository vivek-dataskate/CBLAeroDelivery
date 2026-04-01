import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from '@/modules/auth';
import { getSupabaseAdminClient } from '@/modules/persistence';
import { getInMemoryResumeBatch, isInMemoryMode } from '../shared';

function toErrorCode(reason: 'unauthenticated' | 'forbidden_role' | 'tenant_mismatch'): string {
  if (reason === 'unauthenticated') return 'unauthenticated';
  if (reason === 'tenant_mismatch') return 'tenant_forbidden';
  return 'forbidden';
}

function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function GET(
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

  if (isInMemoryMode()) {
    const batch = getInMemoryResumeBatch(batchId, tenantId);
    if (!batch) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Batch not found.' } },
        { status: 404 }
      );
    }

    const complete = batch.files.filter((f) => f.status === 'complete').length;
    const failed = batch.files.filter((f) => f.status === 'failed').length;

    return NextResponse.json({
      data: {
        batchId: batch.id,
        status: batch.status,
        totalFiles: batch.files.length,
        processed: complete + failed,
        complete,
        failed,
        imported: batch.imported,
        skipped: batch.skipped,
        errors: batch.errors,
        files: batch.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          error: f.error ?? undefined,
        })),
      },
      meta: {},
    });
  }

  const db = getSupabaseAdminClient();
  const { data: batch, error: batchErr } = await db
    .from('import_batch')
    .select('id, status, total_rows, imported, skipped, errors, started_at, completed_at')
    .eq('id', batchId)
    .eq('tenant_id', tenantId)
    .single();

  if (batchErr || !batch) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Batch not found.' } },
      { status: 404 }
    );
  }

  const { data: submissions } = await db
    .from('candidate_submissions')
    .select('id, extracted_data, attachments')
    .eq('import_batch_id', batchId)
    .eq('tenant_id', tenantId);

  const files = (submissions ?? []).map((s: { id: string; extracted_data: unknown; attachments: unknown }) => {
    const attachments = Array.isArray(s.attachments) ? s.attachments : [];
    const filename = attachments[0]?.filename ?? 'unknown';
    const hasExtraction = s.extracted_data !== null;
    return {
      filename,
      status: hasExtraction ? 'complete' : 'failed',
      submissionId: s.id,
    };
  });

  return NextResponse.json({
    data: {
      batchId: batch.id,
      status: batch.status,
      totalFiles: batch.total_rows,
      processed: files.length,
      complete: files.filter((f: { status: string }) => f.status === 'complete').length,
      failed: files.filter((f: { status: string }) => f.status === 'failed').length,
      imported: batch.imported,
      skipped: batch.skipped,
      errors: batch.errors,
      files,
    },
    meta: {},
  });
}
