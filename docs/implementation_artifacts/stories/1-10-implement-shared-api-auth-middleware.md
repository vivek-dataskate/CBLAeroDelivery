# Story 1.10: Implement Shared API Auth Middleware

Status: ready-for-dev

## Story

As a platform engineer,
I want a reusable auth middleware wrapper for API routes,
so that the session-validation, RBAC, step-up, and audit enforcement pattern is defined once and applied consistently — not copy-pasted across 15+ route handlers.

## Acceptance Criteria

1. **Given** any protected API route handler
   **When** it needs auth enforcement
   **Then** it uses `withAuth(handler, options)` wrapper instead of inline auth boilerplate

2. **Given** the `withAuth()` wrapper
   **When** called with `{ action, requireStepUp?, requireFreshAuth? }`
   **Then** it performs: extract session token → validate session → authorize access → optional step-up → inject `session` into handler context

3. **Given** a request that fails auth (no session, wrong role, stale for step-up)
   **When** processed by `withAuth()`
   **Then** the correct error response is returned with standard envelope format, and an audit event is recorded

4. **Given** all existing route handlers
   **When** refactored to use `withAuth()`
   **Then** all existing tests pass with no behavior changes

5. **Given** a new route handler being created in a future story
   **When** the developer needs auth protection
   **Then** they use `withAuth()` — the inline pattern is no longer available as a template to copy

## Tasks / Subtasks

- [ ] Create `withAuth()` middleware wrapper (AC: 1, 2, 3)
  - [ ] Create `src/modules/auth/with-auth.ts`
  - [ ] Implement: `withAuth<T>(handler: AuthenticatedHandler<T>, options: AuthOptions): RouteHandler`
  - [ ] Options: `{ action: ProtectedAction, requireStepUp?: boolean, requireFreshAuth?: boolean }`
  - [ ] Handler receives `{ session: AuthSession, request: NextRequest, params: T }`
  - [ ] On auth failure: return standard error envelope, record audit event
  - [ ] Export from `modules/auth/index.ts`

- [ ] Define types (AC: 2)
  - [ ] `AuthOptions` — action, step-up requirements, custom validators
  - [ ] `AuthenticatedHandler<T>` — handler function receiving authenticated context
  - [ ] `AuthenticatedContext` — `{ session, request, params }`

- [ ] Refactor route handlers to use `withAuth()` (AC: 4)
  - [ ] `app/api/internal/candidates/route.ts` — GET and POST
  - [ ] `app/api/internal/candidates/[candidateId]/route.ts` — GET
  - [ ] `app/api/internal/recruiter/csv-upload/route.ts` — POST
  - [ ] `app/api/internal/recruiter/csv-upload/[batchId]/route.ts` — GET, DELETE
  - [ ] `app/api/internal/recruiter/resume-upload/route.ts` — POST
  - [ ] `app/api/internal/recruiter/resume-upload/[batchId]/route.ts` — GET
  - [ ] `app/api/internal/recruiter/resume-upload/[batchId]/confirm/route.ts` — POST
  - [ ] `app/api/internal/admin/governance/route.ts` — GET and POST
  - [ ] `app/api/internal/admin/import-batches/route.ts` — GET
  - [ ] `app/api/internal/admin/import-batches/[batchId]/route.ts` — PATCH
  - [ ] `app/api/internal/saved-searches/route.ts` — GET and POST (if exists)
  - [ ] Note: `/api/internal/jobs/run/route.ts` uses bearer token auth, NOT session — leave as-is but ensure secret-required guard per §13

- [ ] Write tests (AC: 3, 4)
  - [ ] Unit tests for `withAuth()`: valid session, invalid session, wrong role, stale step-up
  - [ ] Verify audit event recorded on auth failure
  - [ ] Verify all existing route integration tests pass unchanged

- [ ] Register capability in architecture.md and development-standards.md §18 (AC: 5)

## Dev Notes

### Architecture Compliance

This story implements the "API Gateway" shared middleware from architecture.md §Service Boundary Architecture. The key rule: **the validate-session → authorize → step-up pattern should be a reusable function, not copy-pasted.**

### Current inline pattern (to be replaced)

Every route currently has this ~15-line block:
```typescript
const sessionToken = extractSessionToken(request);
const session = await validateActiveSession(sessionToken);
if (!session) {
  await authorizeAccess({ session: null, action: '...', path: '...', method: '...' });
  return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: '...' } }, { status: 401 });
}
const authz = await authorizeAccess({ session, action: '...', path: '...', method: '...' });
if (!authz.allowed) {
  return NextResponse.json({ error: { code: 'FORBIDDEN', message: authz.reason } }, { status: authz.status });
}
// optional step-up check...
```

### Target pattern (after this story)
```typescript
export const GET = withAuth(async ({ session, request }) => {
  // Business logic only — auth already enforced
  const result = await listCandidates({ tenantId: session.tenantId, ... });
  return NextResponse.json({ data: result.items, meta: { ... } });
}, { action: 'candidate:read' });
```

### What NOT to change
- `/api/internal/jobs/run/route.ts` — uses bearer token auth, different pattern
- `/api/auth/*` routes — handle SSO flow, not session-based
- The cross-client confirmation logic (moved to auth module in Story 1.8)

### Dependency
- Depends on Story 1.8 completing the cross-client confirmation extraction first (otherwise candidates/route.ts is too complex to refactor cleanly)

### References

- [Source: docs/planning_artifacts/development-standards.md — §13 Auth Guards, §16 API Envelope, §17 Logging, §20 Capability Registry]
- [Source: docs/planning_artifacts/architecture.md — Service Boundary Architecture]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
