import {
  getSupabaseAdminClient,
  shouldUseInMemoryPersistenceForTests,
} from "@/modules/persistence";
import type {
  AvailabilityStatus,
  CandidateDetail,
  CandidateListItem,
  CandidateListParams,
  CandidateListResult,
  IngestionState,
} from "../contracts/candidate";

export class CandidateNotFoundError extends Error {
  constructor() {
    super("Candidate not found.");
    this.name = "CandidateNotFoundError";
  }
}

// -----------------------------------------------------------------------
// In-memory store (test mode only)
// -----------------------------------------------------------------------

const candidateStore = new Map<string, CandidateDetail>();

export function seedCandidateForTest(candidate: CandidateDetail): void {
  candidateStore.set(candidate.id, { ...candidate });
}

export function clearCandidateStoreForTest(): void {
  candidateStore.clear();
}

// -----------------------------------------------------------------------
// Row mapping helpers
// -----------------------------------------------------------------------

type CandidateRow = {
  id: string;
  tenant_id: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  availability_status: string;
  ingestion_state: string;
  source: string;
  source_batch_id: string | null;
  created_at: string;
  updated_at: string;
};

type CandidateDetailRow = CandidateRow & {
  middle_name: string | null;
  home_phone: string | null;
  work_phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  current_company: string | null;
  job_title: string | null;
  alternate_email: string | null;
  skills: unknown[];
  certifications: unknown[];
  experience: unknown[];
  extra_attributes: Record<string, unknown>;
  // Story 2.3 columns
  work_authorization: string | null;
  clearance: string | null;
  aircraft_experience: unknown[];
  employment_type: string | null;
  current_rate: string | null;
  per_diem: string | null;
  has_ap_license: boolean | null;
  years_of_experience: string | null;
  ceipal_id: string | null;
  submitted_by: string | null;
  submitter_email: string | null;
  shift_preference: string | null;
  expected_start_date: string | null;
  call_availability: string | null;
  interview_availability: string | null;
  veteran_status: string | null;
};

function toListItem(row: CandidateRow): CandidateListItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    location: row.location,
    availabilityStatus: row.availability_status as AvailabilityStatus,
    ingestionState: row.ingestion_state as IngestionState,
    source: row.source,
    sourceBatchId: row.source_batch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDetail(row: CandidateDetailRow): CandidateDetail {
  return {
    ...toListItem(row),
    middleName: row.middle_name,
    homePhone: row.home_phone,
    workPhone: row.work_phone,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    postalCode: row.postal_code,
    currentCompany: row.current_company,
    jobTitle: row.job_title,
    alternateEmail: row.alternate_email,
    skills: Array.isArray(row.skills) ? row.skills : [],
    certifications: Array.isArray(row.certifications) ? row.certifications : [],
    experience: Array.isArray(row.experience) ? row.experience : [],
    extraAttributes:
      row.extra_attributes && typeof row.extra_attributes === "object"
        ? (row.extra_attributes as Record<string, unknown>)
        : {},
    // Story 2.3 columns
    workAuthorization: row.work_authorization,
    clearance: row.clearance,
    aircraftExperience: Array.isArray(row.aircraft_experience) ? row.aircraft_experience : [],
    employmentType: row.employment_type,
    currentRate: row.current_rate,
    perDiem: row.per_diem,
    hasApLicense: row.has_ap_license,
    yearsOfExperience: row.years_of_experience,
    ceipalId: row.ceipal_id,
    submittedBy: row.submitted_by,
    submitterEmail: row.submitter_email,
    shiftPreference: row.shift_preference,
    expectedStartDate: row.expected_start_date,
    callAvailability: row.call_availability,
    interviewAvailability: row.interview_availability,
    veteranStatus: row.veteran_status,
  };
}

// -----------------------------------------------------------------------
// Public repository functions
// -----------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export async function listCandidates(params: CandidateListParams): Promise<CandidateListResult> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = params.cursor ?? ZERO_UUID;

  if (shouldUseInMemoryPersistenceForTests()) {
    let candidates = [...candidateStore.values()].filter(
      (c) => c.tenantId === params.tenantId && c.ingestionState === "active" && c.id > cursor,
    );

    if (params.availabilityStatus) {
      candidates = candidates.filter((c) => c.availabilityStatus === params.availabilityStatus);
    }
    if (params.location) {
      const loc = params.location.toLowerCase();
      candidates = candidates.filter((c) => c.location?.toLowerCase().includes(loc));
    }
    if (params.certType) {
      const ct = params.certType.toLowerCase();
      candidates = candidates.filter((c) =>
        Array.isArray(c.certifications) &&
        c.certifications.some(
          (cert) =>
            typeof cert === "object" &&
            cert !== null &&
            typeof (cert as Record<string, unknown>).type === "string" &&
            ((cert as Record<string, unknown>).type as string).toLowerCase() === ct,
        ),
      );
    }
    if (params.search) {
      const terms = params.search.toLowerCase().split(/\s+/).filter(Boolean);
      candidates = candidates.filter((c) => {
        const haystack = `${c.firstName} ${c.lastName} ${c.name}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    candidates.sort((a, b) => a.id.localeCompare(b.id));

    const hasMore = candidates.length > limit;
    const page = candidates.slice(0, limit);
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return { items: page.map((c) => ({ ...c })), nextCursor };
  }

  const client = getSupabaseAdminClient();
  const selectCols =
    "id, tenant_id, name, first_name, last_name, email, phone, location, availability_status, ingestion_state, source, source_batch_id, created_at, updated_at";

  let query = client
    .from("candidates")
    .select(selectCols)
    .eq("tenant_id", params.tenantId)
    .eq("ingestion_state", "active")
    .gt("id", cursor)
    .order("id", { ascending: true })
    .limit(limit + 1);

  if (params.availabilityStatus) {
    query = query.eq("availability_status", params.availabilityStatus);
  }
  if (params.location) {
    const escaped = params.location.replace(/[%_]/g, (ch) => `\\${ch}`);
    query = query.ilike("location", `%${escaped}%`);
  }
  if (params.certType) {
    query = query.contains("certifications", JSON.stringify([{ type: params.certType }]));
  }
  if (params.search) {
    const tsquery = params.search
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `${term}:*`)
      .join(" & ");
    query = query.textSearch("name_tsv", tsquery);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list candidates: ${error.message}`);
  }

  const rows = (data ?? []) as CandidateRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return { items: page.map(toListItem), nextCursor };
}

export async function getCandidateById(
  candidateId: string,
  tenantId: string,
): Promise<CandidateDetail> {
  if (shouldUseInMemoryPersistenceForTests()) {
    const candidate = candidateStore.get(candidateId);
    if (!candidate || candidate.tenantId !== tenantId) {
      throw new CandidateNotFoundError();
    }
    return { ...candidate };
  }

  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("candidates")
    .select("*")
    .eq("id", candidateId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch candidate: ${error.message}`);
  }

  if (!data) {
    throw new CandidateNotFoundError();
  }

  return toDetail(data as CandidateDetailRow);
}
