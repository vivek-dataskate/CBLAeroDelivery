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

create table if not exists cblaero_app.audit_import_batch_accesses (
  id bigint generated always as identity primary key,
  trace_id text not null,
  actor_id text not null,
  tenant_id text not null,
  batch_id uuid,
  action text not null check (action in ('list_import_batches', 'read_import_batch_detail', 'csv_upload_access', 'download_csv_error_report', 'resume_upload_access', 'resume_confirm_access')),
  occurred_at timestamptz not null default now()
);

create index if not exists idx_audit_import_batch_accesses_occurred_at
  on cblaero_app.audit_import_batch_accesses (occurred_at desc);

create index if not exists idx_audit_import_batch_accesses_tenant
  on cblaero_app.audit_import_batch_accesses (tenant_id, occurred_at desc);

-- ============================================================
-- Epic 2: Candidate Data Ingestion
-- ============================================================

create table if not exists cblaero_app.import_batch (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  source text not null check (source in ('migration', 'csv_upload', 'ats_sync', 'inbox_parse', 'resume_upload')),
  status text not null check (status in ('validating', 'running', 'processing', 'paused_on_error_threshold', 'complete', 'rolled_back')),
  total_rows int not null default 0,
  imported int not null default 0,
  skipped int not null default 0,
  errors int not null default 0,
  error_threshold_pct int not null default 5,
  created_by_actor_id text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_import_batch_tenant_started
  on cblaero_app.import_batch (tenant_id, started_at desc);

create index if not exists idx_import_batch_status
  on cblaero_app.import_batch (status, started_at desc);

create table if not exists cblaero_app.import_row_error (
  id bigint generated always as identity primary key,
  batch_id uuid not null references cblaero_app.import_batch (id),
  row_number int not null,
  raw_data jsonb not null default '{}'::jsonb,
  error_code text not null,
  error_detail text,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_import_row_error_batch
  on cblaero_app.import_row_error (batch_id, row_number);

create table if not exists cblaero_app.candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  email text,
  phone text,
  name text not null,
  location text,
  skills jsonb not null default '[]'::jsonb,
  certifications jsonb not null default '[]'::jsonb,
  experience jsonb not null default '[]'::jsonb,
  extra_attributes jsonb not null default '{}'::jsonb,
  availability_status text not null default 'passive' check (availability_status in ('active', 'passive', 'unavailable')),
  ingestion_state text not null default 'pending_dedup' check (ingestion_state in ('pending_dedup', 'pending_enrichment', 'active', 'rejected')),
  source text not null,
  source_batch_id uuid references cblaero_app.import_batch (id),
  created_by_actor_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidates_email_or_phone_required check (email is not null or phone is not null)
);

alter table cblaero_app.candidates
  add column if not exists extra_attributes jsonb not null default '{}'::jsonb;

alter table cblaero_app.candidates
  add column if not exists first_name text not null default '',
  add column if not exists last_name text not null default '',
  add column if not exists middle_name text,
  add column if not exists home_phone text,
  add column if not exists work_phone text,
  add column if not exists address text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists country text,
  add column if not exists postal_code text,
  add column if not exists current_company text,
  add column if not exists job_title text,
  add column if not exists alternate_email text;

alter table cblaero_app.candidates
  add column if not exists created_by_actor_id text;

create unique index if not exists uq_candidates_tenant_email
  on cblaero_app.candidates (tenant_id, email)
  where email is not null;

create unique index if not exists uq_candidates_tenant_phone
  on cblaero_app.candidates (tenant_id, phone)
  where phone is not null;

create index if not exists idx_candidates_tenant_availability
  on cblaero_app.candidates (tenant_id, availability_status)
  where ingestion_state = 'active';

create index if not exists idx_candidates_tenant_location
  on cblaero_app.candidates (tenant_id, location)
  where ingestion_state = 'active';

create index if not exists idx_candidates_source_batch
  on cblaero_app.candidates (source_batch_id)
  where source_batch_id is not null;

-- Story 2.4: GIN indexes for JSONB queryability at 1M+ rows
create index if not exists idx_candidates_certifications_gin
  on cblaero_app.candidates using gin (certifications)
  where ingestion_state = 'active';

create index if not exists idx_candidates_skills_gin
  on cblaero_app.candidates using gin (skills)
  where ingestion_state = 'active';

-- Story 2.4: Full-text search on name fields
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

-- Story 2.4: Composite index for state-scoped tenant queries
create index if not exists idx_candidates_tenant_state
  on cblaero_app.candidates (tenant_id, ingestion_state);

create or replace function cblaero_app.process_import_chunk(
  p_batch_id uuid,
  p_candidates jsonb,
  p_error_rows jsonb,
  p_total_imported int,
  p_total_skipped int,
  p_total_errors int
)
returns table (imported int, skipped int, errors int)
language plpgsql
security definer
set search_path = cblaero_app, public
as $$
declare
  v_candidate jsonb;
  v_error jsonb;
  v_chunk_inserted int := 0;
  v_chunk_updated int := 0;
  v_chunk_errors int := 0;
  v_xmax bigint;
  v_email text;
  v_phone text;
  v_row_number int;
  v_raw_data jsonb;
  v_first_name text;
  v_last_name text;
  v_middle_name text;
  v_home_phone text;
  v_work_phone text;
  v_address text;
  v_city text;
  v_state text;
  v_country text;
  v_postal_code text;
  v_current_company text;
  v_job_title text;
  v_alternate_email text;
  v_computed_name text;
begin
  for v_error in select value from jsonb_array_elements(coalesce(p_error_rows, '[]'::jsonb)) loop
    insert into cblaero_app.import_row_error (
      batch_id,
      row_number,
      raw_data,
      error_code,
      error_detail
    )
    values (
      p_batch_id,
      coalesce((v_error->>'row_number')::int, 0),
      coalesce(v_error->'raw_data', '{}'::jsonb),
      coalesce(v_error->>'error_code', 'parse_error'),
      v_error->>'error_detail'
    );

    v_chunk_errors := v_chunk_errors + 1;
  end loop;

  for v_candidate in select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) loop
    v_email := nullif(trim(v_candidate->>'email'), '');
    v_phone := nullif(trim(v_candidate->>'phone'), '');
    v_row_number := nullif(v_candidate->>'row_number', '')::int;
    v_raw_data := coalesce(v_candidate->'raw_data', '{}'::jsonb);
    v_first_name := nullif(trim(coalesce(v_candidate->>'first_name', '')), '');
    v_last_name := nullif(trim(coalesce(v_candidate->>'last_name', '')), '');
    v_middle_name := nullif(trim(coalesce(v_candidate->>'middle_name', '')), '');
    v_home_phone := nullif(trim(coalesce(v_candidate->>'home_phone', '')), '');
    v_work_phone := nullif(trim(coalesce(v_candidate->>'work_phone', '')), '');
    v_address := nullif(trim(coalesce(v_candidate->>'address', '')), '');
    v_city := nullif(trim(coalesce(v_candidate->>'city', '')), '');
    v_state := nullif(trim(coalesce(v_candidate->>'state', '')), '');
    v_country := nullif(trim(coalesce(v_candidate->>'country', '')), '');
    v_postal_code := nullif(trim(coalesce(v_candidate->>'postal_code', '')), '');
    v_current_company := nullif(trim(coalesce(v_candidate->>'current_company', '')), '');
    v_job_title := nullif(trim(coalesce(v_candidate->>'job_title', '')), '');
    v_alternate_email := nullif(trim(coalesce(v_candidate->>'alternate_email', '')), '');
    -- Derive name: prefer first_name + last_name; fall back to explicit name field
    v_computed_name := coalesce(
      nullif(trim(coalesce(v_first_name, '') || ' ' || coalesce(v_last_name, '')), ''),
      nullif(trim(coalesce(v_candidate->>'name', '')), ''),
      ''
    );

    if v_email is null and v_phone is null then
      insert into cblaero_app.import_row_error (
        batch_id,
        row_number,
        raw_data,
        error_code,
        error_detail
      )
      values (
        p_batch_id,
        coalesce(v_row_number, 0),
        v_raw_data,
        'missing_identity',
        'Row must have at least one of: email, phone'
      );

      v_chunk_errors := v_chunk_errors + 1;
      continue;
    end if;

    begin
      if v_email is not null then
        insert into cblaero_app.candidates (
          tenant_id,
          email,
          phone,
          name,
          first_name,
          last_name,
          middle_name,
          home_phone,
          work_phone,
          location,
          address,
          city,
          state,
          country,
          postal_code,
          current_company,
          job_title,
          alternate_email,
          skills,
          certifications,
          experience,
          extra_attributes,
          availability_status,
          ingestion_state,
          source,
          source_batch_id,
          created_by_actor_id,
          updated_at
        )
        values (
          v_candidate->>'tenant_id',
          v_email,
          v_phone,
          v_computed_name,
          v_first_name,
          v_last_name,
          v_middle_name,
          v_home_phone,
          v_work_phone,
          nullif(v_candidate->>'location', ''),
          v_address,
          v_city,
          v_state,
          v_country,
          v_postal_code,
          v_current_company,
          v_job_title,
          v_alternate_email,
          coalesce(v_candidate->'skills', '[]'::jsonb),
          coalesce(v_candidate->'certifications', '[]'::jsonb),
          coalesce(v_candidate->'experience', '[]'::jsonb),
          coalesce(v_candidate->'extra_attributes', '{}'::jsonb),
          coalesce(v_candidate->>'availability_status', 'passive'),
          coalesce(v_candidate->>'ingestion_state', 'pending_dedup'),
          coalesce(v_candidate->>'source', 'migration'),
          coalesce((v_candidate->>'source_batch_id')::uuid, p_batch_id),
          nullif(trim(coalesce(v_candidate->>'created_by_actor_id', '')), ''),
          coalesce((v_candidate->>'updated_at')::timestamptz, now())
        )
        on conflict (tenant_id, email) where email is not null
        do update set
          phone = excluded.phone,
          name = excluded.name,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          middle_name = excluded.middle_name,
          home_phone = excluded.home_phone,
          work_phone = excluded.work_phone,
          location = excluded.location,
          address = excluded.address,
          city = excluded.city,
          state = excluded.state,
          country = excluded.country,
          postal_code = excluded.postal_code,
          current_company = excluded.current_company,
          job_title = excluded.job_title,
          alternate_email = excluded.alternate_email,
          skills = excluded.skills,
          certifications = excluded.certifications,
          experience = excluded.experience,
          extra_attributes = excluded.extra_attributes,
          availability_status = excluded.availability_status,
          ingestion_state = excluded.ingestion_state,
          source = excluded.source,
          source_batch_id = excluded.source_batch_id,
          created_by_actor_id = coalesce(candidates.created_by_actor_id, excluded.created_by_actor_id),
          updated_at = excluded.updated_at
        returning xmax into v_xmax;
      else
        insert into cblaero_app.candidates (
          tenant_id,
          email,
          phone,
          name,
          first_name,
          last_name,
          middle_name,
          home_phone,
          work_phone,
          location,
          address,
          city,
          state,
          country,
          postal_code,
          current_company,
          job_title,
          alternate_email,
          skills,
          certifications,
          experience,
          extra_attributes,
          availability_status,
          ingestion_state,
          source,
          source_batch_id,
          created_by_actor_id,
          updated_at
        )
        values (
          v_candidate->>'tenant_id',
          v_email,
          v_phone,
          v_computed_name,
          v_first_name,
          v_last_name,
          v_middle_name,
          v_home_phone,
          v_work_phone,
          nullif(v_candidate->>'location', ''),
          v_address,
          v_city,
          v_state,
          v_country,
          v_postal_code,
          v_current_company,
          v_job_title,
          v_alternate_email,
          coalesce(v_candidate->'skills', '[]'::jsonb),
          coalesce(v_candidate->'certifications', '[]'::jsonb),
          coalesce(v_candidate->'experience', '[]'::jsonb),
          coalesce(v_candidate->'extra_attributes', '{}'::jsonb),
          coalesce(v_candidate->>'availability_status', 'passive'),
          coalesce(v_candidate->>'ingestion_state', 'pending_dedup'),
          coalesce(v_candidate->>'source', 'migration'),
          coalesce((v_candidate->>'source_batch_id')::uuid, p_batch_id),
          nullif(trim(coalesce(v_candidate->>'created_by_actor_id', '')), ''),
          coalesce((v_candidate->>'updated_at')::timestamptz, now())
        )
        on conflict (tenant_id, phone) where phone is not null
        do update set
          email = excluded.email,
          name = excluded.name,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          middle_name = excluded.middle_name,
          home_phone = excluded.home_phone,
          work_phone = excluded.work_phone,
          location = excluded.location,
          address = excluded.address,
          city = excluded.city,
          state = excluded.state,
          country = excluded.country,
          postal_code = excluded.postal_code,
          current_company = excluded.current_company,
          job_title = excluded.job_title,
          alternate_email = excluded.alternate_email,
          skills = excluded.skills,
          certifications = excluded.certifications,
          experience = excluded.experience,
          extra_attributes = excluded.extra_attributes,
          availability_status = excluded.availability_status,
          ingestion_state = excluded.ingestion_state,
          source = excluded.source,
          source_batch_id = excluded.source_batch_id,
          created_by_actor_id = coalesce(candidates.created_by_actor_id, excluded.created_by_actor_id),
          updated_at = excluded.updated_at
        returning xmax into v_xmax;
      end if;

      if v_xmax = 0 then
        v_chunk_inserted := v_chunk_inserted + 1;
      else
        v_chunk_updated := v_chunk_updated + 1;
      end if;
    exception
      when others then
        insert into cblaero_app.import_row_error (
          batch_id,
          row_number,
          raw_data,
          error_code,
          error_detail
        )
        values (
          p_batch_id,
          coalesce(v_row_number, 0),
          v_raw_data,
          'upsert_failure',
          sqlerrm
        );

        v_chunk_errors := v_chunk_errors + 1;
    end;
  end loop;

  update cblaero_app.import_batch
  set
    imported = p_total_imported + v_chunk_inserted,
    skipped = p_total_skipped + v_chunk_updated,
    errors = p_total_errors + v_chunk_errors
  where id = p_batch_id;

  return query
  select p_total_imported + v_chunk_inserted,
         p_total_skipped + v_chunk_updated,
         p_total_errors + v_chunk_errors;
