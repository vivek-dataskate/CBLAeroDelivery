import { createHash } from "crypto";
import {
  getSupabaseAdminClient,
  shouldUseInMemoryPersistenceForTests,
} from "@/modules/persistence";

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type FingerprintType =
  | "file_sha256"
  | "email_message_id"
  | "csv_row_hash"
  | "ats_external_id"
  | "candidate_identity";

export type FingerprintSource =
  | "email"
  | "ats"
  | "csv"
  | "ceipal"
  | "resume_upload"
  | "onedrive";

export type FingerprintStatus = "processed" | "failed";

export type ContentFingerprint = {
  id: number;
  tenantId: string;
  fingerprintType: FingerprintType;
  fingerprintHash: string;
  source: FingerprintSource;
  status: FingerprintStatus;
  candidateId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RecordFingerprintParams = {
  tenantId: string;
  type: FingerprintType;
  hash: string;
  source: FingerprintSource;
  candidateId?: string | null;
  metadata?: Record<string, unknown>;
  status?: FingerprintStatus;
};

// -----------------------------------------------------------------------
// Row type (DB shape)
// -----------------------------------------------------------------------

type FingerprintRow = {
  id: number;
  tenant_id: string;
  fingerprint_type: string;
  fingerprint_hash: string;
  source: string;
  status: string;
  candidate_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

// -----------------------------------------------------------------------
// Row mapping
// -----------------------------------------------------------------------

function toFingerprint(row: FingerprintRow): ContentFingerprint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fingerprintType: row.fingerprint_type as FingerprintType,
    fingerprintHash: row.fingerprint_hash,
    source: row.source as FingerprintSource,
    status: row.status as FingerprintStatus,
    candidateId: row.candidate_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

// -----------------------------------------------------------------------
// In-memory store (test mode only)
// -----------------------------------------------------------------------

let nextId = 1;
const fingerprintStore = new Map<string, FingerprintRow>();

function storeKey(tenantId: string, type: string, hash: string): string {
  return `${tenantId}::${type}::${hash}`;
}

export function seedFingerprintsForTest(fingerprint: ContentFingerprint): void {
  const key = storeKey(fingerprint.tenantId, fingerprint.fingerprintType, fingerprint.fingerprintHash);
  fingerprintStore.set(key, {
    id: fingerprint.id,
    tenant_id: fingerprint.tenantId,
    fingerprint_type: fingerprint.fingerprintType,
    fingerprint_hash: fingerprint.fingerprintHash,
    source: fingerprint.source,
    status: fingerprint.status,
    candidate_id: fingerprint.candidateId,
    metadata: fingerprint.metadata,
    created_at: fingerprint.createdAt,
  });
}

export function clearFingerprintsForTest(): void {
  if (!shouldUseInMemoryPersistenceForTests()) return;
  fingerprintStore.clear();
  nextId = 1;
}

// -----------------------------------------------------------------------
// Hash computation utilities
// -----------------------------------------------------------------------

export function computeFileHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function computeIdentityHash(
  email?: string | null,
  firstName?: string | null,
  lastName?: string | null,
  phone?: string | null,
): string {
  if (email) {
    return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
  }
  const namePart = `${(firstName ?? "").toLowerCase().trim()}${(lastName ?? "").toLowerCase().trim()}`;
  const phonePart = (phone ?? "").replace(/\D/g, "");
  if (!namePart && !phonePart) return "";
  return createHash("sha256").update(`${namePart}|${phonePart}`).digest("hex");
}

export function computeRowHash(
  email?: string | null,
  firstName?: string | null,
  lastName?: string | null,
  phone?: string | null,
): string {
  const emailPart = (email ?? "").toLowerCase().trim();
  const namePart = `${(firstName ?? "").toLowerCase().trim()}${(lastName ?? "").toLowerCase().trim()}`;
  const phonePart = (phone ?? "").replace(/\D/g, "");
  return createHash("sha256").update(`${emailPart}|${namePart}|${phonePart}`).digest("hex");
}

// -----------------------------------------------------------------------
// Public repository functions
// -----------------------------------------------------------------------

export async function isAlreadyProcessed(
  tenantId: string,
  type: FingerprintType,
  hash: string,
): Promise<boolean> {
  if (shouldUseInMemoryPersistenceForTests()) {
    const key = storeKey(tenantId, type, hash);
    const row = fingerprintStore.get(key);
    return row !== undefined && row.status === "processed";
  }

  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("content_fingerprints")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("fingerprint_type", type)
    .eq("fingerprint_hash", hash)
    .eq("status", "processed")
    .maybeSingle();

  if (error) {
    throw new Error(`[Fingerprint] Lookup failed: ${error.message}`);
  }

  return data !== null;
}

export async function recordFingerprint(params: RecordFingerprintParams): Promise<void> {
  const status = params.status ?? "processed";

  if (shouldUseInMemoryPersistenceForTests()) {
    const key = storeKey(params.tenantId, params.type, params.hash);
    const id = nextId++;
    fingerprintStore.set(key, {
      id,
      tenant_id: params.tenantId,
      fingerprint_type: params.type,
      fingerprint_hash: params.hash,
      source: params.source,
      status,
      candidate_id: params.candidateId ?? null,
      metadata: params.metadata ?? {},
      created_at: new Date().toISOString(),
    });
    return;
  }

  const client = getSupabaseAdminClient();
  const { error } = await client
    .from("content_fingerprints")
    .upsert(
      {
        tenant_id: params.tenantId,
        fingerprint_type: params.type,
        fingerprint_hash: params.hash,
        source: params.source,
        status,
        candidate_id: params.candidateId ?? null,
        metadata: params.metadata ?? {},
      },
      { onConflict: "tenant_id,fingerprint_type,fingerprint_hash" },
    );

  if (error) {
    throw new Error(`[Fingerprint] Record failed: ${error.message}`);
  }
}

export async function loadRecentFingerprints(
  tenantId: string,
  type: FingerprintType,
  days: number = 30,
): Promise<Set<string>> {
  if (shouldUseInMemoryPersistenceForTests()) {
    const result = new Set<string>();
    for (const row of fingerprintStore.values()) {
      if (
        row.tenant_id === tenantId &&
        row.fingerprint_type === type &&
        row.status === "processed"
      ) {
        result.add(row.fingerprint_hash);
      }
    }
    return result;
  }

  const MAX_FINGERPRINTS = 100_000;
  const client = getSupabaseAdminClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("content_fingerprints")
    .select("fingerprint_hash")
    .eq("tenant_id", tenantId)
    .eq("fingerprint_type", type)
    .eq("status", "processed")
    .gte("created_at", since)
    .limit(MAX_FINGERPRINTS);

  if (error) {
    throw new Error(`[Fingerprint] Batch load failed: ${error.message}`);
  }

  if ((data ?? []).length >= MAX_FINGERPRINTS) {
    console.warn(`[Fingerprint] Hit ${MAX_FINGERPRINTS} limit for ${type} — some duplicates may not be caught`);
  }

  return new Set((data ?? []).map((row: { fingerprint_hash: string }) => row.fingerprint_hash));
}
