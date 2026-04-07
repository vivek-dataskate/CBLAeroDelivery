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

create index if not exists idx_candidates_source_batch
  on cblaero_app.candidates (source_batch_id)
  where source_batch_id is not null;

-- Full-text search on name fields (tsvector generated column)
alter table cblaero_app.candidates
  add column if not exists name_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(first_name, '') || ' ' ||
      coalesce(last_name, '')
    )
  ) stored;

create index if not exists idx_candidates_name_fts
  on cblaero_app.candidates using gin (name_tsv)
  where ingestion_state = 'active';

-- GIN index for skills JSONB contains queries
create index if not exists idx_candidates_skills_gin
  on cblaero_app.candidates using gin (skills)
  where ingestion_state = 'active';

-- Composite index for tenant + ingestion_state filtering (used on every query)
create index if not exists idx_candidates_tenant_state
  on cblaero_app.candidates (tenant_id, ingestion_state);

-- Trigram indexes for fast ILIKE '%...%' substring searches (pg_trgm)
create extension if not exists pg_trgm;

create index if not exists idx_candidates_email_trgm
  on cblaero_app.candidates using gin (email gin_trgm_ops)
  where ingestion_state = 'active';

create index if not exists idx_candidates_job_title_trgm
  on cblaero_app.candidates using gin (job_title gin_trgm_ops)
  where ingestion_state = 'active';

create index if not exists idx_candidates_city_trgm
  on cblaero_app.candidates using gin (city gin_trgm_ops)
  where ingestion_state = 'active';

-- Source filter index
create index if not exists idx_candidates_tenant_source
  on cblaero_app.candidates (tenant_id, source)
  where ingestion_state = 'active';

-- Sort performance indexes
create index if not exists idx_candidates_tenant_created_desc
  on cblaero_app.candidates (tenant_id, created_at desc)
  where ingestion_state = 'active';

create index if not exists idx_candidates_tenant_yoe_desc
  on cblaero_app.candidates (tenant_id, years_of_experience desc nulls last)
  where ingestion_state = 'active';

