export type IngestionSource = "csv" | "ats" | "email";

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

// --- Candidate normalization ---

type NormalizedCandidate = {
  firstName: string;
  lastName: string;
  email: string;
};

function normalizeCandidate(candidate: Record<string, unknown>): NormalizedCandidate {
  return {
    firstName: typeof candidate.firstName === 'string' ? candidate.firstName : '',
    lastName: typeof candidate.lastName === 'string' ? candidate.lastName : '',
    email: typeof candidate.email === 'string' ? candidate.email : '',
  };
}

// --- Upsert functions ---

export async function upsertCandidateFromATS(record: Record<string, unknown>): Promise<void> {
  const normalized = normalizeCandidate(record);
  // TODO: Persist to candidates table via Supabase (getSupabaseAdminClient())
  // Once candidates module lands (Story 2.4), replace with: await upsertCandidate(normalized)
  console.log('Upserting ATS candidate', normalized);
}

export async function upsertCandidateFromEmailFull(record: {
  id: string;
  subject: string;
  body: string;
  attachments?: Array<{ filename: string }>;
  candidate: Record<string, unknown>;
  receivedAt: string;
}): Promise<void> {
  const normalized = normalizeCandidate(record.candidate);
  // TODO: Persist full email record to candidates table + attachments store via Supabase
  // Once candidates module lands (Story 2.4), replace with full persistence logic
  console.log('Saving full email record:', {
    id: record.id,
    subject: record.subject,
    attachments: record.attachments?.map((a) => a.filename),
    candidate: normalized,
    receivedAt: record.receivedAt,
  });
}
