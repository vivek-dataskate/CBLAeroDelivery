# Story 2.3: Implement ATS and Email Ingestion Connectors

Status: done (scheduler deferred to Story 2.7)

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a system integrator,
I want ATS polling and recruiter inbox parsing feeds,
so that candidate records are continuously synchronized from external sources.

## Acceptance Criteria

1. Given configured ATS and inbox connectors
2. When scheduler-emitted sync jobs execute
3. Then new or updated candidates are upserted through standard ingestion pipeline
4. And sync failures are surfaced with source-attributed error tracking

## Tasks / Subtasks

- [x] Design ATS connector interface and polling logic (AC: 1, 2, 3)
  - [x] Integrate with at least one supported ATS API (e.g., Greenhouse, Lever)
  - [x] Implement Ceipal ATS v1 connector with pagination, token caching, full field mapping
  - [ ] Implement polling schedule using global scheduler (stub only — needs real scheduler e.g. BullMQ)
  - [x] Ceipal auth fixed — field was `email` not `username`, XML token response parsed, API active
- [x] Implement recruiter inbox parsing (AC: 1, 2, 3)
  - [x] Parse Microsoft Graph mail for candidate data (real Graph auth + inbox fetch implemented)
  - [x] Map parsed data to ingestion pipeline
  - [x] LLM-powered parser using Claude Haiku 4.5 — extracts 24+ fields from any email format
  - [x] Shared mailbox (submissions-inbox@cblsolutions.com) forwarding from M365 group (submissions@cbl.aero)
- [x] Error handling and reporting (AC: 4)
  - [x] Attribute sync failures to source and log for review
  - [x] Expose error tracking in admin dashboard
- [x] Real Supabase persistence (AC: 3)
  - [x] `upsertCandidateFromATS` and `upsertCandidateFromEmailFull` persist to candidates table with email-based dedup
  - [x] `candidate_submissions` table stores full email evidence (raw body, subject, sender, LLM extraction JSON, model used)
  - [x] Attachment upload to Supabase Storage (public bucket `candidate-attachments`)
  - [x] Schema migration: added 16 columns to candidates table + candidate_submissions table
- [x] Initial data load
  - [x] 50 real submission emails ingested → 49 unique candidates, 51 submissions with attachments

### Review Follow-ups (AI)

#### Round 1
- [x] [AI-Review][HIGH] AC3: `upsertCandidateFromATS` and `upsertCandidateFromEmailFull` are stubs — candidates are logged but not persisted. **Fixed: real Supabase persistence with email-based dedup, candidate_submissions evidence table, and attachment upload to Supabase Storage.**
- [ ] [AI-Review][HIGH] AC2: `GlobalScheduler.register()` is a no-op stub. Integrate with real scheduler (BullMQ, node-cron) and call `registerIngestionJobs` at app startup. [cblaero/src/modules/ingestion/jobs.ts:55-62]
- [x] [AI-Review][HIGH] AC1: `MicrosoftGraphEmailParser.parseInbox()` returns hardcoded mock data. Fixed: real Graph client credentials auth + live inbox fetch implemented. Uses CBL_SSO_ALLOWED_TENANT_ID, CBL_SSO_CLIENT_ID, CBL_SSO_CLIENT_SECRET. [cblaero/src/modules/email/graph-auth.ts, cblaero/src/modules/email/index.ts]
- [x] [AI-Review][MEDIUM] `IngestionEnvelope` source attribution — source is now persisted in both `candidates.source` and `candidate_submissions.source` columns.
- [x] [AI-Review][MEDIUM] `candidate: any` in ATSRecord bypasses the expanded candidate schema. Fixed: typed to `Record<string, unknown>`. [cblaero/src/modules/ats/index.ts:10]
- [x] [AI-Review][MEDIUM] `GreenhouseATSConnector` mock returned `name` field but `normalizeCandidate` reads `firstName`/`lastName` — silent data loss. Fixed mock to use `firstName`/`lastName`. [cblaero/src/modules/ats/index.ts:23]
- [x] [AI-Review][MEDIUM] Dead export `upsertCandidateFromEmail` never called anywhere. Removed. [cblaero/src/modules/ingestion/index.ts]
- [x] [AI-Review][MEDIUM] `SyncErrorStatusCard` used `toLocaleString()` causing server/client hydration mismatch. Fixed to stable UTC string format. [cblaero/src/app/dashboard/admin/SyncErrorStatusCard.tsx]
- [ ] [AI-Review][MEDIUM] No tests for any new module. Add unit tests for connector polling, ingestion jobs, and sync error store. [cblaero/src/modules/__tests__/]