end;
$$;

-- ============================================================
-- Permissions
-- Grant schema usage + table/function access to Supabase roles.
-- Re-run after adding new tables — grants are not retroactive.
-- schema usage is required for PostgREST to route into cblaero_app.
-- ============================================================

grant usage on schema cblaero_app to anon, authenticated, service_role;

grant select, insert on cblaero_app.audit_import_batch_accesses
  to authenticated, service_role;

grant select, insert, update on cblaero_app.import_batch
  to authenticated, service_role;

grant select, insert on cblaero_app.import_row_error
  to authenticated, service_role;

grant select, insert, update, delete on cblaero_app.candidates
  to authenticated, service_role;

grant execute on function cblaero_app.process_import_chunk(uuid, jsonb, jsonb, int, int, int)
  to service_role;

-- Story 2.3: Extended candidate fields for ATS/email ingestion
alter table cblaero_app.candidates
  add column if not exists work_authorization text,
  add column if not exists clearance text,
  add column if not exists aircraft_experience jsonb not null default '[]'::jsonb,
  add column if not exists employment_type text,
  add column if not exists current_rate text,
  add column if not exists per_diem text,
  add column if not exists has_ap_license boolean,
  add column if not exists years_of_experience text,
  add column if not exists ceipal_id text,
  add column if not exists submitted_by text,
  add column if not exists submitter_email text,
  add column if not exists shift_preference text,
  add column if not exists expected_start_date text,
  add column if not exists call_availability text,
  add column if not exists interview_availability text,
  add column if not exists veteran_status text;

