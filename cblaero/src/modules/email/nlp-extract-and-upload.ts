// Pluggable NLP-based candidate extraction and OneDrive upload integration
// TODO: Install @microsoft/microsoft-graph-client and isomorphic-fetch when wiring up real Graph auth

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
  _accessToken: string,
  _buffer: Buffer,
  _filename: string,
  _inbox: string,
  _emailIdOrDate: string
): Promise<string> {
  // TODO: Implement using @microsoft/microsoft-graph-client once package is installed
  // Uses Client.init with authProvider, uploads to /CBLAeroAttachments/{inbox}/{emailId}/{filename}
  throw new Error("uploadAttachmentToOneDrive not yet implemented");
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