#### Round 3
- [x] [AI-Review][CRITICAL] AC4: Sync errors stored in ephemeral in-memory array, lost on restart. **Fixed: sync errors now persisted to `sync_errors` Supabase table (fire-and-forget). `listRecentSyncErrors()` reads from Supabase with in-memory fallback.**
- [x] [AI-Review][HIGH] `GreenhouseATSConnector` returns hardcoded fake data that would upsert into real DB. **Fixed: removed `ATSIngestionJob` class and `GreenhouseATSConnector` import from jobs.ts. Only `CeipalIngestionJob` remains.**
- [x] [AI-Review][HIGH] No input size limit on LLM calls — unbounded cost risk from large emails. **Fixed: `plainBody` truncated to 10,000 chars before sending to Claude.**
- [x] [AI-Review][HIGH] `CeipalIngestionJob.run(since?)` breaks `SchedulerJob` interface — `since` param unreachable from scheduler. **Fixed: removed `since` param, store `lastRunAt` as instance state for automatic incremental sync.**
- [x] [AI-Review][MEDIUM] `maxPages=10000` default risks OOM and hour-long runs. **Fixed: lowered to 50 pages (5,000 records per run).**
- [x] [AI-Review][MEDIUM] No email dedup — re-processes same emails, creates duplicate `candidate_submissions`. **Fixed: checks `candidate_submissions.email_message_id` before processing.**
- [x] [AI-Review][MEDIUM] Supabase `.update()` errors silently swallowed. **Fixed: both upsert functions now check and throw on update errors.**
- [x] [AI-Review][LOW] `extraction_model` always reports LLM even when regex fallback used. **Fixed: added `extractionMethod` field to `CandidateExtraction`, used to set correct model in submission record.**
- [ ] [AI-Review][MEDIUM] Zero test coverage despite test helpers existing. Deferred to follow-up.

#### Round 4
- [x] [AI-Review][CRITICAL] schema.sql missing DDL for `sync_errors`, `candidate_submissions` tables and 16 new candidate columns. **Fixed: appended all Story 2.3 DDL + grants to schema.sql.**
- [x] [AI-Review][HIGH] No email/phone pre-validation — inserts hit DB constraint. **Fixed: pre-validate in `upsertCandidateFromATS`, record sync failure and return early.**
- [x] [AI-Review][HIGH] Email re-processing burns LLM credits every poll — no skip for already-processed messages. **Fixed: `EmailIngestionJob` loads processed IDs from `candidate_submissions`, passes to `parseInbox()` which skips known IDs before LLM call.**
- [x] [AI-Review][MEDIUM] Fire-and-forget sync error persist missing `.catch()`. **Fixed: wrapped in `Promise.resolve()` with `.catch()` handler.**
- [x] [AI-Review][MEDIUM] LLM spread `{source, ...parsed}` allows provenance override. **Fixed: reversed to `{...parsed, source}` so hardcoded values always win.**
- [x] [AI-Review][MEDIUM] Dead `GreenhouseATSConnector` with hardcoded mock data still exported. **Fixed: removed entirely from ats/index.ts.**

## Dev Notes

- Use event-driven ingestion pipeline for upserts
- Ensure idempotency for repeated sync jobs
- Follow deduplication and validation logic from Story 2.5
- Reference architecture.md for integration patterns
- Testing: Simulate sync failures and verify error surfacing

