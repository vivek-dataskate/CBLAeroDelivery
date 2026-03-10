---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - docs/planning_artifacts/prd.md
  - docs/planning_artifacts/ux-design-specification.md
  - docs/planning_artifacts/prd-validation-report.md
  - docs/planning_artifacts/source-inputs/aviation-product-brief.md
  - docs/planning_artifacts/source-inputs/aviation-marketing-copy.md
  - docs/planning_artifacts/source-inputs/aviation-product-slides.md
  - docs/planning_artifacts/source-inputs/aviation-talent-PRD.md
  - docs/planning_artifacts/analysis/cblAero-advanced-elicitation-FR-analysis.md
  - docs/planning_artifacts/analysis/cblAero-FR-analysis-executive-brief.md
  - docs/planning_artifacts/analysis/cblAero-MVP-Elicitation-Analysis.md
  - docs/planning_artifacts/analysis/cblAero-PRD-polish-analysis.md
workflowType: 'architecture'
project_name: 'CBLAero'
user_name: 'vivek'
date: '2026-03-10'
lastStep: 8
status: 'complete'
completedAt: '2026-03-10'
---

# Architecture Decision Document

_This document captures collaborative architecture decisions for CBLAero and is the implementation source of truth for AI agents._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**

- `prd.md` defines 75 FRs across 3 tiers.
- Core capability domains are:
  - Candidate management (ingestion, profile, dedupe, retention)
  - Outreach and engagement (SMS/email orchestration, preferences, opt-outs)
  - Recruiter workflow (job posting, ranked candidates, interaction logging, exports)
  - Match and scoring (opportunity score, signal validation, confidence logic)
  - Delivery operations and analytics (dashboards, SLA tracking, forecasting)
  - Compliance and governance (audit, tenant controls, access and retention)
- Architecture implication: this is not a single CRUD app. It is an event-rich workflow system with strict data boundaries and high observability needs.

**Non-Functional Requirements:**

- 99.5% uptime target
- 24-hour delivery SLA for 5 prioritized candidates
- Notification latency under 1 minute and periodic refresh windows
- Strict tenant isolation and adversarial pre-launch verification
- Immutable/tamper-evident audit requirements
- GDPR/CCPA/TCPA and SOC 2 trajectory support
- Architecture implication: security, data lineage, and operational reliability are first-order design concerns, not add-ons.

**Scale and Complexity:**

- Primary domain: multi-tenant web platform with workflow orchestration and asynchronous communication
- Complexity level: high
- Architectural component estimate: 12-16 bounded components/services
- Complexity drivers:
  - Multi-channel communication with fallback behavior
  - Role-based multi-persona workflows (recruiter, candidate, delivery lead, admin, executive)
  - Compliance and immutable audit requirements
  - Tiered rollout with go/no-go gates and evolving confidence model

### Technical Constraints and Dependencies

- Tiered implementation model:
  - Tier 1: manual-heavy validation path, high feedback density
  - Tier 2: automation and throughput expansion
  - Tier 3: pilot-readiness hardening
- Integration dependency on Microsoft Teams for recruiter delivery flow, with explicit outage fallback.
- Candidate trust flow requires job-scoped opt-in, one-time token links, and anti-abuse controls.
- Confidence/motivation models must remain explainable in MVP.

### Cross-Cutting Concerns Identified

- Tenant isolation and authorization enforcement at object level
- Auditability and event traceability for all critical actions
- Compliance-safe communication consent and retention
- Queueing/idempotency for outreach and notification flows
- Explainability of scoring and rejection rationale to preserve recruiter trust
- Cost guardrails and per-tenant metering readiness

## Starter Template Evaluation

### Primary Technology Domain

Full-stack web application with async worker processes and integration adapters.

### Starter Options Considered

1. `create-next-app` App Router baseline
- Strong fit for recruiter/admin web surface, API routes, and modern full-stack patterns.
- Fast bootstrap for typed UI + API.

2. `create-next-app` + separate backend framework at start
- Adds early complexity before Tier 1 learning is complete.
- Better deferred until clear scaling trigger.

