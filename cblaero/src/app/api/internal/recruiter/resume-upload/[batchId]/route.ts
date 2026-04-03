import { NextRequest, NextResponse } from 'next/server';
import { authorizeAccess, validateActiveSession } from '@/modules/auth';
import { recordImportBatchAccessEvent } from '@/modules/audit';
import { getImportBatchById } from '@/features/candidate-management/infrastructure/import-batch-repository';
import { listSubmissionsByBatch } from '@/features/candidate-management/infrastructure/submission-repository';
import { extractSessionToken, toErrorCode } from '../shared';

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

  const batch = await getImportBatchById(batchId, tenantId);
  if (!batch) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Batch not found.' } },
      { status: 404 }
    );
  }

  const submissions = await listSubmissionsByBatch(batchId, tenantId);

  const files = submissions.map((s) => {
    const attachments = s.attachments;
    const filename = attachments[0]?.filename ?? 'unknown';
    const hasExtraction = s.extractedData !== null;
    return {
      filename,
      status: hasExtraction ? 'complete' : 'failed',
      submissionId: s.id,
    };
  });

  try {
    await recordImportBatchAccessEvent({
      traceId,
      actorId: session.actorId,
      tenantId,
      batchId,
      action: 'resume_upload_access',
    });
  } catch {
    // Audit is best-effort — do not block status reads
  }

  const complete = files.filter((f) => f.status === 'complete').length;
  const failed = files.filter((f) => f.status === 'failed').length;

  return NextResponse.json({
    data: {
      batchId: batch.id,
      status: batch.status,
      totalFiles: batch.totalRows,
      processed: files.length,
      complete,
      failed,
      imported: batch.imported,
      skipped: batch.skipped,
      errors: batch.errors,
      files,
    },
    meta: {},
  });
}
