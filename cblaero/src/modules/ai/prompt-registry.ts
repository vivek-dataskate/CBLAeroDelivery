import { isSupabaseConfigured, getSupabaseAdminClient } from '../persistence';

export interface PromptRecord {
  name: string;
  version: string;
  prompt_text: string;
  model: string;
}

// In-memory fallback prompts — used when DB is unavailable (tests, no Supabase config)
const fallbackPrompts = new Map<string, PromptRecord>();

// DB prompt cache — avoids per-call DB round-trips in batch paths (dev-standards §19)
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const dbCache = new Map<string, { record: PromptRecord; cachedAt: number }>();

/**
 * Register an inline fallback prompt so loadPrompt works without a DB.
 * Call this at module init for each known prompt.
 */
export function registerFallbackPrompt(record: PromptRecord): void {
  fallbackPrompts.set(record.name, record);
}

/**
 * Load a prompt by name. Optionally pin to a specific version.
 * Tries in-memory cache first (5min TTL), then prompt_registry table, then fallback.
 */
export async function loadPrompt(
  name: string,
  version?: string
): Promise<PromptRecord | null> {
  // Check cache first (unversioned lookups only — pinned versions always hit DB)
  if (!version) {
    const cached = dbCache.get(name);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.record;
    }
  }

  if (isSupabaseConfigured()) {
    try {
      const db = getSupabaseAdminClient();
      let query = db
        .from('prompt_registry')
        .select('name, version, prompt_text, model')
        .eq('name', name);

      if (version) {
        query = query.eq('version', version);
      } else {
        query = query.order('created_at', { ascending: false }).limit(1);
      }

      const { data, error } = await query.maybeSingle();
      if (!error && data) {
        const record = data as PromptRecord;
        // Cache unversioned lookups
        if (!version) {
          dbCache.set(name, { record, cachedAt: Date.now() });
        }
        return record;
      }
      // Fall through to fallback on error or no data
    } catch {
      // DB unavailable — use fallback
    }
  }

  return fallbackPrompts.get(name) ?? null;
}

/** Clear fallback registry and DB cache for test isolation. No-op outside test environment. */
export function clearFallbackPromptsForTest(): void {
  if (process.env.NODE_ENV !== 'test') return;
  fallbackPrompts.clear();
  dbCache.clear();
}