3. API-first backend starter with separate SPA
- More control for long-term decomposition.
- Slower Tier 1 execution and higher coordination overhead.

### Selected Starter: Next.js App Router Baseline

**Rationale for Selection:**

- Fastest path to Tier 1 validation while preserving future modular decomposition.
- Supports server rendering, route handlers, and strong TypeScript workflow in one codebase.
- Reduces integration surface area early while leaving room for extraction of workers/services later.

**Initialization Command:**

```bash
npx create-next-app@latest cblaero --typescript --eslint --tailwind --src-dir --app --import-alias "@/*"
```

**Version and runtime references used in this decision:**

- Node.js: v24 Active LTS line (Node releases page)
- Next.js docs indicate latest series in use: `16.x` (`16.1.6` shown)
- PostgreSQL docs indicate current major: `18`

**Architectural Decisions Provided by Starter:**

- TypeScript-first project baseline
- App Router structure for feature composition
- ESLint and modern build defaults
- Source directory conventions (`src/`)
- Frontend and API boundary co-located for early phase speed

**Note:**

- First implementation story should initialize this baseline and immediately add architecture guardrails (module boundaries, API contracts, auth/tenant middleware, audit envelope).

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (implementation-blocking):**

- Multi-tenant boundary model and object-level authorization
- Candidate and recruiter identity/security model
- Event/audit architecture and immutable audit envelope
- Communication orchestration pattern with retry/idempotency
- Data model partitioning for tenant, candidate, job, outreach, and event streams

**Important Decisions (shape architecture):**

- Scoring and explainability model (deterministic + calibrated)
- Teams integration adapter pattern with fallback channels
- Observability stack and alerting thresholds
- Data retention lifecycle and deletion workflows

**Deferred Decisions (post-MVP):**

- Advanced ML confidence serving infrastructure
- Multi-region active-active failover architecture
- Dedicated stream platform beyond relational/event-outbox pattern

### Data Architecture

- Primary OLTP database: Supabase Postgres (PostgreSQL 18-compatible target).
- Data strategy:
  - Relational core for transactional consistency
  - Event outbox for reliable asynchronous publication
  - Materialized read models for dashboards and SLA views
- Canonical entities:
  - `tenant`, `user`, `role_assignment`
  - `candidate`, `candidate_identity_link`, `candidate_availability_signal`
  - `job_requirement`, `job_intake_question`, `candidate_match`
  - `outreach_message`, `consent_record`, `delivery_attempt`
  - `interaction_event`, `audit_event`, `teams_notification`
- Dedupe strategy:
  - Deterministic identity confidence thresholds per PRD
  - Manual review queue for uncertain merges
- Retention/deletion:
  - Policy-driven lifecycle with legal hold support
  - GDPR erase workflow as first-class background process
  - Voice call recordings and transcripts retained in Supabase for 3 years

### Authentication and Security

- Authentication:
  - Candidate: one-time token links, short-lived verification step
  - Internal users: SSO-ready session model and step-up auth for sensitive operations
- Authorization:
  - RBAC + tenant-scoped object checks on every read/write path
- Security controls:
  - Signed token links, replay protection, and strict expiry
  - Rate limiting and abuse detection on public-facing endpoints
  - PII encryption at rest and in transit
  - Security-relevant action logging into immutable audit stream

### API and Communication Patterns

- External API style: REST with explicit resource scoping and contract versioning.
- Internal async pattern: transactional outbox plus background workers.
- Response contract:
  - success: `{"data": ..., "meta": ...}`
  - error: `{"error": {"code": "...", "message": "...", "details": ...}}`
- Idempotency requirements:
  - Outreach scheduling and notification sends require idempotency keys.
- Retry behavior:
  - Bounded retries with escalating delay and dead-letter classification.

### Frontend Architecture

- Next.js App Router UI with feature-bounded folders.
- Core application surfaces:
  - Recruiter workspace (action stream, candidate cards, match reasons)
  - Candidate portal (job-scoped trust-first opt-in flow)
  - Delivery lead operations console
  - Admin and compliance console