-- RPC: Candidate search with all filters, sorting, and pagination in SQL
-- Avoids PostgREST filter limitations; supports skills::text ILIKE, numeric casts, tsvector search
create or replace function cblaero_app.search_candidates(
  p_tenant_id text,
  p_search text default null,
  p_email text default null,
  p_job_title text default null,
  p_skills text default null,
  p_city text default null,
  p_state text default null,
  p_availability_status text default null,
  p_work_authorization text default null,
  p_source text default null,
  p_employment_type text default null,
  p_years_of_experience numeric default null,
  p_veteran_status text default null,
  p_has_ap_license boolean default null,
  p_cert_type text default null,
  p_current_company text default null,
  p_phone text default null,
  p_shift_preference text default null,
  p_created_after timestamptz default null,
  p_created_before timestamptz default null,
  p_sort_by text default 'created_at',
  p_sort_dir text default 'desc',
  p_limit int default 25
)
returns table (
  id uuid, tenant_id text, first_name text, last_name text,
  email text, phone text, location text, city text, state text,
  availability_status text, ingestion_state text, job_title text,
  skills jsonb, years_of_experience text, source text,
  source_batch_id uuid, created_at timestamptz, updated_at timestamptz
)
language plpgsql stable
as $$
declare v_tsquery tsquery;
begin
  if p_search is not null and trim(p_search) != '' then
    v_tsquery := to_tsquery('english',
      array_to_string(array(select s || ':*' from unnest(string_to_array(trim(p_search), ' ')) as s where s != ''), ' & ')
    );
  end if;
  return query
  select c.id, c.tenant_id, c.first_name, c.last_name, c.email, c.phone,
    c.location, c.city, c.state, c.availability_status, c.ingestion_state,
    c.job_title, c.skills, c.years_of_experience, c.source,
    c.source_batch_id, c.created_at, c.updated_at
  from cblaero_app.candidates c
  where c.tenant_id = p_tenant_id and c.ingestion_state = 'active'
    and (v_tsquery is null or c.name_tsv @@ v_tsquery)
    and (p_email is null or c.email ilike '%' || p_email || '%')
    and (p_job_title is null or c.job_title ilike '%' || p_job_title || '%')
    and (p_skills is null or c.skills::text ilike '%' || p_skills || '%')
    and (p_city is null or c.city ilike '%' || p_city || '%')
    and (p_state is null or c.state ilike '%' || p_state || '%')
    and (p_work_authorization is null or c.work_authorization ilike '%' || p_work_authorization || '%')
    and (p_current_company is null or c.current_company ilike '%' || p_current_company || '%')
    and (p_phone is null or c.phone ilike '%' || p_phone || '%')
    and (p_shift_preference is null or c.shift_preference ilike '%' || p_shift_preference || '%')
    and (p_availability_status is null or c.availability_status = p_availability_status)
    and (p_source is null or c.source = p_source)
    and (p_employment_type is null or c.employment_type = p_employment_type)
    and (p_veteran_status is null or c.veteran_status = p_veteran_status)
    and (p_has_ap_license is null or c.has_ap_license = p_has_ap_license)
    and (p_cert_type is null or c.certifications @> jsonb_build_array(jsonb_build_object('type', p_cert_type)))
    and (p_years_of_experience is null or (c.years_of_experience is not null and c.years_of_experience != '' and c.years_of_experience::numeric >= p_years_of_experience))
    and (p_created_after is null or c.created_at >= p_created_after)
    and (p_created_before is null or c.created_at < (p_created_before + interval '1 day'))
  order by
    case when p_sort_by = 'created_at' and p_sort_dir = 'desc' then c.created_at end desc nulls last,
    case when p_sort_by = 'created_at' and p_sort_dir = 'asc' then c.created_at end asc nulls last,
    case when p_sort_by = 'years_of_experience' and p_sort_dir = 'desc' then c.years_of_experience end desc nulls last,
    case when p_sort_by = 'years_of_experience' and p_sort_dir = 'asc' then c.years_of_experience end asc nulls last,
    case when p_sort_by = 'first_name' and p_sort_dir = 'asc' then c.first_name end asc nulls last,
    case when p_sort_by = 'first_name' and p_sort_dir = 'desc' then c.first_name end desc nulls last,
    case when p_sort_by = 'job_title' and p_sort_dir = 'asc' then c.job_title end asc nulls last,
    case when p_sort_by = 'job_title' and p_sort_dir = 'desc' then c.job_title end desc nulls last,
    c.id desc
  limit p_limit + 1;
end;
$$;

