import { getSupabaseAdminClient, isSupabaseConfigured } from '../persistence';
import { uploadAttachmentToStorage } from '../email/nlp-extract-and-upload';

export type IngestionSource = "csv" | "ats" | "email" | "ceipal";

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
// NOTE: Module-level state — does not persist across serverless cold starts or
// multiple instances. Suitable for development; replace with a persistent store
// (e.g., Supabase table) for production multi-instance deployments.
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
}

export function listRecentSyncErrors(): SyncError[] {
  return [...recentSyncErrors];
}

export function clearSyncErrorsForTest(): void {
  recentSyncErrors.splice(0);
}

// Default tenant for single-tenant MVP
const DEFAULT_TENANT_ID = 'cbl-aero';

// --- Candidate upsert (real Supabase persistence) ---

export async function upsertCandidateFromATS(record: Record<string, unknown>): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.log('[Ingestion] Supabase not configured — skipping persist:', record.email ?? record.firstName);
    return;
  }

  const db = getSupabaseAdminClient();
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  const source = typeof record.source === 'string' ? record.source : 'ats';

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
      await db.from('candidates').update({ ...candidateRow, updated_at: new Date().toISOString() }).eq('id', existing.id);
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
      await db.from('candidates').update({ ...candidateRow, updated_at: new Date().toISOString() }).eq('id', existing.id);
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

  // 2. Insert submission first to get its ID for attachment paths
  const submissionId = crypto.randomUUID();
  const submissionRow = {
    id: submissionId,
    candidate_id: candidateId,
    tenant_id: DEFAULT_TENANT_ID,
    source,
    email_message_id: record.id,
    email_subject: record.subject,
    email_body: record.body,
    email_from: typeof record.candidate.submitterEmail === 'string' ? record.candidate.submitterEmail : null,
    email_received_at: record.receivedAt,
    extracted_data: record.candidate,
    attachments: [] as Array<{ filename: string; url?: string; size?: number }>,
    extraction_model: record.candidate.source === 'email' ? 'claude-haiku-4-5-20251001' : 'regex-fallback',
  };

  // 3. Upload attachments to Supabase Storage
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
  submissionRow.attachments = attachmentMeta;

  // 4. Save submission evidence with attachment URLs
  const { error: subError } = await db.from('candidate_submissions').insert(submissionRow);
  if (subError) {
    console.error(`[Ingestion] Submission evidence insert failed: ${subError.message}`);
  } else {
    const attCount = attachmentMeta.filter((a) => a.url).length;
    console.log(`[Ingestion] Saved submission evidence for ${record.subject} (${attCount} attachments uploaded)`);
  }
}

// --- Map extracted data to candidates table columns ---

function mapToCandidateRow(record: Record<string, unknown>, source: string) {
  const str = (key: string) => typeof record[key] === 'string' ? record[key].trim() : null;
  const firstName = str('firstName') ?? '';
  const lastName = str('lastName') ?? '';

  return {
    tenant_id: DEFAULT_TENANT_ID,
    first_name: firstName,
    last_name: lastName,
    name: `${firstName} ${lastName}`.trim(),
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
    ingestion_state: 'active',
  };
}