- State strategy:
  - Server-driven data for most views
  - Client state only for transient workflow/UI state
- UX-critical architecture requirements:
  - Explicit rejection reasons and override traceability
  - Progressive disclosure for high-volume candidate sets
  - Accessibility baseline with WCAG 2.1 AA alignment

### Infrastructure and Deployment

- Baseline deployment:
  - Web/API runtime deployed on Render
  - Python worker services deployed on Render background workers
  - Data platform on Supabase Postgres (managed Postgres on Render is not used)
  - Separate staging and production environments
- CI/CD expectations:
  - Test gates including tenant isolation test suite
  - Migration checks and backward compatibility checks for schema changes
  - Security/static analysis checks on protected branches
- Observability:
  - Render-native metrics/logging and Supabase-native telemetry
  - Structured logs with correlation IDs
  - Metrics for SLA, delivery latency, queue depth, and failure rates
  - Alerts for fallback triggers, compliance workflow failures, and budget thresholds
- Secrets and configuration:
  - Render environment secrets only for MVP

### Confirmed Integration System Matrix

| Capability | Selected System | MVP Notes |
|---|---|---|
| SMS (two-way) | Telnyx | Primary provider; no backup SMS provider in MVP |
| Voice calling | Telnyx Voice | Dial + call recording + transcription |
| Email campaigns | Instantly | Campaign orchestration and delivery analytics |
| Ad hoc recruiter email | Microsoft Graph/Outlook | One-click recruiter email actions |
| Teams collaboration | Microsoft Teams | Notification cards, task creation, scheduling, recruiter communication |
| Identity | Microsoft Entra ID + magic links | Internal SSO for staff, SMS/email magic links for candidates |
| Candidate enrichment | Internal DB, Clay, RapidAPI sources | Provider-agnostic connector layer remains mandatory |
| FAA verification | Official FAA public data + manual workflow | Automated third-party FAA API deferred |
| Background checks | Manual only | No background-check API integration in MVP |
| Job queue and retries | Render background workers | Async processing and retry handling on worker services |
| Monitoring and alerting | Render + Supabase native | No external APM in MVP |
| Secrets management | Render environment secrets | External vault deferred |
| Audit immutability | DB append-only + hash chain | Tamper-evidence implemented in audit model |
| Document/file storage | SharePoint folder | `https://cblsolution-my.sharepoint.com/:f:/g/personal/vivek_cblsolutions_com/IgDKIFYS0joSSbhgfpiY6XA_AbVtySkMKVQAIZwkiyZblTg?e=QTy2dU` |
| Analytics/BI | In-app only | External BI warehouse/tools deferred |

### Budget and KPI Alert Baselines

- API spend alert threshold: $1,000/month
- SMS cost alert threshold: $200/placement
- KPI breach alert threshold: conversion rate <5%

### Architecture Standards and Governance

**Standards we follow for implementation:**

- C4 model for architecture views and boundary documentation (Context, Container, Component).
- Domain-oriented module boundaries (bounded-context style) aligned to FR domains.
- Twelve-Factor app principles for config, stateless runtime, and environment parity.
- OWASP ASVS L2 and OWASP API Security Top 10 as baseline application/API security standard.
- Zero-trust access posture for internal services and operational tools.

**Vector and RAG standard (when introduced):**

- RAG is not mandatory for Tier 1 MVP. If introduced, it must be tenant-safe by design.
- Vector storage standard: `pgvector` in Supabase Postgres under isolated schema.
- Retrieval must enforce tenant filter + role filter before semantic ranking.
- Prompt input pipeline must include prompt-injection detection and policy filtering.
- PII and sensitive compliance data are excluded from embeddings unless explicitly approved.

**MCP-based access control standard:**

- MCP usage must be brokered through a server-side policy gateway.
- Tool access is allowlisted per role and per environment.
- Every MCP tool invocation must include actor, tenant, scope, and trace ID.
- High-risk MCP operations (export, bulk update, credentialed actions) require step-up auth and audit trail.

**Strict Supabase access from Python standard:**

