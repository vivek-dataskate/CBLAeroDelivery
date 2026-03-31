/**
 * Ceipal ATS connector — v1 API
 *
 * Required env vars (set in Render):
 *   CEIPAL_API_KEY      — API key from Ceipal admin panel
 *   CEIPAL_USERNAME     — Ceipal login username
 *   CEIPAL_PASSWORD     — Ceipal login password
 *
 * Auth endpoint:  POST https://api.ceipal.com/v1/createAuthtoken/
 * Data endpoint:  GET  https://api.ceipal.com/getCustomApplicantDetails/{endpoint_key}
 *
 * The endpoint key is embedded in the URL — stored as CEIPAL_ENDPOINT_KEY env var.
 * Default page size: 100 records per page.
 */

const CEIPAL_AUTH_URL = 'https://api.ceipal.com/v1/createAuthtoken/';
const CEIPAL_PAGE_SIZE = 100;

type CeipalTokenCache = {
  token: string;
  expiresAt: number;
};

let tokenCache: CeipalTokenCache | null = null;

function getCeipalConfig() {
  const apiKey = process.env.CEIPAL_API_KEY;
  const username = process.env.CEIPAL_USERNAME;
  const password = process.env.CEIPAL_PASSWORD;
  const endpointKey = process.env.CEIPAL_ENDPOINT_KEY;

  if (!apiKey || !username || !password || !endpointKey) {
    throw new Error(
      'Ceipal not configured. Required env vars: CEIPAL_API_KEY, CEIPAL_USERNAME, CEIPAL_PASSWORD, CEIPAL_ENDPOINT_KEY'
    );
  }

  return { apiKey, username, password, endpointKey };
}

async function acquireCeipalToken(): Promise<string> {
  // Return cached token with 5-min buffer
  if (tokenCache && Date.now() < tokenCache.expiresAt - 300_000) {
    return tokenCache.token;
  }

  const { apiKey, username, password } = getCeipalConfig();

  const response = await fetch(CEIPAL_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, username, password, json: 1 }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ceipal auth failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { token?: string; access_token?: string; expires_in?: number };
  const token = data.token ?? data.access_token;
  if (!token) {
    throw new Error(`Ceipal auth response missing token: ${JSON.stringify(data)}`);
  }

  // Default 1 hour expiry if not provided
  const expiresIn = (data.expires_in ?? 3600) * 1000;
  tokenCache = { token, expiresAt: Date.now() + expiresIn };

  return token;
}

export type CeipalApplicant = {
  first_name: string;
  middle_name?: string;
  last_name: string;
  nick_name?: string;
  email_address: string;
  alternate_email_address?: string;
  home_phone_number?: string;
  mobile_number?: string;
  work_phone_number?: string;
  other_phone?: string;
  date_of_birth?: string;
  work_authorization?: string;
  clearance?: string;
  address?: string;
  city?: string;
  country?: string;
  state?: string;
  zip_code?: string;
  source?: string;
  experience?: string;
  applicant_status?: string;
  job_title?: string;
  skills?: string;
  primary_skills?: string;
  technology?: string;
  relocation?: string;
  gender?: string;
  veteran_status?: string;
  work_authorization_expiry?: string;
  linkedin_profile_url?: string;
  additional_comments?: string;
};

/**
 * Fetch all applicants from Ceipal with pagination.
 * Supports optional date filter for incremental sync.
 */
export async function fetchCeipalApplicants(options?: {
  since?: Date;
  maxPages?: number;
}): Promise<CeipalApplicant[]> {
  const token = await acquireCeipalToken();
  const { endpointKey } = getCeipalConfig();
  const baseUrl = `https://api.ceipal.com/getCustomApplicantDetails/${endpointKey}`;

  const all: CeipalApplicant[] = [];
  let page = 1;
  const maxPages = options?.maxPages ?? 10000; // safety cap

  while (page <= maxPages) {
    const url = `${baseUrl}?json=1&paging_length=${CEIPAL_PAGE_SIZE}&page=${page}` +
      (options?.since ? `&modified_after=${options.since.toISOString().slice(0, 10)}` : '');

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ceipal fetch failed on page ${page} (${response.status}): ${text}`);
    }

    const data = await response.json() as { results?: CeipalApplicant[]; count?: number } | CeipalApplicant[];

    // Handle both array and paginated object response shapes
    const results = Array.isArray(data) ? data : (data.results ?? []);

    if (results.length === 0) break;

    all.push(...results);

    // Stop if we got a partial page (last page)
    if (results.length < CEIPAL_PAGE_SIZE) break;

    page++;
  }

  return all;
}

/**
 * Map a Ceipal applicant to the ingestion candidate shape.
 */
export function mapCeipalApplicantToCandidate(a: CeipalApplicant): Record<string, unknown> {
  return {
    firstName: a.first_name?.trim() ?? '',
    lastName: a.last_name?.trim() ?? '',
    middleName: a.middle_name?.trim() ?? undefined,
    email: a.email_address?.trim() ?? '',
    alternateEmail: a.alternate_email_address?.trim() ?? undefined,
    phone: a.mobile_number?.trim() || a.home_phone_number?.trim() || undefined,
    homePhone: a.home_phone_number?.trim() ?? undefined,
    workPhone: a.work_phone_number?.trim() ?? undefined,
    address: a.address?.trim() ?? undefined,
    city: a.city?.trim() ?? undefined,
    state: a.state?.trim() ?? undefined,
    country: a.country?.trim() ?? undefined,
    postalCode: a.zip_code?.trim() ?? undefined,
    jobTitle: a.job_title?.trim() ?? undefined,
    skills: a.skills ? a.skills.split(',').map((s) => s.trim()).filter(Boolean) : [],
    workAuthorization: a.work_authorization?.trim() ?? undefined,
    clearance: a.clearance?.trim() ?? undefined,
    source: 'ceipal',
  };
}

export function clearCeipalTokenCacheForTest(): void {
  tokenCache = null;
}