grant execute on function cblaero_app.search_candidates to anon, authenticated, service_role;

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
  v_resume_url text;
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
    v_resume_url := nullif(trim(coalesce(v_candidate->>'resume_url', '')), '');
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
          resume_url,
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
          v_resume_url,
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
          resume_url = coalesce(excluded.resume_url, candidates.resume_url),
          updated_at = excluded.updated_at
        returning xmax into v_xmax;
      else
        insert into cblaero_app.candidates (
          tenant_id, email, phone, name, first_name, last_name, middle_name,
          home_phone, work_phone, location, address, city, state, country,
          postal_code, current_company, job_title, alternate_email,
          skills, certifications, experience, extra_attributes,
          availability_status, ingestion_state, source, source_batch_id,
          created_by_actor_id, resume_url, updated_at
        )
        values (
          v_candidate->>'tenant_id', v_email, v_phone, v_computed_name,
          v_first_name, v_last_name, v_middle_name, v_home_phone, v_work_phone,
          nullif(v_candidate->>'location', ''), v_address, v_city, v_state,
          v_country, v_postal_code, v_current_company, v_job_title, v_alternate_email,
          coalesce(v_candidate->'skills', '[]'::jsonb),
          coalesce(v_candidate->'certifications', '[]'::jsonb),
          coalesce(v_candidate->'experience', '[]'::jsonb),
          coalesce(v_candidate->'extra_attributes', '{}'::jsonb),
          coalesce(v_candidate->>'availability_status', 'passive'),
          coalesce(v_candidate->>'ingestion_state', 'pending_dedup'),
          coalesce(v_candidate->>'source', 'migration'),
          coalesce((v_candidate->>'source_batch_id')::uuid, p_batch_id),
          nullif(trim(coalesce(v_candidate->>'created_by_actor_id', '')), ''),
          v_resume_url,
          coalesce((v_candidate->>'updated_at')::timestamptz, now())
        )
        on conflict (tenant_id, phone) where phone is not null
        do update set
          email = excluded.email, name = excluded.name,
          first_name = excluded.first_name, last_name = excluded.last_name,
          middle_name = excluded.middle_name, home_phone = excluded.home_phone,
          work_phone = excluded.work_phone, location = excluded.location,
          address = excluded.address, city = excluded.city, state = excluded.state,
          country = excluded.country, postal_code = excluded.postal_code,
          current_company = excluded.current_company, job_title = excluded.job_title,
          alternate_email = excluded.alternate_email, skills = excluded.skills,
          certifications = excluded.certifications, experience = excluded.experience,
          extra_attributes = excluded.extra_attributes,
          availability_status = excluded.availability_status,
          ingestion_state = excluded.ingestion_state, source = excluded.source,
          source_batch_id = excluded.source_batch_id,
          created_by_actor_id = coalesce(candidates.created_by_actor_id, excluded.created_by_actor_id),
          resume_url = coalesce(excluded.resume_url, candidates.resume_url),
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

-- Audit tables: append-only (§27) — INSERT + SELECT only, no UPDATE/DELETE
grant select, insert on cblaero_app.audit_authorization_denials
  to authenticated, service_role;

grant select, insert on cblaero_app.audit_admin_actions
  to authenticated, service_role;

grant select, insert on cblaero_app.audit_step_up_attempts
  to authenticated, service_role;

grant select, insert on cblaero_app.audit_client_context_confirmations
  to authenticated, service_role;

grant select, insert on cblaero_app.audit_data_residency_checks
  to authenticated, service_role;

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

-- RPC: Get single candidate detail with explicit columns (replaces select(*))
create or replace function cblaero_app.get_candidate_detail(p_candidate_id uuid, p_tenant_id text)
returns table (
  id uuid, tenant_id text, first_name text, last_name text, middle_name text,
  email text, phone text, home_phone text, work_phone text,
  location text, address text, city text, state text, country text, postal_code text,
  availability_status text, ingestion_state text,
  current_company text, job_title text, alternate_email text,
  skills jsonb, certifications jsonb, experience jsonb, extra_attributes jsonb,
  work_authorization text, clearance text, aircraft_experience jsonb,
  employment_type text, current_rate text, per_diem text, has_ap_license boolean,
  years_of_experience text, ceipal_id text, submitted_by text, submitter_email text,
  shift_preference text, expected_start_date text, call_availability text,
  interview_availability text, veteran_status text,
  source text, source_batch_id uuid, created_at timestamptz, updated_at timestamptz
)
language sql stable
as $$
  select c.id, c.tenant_id, c.first_name, c.last_name, c.middle_name,
    c.email, c.phone, c.home_phone, c.work_phone,
    c.location, c.address, c.city, c.state, c.country, c.postal_code,
    c.availability_status, c.ingestion_state,
    c.current_company, c.job_title, c.alternate_email,
    c.skills, c.certifications, c.experience, c.extra_attributes,
    c.work_authorization, c.clearance, c.aircraft_experience,
    c.employment_type, c.current_rate, c.per_diem, c.has_ap_license,
    c.years_of_experience, c.ceipal_id, c.submitted_by, c.submitter_email,
    c.shift_preference, c.expected_start_date, c.call_availability,
    c.interview_availability, c.veteran_status,
    c.source, c.source_batch_id, c.created_at, c.updated_at
  from cblaero_app.candidates c
  where c.id = p_candidate_id and c.tenant_id = p_tenant_id
  limit 1;