- Python workers access Supabase only from trusted backend runtime on Render.
- Service-role key is never exposed to browser/client code.
- Candidate-facing and recruiter-facing app paths use RLS-protected tokens; service role bypass is backend-only.
- Separate key scopes by environment (`dev`, `staging`, `prod`) with rotation policy.
- Use least-privilege SQL roles for worker jobs where possible; avoid broad superuser privileges.
- All Python DB calls must use TLS and connection settings enforcing certificate verification.
- Administrative SQL operations are restricted to migration pipeline and audited maintenance workflows.

**SSL/TLS implementation standard:**

- External traffic: HTTPS only with TLS 1.2+ (TLS 1.3 preferred) at edge.
- Enforce HTTP->HTTPS redirects and HSTS for authenticated application surfaces.
- Service-to-database traffic: TLS required (`sslmode=require` minimum, `verify-full` where supported).
- Certificates are managed by platform-managed TLS endpoints (Render and Supabase) with automatic renewal.
- No plaintext credentials or connection strings in source control; all secrets via Render environment secrets.

### Decision Impact Analysis

**Implementation sequence:**

1. Baseline app scaffold and module boundaries
2. Identity, auth, and tenant middleware foundation
3. Core data model + migrations + repository contracts
4. Outreach pipeline + idempotent job workers
5. Recruiter and candidate primary workflows
6. Audit immutability and compliance workflows
7. Teams integration + fallback path hardening
8. Operational dashboards and readiness checks

**Cross-component dependencies:**

- Scoring explainability depends on event and interaction model quality.
- Compliance workflows depend on consent and immutable audit architecture.
- Tier 2 automation throughput depends on queue and retry architecture selected in Tier 1.

## Implementation Patterns and Consistency Rules

### Pattern Categories Defined

Critical conflict points identified: naming, API contract shape, event semantics, and cross-module boundaries.

### Naming Patterns

**Database naming conventions:**

- Tables: `snake_case`, plural (`candidates`, `job_requirements`)
- Columns: `snake_case`
- FK fields: `<entity>_id`
- Indexes: `idx_<table>_<column_list>`

**API naming conventions:**

- Endpoint paths: plural nouns (`/api/v1/candidates`)
- Route params: kebab path segments with IDs as UUID strings
- Query params: `snake_case`

**Code naming conventions:**

- TypeScript types/interfaces: `PascalCase`
- Variables/functions: `camelCase`
- File names:
  - React components: `PascalCase.tsx`
  - non-component modules: `kebab-case.ts`

### Structure Patterns

- Organize by feature domain first, technical type second.
- Every feature domain has explicit layers:
  - `contracts`
  - `application`
  - `domain`
  - `infrastructure`
  - `ui` (where applicable)
- No direct cross-feature imports except through published feature contracts.

### Format Patterns

- API response and error envelopes are mandatory and stable.
- Dates/times use ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- IDs use UUIDv7 (or UUIDv4 if v7 support unavailable at initialization).
- Booleans are strict true/false, never numeric substitutions.

### Communication Patterns

- Event naming: `<bounded_context>.<aggregate>.<past_tense_verb>`
  - Example: `outreach.message.sent`
- Event envelope:
  - `event_id`, `event_type`, `occurred_at`, `tenant_id`, `actor_id`, `payload`, `schema_version`
- Correlation and causation IDs required for all async workflows.

### Process Patterns

**Error handling:**

- Domain errors are explicit typed errors.
- User-facing messages are safe/sanitized.
- Internal diagnostics are captured in structured logs only.

**Loading and async status:**

- Long-running operations expose explicit status resources.
- UI polling intervals are bounded and adaptive.
- Retries are never silent; retry state is observable in operations views.

### Enforcement Guidelines

All AI agents must:

- Respect module boundaries and public contracts.
- Use the standard API and event envelopes.
- Preserve tenant ID propagation in all data and event paths.
- Include tests for boundary, authorization, and idempotency behavior.

Pattern enforcement:

- Pull request checklist for architecture contract compliance
- Contract tests for API envelope and event schema stability
- Lint and static import-boundary checks

