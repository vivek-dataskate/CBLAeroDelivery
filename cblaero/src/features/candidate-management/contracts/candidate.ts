export type AvailabilityStatus = "active" | "passive" | "unavailable";
export type IngestionState = "pending_dedup" | "pending_enrichment" | "active" | "rejected";

export type CandidateListItem = {
  id: string;
  tenantId: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  availabilityStatus: AvailabilityStatus;
  ingestionState: IngestionState;
  source: string;
  sourceBatchId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CandidateDetail = CandidateListItem & {
  middleName: string | null;
  homePhone: string | null;
  workPhone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  currentCompany: string | null;
  jobTitle: string | null;
  alternateEmail: string | null;
  skills: unknown[];
  certifications: unknown[];
  experience: unknown[];
  extraAttributes: Record<string, unknown>;
  // Story 2.3 columns (aviation-specific and ingestion metadata)
  workAuthorization: string | null;
  clearance: string | null;
  aircraftExperience: unknown[];
  employmentType: string | null;
  currentRate: string | null;
  perDiem: string | null;
  hasApLicense: boolean | null;
  yearsOfExperience: string | null;
  ceipalId: string | null;
  submittedBy: string | null;
  submitterEmail: string | null;
  shiftPreference: string | null;
  expectedStartDate: string | null;
  callAvailability: string | null;
  interviewAvailability: string | null;
  veteranStatus: string | null;
};

export type CandidateListParams = {
  tenantId: string;
  availabilityStatus?: AvailabilityStatus;
  location?: string;
  certType?: string;
  search?: string;
  cursor?: string;
  limit?: number;
};

export type CandidateListResult = {
  items: CandidateListItem[];
  nextCursor: string | null;
};
