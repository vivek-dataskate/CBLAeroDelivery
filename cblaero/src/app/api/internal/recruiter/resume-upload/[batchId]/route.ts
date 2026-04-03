import { NextResponse } from 'next/server';
import { withAuth } from '@/modules/auth';
import { recordImportBatchAccessEvent } from '@/modules/audit';
import { getImportBatchById } from '@/features/candidate-management/infrastructure/import-batch-repository';
import { listSubmissionsByBatch } from '@/features/candidate-management/infrastructure/submission-repository';

export const GET = withAuth<{ batchId: string }>(async ({ session, params, traceId, request }) => {
  const { batchId } = params;
  const requestedTenantId =
    request.headers.get('x-active-client-id')?.trim() || null;
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
}, { action: 'recruiter:csv-upload' });