create index if not exists idx_candidates_ceipal_id
  on cblaero_app.candidates (ceipal_id) where ceipal_id is not null;

-- Story 2.3: Submission evidence table
create table if not exists cblaero_app.candidate_submissions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references cblaero_app.candidates(id) on delete set null,
  tenant_id text not null,
  source text not null check (source in ('email', 'ats', 'csv', 'ceipal', 'resume_upload')),
  email_message_id text,
  email_subject text,
  email_body text,
  email_from text,
  email_received_at timestamptz,
  extracted_data jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  extraction_model text,
  extraction_confidence text,
  created_at timestamptz not null default now()
);

create index if not exists idx_submissions_candidate
  on cblaero_app.candidate_submissions (candidate_id);
create index if not exists idx_submissions_source
  on cblaero_app.candidate_submissions (source);
create index if not exists idx_submissions_received
  on cblaero_app.candidate_submissions (email_received_at desc);

-- Story 2.3: Persistent sync error tracking
create table if not exists cblaero_app.sync_errors (
  id bigint generated always as identity primary key,
  source text not null,
  record_id text not null,
  message text not null,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_sync_errors_occurred
  on cblaero_app.sync_errors (occurred_at desc);
create index if not exists idx_sync_errors_source
  on cblaero_app.sync_errors (source);

-- Story 2.3: Grants for new tables
grant select, insert, update, delete on cblaero_app.candidate_submissions
  to anon, authenticated, service_role;

grant select, insert on cblaero_app.sync_errors
  to anon, authenticated, service_role;

grant usage on all sequences in schema cblaero_app
  to anon, authenticated, service_role;
