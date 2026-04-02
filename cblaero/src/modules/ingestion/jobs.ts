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
 * Requires Files.ReadWrite.All application permission in Azure AD.
 *
 * Dedup: files are deleted from OneDrive after successful processing.
 * Supabase Storage is the source of truth — the PDF is stored there before deletion.
 * OneDrive folder acts as an inbox: any file present = unprocessed.
 */
export class OneDriveResumePollerJob implements SchedulerJob {
  name = 'OneDriveResumePollerJob';
  private static ATTACHMENT_BUCKET = 'candidate-attachments';

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

    console.log(`[OneDrivePoller] ${files.length} PDF files to process`);

    const db = isSupabaseConfigured() ? getSupabaseAdminClient() : null;
    let batchId: string | null = null;

    if (db) {
      const { data: batchRow, error: batchErr } = await db
        .from('import_batch')
        .insert({
          tenant_id: 'cbl-aero',
          source: 'resume_upload',
          status: 'processing',
          total_rows: files.length,
        })
        .select('id')
        .single();

      if (batchErr) {
        console.error('[OneDrivePoller] Failed to create import batch:', batchErr.message);
      }
      batchId = batchRow ? String(batchRow.id) : null;
    }

    let imported = 0;
    let failed = 0;

    for (const file of files) {
      try {
        const buffer = await this.downloadFile(file.downloadUrl);

        // Store PDF in Supabase Storage (source of truth) before extraction
        let storageUrl = '';
        if (db && batchId) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storagePath = `resume-uploads/cbl-aero/${batchId}/${safeName}`;
          const { error: uploadErr } = await db.storage
            .from(OneDriveResumePollerJob.ATTACHMENT_BUCKET)
            .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });

          if (uploadErr) {
            console.warn(`[OneDrivePoller] Storage upload failed for ${file.name}:`, uploadErr.message);
          } else {
            const { data: urlData } = db.storage
              .from(OneDriveResumePollerJob.ATTACHMENT_BUCKET)
              .getPublicUrl(storagePath);
            storageUrl = urlData.publicUrl;
          }
        }

        const result = await extractCandidateFromDocument(buffer, 'pdf', {
          source: 'resume_upload',
          tenantId: 'cbl-aero',
          batchId: batchId ?? undefined,
        });

        if (result.error || !result.extraction) {
          console.warn(`[OneDrivePoller] Extraction failed for ${file.name}: ${result.error}`);
          failed++;
          recordSyncFailure('onedrive', file.name, result.error ?? 'Extraction returned no data');
          // Delete from OneDrive even on failure — PDF is safe in Supabase Storage
          await this.deleteFromOneDrive(token, file.id, file.name);
          continue;
        }

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
            resume_url: storageUrl || null,
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

          // Save submission evidence
          const { error: subErr } = await db.from('candidate_submissions').insert({
            id: crypto.randomUUID(),
            tenant_id: 'cbl-aero',
            source: 'resume_upload',
            extracted_data: ext,
            extraction_model: 'claude-haiku-4-5-20251001',
            attachments: [{ filename: file.name, url: storageUrl, size: file.size }],
          });

          if (subErr) {
            console.warn(`[OneDrivePoller] Submission insert failed for ${file.name}:`, subErr.message);
          }
        }

        imported++;
        console.log(`[OneDrivePoller] Processed ${file.name} → ${result.extraction.firstName} ${result.extraction.lastName}`);

        // Delete from OneDrive — Supabase Storage is now source of truth
        await this.deleteFromOneDrive(token, file.id, file.name);
      } catch (err) {
        failed++;
        recordSyncFailure('onedrive', file.name, err);
      }
    }

    if (db && batchId) {
      await db
        .from('import_batch')
        .update({ status: 'complete', imported, errors: failed, completed_at: new Date().toISOString() })
        .eq('id', batchId);
    }

    console.log(`[OneDrivePoller] Complete: ${imported} imported, ${failed} failed out of ${files.length} files`);
  }

  private async listPdfFiles(token: string): Promise<Array<{ id: string; name: string; size: number; downloadUrl: string }>> {
    const user = encodeURIComponent(this.driveUser);
    const path = this.folderPath;
    const url = `https://graph.microsoft.com/v1.0/users/${user}/drive/root:/${path}:/children?$top=200`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

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

  private async downloadFile(downloadUrl: string): Promise<Buffer> {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`File download failed (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async deleteFromOneDrive(token: string, fileId: string, filename: string): Promise<void> {
    const user = encodeURIComponent(this.driveUser);
    const url = `https://graph.microsoft.com/v1.0/users/${user}/drive/items/${fileId}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok || response.status === 204) {
      console.log(`[OneDrivePoller] Deleted ${filename} from OneDrive`);
    } else {
      console.warn(`[OneDrivePoller] Failed to delete ${filename} from OneDrive (${response.status})`);
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
