import { fetchCeipalApplicants, mapCeipalApplicantToCandidate } from '../ats';
import { MicrosoftGraphEmailParser } from '../email';
import { acquireGraphToken } from '../email/graph-auth';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../persistence';
import { extractCandidateFromDocument } from '../../features/candidate-management/application/candidate-extraction';
import { recordSyncFailure, upsertCandidateFromATS, upsertCandidateFromEmailFull, batchUpsertCandidatesFromATS } from './index';

export interface SchedulerJob {
  name: string;
  run(): Promise<void>;
}

export class EmailIngestionJob implements SchedulerJob {
  name = 'EmailIngestionJob';
  private parser = new MicrosoftGraphEmailParser();
  private get inboxAddresses(): string[] {
    const env = process.env.CBL_SUBMISSION_INBOXES;
    if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
    return ['submissions-inbox@cblsolutions.com'];
  }

  async run() {
    try {
      // Load already-processed message IDs to skip LLM calls on re-runs
      const processedIds = await this.loadProcessedMessageIds();
      const records = await this.parser.parseInbox(this.inboxAddresses, processedIds);
      console.log(`[EmailIngestionJob] ${records.length} new emails to process (${processedIds.size} already processed)`);
      for (const record of records) {
        try {
          await upsertCandidateFromEmailFull(record);
        } catch (err) {
          recordSyncFailure('email', record.id, err);
        }
      }
    } catch (err) {
      recordSyncFailure('email', 'polling', err);
    }
  }

  private async loadProcessedMessageIds(): Promise<Set<string>> {
    if (!isSupabaseConfigured()) return new Set();
    try {
      const db = getSupabaseAdminClient();
      // Only load recent IDs — inbox fetch is $top=50 so older IDs won't match
      const { data } = await db
        .from('candidate_submissions')
        .select('email_message_id')
        .not('email_message_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500);
      return new Set((data ?? []).map((r: { email_message_id: string }) => r.email_message_id));
    } catch {
      return new Set();
    }
  }
}

/**
 * Ceipal ATS ingestion — polls all applicants (or incremental since last run).
 * Set CEIPAL_API_KEY, CEIPAL_USERNAME, CEIPAL_PASSWORD, CEIPAL_ENDPOINT_KEY in Render.
 */
export class CeipalIngestionJob implements SchedulerJob {
  name = 'CeipalIngestionJob';

  async run(params?: { startPage?: number; maxPages?: number; since?: Date }) {
    try {
      const startPage = params?.startPage ?? 1;
      const maxPages = params?.maxPages ?? 50;

      const applicants = await fetchCeipalApplicants({
        startPage,
        maxPages,
        since: params?.since,
      });

      console.log(`[CeipalIngestionJob] Fetched ${applicants.length} applicants (page ${startPage}, maxPages ${maxPages})`);

      if (applicants.length === 0) return;

      const candidates = applicants.map(mapCeipalApplicantToCandidate);
      const { inserted, failed } = await batchUpsertCandidatesFromATS(candidates);
      console.log(`[CeipalIngestionJob] ${inserted} upserted, ${failed} failed`);
    } catch (err) {
      recordSyncFailure('ceipal', 'polling', err);
    }
  }
}

/**
 * OneDrive resume poller — checks a configured OneDrive folder for new PDF files,
 * downloads them, extracts candidate data via LLM, and persists to the database.
 *
 * Env vars:
 *   CBL_ONEDRIVE_USER — mailbox/UPN owning the drive (default: vivek@cblsolutions.com)
 *   CBL_ONEDRIVE_RESUME_PATH — folder path relative to drive root (default: CBLAeroCons/Resumes)
 *
 * Uses the same Azure app registration as email ingestion (CBL_SSO_* credentials).
 * Requires Files.Read.All or Sites.Read.All application permission in Azure AD.
 */
export class OneDriveResumePollerJob implements SchedulerJob {
  name = 'OneDriveResumePollerJob';

  private get driveUser(): string {
    return process.env.CBL_ONEDRIVE_USER?.trim() || 'vivek@cblsolutions.com';
  }

  private get folderPath(): string {
    return process.env.CBL_ONEDRIVE_RESUME_PATH?.trim() || 'CBLAeroCons/Resumes';
  }

