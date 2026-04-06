import { acquireGraphToken } from './graph-auth';
import { extractCandidateFromEmail } from './nlp-extract-and-upload';
import { fetchWithRetry } from '../ingestion/fetch-with-retry';

export interface EmailParser {
  name: string;
  parseInbox(addresses: string[], processedIds?: Set<string>): Promise<EmailCandidateRecord[]>;
  /** Stream-process: fetch message list, call handler per email, avoid holding all in memory */
  processInbox(
    addresses: string[],
    processedIds: Set<string>,
    handler: (record: EmailCandidateRecord) => Promise<void>,
  ): Promise<{ processed: number; skipped: number; failed: number }>;
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
  // Cache folder ID per mailbox to avoid repeated lookups
  private processedFolderIds = new Map<string, string>();

  async parseInbox(addresses: string[], processedIds?: Set<string>): Promise<EmailCandidateRecord[]> {
    const token = await acquireGraphToken();
    const allEmails: EmailCandidateRecord[] = [];

    for (const address of addresses) {
      const messages = await this.fetchMessages(token, address);
      for (const msg of messages) {
        // Skip already-processed messages — fingerprint safety net
        if (processedIds?.has(msg.id)) {
          // Already processed but still unread (edge case) — mark read now
          await this.moveToProcessed(token, address, msg.id);
          continue;
        }

        // LLM classification FIRST — cheaper than fetching multi-MB attachment binaries
        const candidate = await extractCandidateFromEmail(msg.body.content, msg.subject ?? '');
        // Skip non-submission emails (treat undefined isSubmission as non-submission too)
        if (!candidate.isSubmission) {
          console.log(`[EmailParser] Skipping non-submission: ${msg.subject ?? '(no subject)'}`);
          await this.moveToProcessed(token, address, msg.id);
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

  /**
   * Stream-process inbox: fetch messages, then for each email:
   * LLM classify → fetch attachments → call handler (persist) → mark as read.
   * Processes one at a time to avoid OOM and allow incremental DB writes.
   */
  async processInbox(
    addresses: string[],
    processedIds: Set<string>,
    handler: (record: EmailCandidateRecord) => Promise<void>,
  ): Promise<{ processed: number; skipped: number; failed: number }> {
    const token = await acquireGraphToken();
    let processed = 0, skipped = 0, failed = 0;

    for (const address of addresses) {
      const messages = await this.fetchMessages(token, address);
      console.log(`[EmailParser] ${messages.length} unread messages in ${address}`);

      for (const msg of messages) {
        try {
          if (processedIds.has(msg.id)) {
            await this.moveToProcessed(token, address, msg.id);
            skipped++;
            continue;
          }

          const candidate = await extractCandidateFromEmail(msg.body.content, msg.subject ?? '');
          if (!candidate.isSubmission) {
            console.log(`[EmailParser] Skipping non-submission: ${msg.subject ?? '(no subject)'}`);
            await this.moveToProcessed(token, address, msg.id);
            skipped++;
            continue;
          }

          const attachments = await this.fetchAttachments(token, address, msg.id);
          const record: EmailCandidateRecord = {
            id: msg.id,
            mailbox: address,
            candidate: candidate as unknown as Record<string, unknown> & { firstName: string; lastName: string; email: string },
            receivedAt: msg.receivedDateTime,
            subject: msg.subject ?? '',
            body: msg.body.content,
            attachments,
          };

          await handler(record);
          await this.moveToProcessed(token, address, msg.id);
          processed++;
        } catch (err) {
          console.error(`[EmailParser] Failed to process ${msg.subject ?? msg.id}:`, err instanceof Error ? err.message : err);
          failed++;
          // Do NOT mark as read on failure — stays unread for retry
        }
      }
    }

    return { processed, skipped, failed };
  }

  /**
   * Move processed email to "Processed" subfolder. Also marks as read automatically.
   * Creates the folder on first use (cached per mailbox for the run).
   */
  /**
   * Mark as read + move to "Processed" subfolder.
   * Creates the folder on first use (cached per mailbox for the run).
   */
  async moveToProcessed(token: string, mailbox: string, messageId: string): Promise<void> {
    const userPath = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}`;
    try {
      // 1. Mark as read
      const patchUrl = `${userPath}/messages/${messageId}`;
      const patchResp = await fetchWithRetry(patchUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true }),
      });
      if (!patchResp.ok) {
        const errText = await patchResp.text().catch(() => '');
        console.warn(`[EmailParser] markAsRead FAILED (${patchResp.status}): ${errText.slice(0, 200)}`);
      }

      // 2. Move to Processed folder
      const folderId = await this.getOrCreateProcessedFolder(token, mailbox);
      const moveUrl = `${userPath}/messages/${messageId}/move`;
      const moveResp = await fetchWithRetry(moveUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationId: folderId }),
      });
      if (!moveResp.ok) {
        const errText = await moveResp.text().catch(() => '');
        console.warn(`[EmailParser] moveToProcessed FAILED (${moveResp.status}): ${errText.slice(0, 200)}`);
      } else {
        console.log(`[EmailParser] Moved to Processed: ${messageId.slice(-10)}`);
      }
    } catch (err) {
      console.error(`[EmailParser] moveToProcessed THREW for ${messageId.slice(-10)}:`, err instanceof Error ? err.message : err);
    }
  }

  private async getOrCreateProcessedFolder(token: string, mailbox: string): Promise<string> {
    // Return cached folder ID if we already resolved it this run
    const cached = this.processedFolderIds.get(mailbox);
    if (cached) return cached;

    const userPath = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}`;

    // Check if "Processed" folder exists under Inbox
    const listUrl = `${userPath}/mailFolders/Inbox/childFolders?$filter=displayName eq 'Processed'`;
    const listResp = await fetchWithRetry(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (listResp.ok) {
      const listData = await listResp.json() as { value: Array<{ id: string; displayName: string }> };
      if (listData.value?.length > 0) {
        const folderId = listData.value[0].id;
        this.processedFolderIds.set(mailbox, folderId);
        console.log(`[EmailParser] Found existing "Processed" folder for ${mailbox}`);
        return folderId;
      }
    }

    // Create the folder
    const createUrl = `${userPath}/mailFolders/Inbox/childFolders`;
    const createResp = await fetchWithRetry(createUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Processed' }),
    });

    if (!createResp.ok) {
      const errText = await createResp.text().catch(() => '');
      throw new Error(`Failed to create Processed folder (${createResp.status}): ${errText.slice(0, 200)}`);
    }

    const createData = await createResp.json() as { id: string };
    this.processedFolderIds.set(mailbox, createData.id);
    console.log(`[EmailParser] Created "Processed" folder for ${mailbox}`);
    return createData.id;
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
    const withContent = allAtts.filter((a) => a.contentBytes);
    if (allAtts.length > 0) {
      console.log(`[EmailParser] Message ${messageId.slice(-10)}: ${allAtts.length} attachments, ${withContent.length} with content (types: ${allAtts.map(a => a['@odata.type']).join(', ')})`);
    }
    return withContent.map((a) => ({
      filename: a.name,
      content: Buffer.from(a.contentBytes, 'base64'),
    }));
  }
}
