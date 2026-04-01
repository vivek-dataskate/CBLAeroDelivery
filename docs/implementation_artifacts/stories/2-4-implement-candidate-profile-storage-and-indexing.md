# Story 2.4: Implement Candidate Profile Storage and Indexing

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a recruiter,
I want candidate profiles stored with searchable core attributes,
so that I can find and review talent quickly.

## Acceptance Criteria

1. **Given** ingested candidate records in the `candidates` table
   **When** a recruiter queries the candidate list with at least one pre-filter (availability_status, location, or cert type)
   **Then** only `active`-state tenant-scoped candidates are returned via cursor-based pagination (no offset, no unfiltered full-scan)

2. **Given** an active candidate record in the database
   **When** a recruiter requests the profile detail view by candidateId
   **Then** the response includes all core attributes (name, contact fields, location, skills, certifications, experience) plus source and ingestion metadata (source, source_batch_id, ingestion_state, created_at, updated_at)

3. **Given** the `candidates` table at 1M+ scale
   **When** filtered list queries execute
   **Then** GIN indexes on `skills` and `certifications` JSONB columns are present and queryable, and a `tsvector` full-text index on `name` supports name-based search

4. **Given** any candidate list or detail endpoint call
   **Then** all responses are tenant-isolated (tenant_id predicate always applied) and follow the standard API envelope (`{"data": ..., "meta": ...}`)

## Tasks / Subtasks

- [x] Add missing schema indexes for queryability (AC: 1, 3)
  - [x] Add GIN index on `certifications` JSONB: `idx_candidates_certifications_gin`
  - [x] Add GIN index on `skills` JSONB: `idx_candidates_skills_gin`
  - [x] Add generated column `name_tsv tsvector` + GIN index for full-text search on `name`, `first_name`, `last_name`
  - [x] Add composite partial index on `(tenant_id, ingestion_state)` for active-only queries: `idx_candidates_tenant_state`
  - [x] Write new migration file in `cblaero/supabase/schema.sql` (append ALTER TABLE + CREATE INDEX DDL)

- [x] Implement real candidate list query in `GET /api/internal/candidates` (AC: 1, 4)
  - [x] Replace hardcoded stub response with Supabase query against `cblaero_app.candidates`
  - [x] Enforce `ingestion_state = 'active'` filter by default (exclude `pending_dedup`, `pending_enrichment`, `rejected`)
  - [x] Require at least one pre-filter param (`availability_status`, `location`, or `cert_type`) — return 400 if none provided (no unfiltered full-scan per architecture)
  - [x] Implement cursor-based pagination: accept `cursor` (last `id` UUID) + `limit` (max 100, default 25) query params; return `meta.nextCursor`
  - [x] Apply `tenant_id` predicate on every query (use session.tenantId)
  - [x] Return standard envelope `{"data": CandidateListItem[], "meta": {tenantId, nextCursor, filters}}`

- [x] Add `GET /api/internal/candidates/[candidateId]` profile detail endpoint (AC: 2, 4)
  - [x] Create `cblaero/src/app/api/internal/candidates/[candidateId]/route.ts`
  - [x] Validate session + `candidate:read` authorization (same pattern as existing candidates route)
  - [x] Query `cblaero_app.candidates` by `id` AND `tenant_id` (no cross-tenant fetch possible)
  - [x] Return full profile: all columns including `source`, `source_batch_id`, `ingestion_state`, `created_at`, `updated_at`
  - [x] Return 404 with `{"error": {"code": "not_found", ...}}` if record not found or tenant mismatch

- [x] Create `features/candidate-management` module foundation (AC: 1, 2)
  - [x] Create `cblaero/src/features/candidate-management/contracts/candidate.ts` with `CandidateListItem`, `CandidateDetail` TypeScript types matching the DB schema
  - [x] Create `cblaero/src/features/candidate-management/infrastructure/candidate-repository.ts` with `listCandidates(params)` and `getCandidateById(id, tenantId)` functions using Supabase client
  - [x] Route handler calls repository, not Supabase directly