  async run() {
    const token = await acquireGraphToken();
    const files = await this.listPdfFiles(token);

    if (files.length === 0) {
      console.log('[OneDrivePoller] No PDF files found in folder');
      return;
    }

    // Load already-processed driveItem IDs
    const processedIds = await this.loadProcessedDriveItemIds();
    const newFiles = files.filter((f) => !processedIds.has(f.id));

    if (newFiles.length === 0) {
      console.log(`[OneDrivePoller] All ${files.length} files already processed`);
      return;
    }

    console.log(`[OneDrivePoller] ${newFiles.length} new files to process (${processedIds.size} already processed)`);

    // Create import batch
    const db = isSupabaseConfigured() ? getSupabaseAdminClient() : null;
    let batchId: string | null = null;

    if (db) {
      const { data: batchRow } = await db
        .from('import_batch')
        .insert({
          tenant_id: 'cbl-aero',
          source: 'resume_upload',
          status: 'processing',
          total_rows: newFiles.length,
        })
        .select('id')
        .single();
      batchId = batchRow ? String(batchRow.id) : null;
    }

    let imported = 0;
    let failed = 0;

    for (const file of newFiles) {
      try {
        const buffer = await this.downloadFile(token, file.downloadUrl);
        const result = await extractCandidateFromDocument(buffer, 'pdf', {
          source: 'resume_upload',
          tenantId: 'cbl-aero',
          batchId: batchId ?? undefined,
        });

        if (result.error || !result.extraction) {
          console.warn(`[OneDrivePoller] Extraction failed for ${file.name}: ${result.error}`);
          if (db) {
            await db.from('candidate_submissions').insert({
              id: crypto.randomUUID(),
              tenant_id: 'cbl-aero',
              source: 'resume_upload',
              import_batch_id: batchId,
              extracted_data: null,
              extraction_model: 'claude-haiku-4-5-20251001',
              attachments: [{ filename: file.name, driveItemId: file.id, size: file.size }],
            });
          }
          failed++;
          recordSyncFailure('onedrive', file.name, result.error ?? 'Extraction returned no data');
          continue;
        }

        // Persist candidate via RPC
        if (db && batchId) {
          const ext = result.extraction;
          const email = typeof ext.email === 'string' ? ext.email.trim().toLowerCase() : null;

          const candidateRow = {
            row_number: imported + failed + 1,
            raw_data: ext,
            tenant_id: 'cbl-aero',
            email,
            phone: ext.phone ?? null,
            first_name: ext.firstName ?? '',
            last_name: ext.lastName ?? '',
            middle_name: ext.middleName ?? null,
            home_phone: null,
            work_phone: null,
            location: ext.location ?? null,
            address: ext.address ?? null,
            city: ext.city ?? null,
            state: ext.state ?? null,
            country: ext.country ?? null,
            postal_code: ext.zipCode ?? null,
            current_company: ext.client ?? null,
            job_title: ext.jobTitle ?? null,
            alternate_email: null,
            skills: ext.skills ?? [],
            availability_status: 'active',
            ingestion_state: 'pending_enrichment',
            source: 'resume_upload',
            source_batch_id: batchId,
            resume_url: null,
            extra_attributes: {},
          };

          const { error: rpcError } = await db.rpc('process_import_chunk', {
            p_batch_id: batchId,
            p_candidates: [candidateRow],
            p_error_rows: [],
            p_total_imported: imported,
            p_total_skipped: 0,
            p_total_errors: failed,
          });

          if (rpcError) {
            console.error(`[OneDrivePoller] RPC failed for ${file.name}:`, rpcError.message);
            failed++;
            continue;
          }

          // Save submission record with driveItemId for dedup
          await db.from('candidate_submissions').insert({
            id: crypto.randomUUID(),
            tenant_id: 'cbl-aero',
            source: 'resume_upload',
            import_batch_id: batchId,
            extracted_data: ext,
            extraction_model: 'claude-haiku-4-5-20251001',
            attachments: [{ filename: file.name, driveItemId: file.id, size: file.size }],
          });
        }

        imported++;
        console.log(`[OneDrivePoller] Processed ${file.name} → ${result.extraction.firstName} ${result.extraction.lastName}`);
      } catch (err) {
        failed++;
        recordSyncFailure('onedrive', file.name, err);
      }
    }

    // Finalize batch
    if (db && batchId) {
      await db
        .from('import_batch')
        .update({ status: 'complete', imported, errors: failed, completed_at: new Date().toISOString() })
        .eq('id', batchId);
    }

    console.log(`[OneDrivePoller] Complete: ${imported} imported, ${failed} failed out of ${newFiles.length} new files`);
  }

  private async listPdfFiles(token: string): Promise<Array<{ id: string; name: string; size: number; downloadUrl: string }>> {
    const user = encodeURIComponent(this.driveUser);
    const path = this.folderPath;
    const url = `https://graph.microsoft.com/v1.0/users/${user}/drive/root:/${path}:/children` +
      `?$top=200`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OneDrive folder listing failed (${response.status}): ${text}`);
    }

    const data = await response.json() as {
      value: Array<{
        id: string;
        name: string;
        size: number;
        file?: { mimeType: string };
        '@microsoft.graph.downloadUrl'?: string;
      }>;
    };

    return (data.value ?? [])
      .filter((item) => item.file && item.name.toLowerCase().endsWith('.pdf'))
      .map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        downloadUrl: item['@microsoft.graph.downloadUrl'] ?? '',
      }))
      .filter((item) => item.downloadUrl);
  }

  private async downloadFile(token: string, downloadUrl: string): Promise<Buffer> {
    // The @microsoft.graph.downloadUrl is a pre-authenticated URL — no Bearer token needed
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`File download failed (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async loadProcessedDriveItemIds(): Promise<Set<string>> {
    if (!isSupabaseConfigured()) return new Set();
    try {
      const db = getSupabaseAdminClient();
      // Query submissions with source=resume_upload that have driveItemId in attachments
      const { data } = await db
        .from('candidate_submissions')
        .select('attachments')
        .eq('source', 'resume_upload')
        .not('attachments', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1000);

      const ids = new Set<string>();
      for (const row of data ?? []) {
        const attachments = Array.isArray(row.attachments) ? row.attachments : [];
        for (const att of attachments) {
          if (typeof att === 'object' && att !== null && 'driveItemId' in att) {
            ids.add(String((att as { driveItemId: string }).driveItemId));
          }
        }
      }
      return ids;
    } catch {
      return new Set();
    }
  }
}

export function registerIngestionJobs(scheduler: { register(job: SchedulerJob): void }) {
  scheduler.register(new CeipalIngestionJob());
  scheduler.register(new EmailIngestionJob());
  scheduler.register(new OneDriveResumePollerJob());
}

// Example stub for a global scheduler
export class GlobalScheduler {
  register(job: SchedulerJob) {
    // TODO: Integrate with real scheduling system (e.g., node-cron, BullMQ)
    console.log(`Registered job: ${job.name}`);
  }
}