$$;

grant execute on function cblaero_app.get_candidate_detail to anon, authenticated, service_role;

-- RPC: Atomic rollback of import batch (delete candidates + mark batch rolled_back)
create or replace function cblaero_app.rollback_import_batch(p_batch_id uuid)
returns table (deleted_candidates bigint)
language plpgsql
as $$
declare v_count bigint;
begin
  delete from cblaero_app.candidates where source_batch_id = p_batch_id;
  get diagnostics v_count = row_count;
  update cblaero_app.import_batch set status = 'rolled_back', completed_at = now() where id = p_batch_id;
  deleted_candidates := v_count;
  return next;
end;
$$;

grant execute on function cblaero_app.rollback_import_batch to service_role;

-- RPC: Bulk load fingerprint hashes for in-memory dedup cache
create or replace function cblaero_app.load_recent_fingerprints(
  p_tenant_id text, p_type text, p_days int default 30, p_max_count int default 100000
)
returns table (fingerprint_hash text)
language sql stable
as $$
  select cf.fingerprint_hash from cblaero_app.content_fingerprints cf
  where cf.tenant_id = p_tenant_id and cf.fingerprint_type = p_type
    and cf.status = 'processed' and cf.created_at >= now() - (p_days || ' days')::interval
  limit p_max_count;
$$;

grant execute on function cblaero_app.load_recent_fingerprints to service_role;

-- RPC: Cleanup old audit logs across all tables atomically
create or replace function cblaero_app.cleanup_audit_logs(p_retention_days int default 90)
returns table (table_name text, deleted_count bigint)
language plpgsql
as $$
declare
  v_cutoff timestamptz := now() - (p_retention_days || ' days')::interval;
  v_count bigint;
begin
  delete from cblaero_app.audit_authorization_denials where occurred_at < v_cutoff;
  get diagnostics v_count = row_count;
  table_name := 'audit_authorization_denials'; deleted_count := v_count; return next;
  delete from cblaero_app.audit_admin_actions where occurred_at < v_cutoff;
  get diagnostics v_count = row_count;
  table_name := 'audit_admin_actions'; deleted_count := v_count; return next;
  delete from cblaero_app.audit_step_up_attempts where occurred_at < v_cutoff;
  get diagnostics v_count = row_count;
  table_name := 'audit_step_up_attempts'; deleted_count := v_count; return next;
  delete from cblaero_app.audit_client_context_confirmations where occurred_at < v_cutoff;
  get diagnostics v_count = row_count;
  table_name := 'audit_client_context_confirmations'; deleted_count := v_count; return next;
  delete from cblaero_app.audit_data_residency_checks where occurred_at < v_cutoff;
  get diagnostics v_count = row_count;
  table_name := 'audit_data_residency_checks'; deleted_count := v_count; return next;
  delete from cblaero_app.audit_import_batch_accesses where occurred_at < v_cutoff;
  get diagnostics v_count = row_count;
  table_name := 'audit_import_batch_accesses'; deleted_count := v_count; return next;
end;
$$;

grant execute on function cblaero_app.cleanup_audit_logs to service_role;

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

