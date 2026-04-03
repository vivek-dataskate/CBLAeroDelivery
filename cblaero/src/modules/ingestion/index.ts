import { getSupabaseAdminClient, isSupabaseConfigured } from '../persistence';
import { uploadAttachmentToStorage } from '../email/nlp-extract-and-upload';
import {
  findSubmissionByMessageId,
  insertSubmission,
} from '@/features/candidate-management/infrastructure/submission-repository';

export type IngestionSource = "csv" | "ats" | "email" | "ceipal" | "resume_upload";

export type IngestionEnvelope = {
  source: IngestionSource;
  receivedAtIso: string;
};

export function createIngestionEnvelope(source: IngestionSource): IngestionEnvelope {
  return {
    source,
    receivedAtIso: new Date().toISOString(),
  };
}

// --- Sync Error Store ---

export type SyncError = {
  id: string;
  source: string;
  recordId: string;
  message: string;
  timestamp: string;
};

const SYNC_ERROR_MAX = 100;
// In-memory buffer for fast reads; also persisted to Supabase when configured.
const recentSyncErrors: SyncError[] = [];

export function recordSyncFailure(source: string, recordId: string, err: unknown): void {
  const error: SyncError = {
    id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source,
    recordId,
    message: err instanceof Error ? err.message : String(err),
    timestamp: new Date().toISOString(),
  };
  recentSyncErrors.unshift(error);
  if (recentSyncErrors.length > SYNC_ERROR_MAX) {
    recentSyncErrors.splice(SYNC_ERROR_MAX);
  }
  // Persist to Supabase (fire-and-forget — don't block the caller)
  if (isSupabaseConfigured()) {
    const db = getSupabaseAdminClient();
    Promise.resolve(
      db.from('sync_errors').insert({
        source,
        record_id: recordId,
        message: error.message,
        occurred_at: error.timestamp,
      })
    ).then(({ error: dbErr }) => {
      if (dbErr) console.error('[SyncError] Failed to persist:', dbErr.message);
      // Prune rows older than 30 days (fire-and-forget cleanup)
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      db.from('sync_errors').delete().lt('occurred_at', cutoff).then(() => {});
    }).catch((e: unknown) => {
      console.error('[SyncError] Persist transport error:', e instanceof Error ? e.message : e);
    });
  }
}

export async function listRecentSyncErrors(): Promise<SyncError[]> {
  // Prefer Supabase if configured; fall back to in-memory
  if (isSupabaseConfigured()) {
    const db = getSupabaseAdminClient();
    const { data } = await db
      .from('sync_errors')
      .select('id, source, record_id, message, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(SYNC_ERROR_MAX);
    if (data && data.length > 0) {
      return data.map((r: { id: string; source: string; record_id: string; message: string; occurred_at: string }) => ({
        id: String(r.id),
        source: r.source,
        recordId: r.record_id,
        message: r.message,
        timestamp: r.occurred_at,
      }));
    }
  }
  return [...recentSyncErrors];
}

export function clearSyncErrorsForTest(): void {
  recentSyncErrors.splice(0);
}

// Default tenant for single-tenant MVP
export const DEFAULT_TENANT_ID = 'cbl-aero';

// --- Candidate upsert (real Supabase persistence) ---

/**
 * Batch upsert candidates from ATS. Uses Supabase .upsert() with email as conflict key.
 * Much faster than individual inserts for bulk loads.
 */
export async function batchUpsertCandidatesFromATS(records: Record<string, unknown>[]): Promise<{ inserted: number; failed: number }> {
  if (!isSupabaseConfigured() || records.length === 0) return { inserted: 0, failed: 0 };

  const db = getSupabaseAdminClient();
  let failed = 0;

  // Filter out records with no email and no phone
  const validRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    const email = typeof record.email === 'string' ? record.email.trim() : '';
    const phone = typeof record.phone === 'string' ? record.phone.trim() : '';
    if (!email && !phone) {
      recordSyncFailure(String(record.source ?? 'ats'), String(record.firstName ?? 'unknown'),
        new Error('Candidate has no email or phone — cannot insert'));
      failed++;
      continue;
    }
    validRecords.push(record);
  }

  if (validRecords.length === 0) return { inserted: 0, failed };

  const rows = validRecords.map((r) => {
    const source = typeof r.source === 'string' ? r.source : 'ats';
    return mapToCandidateRow(r, source);
  });

  // Split into rows with email (can upsert) and without (insert only)
  const withEmail = rows.filter((r) => r.email);
  const withoutEmail = rows.filter((r) => !r.email);

  let totalInserted = 0;

  // Batch upsert rows that have email — uses partial unique index
  if (withEmail.length > 0) {
    const { error: upsertErr } = await db.from('candidates').upsert(withEmail, { onConflict: 'tenant_id,email' });
    if (upsertErr) {
      console.error(`[Ingestion] Batch upsert (with email) failed: ${upsertErr.message}`);
      // Fall back to individual inserts
      for (const record of validRecords.filter((r) => r.email)) {
        try { await upsertCandidateFromATS(record); totalInserted++; } catch (err) {
          recordSyncFailure(String(record.source ?? 'ats'), String(record.email ?? 'unknown'), err); failed++;
        }
      }
    } else {
      totalInserted += withEmail.length;
    }
  }

  // Insert rows without email (no dedup possible)
  if (withoutEmail.length > 0) {
    const { error: insertErr } = await db.from('candidates').insert(withoutEmail);
    if (insertErr) {
      console.error(`[Ingestion] Batch insert (no email) failed: ${insertErr.message}`);
      failed += withoutEmail.length;
    } else {
      totalInserted += withoutEmail.length;
    }
  }

  console.log(`[Ingestion] Batch upserted ${totalInserted} candidates`);
  return { inserted: totalInserted, failed };
}

