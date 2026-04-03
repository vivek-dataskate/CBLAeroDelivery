# Story 1.9a: AI Cost Dashboard and Prompt Deployment Gates

Status: backlog

## Story

As a delivery head / admin,
I want a cost dashboard showing daily/weekly LLM token usage and spending, plus controlled prompt version rollouts,
so that I can monitor AI costs, set budget alerts, and safely deploy new prompt versions without risking production quality.

## Acceptance Criteria

1. **Given** the `llm_usage_log` table (populated by `callLlm()` from Story 1.9)
   **When** an admin views the AI cost dashboard
   **Then** they see: total tokens (input/output), estimated cost, call count — grouped by day, model, and prompt name

2. **Given** daily cost data
   **When** estimated spend exceeds a configurable threshold (e.g., $10/day)
   **Then** a structured log alert is emitted: `{ level: 'warn', module: 'ai', action: 'budget_alert', dailyCostUsd, threshold }`

3. **Given** an admin wants to deploy a new prompt version
   **When** they insert a new version into `prompt_registry`
   **Then** the system supports staged rollout: new version is used for new calls only while old version remains active for comparison

4. **Given** two prompt versions running in parallel
   **When** the admin views the dashboard
   **Then** they see side-by-side fill rate and cost comparison for each version

5. **Given** an old prompt version
   **When** the delivery head approves retirement
   **Then** the version is marked deprecated (not deleted — append-only) and `loadPrompt()` stops returning it

## Tasks / Subtasks

- [ ] Create admin API route: `GET /api/internal/admin/ai-usage` (AC: 1)
  - [ ] Query `llm_usage_log` grouped by day, model, prompt_name
  - [ ] Return: `{ daily: [{ date, model, promptName, callCount, inputTokens, outputTokens, estimatedCostUsd }], totals: { ... } }`
  - [ ] Support query params: `?days=7` (default), `?model=`, `?promptName=`

- [ ] Create `AiCostDashboard` UI component (AC: 1, 4)
  - [ ] Add to admin dashboard page
  - [ ] Show daily cost chart (bar chart by day, stacked by model)
  - [ ] Show per-prompt version fill rate comparison table
  - [ ] Show total spend summary card

- [ ] Implement budget threshold alerting (AC: 2)
  - [ ] Add `ai_budget_threshold_usd` to tenant/system config (default: $10/day)
  - [ ] In `recordLlmUsage()` or a lightweight check: sum today's cost, warn if threshold exceeded
  - [ ] Log structured alert; optionally integrate with Teams notification (future)

- [ ] Add prompt version lifecycle management (AC: 3, 5)
  - [ ] Add `status` column to `prompt_registry`: `active` | `staged` | `deprecated` (default: `active`)
  - [ ] Update `loadPrompt()` to filter by `status != 'deprecated'`
  - [ ] Add admin route: `POST /api/internal/admin/prompt-registry/deprecate` with `{ name, version }`
  - [ ] Staged rollout: new version inserted as `staged`, admin promotes to `active` after review

- [ ] Write tests
  - [ ] Unit tests for usage aggregation query
  - [ ] Unit tests for budget threshold logic
  - [ ] Unit tests for prompt deprecation filtering
  - [ ] Integration test for dashboard API route

## Dev Notes

### What already exists (from Story 1.9)
- `modules/ai/inference.ts` — `callLlm()` returns `inputTokens`, `outputTokens`, `estimatedCostUsd`
- `modules/ai/usage-log.ts` — `recordLlmUsage()` persists every call to `llm_usage_log` table
- `modules/ai/prompt-registry.ts` — `loadPrompt()` with DB + fallback + 5min cache
- `prompt_registry` table — append-only, `(name, version)` unique
- `llm_usage_log` table — per-call token counts, cost, model, prompt attribution
- Model pricing map in inference.ts: Haiku $0.80/$4.00, Sonnet $3.00/$15.00 per 1M tokens

### Architecture constraints
- Dashboard should use `withAuth()` middleware (Story 1.10) once available — until then, use existing admin auth pattern
- Budget alerts are log-based initially; Teams integration deferred to Story 6.x
- Prompt deployment gates follow architecture.md §Resilience §13 — 30-day co-existence, version badge in UI

### References
- [Source: docs/planning_artifacts/architecture.md — Resilience §13 Prompt Registry, §AI Inference Service]
- [Source: docs/planning_artifacts/development-standards.md — §19 Cost Optimization, §22 Prompt Versioning]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
