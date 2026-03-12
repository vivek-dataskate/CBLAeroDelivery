# Story 1.2: Implement Enterprise SSO and Session Controls

Status: ready-for-dev

## Story

As an internal user,
I want to authenticate with enterprise SSO and managed session persistence,
so that access is secure and aligned with organizational identity policy.

## Acceptance Criteria

1. Given a valid enterprise identity, when the user signs in through SSO, then an authenticated session is created with remember-device support up to 30 days.
2. Session expiration and revocation behavior is enforced server-side.

## Tasks / Subtasks

- [ ] Implement enterprise SSO login and callback flow (AC: 1)
  - [ ] Add SSO provider integration for internal users in the auth module.
  - [ ] Implement login entrypoint and callback handling for code-to-token exchange.
  - [ ] Validate identity claims and map role and tenant context for session bootstrap.

- [ ] Implement managed session persistence with remember-device (AC: 1)
  - [ ] Add server-managed session issuance for authenticated internal users.
  - [ ] Implement remember-device behavior with 30-day persistence limit for low-risk actions.
  - [ ] Enforce secure cookie/session defaults (httpOnly, secure, sameSite, bounded TTL).

- [ ] Enforce server-side session expiration and revocation (AC: 2)
  - [ ] Add session validation middleware/proxy checks on protected internal routes.
  - [ ] Implement explicit sign-out and session revocation path.
  - [ ] Ensure revoked/expired sessions are denied even if client-side state still exists.

- [ ] Add quality gates and verification for auth/session behavior (AC: 1, 2)
  - [ ] Add unit tests for claim validation, session issuance, and TTL boundaries.
  - [ ] Add integration tests for login success, expiration handling, and revocation denial.
  - [ ] Run lint, typecheck, test, and build; capture evidence in completion notes.

## Dev Notes

- Reuse and extend the baseline module boundaries from Story 1.1; avoid cross-module leakage.
- Keep internal APIs protected with authenticated session and tenant context.
- Treat session revocation as a server-authoritative control; do not rely on client token removal alone.
- Keep implementation scoped to internal enterprise SSO and session controls for this story.

### Project Structure Notes

- Existing baseline modules are in place under `cblaero/src/modules/*` from Story 1.1.
- Expected primary touchpoints for this story:
  - `cblaero/src/modules/auth/`
  - `cblaero/src/proxy.ts`
  - Internal auth routes/components under `cblaero/src/app/`
  - Auth/session-focused tests under `cblaero/src/modules/__tests__/` and/or `cblaero/src/app/**/__tests__/`

### References

- Source: docs/planning_artifacts/epics.md (Epic 1, Story 1.2)
- Source: docs/planning_artifacts/prd.md (Identity and Session Management)
- Source: docs/planning_artifacts/prd.md (FR41, NFR13)
- Source: docs/planning_artifacts/architecture.md (Authentication and Security)
- Source: docs/planning_artifacts/architecture.md (Sequence: Internal Recruiter SSO Login)
- Source: docs/planning_artifacts/architecture.md (Architectural Boundaries)
- Source: docs/planning_artifacts/architecture.md (Identity and Access checklist)

## Dev Agent Record

### Agent Model Used

GPT-5.3-Codex

### Debug Log References

### Completion Notes List

- Story created from Epic 1 Story 1.2 with architecture and PRD constraints linked.

### File List

- docs/implementation_artifacts/stories/1-2-implement-enterprise-sso-and-session-controls.md
