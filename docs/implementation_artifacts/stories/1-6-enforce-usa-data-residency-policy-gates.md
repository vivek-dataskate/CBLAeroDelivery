# Story 1.6: Enforce USA Data Residency Policy Gates

Status: review

## Story

As a platform owner,
I want storage and backup targets constrained to approved USA regions,
so that residency commitments are enforced by architecture and configuration.

## Acceptance Criteria

1. Given deployment and storage configuration, when non-approved region targets are configured, then deployment or provisioning is blocked with explicit error messaging.
2. Compliance evidence for active region settings is queryable.

## Tasks / Subtasks

- [x] Define USA residency policy contract and fail-fast validation module (AC: 1)
  - [x] Add a dedicated residency policy module that validates runtime region targets for data, logs, and backups against an approved USA allowlist.
  - [x] Ensure configuration validation errors include the non-approved target and the approved region list.
  - [x] Prevent implicit fallback behavior when a required residency setting is missing.

- [x] Enforce residency policy gates on startup/provisioning paths (AC: 1)
  - [x] Wire policy validation into startup checks so invalid region targets fail fast before app traffic is served.
  - [x] Ensure provisioning and migration entrypoints are blocked when residency policy fails.
  - [x] Keep enforcement server-authoritative (no client-side-only controls).

- [x] Add compliance evidence recording and protected query access (AC: 2)
  - [x] Record residency validation outcomes (pass/fail, checked targets, effective approved list, timestamp, trace ID) in the audit/compliance stream.
  - [x] Add a protected internal endpoint for admin/compliance roles to query current effective residency configuration evidence.
  - [x] Ensure evidence payloads remain tenant-safe and auditable.

- [x] Add tests and quality gates for residency controls (AC: 1, 2)
  - [x] Add unit tests for allow/deny behavior and explicit validation error text.
  - [x] Add route/integration tests for protected compliance evidence query behavior.
  - [x] Run lint, typecheck, test, and build; capture verification output in completion notes.

### Review Follow-ups (AI)

- [x] [AI-Review][High] Fix invalid-policy response path so explicit policy-gate errors are returned without invoking Supabase persistence helpers that re-trigger the residency assertion and can produce a 500. [Source: cblaero/src/app/api/internal/compliance/data-residency/route.ts:68, cblaero/src/modules/audit/index.ts:449, cblaero/src/modules/persistence/index.ts:65]
- [x] [AI-Review][High] Enforce that approved residency allowlist values are USA-only region identifiers (for example, reject non-US values in CBL_APPROVED_US_REGIONS). [Source: cblaero/src/modules/persistence/data-residency.ts:46, cblaero/src/modules/persistence/data-residency.ts:71]
- [x] [AI-Review][Medium] Implement or document concrete provisioning and migration gate enforcement; current implementation is runtime persistence-path enforcement only while task is marked complete. [Source: docs/implementation_artifacts/stories/1-6-enforce-usa-data-residency-policy-gates.md:25, cblaero/src/modules/persistence/index.ts:61]
- [x] [AI-Review][Medium] Add non-test coverage for invalid-policy endpoint behavior, since current tests run with NODE_ENV=test and do not exercise production enforcement behavior. [Source: cblaero/src/modules/persistence/data-residency.ts:40, cblaero/src/app/api/internal/compliance/data-residency/__tests__/route.test.ts:153]
- [x] [AI-Review][Medium] Consolidate USA residency policy validation logic so preflight and runtime use a single source of truth; current duplicate implementations can drift and produce conflicting pass/fail behavior. [Source: cblaero/scripts/residency-preflight.mjs:3, cblaero/src/modules/persistence/data-residency.ts:21]
- [x] [AI-Review][Medium] Stop storing residency check events in process memory for non-test execution paths; currently every request retains actor/tenant policy evidence in memory even when persistent storage is available. [Source: cblaero/src/modules/audit/index.ts:439, cblaero/src/modules/audit/index.ts:447]

## Dev Notes

- Story dependency context:
  - Story 1.5 established sensitive-operation hardening and dedicated audit pathways. Reuse its server-side enforcement and explicit error semantics patterns.
  - Story 1.3/1.4 established RBAC + tenant-safe authorization and admin governance route structure; align new compliance evidence route to the same guardrails.
- Residency requirements to enforce in implementation:
  - FR70/NFR23 require USA-only residency for customer data, logs, and backups.
  - Cross-region replication outside approved USA regions is prohibited.
  - Third-party processors must have documented residency posture; unsupported posture must be blocked or routed via approved proxy approach.
- Guardrail from architecture policy model:
  - Do not hardcode business policy values in application logic; keep approved-region policy values explicit and configurable under policy governance.
- Persistence and reliability expectations:
  - Compliance evidence must be persisted in Supabase-backed auditable storage (not process-local memory for production behavior).
  - Backup/residency controls must align with immutable backup and recovery constraints defined in FR69/NFR31.

### Project Structure Notes

- Expected primary touchpoints:
  - `cblaero/src/modules/persistence/`
  - `cblaero/src/modules/audit/`
  - `cblaero/src/modules/auth/`
  - `cblaero/src/app/api/internal/`
  - `cblaero/src/modules/__tests__/`
  - `cblaero/src/app/api/internal/**/__tests__/`
- If additional env contract is introduced for approved regions, update:
  - `cblaero/.env.local.example`
  - `cblaero/.env.render.example`
  - `cblaero/README.md`

### References

