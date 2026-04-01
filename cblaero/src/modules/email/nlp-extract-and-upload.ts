/**
 * Email-specific candidate extraction — thin wrapper around the unified service.
 *
 * Re-exports CandidateExtraction type for backwards compatibility.
 * Delegates LLM extraction to the centralized candidate-extraction service.
 */

import {
  extractCandidateFromDocument,
  type CandidateExtraction,
} from '../../features/candidate-management/application/candidate-extraction';

// Re-export for backwards compatibility
export type { CandidateExtraction };

export interface AttachmentMeta {
  filename: string;
  url: string;
}

export async function extractCandidateFromEmail(
  emailBody: string,
  subject: string
): Promise<CandidateExtraction> {
  const result = await extractCandidateFromDocument(emailBody, 'email_body', {
    source: 'email',
    tenantId: 'cbl-aero',
    subject,
  });

  if (result.extraction) {
    return result.extraction;
  }

  // On error, return empty non-submission record (matches previous behavior)
  console.error('[NLP Parser] Extraction failed:', result.error);
  return {
    firstName: '',
    lastName: '',
    email: '',
    source: 'email',
    extractionMethod: 'llm' as const,
    isSubmission: false,
  };
}

const ATTACHMENT_BUCKET = 'candidate-attachments';

/**
 * Upload attachment to Supabase Storage.
 * Path: /{candidateId_short}/{submissionId_short}/{filename}
 * Returns the public URL.
 */
export async function uploadAttachmentToStorage(
  db: ReturnType<typeof import('../persistence').getSupabaseAdminClient>,
  buffer: Buffer,
  filename: string,
  candidateId: string,
  submissionId: string
): Promise<{ filename: string; url: string; size: number }> {
  const candidateShort = candidateId.slice(0, 8);
  const submissionShort = submissionId.slice(0, 8);
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${candidateShort}/${submissionShort}/${safeName}`;

  const { error } = await db.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, buffer, {
      contentType: guessMimeType(safeName),
      upsert: true,
    });

  if (error) {
    console.error(`[Attachment] Upload failed for ${path}: ${error.message}`);
    throw error;
  }

  const { data: urlData } = db.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);

  return {
    filename,
    url: urlData.publicUrl,
    size: buffer.length,
  };
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    txt: 'text/plain',
  };
  return mimeMap[ext ?? ''] ?? 'application/octet-stream';
}
