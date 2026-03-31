# Story 2.3: Implement ATS and Email Ingestion Connectors

Status: in-progress

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
  - [ ] Implement polling schedule using global scheduler (stub only — needs real scheduler e.g. BullMQ)
- [x] Implement recruiter inbox parsing (AC: 1, 2, 3)
  - [ ] Parse Microsoft Graph mail for candidate data (stub only — auth and real API call not implemented)
  - [x] Map parsed data to ingestion pipeline
- [x] Error handling and reporting (AC: 4)
  - [x] Attribute sync failures to source and log for review
  - [x] Expose error tracking in admin dashboard

### Review Follow-ups (AI)

- [ ] [AI-Review][HIGH] AC3: `upsertCandidateFromATS` and `upsertCandidateFromEmailFull` are stubs — candidates are logged but not persisted. Wire to Supabase once Story 2.4 candidates table lands. [cblaero/src/modules/ingestion/index.ts:65-82]
- [ ] [AI-Review][HIGH] AC2: `GlobalScheduler.register()` is a no-op stub. Integrate with real scheduler (BullMQ, node-cron) and call `registerIngestionJobs` at app startup. [cblaero/src/modules/ingestion/jobs.ts:55-62]
- [ ] [AI-Review][HIGH] AC1: `MicrosoftGraphEmailParser.parseInbox()` returns hardcoded mock data. Implement real Microsoft Graph auth and mail fetch. [cblaero/src/modules/email/index.ts:22-46]
- [ ] [AI-Review][MEDIUM] `IngestionEnvelope` is never passed through the upsert functions — source attribution metadata is dropped. Thread envelope through upsert calls. [cblaero/src/modules/ats/index.ts:33-38]
- [x] [AI-Review][MEDIUM] `candidate: any` in ATSRecord bypasses the expanded candidate schema. Fixed: typed to `Record<string, unknown>`. [cblaero/src/modules/ats/index.ts:10]
- [x] [AI-Review][MEDIUM] `GreenhouseATSConnector` mock returned `name` field but `normalizeCandidate` reads `firstName`/`lastName` — silent data loss. Fixed mock to use `firstName`/`lastName`. [cblaero/src/modules/ats/index.ts:23]
- [x] [AI-Review][MEDIUM] Dead export `upsertCandidateFromEmail` never called anywhere. Removed. [cblaero/src/modules/ingestion/index.ts]
- [x] [AI-Review][MEDIUM] `SyncErrorStatusCard` used `toLocaleString()` causing server/client hydration mismatch. Fixed to stable UTC string format. [cblaero/src/app/dashboard/admin/SyncErrorStatusCard.tsx]
- [ ] [AI-Review][MEDIUM] No tests for any new module. Add unit tests for connector polling, ingestion jobs, and sync error store. [cblaero/src/modules/__tests__/]

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
- Remaining: real scheduler integration, real Microsoft Graph auth, Supabase persistence (blocked on Story 2.4), tests

### File List

- cblaero/src/modules/ats/index.ts (new)
- cblaero/src/modules/email/index.ts (new)
- cblaero/src/modules/email/nlp-extract-and-upload.ts (new)
- cblaero/src/modules/ingestion/jobs.ts (new)
- cblaero/src/modules/ingestion/index.ts (modified)
- cblaero/src/app/dashboard/admin/SyncErrorStatusCard.tsx (new)
- cblaero/src/app/dashboard/admin/page.tsx (modified)
