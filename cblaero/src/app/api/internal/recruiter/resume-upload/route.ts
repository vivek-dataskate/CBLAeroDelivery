import { NextRequest, NextResponse } from 'next/server';
import { authorizeAccess, validateActiveSession } from '@/modules/auth';
import { recordImportBatchAccessEvent } from '@/modules/audit';
import { extractCandidateFromDocument } from '@/features/candidate-management/application/candidate-extraction';
import { createImportBatch } from '@/features/candidate-management/infrastructure/import-batch-repository';
import { insertSubmission, uploadResumeToStorage } from '@/features/candidate-management/infrastructure/submission-repository';
import {
  computeFileHash,
  isAlreadyProcessed,
  recordFingerprint,
} from '@/features/candidate-management/infrastructure/fingerprint-repository';
import {
  extractSessionToken,
  toErrorCode,
  type ResumeFileResult,
} from './shared';

const BATCH_SIZE = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

function isPdfFile(file: File): boolean {
  return (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  );
}

export async function POST(request: NextRequest) {
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
      {
        error: {
          code: toErrorCode(authz.reason),
          message: 'Access denied. Resume upload requires recruiter, delivery-head, or admin role.',
        },
      },
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_form_data', message: 'Expected multipart/form-data payload.' } },
      { status: 400 }
    );
  }

  const files: File[] = [];
  for (const [, value] of formData.entries()) {
    if (value instanceof File && value.size > 0) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: { code: 'missing_file', message: 'At least one PDF file is required.' } },
      { status: 400 }
    );
  }

  const unsupportedFiles = files.filter((f) => !isPdfFile(f));
  if (unsupportedFiles.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_file_type',
          message:
            'Only PDF files are supported. Please convert Word, RTF, or other formats to PDF before uploading.',
          details: { rejectedFiles: unsupportedFiles.map((f) => f.name) },
        },
      },
      { status: 422 }
    );
  }

  // Reject oversized files before processing
  const oversizedFiles = files.filter((f) => f.size > MAX_FILE_BYTES);
  if (oversizedFiles.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: 'file_too_large',
          message: `Each PDF must be smaller than ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
          details: { rejectedFiles: oversizedFiles.map((f) => ({ name: f.name, size: f.size })) },
        },
      },
      { status: 413 }
    );
  }

  let batchId: string;
  try {
    const batch = await createImportBatch({
      tenantId,
      source: 'resume_upload',
      status: 'processing',
      totalRows: files.length,
      createdByActorId: session.actorId,
    });
    batchId = batch.id;
  } catch {
    return NextResponse.json(
      { error: { code: 'database_error', message: 'Failed to create import batch.' } },
      { status: 500 }
    );
  }

  const fileResults: ResumeFileResult[] = [];

  for (let start = 0; start < files.length; start += BATCH_SIZE) {
    const chunk = files.slice(start, start + BATCH_SIZE);

    const chunkResults = await Promise.all(
      chunk.map(async (file): Promise<ResumeFileResult> => {
        const submissionId = crypto.randomUUID();
        try {
          const arrayBuffer = await file.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          // Fingerprint gate: skip LLM extraction if this exact file was already processed
          const fileHash = computeFileHash(buffer);
          if (await isAlreadyProcessed(tenantId, 'file_sha256', fileHash)) {
            console.log(JSON.stringify({ event: 'fingerprint_hit', type: 'file_sha256', source: 'resume_upload', tenantId, hash: fileHash.slice(0, 12) }));
            return {
              filename: file.name,
              status: 'skipped',
              error: 'Duplicate file — already processed',
              submissionId,
            };
          }

          const storage = await uploadResumeToStorage(buffer, file.name, tenantId, batchId, submissionId);
          const storageUrl = storage.url;
          const storageWarning = storage.warning;

          const result = await extractCandidateFromDocument(buffer, 'pdf', {
            source: 'resume_upload',
            tenantId,
            batchId,
          });

          if (result.error || !result.extraction) {
            await insertSubmission({
              id: submissionId,
              tenantId,
              source: 'resume_upload',
              importBatchId: batchId,
              extractedData: null,
              extractionModel: 'claude-haiku-4-5-20251001',
              attachments: [{ filename: file.name, url: storageUrl, size: buffer.length }],
            });

            await recordFingerprint({ tenantId, type: 'file_sha256', hash: fileHash, source: 'resume_upload', status: 'failed' });

            return {
              filename: file.name,
              status: 'failed',
              error: result.error ?? 'Extraction returned no data',
              storageUrl,
              storageWarning,
              submissionId,
            };
          }

          await insertSubmission({
            id: submissionId,
            tenantId,
            source: 'resume_upload',
            importBatchId: batchId,
            extractedData: result.extraction as unknown as Record<string, unknown>,
            extractionModel: 'claude-haiku-4-5-20251001',
            attachments: [{ filename: file.name, url: storageUrl, size: buffer.length }],
          });

          await recordFingerprint({ tenantId, type: 'file_sha256', hash: fileHash, source: 'resume_upload' });

          return {
            filename: file.name,
            status: 'complete',
            extraction: result.extraction,
            storageUrl,
            storageWarning,
            submissionId,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Record failed fingerprint if hash was computed (allows retry on next upload)
          if (typeof fileHash === 'string') {
            recordFingerprint({ tenantId, type: 'file_sha256', hash: fileHash, source: 'resume_upload', status: 'failed' }).catch(() => {});
          }
          return {
            filename: file.name,
            status: 'failed',
            error: message,
            submissionId,
          };
        }
      })
    );

    fileResults.push(...chunkResults);
  }

  await recordImportBatchAccessEvent({
    traceId,
    actorId: session.actorId,
    tenantId,
    batchId,
    action: 'resume_upload_access',
  });

  return NextResponse.json({
    data: {
      batchId,
      files: fileResults.map((f) => ({
        filename: f.filename,
        status: f.status,
        extraction: f.extraction ?? undefined,
        error: f.error ?? undefined,
        storageWarning: f.storageWarning ?? undefined,
        submissionId: f.submissionId,
      })),
    },
    meta: {},
  });
}