- Source: docs/planning_artifacts/epics.md (Epic 1, Story 1.6)
- Source: docs/planning_artifacts/epics.md (FR70, NFR23)
- Source: docs/planning_artifacts/prd.md (Data Residency and Compliance Boundaries)
- Source: docs/planning_artifacts/prd.md (FR70, NFR23, NFR31)
- Source: docs/planning_artifacts/architecture.md (Infrastructure and Deployment)
- Source: docs/planning_artifacts/architecture.md (Supabase and Data Security Readiness)
- Source: docs/planning_artifacts/architecture.md (Policy Registry and Zero-Inference Guardrail)
- Source: docs/planning_artifacts/implementation-readiness-tracker.md (D-01 Supabase in approved US region)

## Dev Agent Record

### Agent Model Used

GPT-5.3-Codex

### Debug Log References

- npm run residency:preflight
- npm test -- src/modules/__tests__/data-residency.test.ts
- npm test -- src/app/api/internal/compliance/data-residency/__tests__/route.test.ts
- npm run lint
- npm run typecheck
- npm test
- npm run build

### Completion Notes List

- Implemented USA residency policy module with explicit allowlist validation for data/log/backup region targets.
- Enforced fail-fast residency gates by wiring policy assertion into Supabase persistence configuration.
- Added compliance evidence audit event model and persistence/listing support for data residency checks.
- Added protected internal endpoint at `/api/internal/compliance/data-residency` for admin/compliance evidence query with explicit pass/fail responses.
- Extended authorization policy to allow compliance/admin evidence access while keeping recruiter access denied.
- Added Supabase schema support for data residency compliance audit events.
- Added Story 1.6 tests for policy validation and compliance endpoint authorization/response behavior.
- Fixed invalid-policy endpoint flow so explicit 412 responses do not depend on Supabase list queries in failure paths.
- Added USA-only identifier validation for approved region allowlist entries.
- Added concrete provisioning/migration residency gate command via `npm run residency:preflight` and documented usage.
- Added production-semantics route coverage with module mocks for invalid-policy behavior.
- Stabilized test-mode persistence behavior to use in-memory stores by default unless explicitly overridden.
- Validation passed locally: targeted tests, lint, typecheck, full test suite, and production build.

### File List

- cblaero/src/modules/persistence/data-residency.ts
- cblaero/src/modules/persistence/index.ts
- cblaero/src/modules/audit/index.ts
- cblaero/src/modules/auth/authorization.ts
- cblaero/src/app/api/internal/compliance/data-residency/route.ts
- cblaero/src/app/api/internal/compliance/data-residency/__tests__/route.test.ts
- cblaero/src/modules/__tests__/data-residency.test.ts
- cblaero/supabase/schema.sql
- cblaero/README.md
- cblaero/.env.local.example
- cblaero/package.json
- cblaero/scripts/data-residency-policy.cjs
- cblaero/scripts/residency-preflight.mjs
- cblaero/src/modules/persistence/data-residency-policy-shared.d.ts
- docs/implementation_artifacts/stories/1-6-enforce-usa-data-residency-policy-gates.md
- docs/implementation_artifacts/sprint-status.yaml

## Senior Developer Review (AI)

### Reviewer

GPT-5.3-Codex

### Date

2026-03-12

### Outcome

Changes Requested

### Summary

- Story implementation is close, but acceptance criteria are not fully reliable under invalid-policy runtime conditions.
- Identified 2 High and 2 Medium findings that require follow-up before marking done.

### Key Findings

1. High: invalid-policy endpoint path can fail with 500 before returning explicit policy error because audit persistence path requests a Supabase client that re-checks and throws residency assertion.
2. High: approved-region allowlist is not validated as USA-only, so a non-US allowlist could pass validation and violate FR70/NFR23 intent.
3. Medium: subtask claiming migration/provisioning entrypoint blocking is marked complete, but implementation evidence currently shows runtime persistence-path gating only.
4. Medium: tests validate invalid-policy route behavior only in test-mode enforcement context and do not cover production enforcement semantics.

### Acceptance Criteria Re-check

- AC1: Partial. Explicit error messaging is implemented in code, but runtime path can throw before response in non-test mode; migration/provisioning blocking is not fully evidenced.
- AC2: Partial. Evidence query route exists, but invalid-policy response reliability is currently impacted by the issue above.

## Senior Developer Re-Review (AI)

### Reviewer

GPT-5.3-Codex

### Date

2026-03-27

### Outcome

Changes Requested

### Summary

- Prior high-severity findings remain resolved.
- Identified 2 medium follow-ups focused on policy-validation consistency and minimizing production memory retention of compliance evidence payloads.

### Key Findings

1. Medium: residency policy validation exists in two separate implementations (runtime module and preflight script), creating drift risk where provisioning and runtime gates could disagree.
2. Medium: data residency checks are appended to process memory before in-memory mode checks, retaining actor/tenant policy evidence in production workers unnecessarily.

### Acceptance Criteria Re-check

- AC1: Partial. Runtime and preflight gates exist, but consistency is not guaranteed due to duplicated validation logic.
- AC2: Partial. Queryability exists, but compliance evidence handling should reduce unnecessary in-memory retention in non-test execution.

## Change Log

- 2026-03-12: Senior developer code review performed; Changes Requested outcome recorded with 4 follow-up action items.
- 2026-03-12: Implemented all code review follow-ups (2 High, 2 Medium) and restored story to review status.
- 2026-03-27: Senior developer re-review performed; 2 Medium follow-up action items added and story returned to in-progress.
- 2026-03-27: Implemented both medium follow-ups by sharing residency validation across runtime/preflight, eliminating non-test in-memory residency event retention, and consolidating route coverage into one residency test file.