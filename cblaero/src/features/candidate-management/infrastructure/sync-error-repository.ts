/**
 * Centralized repository for sync_errors table access.
 * All sync error reads/writes go through here — no direct db.from('sync_errors') elsewhere.
 */
import {
  getSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/modules/persistence";

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

/**
 * Record a sync failure — persists to Supabase (fire-and-forget) and keeps in-memory buffer.
 */
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
      db.from("sync_errors").insert({
        source,
        record_id: recordId,
        message: error.message,
        occurred_at: error.timestamp,
      }),
    )
      .then(({ error: dbErr }) => {
        if (dbErr) console.error("[SyncError] Failed to persist:", dbErr.message);
        // Prune rows older than 30 days (fire-and-forget cleanup)
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        db.from("sync_errors")
          .delete()
          .lt("occurred_at", cutoff)
          .then(() => {});
      })
      .catch((e: unknown) => {
        console.error("[SyncError] Persist transport error:", e instanceof Error ? e.message : e);
      });
  }
}

/**
 * List recent sync errors. Prefers Supabase; falls back to in-memory.
 */
export async function listRecentSyncErrors(): Promise<SyncError[]> {
  if (isSupabaseConfigured()) {
    const db = getSupabaseAdminClient();
    const { data, error } = await db
      .from("sync_errors")
      .select("id, source, record_id, message, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(SYNC_ERROR_MAX);
    if (error) {
      console.error("[SyncError] Failed to query sync_errors:", error.message);
    } else if (data) {
      return data.map(
        (r: { id: string; source: string; record_id: string; message: string; occurred_at: string }) => ({
          id: String(r.id),
          source: r.source,
          recordId: r.record_id,
          message: r.message,
          timestamp: r.occurred_at,
        }),
      );
    }
  }
  return [...recentSyncErrors];
}

export function clearSyncErrorsForTest(): void {
  recentSyncErrors.splice(0);
}

// -----------------------------------------------------------------------
// Key-value marker storage (uses sync_errors table as lightweight KV store)
// -----------------------------------------------------------------------

/**
 * Read a marker value stored as a sync_errors row (e.g., resume page for initial load).
 */
export async function getMarkerValue(markerSource: string, markerRecordId: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;

  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("sync_errors")
    .select("message")
    .eq("source", markerSource)
    .eq("record_id", markerRecordId)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[SyncError] Failed to read marker ${markerSource}:`, error.message);
    return null;
  }

  return data?.message ?? null;
}

/**
 * Write a marker value as a sync_errors row.
 */
export async function setMarkerValue(markerSource: string, markerRecordId: string, value: string): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const db = getSupabaseAdminClient();
  const { error } = await db.from("sync_errors").insert({
    source: markerSource,
    record_id: markerRecordId,
    message: value,
  });

  if (error) {
    console.error(`[SyncError] Failed to write marker ${markerSource}:`, error.message);
  }
}
