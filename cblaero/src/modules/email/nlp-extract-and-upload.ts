import Anthropic from '@anthropic-ai/sdk';

/**
 * LLM-powered candidate extraction from submission emails.
 *
 * Uses Claude to intelligently parse any email format — handles varying
 * recruiter templates, free-form text, and inconsistent field names.
 * Falls back to regex if ANTHROPIC_API_KEY is not configured.
 */

export interface CandidateExtraction {
  // Core identity
  firstName: string;
  lastName: string;
  middleName?: string;
  email: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;

  // Position details
  jobTitle?: string;
  client?: string;
  location?: string;
  employmentType?: string; // Contract, Direct Hire, etc.
  shiftPreference?: string;
  expectedStartDate?: string;

  // Compensation
  currentRate?: string;
  perDiem?: string;

  // Qualifications
  skills?: string[];
  certifications?: string[];
  aircraftExperience?: string[];
  hasAPLicense?: boolean;
  yearsOfExperience?: string;
  workAuthorization?: string;
  clearance?: string;

  // Availability
  callAvailability?: string;
  interviewAvailability?: string;

  // Metadata
  ceipalId?: string;
  submittedBy?: string;
  submitterEmail?: string;
  source: string;

  // Catch-all for fields not in the schema
  additionalFields?: Record<string, string>;
}

export interface AttachmentMeta {
  filename: string;
  url: string;
}

const EXTRACTION_PROMPT = `You are a candidate data extraction agent for an aerospace staffing company (CBL Aero).
Given a submission email body, extract ALL candidate information into structured JSON.

Return ONLY valid JSON matching this schema (omit fields that are not present):
{
  "firstName": "string (required)",
  "lastName": "string (required)",
  "middleName": "string",
  "email": "string (required - candidate's email, NOT the recruiter's)",
  "phone": "string",
  "address": "string",
  "city": "string",
  "state": "string",
  "zipCode": "string",
  "country": "string",
  "jobTitle": "string (the position/role being applied for)",
  "client": "string (the client company, e.g. MHIRJ, AeroGuard)",
  "location": "string (job location)",
  "employmentType": "string (Contract, Direct Hire, etc.)",
  "shiftPreference": "string",
  "expectedStartDate": "string",
  "currentRate": "string (pay rate including currency)",
  "perDiem": "string",
  "skills": ["array of skill strings"],
  "certifications": ["array of certification strings, e.g. FAA A&P License"],
  "aircraftExperience": ["array of aircraft types, e.g. Boeing 737, Airbus A320"],
  "hasAPLicense": true/false,
  "yearsOfExperience": "string",
  "workAuthorization": "string (e.g. US Citizen, Green Card, H1B)",
  "clearance": "string",
  "callAvailability": "string",
  "interviewAvailability": "string",
  "ceipalId": "string (numeric ID from Ceipal ATS)",
  "submittedBy": "string (recruiter name who submitted)",
  "submitterEmail": "string (recruiter's email)",
  "additionalFields": {"key": "value for any other relevant data not covered above"}
}

Rules:
- Extract the CANDIDATE's email/phone, not the submitting recruiter's
- Parse the subject line for client, location, role if not in body
- "A&P License: Yes" means hasAPLicense: true and add "FAA A&P License" to certifications
- Split aircraft types into individual entries (e.g. "Boeing 737", "Boeing 747", not "Boeing (737, 747)")
- Normalize phone numbers to include country code if present
- Return ONLY the JSON object, no markdown fencing, no backticks, no explanation
- Use EXACTLY these field names — do not rename or nest them`;

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

export async function extractCandidateFromEmail(
  emailBody: string,
  subject: string
): Promise<CandidateExtraction> {
  const client = getAnthropicClient();

  if (client) {
    return extractWithLLM(client, emailBody, subject);
  }

  // Fallback: regex-based extraction
  console.warn('[NLP Parser] ANTHROPIC_API_KEY not set — using regex fallback');
  return extractWithRegex(emailBody, subject);
}

