# CBL Solutions — Development Standards & Best Practices

These standards are mandatory for all stories. Dev agents and reviewers must follow these patterns. Code reviews should verify compliance.

## 1. External API Calls — Retry & Rate Limiting

All calls to external APIs (Anthropic, Microsoft Graph, Ceipal, Supabase Storage, any third-party) must follow this pattern:

### Retry with Exponential Backoff
```typescript
// Standard retry pattern — use for ALL external API calls
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    const result = await apiCall();
    return result;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 429 && attempt < MAX_RETRIES - 1) {
      const delay = (attempt + 1) * BASE_DELAY_MS;
      console.warn(`[${context}] Rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    throw err;
  }
}
```

### Constants
- `MAX_RETRIES = 3` for all external calls
- `BASE_DELAY_MS = 5000` (5s, 10s, 15s escalation)
- Add 500ms inter-call delay when processing batches to avoid rate limits proactively

### Never silently swallow errors
```typescript
// BAD — error lost
await db.from('table').update(row).eq('id', id);

// GOOD — error checked
const { error } = await db.from('table').update(row).eq('id', id);
if (error) throw new Error(`Update failed: ${error.message}`);
```

## 2. LLM Integration Standards

### Input Safety
- Always truncate LLM input to a max character limit (default 10,000 chars) to control cost
- Strip HTML tags, decode entities before sending to LLM
- Never trust LLM output for security-critical fields — hardcode `source`, `extractionMethod` etc. AFTER the spread:
  ```typescript
  // GOOD — our values always win
  return { ...parsed, source: 'email', extractionMethod: 'llm' };
  // BAD — LLM could override source
  return { source: 'email', ...parsed };
  ```

### Output Parsing
- Always strip markdown fencing (```json ... ```) from LLM responses
- Always wrap `JSON.parse()` in try/catch with regex fallback
- Track extraction method (`llm` vs `regex`) for audit trail

### Classification
- When LLM classifies emails/documents (submission vs non-submission), return a boolean classification field
- Non-matching items should be skipped BEFORE expensive operations (attachment download, persistence)

### Model Selection
- Use `claude-haiku-4-5-20251001` for high-volume extraction tasks (cost-efficient)
- Use `claude-sonnet-4-6` for complex reasoning tasks only when needed
- Always record the model used in audit/evidence tables (`extraction_model` column)

## 3. Data Ingestion Standards

### Dedup Before Processing
- Always check if a record was already processed BEFORE calling the LLM or doing expensive work
- Use a persistent identifier (e.g., `email_message_id`, `ceipal_id`) as the dedup key
- Query `candidate_submissions` or equivalent table for existing records
- Pass processed IDs as a `Set<string>` to skip known records early in the pipeline

### Evidence Preservation
- Every ingestion source must store the raw input (email body, CSV row, API response) in a submissions/evidence table
- Store the full LLM extraction result as JSONB alongside structured columns
- Record: source, extraction model, timestamp, submitter info

### Candidate Upsert Pattern
- Dedup by email (primary), phone (secondary)
- Pre-validate required fields (email or phone) before attempting insert — don't let DB constraints fire
- Always check `.error` on both insert AND update Supabase calls
- Use `recordSyncFailure()` for any ingestion error — never swallow

### Pagination Safety
- Set reasonable `maxPages` defaults (50 pages = 5,000 records per run)
- Never accumulate unbounded results in memory
- Use incremental sync (`since`/`lastRunAt`) when the API supports it

## 4. Supabase Patterns

### Always check errors
```typescript
const { data, error } = await db.from('table').insert(row);
if (error) throw new Error(`Insert failed: ${error.message}`);
```

### Fire-and-forget writes must have .catch()
```typescript
// For non-blocking writes (e.g., sync error logging)
Promise.resolve(
  db.from('sync_errors').insert({ ... })
).then(({ error }) => {
  if (error) console.error('[SyncError] Failed:', error.message);
}).catch((e) => {
  console.error('[SyncError] Transport error:', e);
});
```

### Schema changes
- Always update `cblaero/supabase/schema.sql` when applying migrations via MCP
- Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for additive changes
- Include `GRANT` statements for new tables
- Add indexes for any column used in WHERE clauses at scale

## 5. Authentication & Token Management

### Token Caching Pattern
```typescript
let tokenCache: { token: string; expiresAt: number } | null = null;

async function acquireToken(): Promise<string> {
  // Return cached token with buffer before expiry
  if (tokenCache && Date.now() < tokenCache.expiresAt - EXPIRY_BUFFER_MS) {
    return tokenCache.token;
  }
  const token = await fetchNewToken();
  tokenCache = { token, expiresAt: Date.now() + expiresInMs };
  return token;
}
```
- Always include an expiry buffer (60s for Graph, 5min for Ceipal)
- Provide `clearTokenCacheForTest()` for unit testing
- Never log token values — log only success/failure

## 6. Error Tracking

### Sync errors must be persisted
- Use `recordSyncFailure(source, recordId, err)` for all ingestion errors
- Errors persist to Supabase `sync_errors` table with in-memory fallback
- Include: source system, record identifier, error message, timestamp
- Admin dashboard reads from persistent store, not in-memory buffer

## 7. File & Attachment Storage

### Supabase Storage pattern
- Bucket: `candidate-attachments` (public)
- Path: `/{candidate_id_short}/{submission_id_short}/{sanitized_filename}`
- Short IDs = first 8 chars of UUID
- Sanitize filenames: `filename.replace(/[^a-zA-Z0-9._-]/g, '_')`
- Store URL + size + original filename in JSONB `attachments` column
- Always set correct MIME type via `contentType` option

## 8. Testing Standards

### Every module must have tests for:
- Happy path
- Error handling (API failures, malformed data)
- Dedup behavior (same record processed twice)
- Edge cases (missing fields, null values)

### Test helpers
- Provide `clear*ForTest()` functions for module-level state (token caches, error buffers)
- Use in-memory stores for unit tests, real Supabase for integration tests
- Never mock the database in integration tests

## 9. Story Documentation

### File List must be accurate
- Every file created or modified must appear in the story's File List
- `schema.sql` must be updated when migrations are applied via MCP
- Use format: `filename (new|modified — brief description)`

### Review follow-ups
- All code review findings go under `### Review Follow-ups (AI)` with severity tags
- Format: `- [ ] [AI-Review][SEVERITY] Description [file:line]`
- Fixed items get marked `[x]` with brief explanation

## 10. Naming Conventions

- DB columns: `snake_case`
- TypeScript: `camelCase` for variables/functions, `PascalCase` for types/classes
- Files: `kebab-case.ts` for modules, `PascalCase.tsx` for React components
- Index names: `idx_{table}_{column_list}` (e.g., `idx_candidates_ceipal_id`)
- Env vars: `SCREAMING_SNAKE_CASE` with prefix (`CBL_`, `CEIPAL_`, `ANTHROPIC_`)