- [x] Write tests (AC: 1, 2, 3, 4)
  - [x] Add unit tests for `candidate-repository.ts` (in-memory store; 14 tests covering list filters, pagination, tenant isolation, getById found/not-found/tenant-mismatch/metadata)
  - [x] Add integration tests for `GET /api/internal/candidates` covering: missing filter → 400, valid filter → paginated results with nextCursor
  - [x] Add integration tests for `GET /api/internal/candidates/[candidateId]` covering: found → 200 with full profile + metadata, not found → 404, cross-tenant → 404, unauthenticated → 401

### Review Follow-ups (AI)

- [ ] [AI-Review][MEDIUM] Detail endpoint does not record audit trail for candidate profile access. Requires new audit event type (`candidate:profile-view`) in `@/modules/audit`. Deferred: cross-cutting concern beyond this story scope. [cblaero/src/app/api/internal/candidates/[candidateId]/route.ts]
- [ ] [AI-Review][LOW] `extractSessionToken` and `toErrorCode` duplicated across two route files. Consider shared utility. [cblaero/src/app/api/internal/candidates/route.ts, candidateId/route.ts]

## Dev Notes

### Context and Background

Story 2.4 is the "queryability" story for the candidate store. The `candidates` table was created in Story 2.1 (migration pipeline) and expanded in Story 2.2 (CSV upload wizard). As of commit `ce25b7c1`, the table has the full contact and professional schema. This story does NOT re-build the schema — it adds missing indexes and implements the profile retrieval layer.

**What already exists (do not duplicate):**
- `cblaero_app.candidates` table with all columns (see `cblaero/supabase/schema.sql` line 230+)
- Schema columns: `id`, `tenant_id`, `email`, `phone`, `name`, `first_name`, `last_name`, `middle_name`, `home_phone`, `work_phone`, `address`, `city`, `state`, `country`, `postal_code`, `current_company`, `job_title`, `alternate_email`, `location`, `skills` (jsonb), `certifications` (jsonb), `experience` (jsonb), `extra_attributes` (jsonb), `availability_status` (active/passive/unavailable), `ingestion_state` (pending_dedup/pending_enrichment/active/rejected), `source`, `source_batch_id`, `created_at`, `updated_at`
- Existing indexes: `uq_candidates_tenant_email`, `uq_candidates_tenant_phone`, `idx_candidates_tenant_availability` (partial, ingestion_state=active), `idx_candidates_tenant_location` (partial, ingestion_state=active), `idx_candidates_source_batch`
- `GET /api/internal/candidates` route — has full auth/authz/step-up scaffolding but returns hardcoded stub (line 536–550 of route.ts). **Only replace the stub response body; do NOT touch the auth/session logic.**
- `cblaero_app.process_import_chunk` RPC — do NOT modify this function

