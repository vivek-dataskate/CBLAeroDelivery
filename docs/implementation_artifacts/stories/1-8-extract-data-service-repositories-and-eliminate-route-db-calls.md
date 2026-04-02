# Story 1.8: Extract Data Service Repositories and Eliminate Route DB Calls

Status: in-progress

## Story

As a platform engineer,
I want all database access routed through dedicated repository functions,
so that route handlers are decoupled from the DB schema and query logic is reusable, testable, and consistent.

## Acceptance Criteria

1. **Given** any API route handler in `src/app/api/`
   **When** the route needs to read or write data
   **Then** it calls a named repository/module function — never `getSupabaseAdminClient()` directly

2. **Given** the `import_batch` table
   **When** any operation (create, update status, list by tenant, get by ID) is needed
   **Then** it goes through `ImportBatchRepository` with typed functions

3. **Given** the `candidate_submissions` table
   **When** any operation (insert submission, check dedup by message_id, list by batch) is needed
   **Then** it goes through `SubmissionRepository` with typed functions

4. **Given** cross-client confirmation token logic (issue, verify, consume)
   **When** a candidate route needs cross-client confirmation
   **Then** it calls functions from `modules/auth/cross-client-confirmation.ts` — not inline JWT logic

5. **Given** all existing tests
   **When** the refactor is complete
   **Then** all tests pass, no regressions, TypeScript compiles clean

6. **Given** the repository pattern
   **When** running in test mode (`shouldUseInMemoryPersistenceForTests()`)
   **Then** new repositories support in-memory mode with `seed*ForTest()` and `clear*ForTest()` functions

## Tasks / Subtasks

- [ ] Create `ImportBatchRepository` (AC: 2, 6)
  - [ ] Create `src/features/candidate-management/infrastructure/import-batch-repository.ts`
  - [ ] Extract functions: `createImportBatch()`, `getImportBatchById()`, `updateImportBatchStatus()`, `listImportBatchesByTenant()`
  - [ ] Add in-memory test mode with seed/clear helpers
  - [ ] Add types: `ImportBatch`, `ImportBatchStatus`

- [ ] Create `SubmissionRepository` (AC: 3, 6)
  - [ ] Create `src/features/candidate-management/infrastructure/submission-repository.ts`
  - [ ] Extract functions: `insertSubmission()`, `findSubmissionByMessageId()`, `listSubmissionsByBatch()`
  - [ ] Add in-memory test mode with seed/clear helpers
  - [ ] Add types: `CandidateSubmission`

- [ ] Move cross-client confirmation logic to auth module (AC: 4)
  - [ ] Create `src/modules/auth/cross-client-confirmation.ts`
  - [ ] Move `issueCrossClientConfirmationToken()`, `verifyCrossClientConfirmationToken()`, `consumeCrossClientConfirmationToken()` from candidates/route.ts
  - [ ] Move in-memory token tracking and DB-backed consumption logic
  - [ ] Export from `modules/auth/index.ts`

- [ ] Refactor route handlers to use repositories (AC: 1)
  - [ ] `app/api/internal/recruiter/resume-upload/route.ts` — use `ImportBatchRepository` + `SubmissionRepository`
  - [ ] `app/api/internal/recruiter/resume-upload/[batchId]/route.ts` — use `SubmissionRepository`
  - [ ] `app/api/internal/recruiter/resume-upload/[batchId]/confirm/route.ts` — use `ImportBatchRepository` + `SubmissionRepository`
  - [ ] `app/api/internal/recruiter/csv-upload/route.ts` — use `ImportBatchRepository`
  - [ ] `app/api/internal/admin/import-batches/route.ts` — use `ImportBatchRepository`
  - [ ] `app/api/internal/admin/import-batches/[batchId]/route.ts` — use `ImportBatchRepository`
  - [ ] `app/api/internal/candidates/route.ts` — use auth/cross-client-confirmation
  - [ ] `app/api/internal/jobs/run/route.ts` — use candidate repository for count queries
  - [ ] Verify: zero occurrences of `getSupabaseAdminClient()` in `app/api/` directory

- [ ] Update `upsertCandidateFromEmailFull` to use `SubmissionRepository` (AC: 3)
  - [ ] Replace inline `db.from('candidate_submissions')` calls in `modules/ingestion/index.ts`

- [ ] Write/update tests (AC: 5, 6)
  - [ ] Unit tests for `ImportBatchRepository` (CRUD, in-memory mode)
  - [ ] Unit tests for `SubmissionRepository` (insert, dedup, in-memory mode)
  - [ ] Unit tests for cross-client confirmation functions
  - [ ] Verify all existing route tests still pass

- [ ] Register new capabilities in architecture.md and development-standards.md §18 (AC: 1)

## Dev Notes

### Architecture Compliance

This story implements the "Data Service" layer from architecture.md §Service Boundary Architecture. The key rule: **route handlers must NEVER call `getSupabaseAdminClient()` directly**.

### Files to grep for violations after completion
```bash
# Should return ZERO matches when done:
grep -r "getSupabaseAdminClient" cblaero/src/app/api/ --include="*.ts"
```

### Existing patterns to follow
- `candidate-repository.ts` — the gold standard. Dual persistence (Supabase + in-memory), typed functions, row mappers, test helpers.
- `saved-search-repository.ts` — same pattern for saved searches.

### What already exists (MODIFY, do not recreate)
- `modules/ingestion/index.ts` — has `upsertCandidateFromEmailFull` with inline submission inserts
- `app/api/internal/candidates/route.ts` lines 179-261 — cross-client JWT logic to extract
- All route handlers listed in Tasks

### References

- [Source: docs/planning_artifacts/development-standards.md — §4 Database Access, §14 Dead Code, §18 Reusability, §20 Capability Registry]
- [Source: docs/planning_artifacts/architecture.md — Service Boundary Architecture, Implemented Capabilities Registry]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
