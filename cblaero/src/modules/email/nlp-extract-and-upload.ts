// Pluggable NLP-based candidate extraction and OneDrive upload integration
import { Client } from "@microsoft/microsoft-graph-client";
import "isomorphic-fetch";

export interface Candidate {
  firstName: string;
  lastName: string;
  email: string;
  [key: string]: any;
}

export interface AttachmentMeta {
  filename: string;
  url: string;
}

export async function extractCandidateFromEmailBody(body: string): Promise<Candidate> {
  // TODO: Replace with real NLP/ML extraction (spaCy, Azure, etc.)
  // Placeholder: naive regex for demonstration
  const firstName = (body.match(/First Name: ([^\n]+)/i)?.[1] || "").trim();
  const lastName = (body.match(/Last Name: ([^\n]+)/i)?.[1] || "").trim();
  const email = (body.match(/Email: ([^\n]+)/i)?.[1] || "").trim();
  return { firstName, lastName, email };
}

export async function uploadAttachmentToOneDrive(
  accessToken: string,
  buffer: Buffer,
  filename: string,
  inbox: string,
  emailIdOrDate: string
): Promise<string> {
  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  });
  // Organize by inbox and email
  const safeInbox = inbox.replace(/[^a-zA-Z0-9@.]/g, '_');
  const safeEmailId = emailIdOrDate.replace(/[^a-zA-Z0-9-_]/g, '_');
  const folder = `/CBLAeroAttachments/${safeInbox}/${safeEmailId}`;
  const uploadPath = `${folder}/${filename}`;
  const response = await client.api(`/me/drive/root:${uploadPath}:/content`).put(buffer);
  return response['webUrl'] as string;
}

export async function processEmailRecord(
  accessToken: string,
  record: {
    id: string;
    subject: string;
    body: string;
    attachments: Array<{ filename: string; content: Buffer }>;
    receivedAt: string;
    inbox: string;
  },
  saveToDb: (candidate: Candidate, attachments: AttachmentMeta[], meta: any) => Promise<void>
) {
  // 1. Extract candidate details
  const candidate = await extractCandidateFromEmailBody(record.body);
  // 2. Upload attachments to OneDrive, organized by inbox and email
  const attachmentLinks: AttachmentMeta[] = [];
  for (const att of record.attachments) {
    const url = await uploadAttachmentToOneDrive(
      accessToken,
      att.content,
      att.filename,
      record.inbox,
      record.id || record.receivedAt
    );
    attachmentLinks.push({ filename: att.filename, url });
  }
  // 3. Save candidate and attachment links to DB
  await saveToDb(candidate, attachmentLinks, {
    emailId: record.id,
    subject: record.subject,
    receivedAt: record.receivedAt,
    inbox: record.inbox,
  });
}
