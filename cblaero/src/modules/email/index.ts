import { IngestionEnvelope } from '../ingestion';

export interface EmailParser {
  name: string;
  parseInbox(addresses: string[]): Promise<EmailCandidateRecord[]>;
}

export interface EmailCandidateRecord {
  id: string;
  candidate: Record<string, unknown>;
  receivedAt: string;
  subject: string;
  body: string;
  attachments: Array<{ filename: string; content: Buffer }>;
}

export class MicrosoftGraphEmailParser implements EmailParser {
  name = 'MicrosoftGraph';

  // Accepts a list of inbox addresses to check
  async parseInbox(addresses: string[]): Promise<EmailCandidateRecord[]> {
    // TODO: Use admin tenant login to authenticate with Microsoft Graph
    // For each address, fetch all emails (simulate for now)
    const allEmails: EmailCandidateRecord[] = [];
    for (const address of addresses) {
      // Simulate fetching all emails for the address
      const mockMail = {
        id: `mail-${address}-001`,
        subject: `Candidate Submission for ${address}`,
        body: 'Name: John Smith\nEmail: john.smith@example.com',
        receivedAt: new Date().toISOString(),
        attachments: [
          { filename: 'resume.pdf', content: Buffer.from('PDFDATA') },
        ],
      };
      const candidate = this.parseCandidateFromMailBody(mockMail.body);
      allEmails.push({
        id: mockMail.id,
        candidate,
        receivedAt: mockMail.receivedAt,
        subject: mockMail.subject,
        body: mockMail.body,
        attachments: mockMail.attachments,
      });
    }
    return allEmails;
  }

  private parseCandidateFromMailBody(body: string): Record<string, unknown> {
    // Very basic parsing for demonstration
    const nameMatch = body.match(/Name: ([^\n]+)/);
    const emailMatch = body.match(/Email: ([^\n]+)/);
    return {
      name: nameMatch ? nameMatch[1] : '',
      email: emailMatch ? emailMatch[1] : '',
    };
  }
}

export function createEmailIngestionEnvelope(record: EmailCandidateRecord): IngestionEnvelope {
  return {
    source: 'email',
    receivedAtIso: record.receivedAt,
  };
}