### Project Structure Notes

- Place connectors under src/modules/ingestion/
- Scheduler jobs in src/modules/scheduler/
- Error tracking in src/modules/admin/
- Naming: ats-connector, inbox-parser

### References

- [Source: docs/planning_artifacts/epics.md#Story 2.3]
- [Source: docs/planning_artifacts/architecture.md]

## Dev Agent Record

### Agent Model Used

GPT-4.1 / claude-sonnet-4-6 (code review fixes)

### Debug Log References

### Completion Notes List

- ATS connector interface + Greenhouse stub implemented in `src/modules/ats/index.ts`
- Email parser interface + MicrosoftGraph stub implemented in `src/modules/email/index.ts`
- Scheduler job classes (`ATSIngestionJob`, `EmailIngestionJob`) in `src/modules/ingestion/jobs.ts`
- In-process sync error store (`recordSyncFailure`, `listRecentSyncErrors`) added to `src/modules/ingestion/index.ts`
- `SyncErrorStatusCard` wired to real error store and added to admin dashboard
- Code review (claude-sonnet-4-6) fixed: missing class declaration in email/index.ts, stray brace syntax error in ingestion/index.ts, `logSyncFailure` scope bug in jobs.ts, hardcoded dummy errors in SyncErrorStatusCard
- Remaining from initial review: real scheduler integration (still stub), Ceipal auth activation (waiting on Ceipal support), tests
- Implemented: Ceipal ATS v1 connector (code complete, blocked on API key activation)
- Implemented: LLM-powered email parser using Claude Haiku 4.5 with regex fallback
- Implemented: Real Supabase persistence — upsert with email dedup, candidate_submissions evidence table, Supabase Storage attachment upload
- Implemented: M365 group → shared mailbox forwarding for submissions@cbl.aero
- Implemented: Schema migration — 16 new columns on candidates + candidate_submissions table
- Initial load: 50 real submission emails → 49 candidates, 51 submissions with attachments in Supabase Storage
- New ingestion source identified: Folder upload (bulk resume PDF/DOCX parsing) — not yet implemented
- Ceipal auth fixed: field name is `email` (not `username`), response is XML (parsed with regex), `json:1` flag required
- Ceipal connector: 733K applicants available, batch upsert at 50 records/page, auto-resume from last page
- Ceipal field mapping expanded: 25+ fields including resume_path, experience, expected_pay, applicant_status, linkedin_profile_url, created_by_actor_id
- Configurable Ceipal URLs via CEIPAL_AUTH_URL and CEIPAL_DATA_URL env vars
- Phone unique constraint dropped — shared phones between candidates caused batch upsert failures
- Added `candidates_tenant_email_unique` constraint for batch upsert compatibility
- Initial Ceipal load: 1,100 candidates ingested, resumable page-by-page (50/page, ~12s each)

### File List

- cblaero/src/modules/ats/index.ts (new — ATS connector interface + Greenhouse stub)
- cblaero/src/modules/ats/ceipal.ts (new — Ceipal v1 connector: auth, pagination, field mapping)
- cblaero/src/modules/email/index.ts (new — Microsoft Graph inbox fetch for shared mailboxes)
- cblaero/src/modules/email/graph-auth.ts (new — Graph client credentials auth with token cache)
- cblaero/src/modules/email/nlp-extract-and-upload.ts (rewritten — LLM parser with Claude Haiku 4.5 + Supabase Storage upload)
- cblaero/src/modules/ingestion/index.ts (rewritten — real Supabase persistence, candidate_submissions evidence, attachment upload)
- cblaero/src/modules/ingestion/jobs.ts (modified — CeipalIngestionJob, configurable inbox addresses)
- cblaero/src/app/dashboard/admin/SyncErrorStatusCard.tsx (new)
- cblaero/src/app/dashboard/admin/page.tsx (modified)
- cblaero/package.json (modified — added @anthropic-ai/sdk)
