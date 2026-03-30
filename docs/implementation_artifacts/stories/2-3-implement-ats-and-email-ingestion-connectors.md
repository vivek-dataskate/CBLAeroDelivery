# Story 2.3: Implement ATS and Email Ingestion Connectors

Status: ready-for-dev

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

- [ ] Design ATS connector interface and polling logic (AC: 1, 2, 3)
  - [ ] Integrate with at least one supported ATS API (e.g., Greenhouse, Lever)
  - [ ] Implement polling schedule using global scheduler
- [ ] Implement recruiter inbox parsing (AC: 1, 2, 3)
  - [ ] Parse Microsoft Graph mail for candidate data
  - [ ] Map parsed data to ingestion pipeline
- [ ] Error handling and reporting (AC: 4)
  - [ ] Attribute sync failures to source and log for review
  - [ ] Expose error tracking in admin dashboard

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

GPT-4.1

### Debug Log References

### Completion Notes List

### File List
