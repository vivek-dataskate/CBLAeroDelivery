# Story 1.3: Enforce RBAC and Tenant-Isolated Authorization

Status: ready-for-dev

## Story

As a security engineer,
I want every read/write path to enforce role and tenant checks,
so that users cannot access data outside their allowed scope.

## Acceptance Criteria

1. Given authenticated users with different roles and tenants, when they access protected APIs and UI routes, then only role-permitted operations succeed.
2. Given cross-tenant access attempts, when a protected path is evaluated, then access is denied and the attempt is audited.

## Tasks / Subtasks

- [ ] Enforce role-based authorization on protected APIs and UI routes (AC: 1)
  - [ ] Define role-permission checks for internal roles across route handlers and protected pages.
  - [ ] Apply authorization guards so only allowed operations execute per role.
  - [ ] Return explicit unauthorized responses for forbidden role operations.

- [ ] Enforce tenant-isolated authorization on read/write paths (AC: 1, 2)
  - [ ] Validate tenant scope on every protected read/write path using trusted server session context.
  - [ ] Deny cross-tenant access attempts regardless of client-provided identifiers.
  - [ ] Ensure tenant context propagation remains server-authoritative throughout request handling.

- [ ] Add authorization audit logging for denied access (AC: 2)
  - [ ] Capture denied-role and cross-tenant events with actor, tenant, path, and reason metadata.
  - [ ] Ensure audit entries are emitted for both API and UI-protected path denials.
  - [ ] Verify denied events are queryable through existing audit foundations.

- [ ] Add quality gates and verification for authorization behavior (AC: 1, 2)
  - [ ] Add unit/integration tests for role-permitted access and role-forbidden access.
  - [ ] Add tests for cross-tenant denial and audit-event emission on denial.
  - [ ] Run lint, typecheck, test, and build; capture evidence in completion notes.

## Dev Notes

- Build on Story 1.2 authenticated session context and keep authorization checks server-side.
- Treat tenant and role from signed session as trusted; do not trust client-supplied actor/tenant claims.
- Ensure denial behavior is deterministic and observable through audit logging.
- Keep implementation scoped to authorization and tenant isolation only.

### Project Structure Notes

- Existing auth/session baseline from Stories 1.1 and 1.2 is in place under `cblaero/src/modules/auth/` and `cblaero/src/proxy.ts`.
- Expected primary touchpoints for this story:
  - `cblaero/src/modules/auth/`
  - `cblaero/src/modules/audit/`
  - Protected route handlers/components under `cblaero/src/app/`
  - Authorization-focused tests under `cblaero/src/modules/__tests__/` and/or `cblaero/src/app/**/__tests__/`

### References

- Source: docs/planning_artifacts/epics.md (Epic 1, Story 1.3)
- Source: docs/planning_artifacts/prd.md (Identity and Session Management)
- Source: docs/planning_artifacts/architecture.md (Authentication and Security)
- Source: docs/planning_artifacts/architecture.md (Architectural Boundaries)

## Dev Agent Record

### Agent Model Used

GPT-5.3-Codex

### Debug Log References

### Completion Notes List

- Story created from Epic 1 Story 1.3 with acceptance criteria and implementation tasks aligned to RBAC and tenant-isolation requirements.

### File List

- docs/implementation_artifacts/stories/1-3-enforce-rbac-and-tenant-isolated-authorization.md