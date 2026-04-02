import Anthropic from '@anthropic-ai/sdk';

/**
 * Unified candidate extraction service.
 *
 * Centralizes LLM-powered extraction from any unstructured content type
 * (PDF resumes, email bodies, email attachments). Each content type has
 * a pre-processor that normalizes to plain text before a shared LLM call.
 */

// ---- Shared Types ----

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
  employmentType?: string;
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

  // Tracks which extraction method was used
  extractionMethod?: 'llm' | 'regex';

  // Whether LLM classified this as a candidate submission email
  isSubmission?: boolean;
}

export type ContentType = 'pdf' | 'docx' | 'email_body' | 'email_attachment';

export interface ExtractionMetadata {
  source: string;
  tenantId: string;
  batchId?: string;
  subject?: string;
}

export interface ExtractionResult {
  extraction: CandidateExtraction | null;
  error?: string;
}

// ---- Prompt ----

export const EXTRACTION_PROMPT = `You are a candidate data extraction agent for a multi-business staffing company (CBL Solutions — includes CBL Aero, DataSkate, and other divisions).

You will receive text content from a document (resume, email, or attachment). Extract ALL candidate information into structured JSON.

For EMAIL content: First determine if it is a candidate submission email. A submission is ANY email where a recruiter is presenting a candidate for a job role — across ALL business units and industries (aviation, IT, legal, engineering, etc.). If it is NOT a submission (e.g. internal team allocation reports, FYI/status updates, calendar invites, newsletters, reply threads without candidate data, meeting notes, requirement allocation sheets), return:
{"isSubmission": false}

For RESUME/PDF content: Always treat as a candidate submission (isSubmission: true).

If it IS a candidate submission, extract ALL candidate information into structured JSON.

Return ONLY valid JSON matching this schema (omit fields that are not present):
{
  "isSubmission": true,
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
  "jobTitle": "string (the position/role being applied for or current role)",
  "client": "string (the client company, e.g. MHIRJ, AeroGuard)",
  "location": "string (job location or candidate location)",
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

// ---- LLM Client ----

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

export function _resetClientForTest(): void {
  anthropicClient = null;
}

// ---- Content Pre-processors ----

const MAX_CONTENT_LENGTH = 10_000;

// Lazy-loaded pdf-parse function — allows test injection via _setPdfParseForTest
let _pdfParseFn: ((buf: Buffer) => Promise<{ text: string }>) | null = null;

async function getPdfParse(): Promise<(buf: Buffer) => Promise<{ text: string }>> {
  if (_pdfParseFn) return _pdfParseFn;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _pdfParseFn = require('pdf-parse/lib/pdf-parse.js');
  return _pdfParseFn!;
}

export function _setPdfParseForTest(fn: ((buf: Buffer) => Promise<{ text: string }>) | null): void {
  _pdfParseFn = fn;
}

export async function preprocessPdf(content: Buffer): Promise<string> {
  const pdfParse = await getPdfParse();
  const result = await pdfParse(content);
  const text = (result.text as string).trim();
  if (!text) {
    throw new Error('This PDF appears to be a scanned image without extractable text');
  }
  return text.slice(0, MAX_CONTENT_LENGTH);
}

// Lazy-loaded mammoth function for docx extraction — allows test injection via _setDocxParseForTest
let _docxParseFn: ((buf: Buffer) => Promise<{ value: string }>) | null = null;

async function getDocxParse(): Promise<(buf: Buffer) => Promise<{ value: string }>> {
  if (_docxParseFn) return _docxParseFn;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require('mammoth');
  _docxParseFn = (buf: Buffer) => mammoth.extractRawText({ buffer: buf });
  return _docxParseFn!;
}

export function _setDocxParseForTest(fn: ((buf: Buffer) => Promise<{ value: string }>) | null): void {
  _docxParseFn = fn;
}

export async function preprocessDocx(content: Buffer): Promise<string> {
  const docxParse = await getDocxParse();
  const result = await docxParse(content);
  const text = (result.value as string).trim();
  if (!text) {
    throw new Error('This document appears to contain no extractable text');
  }
  return text.slice(0, MAX_CONTENT_LENGTH);
}

export function preprocessEmailBody(content: string, subject?: string): string {
  const plainBody = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (subject) {
    const prefix = `Subject: ${subject}\n\nEmail Body:\n`;
    return (prefix + plainBody).slice(0, MAX_CONTENT_LENGTH);
  }
  return plainBody.slice(0, MAX_CONTENT_LENGTH);
}

// ---- Core Extraction ----

export async function extractCandidateFromDocument(
  content: Buffer | string,
  contentType: ContentType,
  metadata: ExtractionMetadata
): Promise<ExtractionResult> {
  try {
    let plainText: string;
    switch (contentType) {
      case 'pdf':
        if (!(content instanceof Buffer)) {
          return { extraction: null, error: 'PDF content must be a Buffer' };
        }
        plainText = await preprocessPdf(content);
        break;
      case 'docx':
        if (!(content instanceof Buffer)) {
          return { extraction: null, error: 'DOCX content must be a Buffer' };
        }
        plainText = await preprocessDocx(content);
        break;
      case 'email_body':
        if (typeof content !== 'string') {
          return { extraction: null, error: 'Email body content must be a string' };
        }
        plainText = preprocessEmailBody(content, metadata.subject);
        break;
      case 'email_attachment':
        if (content instanceof Buffer) {
          plainText = await preprocessPdf(content);
        } else {
          plainText = String(content).slice(0, MAX_CONTENT_LENGTH);
        }
        break;
      default:
        return { extraction: null, error: `Unsupported content type: ${contentType}` };
    }

    const client = getAnthropicClient();
    if (client) {
      return await extractWithLLM(client, plainText, metadata.source, contentType);
    }

    if (contentType === 'email_body') {
      console.warn('[CandidateExtraction] ANTHROPIC_API_KEY not set — using regex fallback');
      return {
        extraction: extractWithRegex(typeof content === 'string' ? content : '', metadata.subject ?? '', metadata.source),
      };
    }

    return { extraction: null, error: 'ANTHROPIC_API_KEY not configured — cannot extract from PDF without LLM' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { extraction: null, error: message };
  }
}

const ALLOWED_EXTRACTION_KEYS = new Set([
  'isSubmission', 'firstName', 'lastName', 'middleName', 'email', 'phone',
  'address', 'city', 'state', 'zipCode', 'country',
  'jobTitle', 'client', 'location', 'employmentType', 'shiftPreference', 'expectedStartDate',
  'currentRate', 'perDiem',
  'skills', 'certifications', 'aircraftExperience', 'hasAPLicense', 'yearsOfExperience',
  'workAuthorization', 'clearance',
  'callAvailability', 'interviewAvailability',
  'ceipalId', 'submittedBy', 'submitterEmail',
  'additionalFields',
]);

function sanitizeLlmResponse(parsed: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (ALLOWED_EXTRACTION_KEYS.has(key)) {
      sanitized[key] = parsed[key];
    }
  }
  return sanitized;
}

async function extractWithLLM(
  client: Anthropic,
  plainText: string,
  source: string,
  contentType: ContentType
): Promise<ExtractionResult> {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: plainText }],
    system: EXTRACTION_PROMPT,
  });

  let responseText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  responseText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(responseText);

    if (contentType === 'email_body' && parsed.isSubmission === false) {
      return {
        extraction: {
          firstName: '', lastName: '', email: '', source,
          extractionMethod: 'llm' as const, isSubmission: false,
        },
      };
    }

    // Whitelist known CandidateExtraction keys to prevent LLM injection of internal fields
    const sanitized = sanitizeLlmResponse(parsed);

    return {
      extraction: {
        ...sanitized,
        source,
        extractionMethod: 'llm' as const,
        isSubmission: contentType === 'pdf' ? true : parsed.isSubmission ?? true,
      } as CandidateExtraction,
    };
  } catch {
    console.error('[CandidateExtraction] Failed to parse LLM response:', responseText.slice(0, 200));
    return { extraction: null, error: 'Failed to parse LLM extraction response' };
  }
}

function extractWithRegex(emailBody: string, subject: string, source: string): CandidateExtraction {
  const text = emailBody.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

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
    source,
    extractionMethod: 'regex',
  };
}