-- Story 2.4 rework: Saved searches table
create table if not exists cblaero_app.saved_searches (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  actor_id text not null,
  actor_email text not null,
  name text not null,
  filters jsonb not null,
  digest_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_saved_searches_actor
  on cblaero_app.saved_searches (actor_id, tenant_id);
create index if not exists idx_saved_searches_digest
  on cblaero_app.saved_searches (digest_enabled)
  where digest_enabled = true;

grant select, insert, update, delete on cblaero_app.saved_searches
  to anon, authenticated, service_role;

-- RLS: users can only access their own saved searches within their tenant
alter table cblaero_app.saved_searches enable row level security;

create policy saved_searches_select on cblaero_app.saved_searches
  for select using (true);
create policy saved_searches_insert on cblaero_app.saved_searches
  for insert with check (true);
create policy saved_searches_update on cblaero_app.saved_searches
  for update using (true);
create policy saved_searches_delete on cblaero_app.saved_searches
  for delete using (true);

-- Note: Application-level enforcement via actor_id/tenant_id predicates in repository.
-- RLS policies are permissive because the admin client (service_role) bypasses RLS anyway.
-- If direct PostgREST access is enabled for authenticated users, tighten policies to:
--   using (actor_id = auth.uid()::text AND tenant_id = current_setting('app.tenant_id'))

-- Story 1.11: Content fingerprint gate for dedup before expensive processing
create table if not exists cblaero_app.content_fingerprints (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  fingerprint_type text not null check (fingerprint_type in (
    'file_sha256', 'email_message_id', 'csv_row_hash', 'ats_external_id', 'candidate_identity'
  )),
  fingerprint_hash text not null,
  source text not null check (source in ('email', 'ats', 'csv', 'ceipal', 'resume_upload', 'onedrive')),
  status text not null default 'processed' check (status in ('processed', 'failed')),
  candidate_id uuid references cblaero_app.candidates(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_fingerprint_tenant_type_hash
  on cblaero_app.content_fingerprints (tenant_id, fingerprint_type, fingerprint_hash);

create index if not exists idx_fingerprints_tenant_type_created
  on cblaero_app.content_fingerprints (tenant_id, fingerprint_type, created_at desc);

grant select, insert, update, delete on cblaero_app.content_fingerprints
  to anon, authenticated, service_role;

-- Prompt Registry — append-only, versioned prompts for AI inference service (Story 1.9)
-- status column added in Story 1.9a for lifecycle management (active/staged/deprecated)
create table if not exists cblaero_app.prompt_registry (
  id bigint generated always as identity primary key,
  name text not null,
  version text not null,
  prompt_text text not null,
  model text not null,
  status text not null default 'active' check (status in ('active', 'staged', 'deprecated')),
  created_at timestamptz not null default now(),
  created_by text,
  notes text,
  unique (name, version)
);

-- Story 1.9a: add status column if table already exists (idempotent migration)
alter table cblaero_app.prompt_registry
  add column if not exists status text not null default 'active';

-- Story 1.9a: add CHECK constraint on status (idempotent — drops if exists first)
do $$
begin
  if not exists (
    select 1 from information_schema.check_constraints
    where constraint_name = 'prompt_registry_status_check'
  ) then
    alter table cblaero_app.prompt_registry
      add constraint prompt_registry_status_check
      check (status in ('active', 'staged', 'deprecated'));
  end if;
end $$;

create index if not exists idx_prompt_registry_name_created
  on cblaero_app.prompt_registry (name, created_at desc);

create index if not exists idx_prompt_registry_name_status
  on cblaero_app.prompt_registry (name, status);

grant select on cblaero_app.prompt_registry
  to anon, authenticated;

grant select, insert, update on cblaero_app.prompt_registry
  to service_role;

-- LLM Usage Log — per-call token counts and cost tracking (Story 1.9)
create table if not exists cblaero_app.llm_usage_log (
  id bigint generated always as identity primary key,
  model text not null,
  prompt_name text,
  prompt_version text,
  module text not null,
  action text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  duration_ms integer not null,
  estimated_cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_llm_usage_log_created
  on cblaero_app.llm_usage_log (created_at desc);

create index if not exists idx_llm_usage_log_model_created
  on cblaero_app.llm_usage_log (model, created_at desc);

grant select on cblaero_app.llm_usage_log
  to authenticated;

grant select, insert on cblaero_app.llm_usage_log
  to service_role;