**What is missing (this story's job):**
- GIN indexes on `skills`, `certifications` JSONB (architecture §Data strategy requires cert-queryable paths)
- Full-text search index on name fields
- Real Supabase query implementation replacing the stub in candidates GET
- Profile detail endpoint (`/api/internal/candidates/[candidateId]`)
- `features/candidate-management/` module skeleton

### Architecture Compliance Requirements

**1. Cursor-based pagination is MANDATORY — no offset pagination ever**
- Architecture §Data strategy: "Cursor-based pagination enforced on all candidate list endpoints (no offset pagination at scale)"
- Use `id > $cursor` ordered by `id ASC` for stable cursor pagination at 1M+ rows
- Pattern: `WHERE tenant_id = $tenantId AND ingestion_state = 'active' AND <filters> AND id > $cursor ORDER BY id ASC LIMIT $limit + 1` (fetch limit+1 to detect next page)

**2. Pre-filter enforcement — no unfiltered full-scan allowed**
- Architecture + UX design: "The UI must not offer a 'show all' control on unfiltered candidate tables"
- API must return 400 if caller provides zero filters (available_status, location, cert_type are the supported pre-filters)
- This is a hard enforcement, not just a recommendation

**3. Tenant isolation is non-negotiable**
- Every DB query MUST include `tenant_id = session.tenantId`
- RLS policies exist on the table — service role client bypasses RLS, so application layer must always set `tenant_id` predicate explicitly
- Pattern already established in existing routes

**4. Supabase client usage**
- Use `getSupabaseAdminClient()` from `@/modules/persistence` for server-side queries (same pattern as existing routes)
- NEVER import Supabase client directly; always go through the persistence module

**5. API response envelope is mandatory**
- Success: `{"data": ..., "meta": {...}}`
- Error: `{"error": {"code": "...", "message": "...", "details": ...}}`
- All existing routes follow this pattern; do NOT deviate

**6. Feature module structure**
- Architecture mandates: "Organize by feature domain first, technical type second"
- Feature modules communicate through typed contracts only
- `features/candidate-management/contracts/` → public TypeScript types
- `features/candidate-management/infrastructure/` → repository (DB adapter)
- Route handlers import from contracts and infrastructure only
- Do NOT import from infrastructure in other feature modules directly

**7. Naming conventions**
- DB: `snake_case`, plural tables (`candidates`)
- Index names: `idx_<table>_<column_list>` (e.g., `idx_candidates_skills_gin`)
- TypeScript: types `PascalCase`, variables/functions `camelCase`
- Files: React components `PascalCase.tsx`, modules `kebab-case.ts`

### Supabase Query Patterns for this Story

```typescript
// Candidate list with cursor pagination
const { data, error } = await client
  .schema('cblaero_app')
  .from('candidates')
  .select('id, tenant_id, name, first_name, last_name, email, phone, location, availability_status, ingestion_state, skills, certifications, source, source_batch_id, created_at, updated_at')
  .eq('tenant_id', tenantId)
  .eq('ingestion_state', 'active')
  .eq('availability_status', filter.availability_status) // if provided
  .gt('id', cursor ?? '00000000-0000-0000-0000-000000000000')
  .order('id', { ascending: true })
  .limit(limit + 1); // fetch one extra to detect next page

// Profile detail
const { data, error } = await client
  .schema('cblaero_app')
  .from('candidates')
  .select('*')
  .eq('id', candidateId)
  .eq('tenant_id', tenantId)
  .single();
```

### Schema Migrations to Add

Append to `cblaero/supabase/schema.sql` (after existing candidate section):

```sql
-- GIN index for querying within certifications JSONB array
create index if not exists idx_candidates_certifications_gin
  on cblaero_app.candidates using gin (certifications)
  where ingestion_state = 'active';

-- GIN index for querying within skills JSONB array
create index if not exists idx_candidates_skills_gin
  on cblaero_app.candidates using gin (skills)
  where ingestion_state = 'active';

-- Full-text search: generated tsvector column on name fields
alter table cblaero_app.candidates
  add column if not exists name_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(first_name, '') || ' ' ||
      coalesce(last_name, '') || ' ' ||
      coalesce(name, '')
    )
  ) stored;

create index if not exists idx_candidates_name_fts
  on cblaero_app.candidates using gin (name_tsv)
  where ingestion_state = 'active';

-- Composite partial index for active-only state queries
create index if not exists idx_candidates_tenant_state
  on cblaero_app.candidates (tenant_id, ingestion_state);
```

> **Important**: Add these as `ALTER TABLE` / `CREATE INDEX IF NOT EXISTS` statements, not inside a new `CREATE TABLE`. The `candidates` table already exists.

### File Structure for This Story

```
cblaero/
  supabase/
    schema.sql                              ← Append new indexes (ALTER/CREATE only)
  src/
    features/
      candidate-management/               ← NEW directory
        contracts/
          candidate.ts                    ← NEW: TypeScript types
        infrastructure/
          candidate-repository.ts         ← NEW: DB query functions
    app/
      api/
        internal/
          candidates/
            route.ts                      ← MODIFY: replace stub GET response body only
            [candidateId]/
              route.ts                    ← NEW: profile detail endpoint
              __tests__/
                route.test.ts             ← NEW: integration tests
            __tests__/
              route.test.ts               ← MODIFY: add list query tests
```

### TypeScript Type Reference

```typescript
// src/features/candidate-management/contracts/candidate.ts

export type CandidateListItem = {
  id: string;
  tenantId: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  availabilityStatus: 'active' | 'passive' | 'unavailable';
  ingestionState: 'pending_dedup' | 'pending_enrichment' | 'active' | 'rejected';
  source: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
};

export type CandidateDetail = CandidateListItem & {
  middleName: string | null;
  homePhone: string | null;
  workPhone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  currentCompany: string | null;
  jobTitle: string | null;
  alternateEmail: string | null;
  skills: unknown[];       // JSONB array
  certifications: unknown[]; // JSONB array
  experience: unknown[];   // JSONB array
  extraAttributes: Record<string, unknown>;
  sourceBatchId: string | null;
};
```

### Previous Story Intelligence

**Story 2.3** (ATS/Email Ingestion Connectors, status: done) — Now fully implemented with real Supabase persistence. The `ingestion/index.ts` has real `upsertCandidateFromATS` and `upsertCandidateFromEmailFull` that persist to the `candidates` table with email-based dedup. Story 2.3 also added:
- 16 new columns to `candidates` table: `work_authorization`, `clearance`, `aircraft_experience` (jsonb), `employment_type`, `current_rate`, `per_diem`, `has_ap_license` (bool), `years_of_experience`, `ceipal_id`, `submitted_by`, `submitter_email`, `shift_preference`, `expected_start_date`, `call_availability`, `interview_availability`, `veteran_status`
- New `candidate_submissions` table for submission email evidence (raw body, LLM extraction JSON, attachment URLs)
- Supabase Storage bucket `candidate-attachments` for resume/document storage
- 49 real candidates and 51 submissions already ingested from email
- The `CandidateDetail` type and detail endpoint need to be updated to include these new columns

**Key pattern from Story 2.2** (CSV upload wizard): The `process_import_chunk` RPC is the established upsert path for ingestion. Story 2.4 is read-only — it does NOT write candidate records. It only queries existing records.

**Key pattern from existing candidates route** (`/api/internal/candidates/route.ts`): Authentication, step-up enforcement, and cross-client confirmation are all fully implemented. Only the GET handler's response stub (lines 536–550) needs to be replaced. Do NOT refactor the auth/authz wiring.

### Git Intelligence

Recent commits show active work on the candidate schema:
- `ce25b7c1` — Expanded candidate schema with full contact/professional fields (first_name, last_name, mobile as primary dedup field, 13 new columns)
- `336a3cbf` — Fixed display labels for canonical CSV fields
- `8fb394a4` — Merged Story 2.2 (CSV upload wizard)

The CSV upload wizard (`CsvUploadWizard.tsx`) and route (`csv-upload/route.ts`) are the reference for how canonical field types are defined. The `CanonicalField` union type in `shared.ts` is the authoritative field list — when adding types for candidate profiles, stay consistent with this list.

### Project Structure Notes

- All candidate domain code lives under `src/features/candidate-management/` per architecture mandates (`features/candidate-management/contracts`, `application`, `domain`, `infrastructure`, `ui`)
- This story only needs `contracts/` and `infrastructure/` layers — `application/` and `domain/` layers can be scaffolded empty or deferred to future stories
- The `src/modules/` directory contains cross-cutting concerns (auth, persistence, audit) — do NOT add candidate-specific logic there
- API routes live in `src/app/api/internal/candidates/` — these call the feature module, not persistence directly

### References

- [Source: docs/planning_artifacts/architecture.md — Data Strategy, §Candidate Data Ingestion Architecture]
- [Source: docs/planning_artifacts/architecture.md — Project Structure and Boundaries]
- [Source: docs/planning_artifacts/architecture.md — Naming Patterns, Structure Patterns]
- [Source: docs/planning_artifacts/epics.md — Story 2.4, FR3]
- [Source: docs/planning_artifacts/ux-design-specification.md — "at 1M+ records, candidate search and list views must use cursor-based pagination and indexed pre-filters"]
- [Source: cblaero/supabase/schema.sql — candidates table and existing indexes]
- [Source: cblaero/src/app/api/internal/candidates/route.ts — existing auth patterns to preserve]

## Senior Developer Review (AI)

**Reviewer:** claude-sonnet-4-6 (adversarial code review)
**Review Date:** 2026-03-31
**Review Outcome:** Changes Requested (5 fixed, 2 deferred)

### Action Items

- [x] [HIGH] CandidateDetail missing 16 columns added by Story 2.3 — Fixed: added all columns to type, row mapping, and test fixtures
- [x] [HIGH] cert_type filter not implemented in Supabase query path — Fixed: added `.contains()` JSONB query
- [x] [HIGH] Location filter LIKE metacharacters not escaped — Fixed: escape `%` and `_` before interpolation
- [x] [MEDIUM] availability_status not validated against allowed values — Fixed: added validation with 400 error
- [x] [MEDIUM] name_tsv full-text column created but never queryable via API — Fixed: added `search` param with `textSearch("name_tsv")` + in-memory fallback
- [ ] [MEDIUM] Detail endpoint missing audit trail (requires new event type in audit module — deferred)
- [ ] [LOW] extractSessionToken/toErrorCode duplicated across route files (acceptable for now)

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Schema: Appended 5 DDL statements to `supabase/schema.sql` — GIN indexes on `skills` and `certifications` JSONB (partial, `ingestion_state = 'active'`), generated `name_tsv tsvector` column with GIN FTS index, composite `(tenant_id, ingestion_state)` index for active-only queries.
- Feature module: Created `src/features/candidate-management/contracts/candidate.ts` (TypeScript types: `CandidateListItem`, `CandidateDetail`, `CandidateListParams`, `CandidateListResult`) and `src/features/candidate-management/infrastructure/candidate-repository.ts` with in-memory store for tests + Supabase path for production.
- GET /api/internal/candidates: Replaced hardcoded stub response with real `listCandidates()` repository call. Added pre-filter enforcement (returns 400 `filter_required` if no `availability_status`/`location`/`cert_type` given), cursor-based pagination (default limit 25, max 100), `ingestion_state = 'active'` default. Existing auth/step-up wiring untouched.
- GET /api/internal/candidates/[candidateId]: New detail endpoint returning full `CandidateDetail` including source/ingestion metadata. 404 on not-found or tenant mismatch. Auth follows same `candidate:read` authorization pattern as list endpoint.
- Tests: 14 repository unit tests, 3 new list-route integration tests (filter enforcement, pagination, filter variants), 6 detail-route integration tests (found, not found, cross-tenant, unauthenticated, role-based, extra_attributes). Updated 2 existing tests to supply required pre-filter param.
- Pre-existing failure in `csv-upload/route.test.ts` (duplicate test name for `(ignore)` contract test) was present before this story and is not a regression.

### File List

- cblaero/supabase/schema.sql (modified — schema indexes appended)
- cblaero/src/features/candidate-management/contracts/candidate.ts (new)
- cblaero/src/features/candidate-management/infrastructure/candidate-repository.ts (new)
- cblaero/src/features/candidate-management/infrastructure/__tests__/candidate-repository.test.ts (new)
- cblaero/src/app/api/internal/candidates/route.ts (modified — replaced stub GET response; added filter enforcement + pagination + repository call)
- cblaero/src/app/api/internal/candidates/__tests__/route.test.ts (modified — added imports, clearCandidateStoreForTest in beforeEach, 3 new tests, updated 2 existing tests to supply filter param)
- cblaero/src/app/api/internal/candidates/[candidateId]/route.ts (new)
- cblaero/src/app/api/internal/candidates/[candidateId]/__tests__/route.test.ts (new)