### Pattern Examples

**Good example (event):**

- `candidate.availability.updated` with `tenant_id`, `candidate_id`, `previous_state`, `new_state`, `source`

**Anti-patterns to avoid:**

- Direct cross-tenant queries without explicit tenant predicate
- Sending Teams notifications without idempotency key
- Feature module accessing another feature's private persistence layer

## Project Structure and Boundaries

### Complete Project Directory Structure

```text
cblaero/
  README.md
  package.json
  pnpm-workspace.yaml
  .env.example
  .github/
    workflows/
      ci.yml
      security.yml
  apps/
    web/
      package.json
      next.config.ts
      tsconfig.json
      src/
        app/
          (recruiter)/
            dashboard/page.tsx
            jobs/[jobId]/page.tsx
            candidates/[candidateId]/page.tsx
          (candidate)/
            portal/[token]/page.tsx
            availability/page.tsx
          (ops)/
            delivery/page.tsx
            compliance/page.tsx
          api/
            v1/
              candidates/route.ts
              jobs/route.ts
              outreach/route.ts
              notifications/route.ts
              reports/route.ts
          layout.tsx
          page.tsx
        features/
          candidate-management/
            contracts/
            application/
            domain/
            infrastructure/
            ui/
          outreach-engagement/
            contracts/
            application/
            domain/
            infrastructure/
            ui/
          recruiter-workflow/
            contracts/
            application/
            domain/
            infrastructure/
            ui/
          scoring-matching/
            contracts/
            application/
            domain/
            infrastructure/
            ui/
          compliance-governance/
            contracts/
            application/
            domain/
            infrastructure/
            ui/
          analytics-operations/
            contracts/
            application/
            domain/
            infrastructure/
            ui/
        shared/
          auth/
          tenancy/
          api/
          observability/
          validation/
          ui/
  workers/
    outreach-worker/
      src/
        jobs/
        retries/
        adapters/
    notifications-worker/
      src/
        teams/
        email/
        sms/
  packages/
    contracts/
      src/api/
      src/events/
    config/
      eslint/
      typescript/
    test-utils/
      src/
  db/
    prisma/
      schema.prisma
      migrations/
    seeds/
  docs/
    architecture/
      adr/
      api-contracts/
      event-catalog/
  tests/
    unit/
    integration/
    e2e/
    adversarial/
      tenant-isolation/
      token-abuse/
```

### Architectural Boundaries

**API boundaries:**

- Public candidate portal endpoints are isolated from authenticated internal endpoints.
- Internal API requires authenticated session and tenant context.

**Component boundaries:**

- Feature modules communicate through typed contracts only.
- UI components do not call persistence adapters directly.

**Service boundaries:**

- Worker services consume outbox events and invoke channel adapters.
- Notification channel adapters are pluggable and isolated from domain logic.

**Data boundaries:**

- Tenant-owned data partitioning enforced via tenant key and policy layer.
- Audit event store treated as append-only with hash-chain tamper-evidence.

### Requirements to Structure Mapping

**Feature/FR domain mapping:**

- Candidate management FRs (`FR1-FR7`) -> `features/candidate-management`
- Outreach and engagement FRs (`FR8-FR17`) -> `features/outreach-engagement` + `workers/outreach-worker`
- Recruiter workflow FRs (`FR18-FR27`) -> `features/recruiter-workflow`
- Scoring/matching FRs (`FR28+` scoring set) -> `features/scoring-matching`
- Compliance/governance FR/NFR sets -> `features/compliance-governance` + `tests/adversarial`
- Delivery analytics and KPI reporting -> `features/analytics-operations`

**Cross-cutting concerns:**

- Auth and tenancy enforcement -> `shared/auth`, `shared/tenancy`
- Audit and observability -> `shared/observability`, `docs/architecture/event-catalog`
- API and event contracts -> `packages/contracts`

### Integration Points

**Internal communication:**

- Sync: typed application services and repository interfaces
- Async: outbox events consumed by worker services

**External integrations:**

