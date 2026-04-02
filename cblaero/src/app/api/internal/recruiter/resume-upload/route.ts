import { NextRequest, NextResponse } from 'next/server';
import { authorizeAccess, validateActiveSession } from '@/modules/auth';
import { recordImportBatchAccessEvent } from '@/modules/audit';
import { getSupabaseAdminClient } from '@/modules/persistence';
import { extractCandidateFromDocument } from '@/features/candidate-management/application/candidate-extraction';
import {
  createInMemoryResumeBatch,
  extractSessionToken,
  getInMemoryResumeBatch,
  isInMemoryMode,
  toErrorCode,
  type ResumeFileResult,
} from './shared';

const BATCH_SIZE = 50;
const ATTACHMENT_BUCKET = 'candidate-attachments';
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
  if (isInMemoryMode()) {
    const batch = createInMemoryResumeBatch(tenantId);
    batchId = batch.id;
  } else {
    const db = getSupabaseAdminClient();
    const { data: batchRow, error: batchError } = await db
      .from('import_batch')
      .insert({
        tenant_id: tenantId,
        source: 'resume_upload',
        status: 'processing',
        total_rows: files.length,
        created_by_actor_id: session.actorId,
      })
      .select('id')
      .single();

    if (batchError || !batchRow) {
      return NextResponse.json(
        { error: { code: 'database_error', message: 'Failed to create import batch.' } },
        { status: 500 }
      );
    }
    batchId = String(batchRow.id);
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

          let storageUrl = '';
          let storageWarning: string | undefined;
          if (!isInMemoryMode()) {
            const db = getSupabaseAdminClient();
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const storagePath = `resume-uploads/${tenantId}/${batchId}/${submissionId}/${safeName}`;

            const { error: uploadError } = await db.storage
              .from(ATTACHMENT_BUCKET)
              .upload(storagePath, buffer, {
                contentType: 'application/pdf',
                upsert: true,
              });

            if (uploadError) {
              console.error(`[ResumeUpload] Storage upload failed for ${file.name}:`, uploadError.message);
              storageWarning = 'PDF storage failed — the original file may not be retrievable.';
            } else {
              const { data: urlData } = db.storage.from(ATTACHMENT_BUCKET).getPublicUrl(storagePath);
              storageUrl = urlData.publicUrl;
            }
          }

          const result = await extractCandidateFromDocument(buffer, 'pdf', {
            source: 'resume_upload',
            tenantId,
            batchId,
          });

          if (result.error || !result.extraction) {
            if (!isInMemoryMode()) {
              const db = getSupabaseAdminClient();
              await db.from('candidate_submissions').insert({
                id: submissionId,
                tenant_id: tenantId,
                source: 'resume_upload',
                import_batch_id: batchId,
                extracted_data: null,
                extraction_model: 'claude-haiku-4-5-20251001',
                attachments: [{ filename: file.name, url: storageUrl, size: buffer.length }],
              });
            }

            return {
              filename: file.name,
              status: 'failed',
              error: result.error ?? 'Extraction returned no data',
              storageUrl,
              storageWarning,
              submissionId,
            };
          }

          if (!isInMemoryMode()) {
            const db = getSupabaseAdminClient();
            await db.from('candidate_submissions').insert({
              id: submissionId,
              tenant_id: tenantId,
              source: 'resume_upload',
              import_batch_id: batchId,
              extracted_data: result.extraction,
              extraction_model: 'claude-haiku-4-5-20251001',
              attachments: [{ filename: file.name, url: storageUrl, size: buffer.length }],
            });
          }

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

  if (isInMemoryMode()) {
    const batch = getInMemoryResumeBatch(batchId, tenantId);
    if (batch) {
      batch.files = fileResults;
    }
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
