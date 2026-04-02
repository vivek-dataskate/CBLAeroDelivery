# Story 1.9: Create Centralized AI Inference Service with Prompt Registry

Status: ready-for-dev

## Story

As a platform engineer,
I want all LLM/AI interactions routed through a centralized inference service with prompt versioning,
so that future AI features (scoring, matching, outreach drafting) reuse the same client, retry, cost tracking, and prompt management patterns.

## Acceptance Criteria

1. **Given** any code that needs to call an LLM (Anthropic Claude)
   **When** it makes the call
   **Then** it uses the shared client from `modules/ai/client.ts` — never instantiates `new Anthropic()` directly

2. **Given** the extraction prompt currently hardcoded in `candidate-extraction.ts`
   **When** the AI service initializes
   **Then** prompts are loadable from the `prompt_registry` table (with inline fallback for when DB is unavailable)

3. **Given** any LLM call
   **When** it completes (success or failure)
   **Then** structured metrics are logged: `{ module, action, model, inputChars, outputChars, durationMs, fillRate, promptVersion }`

4. **Given** the existing `candidate-extraction.ts`
   **When** migrated to use `modules/ai/`
   **Then** all existing tests pass, extraction behavior is identical, and the capability is registered

5. **Given** the `prompt_registry` table schema (already defined in architecture.md resilience §13)
   **When** a new prompt version is created
   **Then** it is append-only (old versions preserved), tagged with name + version, and the active version is loadable by name

6. **Given** a future story that needs LLM for scoring or outreach
   **When** it imports from `modules/ai/`
   **Then** it gets the shared client, retry handling, cost logging, and prompt loading without reimplementing any of it

## Tasks / Subtasks

- [ ] Create `modules/ai/` service structure (AC: 1, 6)
  - [ ] Create `src/modules/ai/client.ts` — shared Anthropic client singleton with lazy init, env check, `clearClientForTest()`
  - [ ] Create `src/modules/ai/prompt-registry.ts` — `loadPrompt(name, version?)` function that reads from `prompt_registry` table with in-memory fallback
  - [ ] Create `src/modules/ai/inference.ts` — `callLlm(model, systemPrompt, userContent, opts)` wrapper with structured logging, cost tracking, retry via fetchWithRetry for API errors
  - [ ] Create `src/modules/ai/index.ts` — public API exports

- [ ] Create `prompt_registry` table if not exists (AC: 5)
  - [ ] Add DDL to `supabase/schema.sql`: `CREATE TABLE IF NOT EXISTS prompt_registry (id SERIAL PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, prompt_text TEXT NOT NULL, model TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), created_by TEXT, notes TEXT, UNIQUE(name, version))`
  - [ ] Apply via Supabase MCP
  - [ ] Seed initial prompt: `candidate-extraction` v1 with current `EXTRACTION_PROMPT` text

- [ ] Migrate `candidate-extraction.ts` to use `modules/ai/` (AC: 1, 4)
  - [ ] Replace `getAnthropicClient()` with import from `modules/ai/client`
  - [ ] Replace direct `anthropicClient.messages.create()` with `callLlm()` from `modules/ai/inference`
  - [ ] Load extraction prompt from registry (with hardcoded fallback for tests/no-DB mode)
  - [ ] Keep `extractCandidateFromDocument()` public API identical — this is a transparent refactor
  - [ ] Update `_resetClientForTest()` to delegate to `modules/ai/client`

- [ ] Add structured LLM call logging (AC: 3)
  - [ ] `callLlm()` logs JSON: `{ level, module: 'ai', action: 'llm_call', model, promptName, promptVersion, inputChars, outputChars, durationMs }`
  - [ ] On extraction complete, log fill rate: `{ action: 'extraction_complete', fillRate, fieldsPopulated, totalFields }`

- [ ] Write tests (AC: 4, 5)
  - [ ] Unit tests for `modules/ai/client.ts` (singleton, env check, test reset)
  - [ ] Unit tests for `modules/ai/prompt-registry.ts` (load from mock DB, fallback to inline)
  - [ ] Unit tests for `modules/ai/inference.ts` (structured logging, error handling)
  - [ ] Verify all existing extraction tests pass unchanged

- [ ] Register capabilities in architecture.md and development-standards.md §18 (AC: 6)
  - [ ] Add `callLlm()`, `loadPrompt()`, `getSharedAnthropicClient()` to Capabilities Registry
  - [ ] Update dev-standards §18 utility table
  - [ ] Update dev-standards §22 Prompt Versioning to reference actual implementation

## Dev Notes

### Architecture Compliance

This story implements the "AI Inference Service" from architecture.md §Service Boundary Architecture. The key rule: **all Anthropic SDK usage goes through `modules/ai/` — no direct `new Anthropic()` in feature code.**

### What already exists (MIGRATE, do not recreate)
- `features/candidate-management/application/candidate-extraction.ts` — has working extraction with Anthropic client, prompt, parsing, regex fallback. The public API (`extractCandidateFromDocument`) MUST remain identical.
- `modules/email/nlp-extract-and-upload.ts` — thin wrapper that calls `extractCandidateFromDocument`. Should not need changes.

### Future consumers (do NOT implement, just ensure the API supports them)
- Story 5.1: Weighted opportunity scoring — will need `callLlm()` with a different prompt
- Story 3.x: Outreach message drafting — will need `callLlm()` with different prompt + template
- Story 6.1: Digest summarization — may need `callLlm()` for candidate highlights

### Model configuration
- Default model: `claude-haiku-4-5-20251001` (cost-efficient for extraction)
- Model should be configurable per prompt in the registry (not hardcoded in callLlm)
- Input truncation (10K chars) stays in the caller, not in the inference service

### References

- [Source: docs/planning_artifacts/development-standards.md — §2 LLM Integration, §19 Cost Optimization, §21 Quality Monitoring, §22 Prompt Versioning, §25 LLM Safety]
- [Source: docs/planning_artifacts/architecture.md — Service Boundary Architecture, Resilience §13 Prompt Registry, Implemented Capabilities Registry]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