- Telnyx for SMS and voice calling (recording and transcription)
- Instantly for campaign email
- Microsoft Graph/Outlook for ad hoc recruiter email
- Microsoft Teams for notifications, scheduling, task creation, and recruiter communication
- Candidate enrichment connectors for internal DB, Clay, and RapidAPI sources
- FAA verification via official FAA public data and manual review workflow
- SharePoint for document/file distribution in MVP

**Data flow:**

1. Candidate/job signals enter transactional core
2. Domain events emitted to outbox
3. Workers deliver outreach/notifications with retries
4. Interaction events feed scoring and analytics projections
5. Audit stream captures all critical transitions

## Architecture Validation Results

### Coherence Validation

**Decision compatibility:**

- Selected stack and module boundaries align with tiered rollout and validation-first MVP strategy.
- Async orchestration pattern supports notification and outreach constraints without forcing early microservices split.

**Pattern consistency:**

- Naming/format/process rules are aligned across DB, API, events, and code organization.
- Multi-tenant requirements are reflected in boundary rules and test strategy.

**Structure alignment:**

- Project structure supports each FR domain and non-functional cross-cutting concerns.
- Dedicated worker paths match retry/fallback and latency requirements.

### Requirements Coverage Validation

**Functional requirement coverage:**

- All major FR domains are mapped to explicit feature modules and runtime components.
- Workflow-heavy paths (outreach, delivery, ranking, tracking) are represented in both sync and async architecture.

**Non-functional requirement coverage:**

- Security/compliance: covered through authz, immutable audit stream, retention/deletion workflows
- Performance/reliability: covered through worker isolation, retry policies, observability, and SLA metrics
- Multi-tenancy: covered through explicit tenancy boundaries and adversarial test suite location

### Implementation Readiness Validation

**Decision completeness:**

- Core blocking decisions are documented and linked to implementation order.

**Structure completeness:**

- Directory tree and module decomposition are specific enough for implementation-story planning.

**Pattern completeness:**

- Agent conflict points are addressed by mandatory conventions and contract enforcement.

### Gap Analysis Results

**Critical gaps:**

- None blocking architecture initiation.

**Important gaps to close during story decomposition:**

- Finalize measurable acceptance thresholds for remaining long-tail FR/NFR entries still marked as warning in PRD validation.
- Finalize candidate portal depth boundaries for MVP vs post-MVP.
- Lock explicit forecast/cohort analytics acceptance criteria for executive workflow.

**Nice-to-have gaps:**

- Add formal ADR records per major decision once implementation starts.
- Add synthetic load test profiles tied to Tier 2 and Tier 3 gates.

### Architecture Completeness Checklist

**Requirements analysis**

- [x] Project context analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**Architectural decisions**

- [x] Critical decisions documented
- [x] Core stack selected
- [x] Integration patterns defined
- [x] Reliability/security expectations captured

**Implementation patterns**

- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process rules documented

**Project structure**

- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements mapped to structure

### Architecture Readiness Assessment

**Overall status:** READY FOR IMPLEMENTATION

**Confidence level:** Medium-high

- Medium because PRD revalidation remains at warning for residual measurability/detail gaps.
- High because architecture now absorbs and resolves previously deferred implementation choices.

**Key strengths:**

- Clear tenant-safe, compliance-aware architecture path
- Strong async workflow foundation for outreach and notifications
- Explainability-preserving scoring and decision traceability support
- Implementation-consistent patterns designed for multi-agent delivery

**Areas for future enhancement:**

- Extract separate backend service boundary if throughput exceeds monolith+worker envelope
- Add advanced model-serving lane after Tier 1 and Tier 2 validation gates

### Implementation Handoff

AI agents must:

- Follow this document for all technical decisions and boundary rules.
- Treat this as canonical for architecture-related implementation questions.
- Escalate only if new requirements conflict with explicit decisions in this file.

First implementation priority:

1. Initialize baseline app with the starter command.
2. Add tenancy/auth/audit foundations before feature implementation.
3. Create first vertical slice: job posting -> ranked candidate list -> Teams delivery with audit trail.