export async function upsertCandidateFromATS(record: Record<string, unknown>): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.log('[Ingestion] Supabase not configured — skipping persist:', record.email ?? record.firstName);
    return;
  }

  const db = getSupabaseAdminClient();
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  const phone = typeof record.phone === 'string' ? record.phone.trim() : '';
  const source = typeof record.source === 'string' ? record.source : 'ats';

  // Pre-validate: candidates table requires email or phone
  if (!email && !phone) {
    recordSyncFailure(source, String(record.firstName ?? 'unknown'), new Error('Candidate has no email or phone — cannot insert'));
    return;
  }

  // Upsert candidate by email (dedup key)
  const candidateRow = mapToCandidateRow(record, source);

  if (email) {
    const { data: existing } = await db
      .from('candidates')
      .select('id')
      .eq('email', email)
      .eq('tenant_id', DEFAULT_TENANT_ID)
      .maybeSingle();

    if (existing) {
      const { error } = await db.from('candidates').update({ ...candidateRow, updated_at: new Date().toISOString() }).eq('id', existing.id);
      if (error) throw new Error(`Candidate update failed: ${error.message}`);
      console.log(`[Ingestion] Updated candidate ${email} (${existing.id})`);
    } else {
      const { error } = await db.from('candidates').insert(candidateRow);
      if (error) throw new Error(`Candidate insert failed: ${error.message}`);
      console.log(`[Ingestion] Inserted new candidate ${email}`);
    }
  } else {
    // No email — insert without dedup
    const { error } = await db.from('candidates').insert(candidateRow);
    if (error) throw new Error(`Candidate insert failed: ${error.message}`);
    console.log(`[Ingestion] Inserted candidate (no email): ${record.firstName} ${record.lastName}`);
  }
}

