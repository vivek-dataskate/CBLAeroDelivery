-- CBLAero Supabase/Postgres schema bootstrap
-- Run in Supabase SQL Editor.
-- If you want a different schema name, replace cblaero_app consistently below
-- and set CBL_SUPABASE_SCHEMA to the same value.

create extension if not exists vector;

create schema if not exists cblaero_app;

create table if not exists cblaero_app.auth_session_revocations (
  session_id text primary key,
  expires_at timestamptz not null,
  revoked_at timestamptz not null default now()
);

create index if not exists idx_auth_session_revocations_expires_at
  on cblaero_app.auth_session_revocations (expires_at);

create table if not exists cblaero_app.audit_authorization_denials (
  id bigint generated always as identity primary key,
  trace_id text not null,
  actor_id text,
  role text,
  session_tenant_id text,
  requested_tenant_id text,
  path text not null,
  method text not null,
  reason text not null check (reason in ('unauthenticated', 'forbidden_role', 'tenant_mismatch')),
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_authorization_denials_occurred_at
  on cblaero_app.audit_authorization_denials (occurred_at desc);

create index if not exists idx_audit_authorization_denials_tenant
  on cblaero_app.audit_authorization_denials (session_tenant_id, occurred_at desc);

create table if not exists cblaero_app.audit_admin_actions (
  id bigint generated always as identity primary key,
  trace_id text not null,
  actor_id text not null,
  tenant_id text not null,
  target_actor_id text,
  action_type text not null check (action_type in ('invite_user', 'assign_role', 'update_team_membership')),
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_admin_actions_occurred_at
  on cblaero_app.audit_admin_actions (occurred_at desc);

create index if not exists idx_audit_admin_actions_tenant
  on cblaero_app.audit_admin_actions (tenant_id, occurred_at desc);

create table if not exists cblaero_app.audit_step_up_attempts (
  id bigint generated always as identity primary key,
  trace_id text not null,
  actor_id text not null,
  tenant_id text not null,
  role text not null,
  path text not null,
  method text not null,
  action text not null,
  outcome text not null check (outcome in ('challenged', 'verified')),
  reason text check (reason in ('fresh_auth_required') or reason is null),
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_step_up_attempts_occurred_at
  on cblaero_app.audit_step_up_attempts (occurred_at desc);

create index if not exists idx_audit_step_up_attempts_tenant
  on cblaero_app.audit_step_up_attempts (tenant_id, occurred_at desc);

create table if not exists cblaero_app.audit_client_context_confirmations (
  id bigint generated always as identity primary key,
  trace_id text not null,
  actor_id text not null,
  role text not null,
  tenant_id text not null,
  active_client_id text not null,
  target_client_id text not null,
  action text not null,
  path text not null,
  method text not null,
  outcome text not null check (outcome in ('required', 'confirmed')),
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_client_context_confirmations_occurred_at
  on cblaero_app.audit_client_context_confirmations (occurred_at desc);

create index if not exists idx_audit_client_context_confirmations_tenant
  on cblaero_app.audit_client_context_confirmations (tenant_id, occurred_at desc);

create table if not exists cblaero_app.cross_client_confirmation_token_uses (
  jti text primary key,
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now()
);

create index if not exists idx_cross_client_confirmation_token_uses_expires_at
  on cblaero_app.cross_client_confirmation_token_uses (expires_at);

create table if not exists cblaero_app.audit_data_residency_checks (
  id bigint generated always as identity primary key,
  trace_id text not null,
  actor_id text,
  tenant_id text,
  status text not null check (status in ('pass', 'fail')),
  approved_regions text[] not null,
  checked_targets jsonb not null,
  violations text[] not null default '{}',
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_data_residency_checks_occurred_at
  on cblaero_app.audit_data_residency_checks (occurred_at desc);

create index if not exists idx_audit_data_residency_checks_tenant
  on cblaero_app.audit_data_residency_checks (tenant_id, occurred_at desc);

create table if not exists cblaero_app.admin_managed_users (
  actor_id text primary key,
  tenant_id text not null,
  email text not null,
  role text not null check (role in ('admin', 'recruiter', 'delivery-head', 'compliance-officer')),
  team_ids text[] not null default '{}',
  invited_at timestamptz not null,
  last_seen_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index if not exists uq_admin_managed_users_tenant_email
  on cblaero_app.admin_managed_users (tenant_id, email);

create index if not exists idx_admin_managed_users_tenant
  on cblaero_app.admin_managed_users (tenant_id, email);

create table if not exists cblaero_app.admin_invitations (
  invitation_id text primary key,
  tenant_id text not null,
  email text not null,
  role text not null check (role in ('admin', 'recruiter', 'delivery-head', 'compliance-officer')),
  team_ids text[] not null default '{}',
  invited_by_actor_id text not null,
  status text not null check (status in ('pending')),
  created_at timestamptz not null,
  expires_at timestamptz not null
);

create index if not exists idx_admin_invitations_tenant_created
  on cblaero_app.admin_invitations (tenant_id, created_at desc);

create unique index if not exists uq_admin_invitations_pending
  on cblaero_app.admin_invitations (tenant_id, email)
  where status = 'pending';

-- Keep this in sync with CBL_VECTOR_DIMENSIONS (default is 8).
create table if not exists cblaero_app.audit_event_vectors (
  id bigint generated always as identity primary key,
  source_table text not null,
  source_event_id bigint not null,
  tenant_id text,
  payload_text text not null,
  embedding vector(8) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_event_vectors_source
  on cblaero_app.audit_event_vectors (source_table, source_event_id);

create index if not exists idx_audit_event_vectors_tenant
  on cblaero_app.audit_event_vectors (tenant_id, created_at desc);
