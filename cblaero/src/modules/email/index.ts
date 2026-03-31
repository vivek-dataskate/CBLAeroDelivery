import { acquireGraphToken } from './graph-auth';
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

type GraphMessage = {
  id: string;
  subject: string;
  receivedDateTime: string;
  body: { content: string; contentType: string };
  hasAttachments: boolean;
};

type GraphAttachment = {
  id: string;
  name: string;
  contentBytes: string; // base64
  '@odata.type': string;
};

export class MicrosoftGraphEmailParser implements EmailParser {
  name = 'MicrosoftGraph';

  async parseInbox(addresses: string[]): Promise<EmailCandidateRecord[]> {
    const token = await acquireGraphToken();
    const allEmails: EmailCandidateRecord[] = [];

    for (const address of addresses) {
      const messages = await this.fetchMessages(token, address);
      for (const msg of messages) {
        const attachments = msg.hasAttachments
          ? await this.fetchAttachments(token, address, msg.id)
          : [];
        const candidate = parseCandidateFromBody(msg.body.content);
        allEmails.push({
          id: msg.id,
          candidate,
          receivedAt: msg.receivedDateTime,
          subject: msg.subject ?? '',
          body: msg.body.content,
          attachments,
        });
      }
    }

    return allEmails;
  }

  private async fetchMessages(token: string, mailbox: string): Promise<GraphMessage[]> {
    // Fetch last 50 unread messages from the shared mailbox
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages` +
      `?$top=50&$select=id,subject,receivedDateTime,body,hasAttachments&$orderby=receivedDateTime desc`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph messages fetch failed for ${mailbox} (${response.status}): ${text}`);
    }

    const data = await response.json() as { value: GraphMessage[] };
    return data.value ?? [];
  }

  private async fetchAttachments(
    token: string,
    mailbox: string,
    messageId: string
  ): Promise<Array<{ filename: string; content: Buffer }>> {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments` +
      `?$select=id,name,contentBytes,@odata.type`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      // Non-fatal — log and continue without attachments
      console.warn(`Graph attachments fetch failed for message ${messageId} (${response.status})`);
      return [];
    }

    const data = await response.json() as { value: GraphAttachment[] };
    return (data.value ?? [])
      .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment')
      .map((a) => ({
        filename: a.name,
        content: Buffer.from(a.contentBytes, 'base64'),
      }));
  }
}

function parseCandidateFromBody(body: string): Record<string, unknown> {
  // Strip HTML tags for plain-text parsing
  const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const firstNameMatch = text.match(/First\s*Name[:\s]+([^\n<]+)/i);
  const lastNameMatch = text.match(/Last\s*Name[:\s]+([^\n<]+)/i);
  const nameMatch = text.match(/(?:^|[\n\r])Name[:\s]+([^\n<]+)/im);
  const emailMatch = text.match(/Email[:\s]+([^\s<\n]+@[^\s<\n]+)/i);
  const phoneMatch = text.match(/(?:Phone|Mobile|Cell)[:\s]+([\d\s\-\(\)\.+]{7,20})/i);

  return {
    firstName: firstNameMatch?.[1]?.trim() ?? '',
    lastName: lastNameMatch?.[1]?.trim() ?? '',
    // Fall back to splitting a single Name field if first/last not found
    ...((!firstNameMatch && nameMatch) ? splitName(nameMatch[1].trim()) : {}),
    email: emailMatch?.[1]?.trim() ?? '',
    phone: phoneMatch?.[1]?.trim() ?? '',
  };
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' ') ?? '',
  };
}

export function createEmailIngestionEnvelope(record: EmailCandidateRecord): IngestionEnvelope {
  return {
    source: 'email',
    receivedAtIso: record.receivedAt,
  };
}