export async function upsertCandidateFromEmailFull(record: {
  id: string;
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; content?: Buffer }>;
  candidate: Record<string, unknown>;
  receivedAt: string;
}): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.log('[Ingestion] Supabase not configured — skipping email persist:', record.subject);
    return;
  }

  const db = getSupabaseAdminClient();
  const email = typeof record.candidate.email === 'string' ? record.candidate.email.trim().toLowerCase() : '';
  const source = typeof record.candidate.source === 'string' ? record.candidate.source : 'email';

  // 1. Upsert the candidate record
  const candidateRow = mapToCandidateRow(record.candidate, source);
  let candidateId: string;

  if (email) {
    const { data: existing } = await db
      .from('candidates')
      .select('id')
      .eq('email', email)
      .eq('tenant_id', DEFAULT_TENANT_ID)
      .maybeSingle();

    if (existing) {
      const { error: updateErr } = await db.from('candidates').update({ ...candidateRow, updated_at: new Date().toISOString() }).eq('id', existing.id);
      if (updateErr) throw new Error(`Candidate update failed: ${updateErr.message}`);
      candidateId = existing.id;
      console.log(`[Ingestion] Updated candidate ${email} from email`);
    } else {
      const { data, error } = await db.from('candidates').insert(candidateRow).select('id').single();
      if (error) throw new Error(`Candidate insert failed: ${error.message}`);
      candidateId = data.id;
      console.log(`[Ingestion] Inserted new candidate ${email} from email`);
    }
  } else {
    const { data, error } = await db.from('candidates').insert(candidateRow).select('id').single();
    if (error) throw new Error(`Candidate insert failed: ${error.message}`);
    candidateId = data.id;
  }

  // 2. Skip if this email was already processed (dedup by message ID)
  const existingSub = await findSubmissionByMessageId(record.id, DEFAULT_TENANT_ID);
  if (existingSub) {
    console.log(`[Ingestion] Skipping already-processed email: ${record.subject}`);
    return;
  }

  // 3. Build submission record
  const submissionId = crypto.randomUUID();
  const extractionModel = record.candidate.extractionMethod === 'llm' ? 'claude-haiku-4-5-20251001' : 'regex-fallback';

  // 4. Upload attachments to Supabase Storage
  const attachmentMeta: Array<{ filename: string; url: string; size: number }> = [];
  for (const att of record.attachments ?? []) {
    if (!att.content) {
      attachmentMeta.push({ filename: att.filename, url: '', size: 0 });
      continue;
    }
    try {
      const result = await uploadAttachmentToStorage(db, att.content, att.filename, candidateId, submissionId);
      attachmentMeta.push(result);
    } catch {
      console.warn(`[Ingestion] Attachment upload failed for ${att.filename} — recording filename only`);
      attachmentMeta.push({ filename: att.filename, url: '', size: att.content.length });
    }
  }

  // 5. Save submission evidence with attachment URLs via repository
  try {
    await insertSubmission({
      id: submissionId,
      tenantId: DEFAULT_TENANT_ID,
      candidateId,
      source,
      emailMessageId: record.id,
      emailSubject: record.subject,
      emailBody: record.body,
      emailFrom: typeof record.candidate.submitterEmail === 'string' ? record.candidate.submitterEmail : null,
      emailReceivedAt: record.receivedAt,
      extractedData: record.candidate,
      extractionModel,
      attachments: attachmentMeta,
    });
    const attCount = attachmentMeta.filter((a) => a.url).length;
    console.log(`[Ingestion] Saved submission evidence for ${record.subject} (${attCount} attachments uploaded)`);
  } catch (subError) {
    console.error(`[Ingestion] Submission evidence insert failed: ${subError instanceof Error ? subError.message : subError}`);
  }
}

// --- Map extracted data to candidates table columns ---

export function mapToCandidateRow(record: Record<string, unknown>, source: string, overrides?: { ingestion_state?: string }) {
  const str = (key: string) => typeof record[key] === 'string' ? record[key].trim() : null;
  const firstName = str('firstName') ?? '';
  const lastName = str('lastName') ?? '';

  return {
    tenant_id: DEFAULT_TENANT_ID,
    first_name: firstName,
    last_name: lastName,
    middle_name: str('middleName'),
    email: str('email')?.toLowerCase() ?? null,
    alternate_email: str('alternateEmail'),
    phone: str('phone'),
    home_phone: str('homePhone'),
    work_phone: str('workPhone'),
    address: str('address'),
    city: str('city'),
    state: str('state'),
    country: str('country'),
    postal_code: str('zipCode') ?? str('postalCode'),
    location: str('location'),
    job_title: str('jobTitle'),
    current_company: str('client'),
    source,
    work_authorization: str('workAuthorization'),
    clearance: str('clearance'),
    aircraft_experience: Array.isArray(record.aircraftExperience) ? record.aircraftExperience : [],
    employment_type: str('employmentType'),
    current_rate: str('currentRate'),
    per_diem: str('perDiem'),
    has_ap_license: typeof record.hasAPLicense === 'boolean' ? record.hasAPLicense : null,
    years_of_experience: str('yearsOfExperience'),
    ceipal_id: str('ceipalId'),
    submitted_by: str('submittedBy'),
    submitter_email: str('submitterEmail'),
    shift_preference: str('shiftPreference'),
    expected_start_date: str('expectedStartDate'),
    call_availability: str('callAvailability'),
    interview_availability: str('interviewAvailability'),
    veteran_status: str('veteranStatus'),
    skills: Array.isArray(record.skills) ? record.skills : [],
    certifications: Array.isArray(record.certifications) ? record.certifications : [],
    availability_status: 'active',
    ingestion_state: overrides?.ingestion_state ?? 'pending_enrichment',
    created_by_actor_id: str('createdByActorId'),
    extra_attributes: record.additionalFields && typeof record.additionalFields === 'object'
      ? record.additionalFields
      : (record.extra_attributes && typeof record.extra_attributes === 'object' ? record.extra_attributes : {}),
  };
}
