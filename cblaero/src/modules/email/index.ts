import { acquireGraphToken } from './graph-auth';
import { extractCandidateFromEmail } from './nlp-extract-and-upload';
import { IngestionEnvelope } from '../ingestion';

export interface EmailParser {
  name: string;
  parseInbox(addresses: string[], processedIds?: Set<string>): Promise<EmailCandidateRecord[]>;
}

export interface EmailCandidateRecord {
  id: string;
  candidate: Record<string, unknown> & { firstName: string; lastName: string; email: string };
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

  async parseInbox(addresses: string[], processedIds?: Set<string>): Promise<EmailCandidateRecord[]> {
    const token = await acquireGraphToken();
    const allEmails: EmailCandidateRecord[] = [];

    for (const address of addresses) {
      const messages = await this.fetchMessages(token, address);
      for (const msg of messages) {
        // Skip already-processed messages — avoids wasting LLM calls
        if (processedIds?.has(msg.id)) continue;

        const attachments = msg.hasAttachments
          ? await this.fetchAttachments(token, address, msg.id)
          : [];
        const candidate = await extractCandidateFromEmail(msg.body.content, msg.subject ?? '');
        // Skip non-submission emails (internal chatter, FYIs, etc.)
        if (candidate.isSubmission === false) {
          console.log(`[EmailParser] Skipping non-submission: ${msg.subject ?? '(no subject)'}`);
          continue;
        }
        allEmails.push({
          id: msg.id,
          candidate: candidate as unknown as Record<string, unknown> & { firstName: string; lastName: string; email: string },
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
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments` +
      `?$select=id,name,contentBytes,@odata.type`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
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

export function createEmailIngestionEnvelope(record: EmailCandidateRecord): IngestionEnvelope {
  return {
    source: 'email',
    receivedAtIso: record.receivedAt,
  };
}
