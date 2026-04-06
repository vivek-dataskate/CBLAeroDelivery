import { acquireGraphToken } from './graph-auth';
import { extractCandidateFromEmail } from './nlp-extract-and-upload';
import { fetchWithRetry } from '../ingestion/fetch-with-retry';

export interface EmailParser {
  name: string;
  parseInbox(addresses: string[], processedIds?: Set<string>): Promise<EmailCandidateRecord[]>;
}

export interface EmailCandidateRecord {
  id: string;
  mailbox: string;
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
        // Skip already-processed messages — fingerprint safety net
        if (processedIds?.has(msg.id)) {
          // Already processed but still unread (edge case) — mark read now
          await this.markAsRead(token, address, msg.id);
          continue;
        }

        // LLM classification FIRST — cheaper than fetching multi-MB attachment binaries
        const candidate = await extractCandidateFromEmail(msg.body.content, msg.subject ?? '');
        // Skip non-submission emails (treat undefined isSubmission as non-submission too)
        if (!candidate.isSubmission) {
          console.log(`[EmailParser] Skipping non-submission: ${msg.subject ?? '(no subject)'}`);
          await this.markAsRead(token, address, msg.id);
          continue;
        }

        // Always attempt attachment fetch — hasAttachments can be false on forwarded/CC'd emails
        const attachments = await this.fetchAttachments(token, address, msg.id);
        allEmails.push({
          id: msg.id,
          mailbox: address,
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

  async markAsRead(token: string, mailbox: string, messageId: string): Promise<void> {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`;
    const response = await fetchWithRetry(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });
    if (!response.ok) {
      console.warn(`[EmailParser] Failed to mark message ${messageId} as read (${response.status})`);
    }
  }

  private async fetchMessages(token: string, mailbox: string): Promise<GraphMessage[]> {
    const MAX_PAGES = 10; // Safety cap: 10 pages × 50 = 500 messages max
    let url: string | null = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages` +
      `?$top=50&$filter=isRead eq false&$select=id,subject,receivedDateTime,body,hasAttachments&$orderby=receivedDateTime desc`;

    const allMessages: GraphMessage[] = [];
    let page = 0;

    while (url && page < MAX_PAGES) {
      const response = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Graph messages fetch failed for ${mailbox} (${response.status}): ${text}`);
      }

      const data = await response.json() as { value: GraphMessage[]; '@odata.nextLink'?: string };
      allMessages.push(...(data.value ?? []));
      url = data['@odata.nextLink'] ?? null;
      page++;
    }

    if (url) {
      console.warn(`[EmailParser] MAX_PAGES (${MAX_PAGES}) reached for ${mailbox} — some messages may not have been processed`);
    }

    return allMessages;
  }

  private async fetchAttachments(
    token: string,
    mailbox: string,
    messageId: string
  ): Promise<Array<{ filename: string; content: Buffer }>> {
    // No $select — requesting contentBytes fails with 400 when itemAttachments are present
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments`;

    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.warn(`Graph attachments fetch failed for message ${messageId} (${response.status})`);
      return [];
    }

    const data = await response.json() as { value: GraphAttachment[] };
    const allAtts = data.value ?? [];
    const fileAtts = allAtts.filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes);
    if (allAtts.length > 0) {
      console.log(`[EmailParser] Message ${messageId}: ${allAtts.length} attachments total, ${fileAtts.length} file attachments (types: ${allAtts.map(a => a['@odata.type']).join(', ')})`);
    }
    return fileAtts.map((a) => ({
      filename: a.name,
      content: Buffer.from(a.contentBytes, 'base64'),
    }));
  }
}