async function extractWithLLM(
  client: Anthropic,
  emailBody: string,
  subject: string
): Promise<CandidateExtraction> {
  // Strip HTML for cleaner LLM input
  const plainBody = emailBody.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `Subject: ${subject}\n\nEmail Body:\n${plainBody}`,
      },
    ],
    system: EXTRACTION_PROMPT,
  });

  let responseText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Strip markdown fencing if LLM wraps response
  responseText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(responseText);
    return { source: 'email', ...parsed };
  } catch {
    console.error('[NLP Parser] Failed to parse LLM response:', responseText.slice(0, 200));
    // Fall back to regex if LLM returns unparseable output
    return extractWithRegex(emailBody, subject);
  }
}

function extractWithRegex(emailBody: string, subject: string): CandidateExtraction {
  const text = emailBody.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

  // Name
  const fullNameMatch = text.match(/Full\s*(?:Legal\s*)?Name[:\s]+([^\n|]+?)(?=\s*(?:Position|Role|Email|Contact|Address|$))/i);
  const firstNameMatch = text.match(/First\s*Name[:\s]+([^\n<|]+)/i);
  const lastNameMatch = text.match(/Last\s*Name[:\s]+([^\n<|]+)/i);

  let firstName = firstNameMatch?.[1]?.trim() ?? '';
  let lastName = lastNameMatch?.[1]?.trim() ?? '';
  if (!firstName && fullNameMatch) {
    const parts = fullNameMatch[1].trim().split(/\s+/);
    firstName = parts[0] ?? '';
    lastName = parts.slice(1).join(' ');
  }

  const emailMatch = text.match(/E-?mail[:\s]+([^\s<\n|]+@[^\s<\n|]+)/i);
  const phoneMatch = text.match(/(?:Contact\s*Number|Phone|Mobile|Cell)[:\s]+([\d\s\-().+]{7,20})/i);
  const positionMatch = text.match(/Position[:\s]+([^\n|]+?)(?=\s*(?:Full|Role|Address|Contact|Email|Work Auth|$))/i);
  const workAuthMatch = text.match(/Work\s*Authorization[:\s]+([^\n|]+?)(?=\s*(?:Current|Rate|Specific|#|Expected|$))/i);
  const ceipalIdMatch = text.match(/Ci?epal\s*ID[:\s]+(\d+)/i);

  // Parse subject: "Role | Type | Client | Location | Name"
  const subjectParts = subject.split('|').map((s) => s.trim());

  return {
    firstName,
    lastName,
    email: emailMatch?.[1]?.trim() ?? '',
    phone: phoneMatch?.[1]?.trim() ?? undefined,
    jobTitle: positionMatch?.[1]?.trim() ?? subjectParts[0] ?? undefined,
    client: subjectParts.length >= 3 ? subjectParts[2] : undefined,
    location: subjectParts.length >= 4 ? subjectParts[3] : undefined,
    employmentType: subjectParts.length >= 2 ? subjectParts[1] : undefined,
    workAuthorization: workAuthMatch?.[1]?.trim() ?? undefined,
    ceipalId: ceipalIdMatch?.[1] ?? undefined,
    source: 'email',
  };
}

const ATTACHMENT_BUCKET = 'candidate-attachments';

/**
 * Upload attachment to Supabase Storage.
 * Path: /{candidateId_short}/{submissionId_short}/{filename}
 * Returns the public URL.
 */
export async function uploadAttachmentToStorage(
  db: ReturnType<typeof import('../persistence').getSupabaseAdminClient>,
  buffer: Buffer,
  filename: string,
  candidateId: string,
  submissionId: string
): Promise<{ filename: string; url: string; size: number }> {
  const candidateShort = candidateId.slice(0, 8);
  const submissionShort = submissionId.slice(0, 8);
  // Sanitize filename — keep only safe chars
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${candidateShort}/${submissionShort}/${safeName}`;

  const { error } = await db.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, buffer, {
      contentType: guessMimeType(safeName),
      upsert: true,
    });

  if (error) {
    console.error(`[Attachment] Upload failed for ${path}: ${error.message}`);
    throw error;
  }

  const { data: urlData } = db.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);

  return {
    filename,
    url: urlData.publicUrl,
    size: buffer.length,
  };
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    txt: 'text/plain',
  };
  return mimeMap[ext ?? ''] ?? 'application/octet-stream';
}
