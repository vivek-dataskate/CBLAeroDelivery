import { fetchCeipalApplicants, mapCeipalApplicantToCandidate } from '../ats';
import { MicrosoftGraphEmailParser } from '../email';
import { acquireGraphToken } from '../email/graph-auth';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../persistence';
import { extractCandidateFromDocument } from '../../features/candidate-management/application/candidate-extraction';
import { recordSyncFailure, upsertCandidateFromEmailFull, batchUpsertCandidatesFromATS, DEFAULT_TENANT_ID } from './index';
import { fetchWithRetry } from './fetch-with-retry';
import {
  computeFileHash,
  isAlreadyProcessed,
  loadRecentFingerprints,
  recordFingerprint,
  recordFingerprintBatch,
} from '../../features/candidate-management/infrastructure/fingerprint-repository';
import {
  getLastCandidateUpdateBySource,
} from '../../features/candidate-management/infrastructure/candidate-repository';

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
      // Fingerprint gate: safety net for any emails that slip past the isRead filter
      const processedIds = await loadRecentFingerprints(DEFAULT_TENANT_ID, 'email_message_id', 3650);

      // Stream-process: each email is parsed → persisted → marked read one at a time.
      // This avoids OOM from holding 500 emails+attachments in memory.
      const { processed, skipped, failed } = await this.parser.processInbox(
        this.inboxAddresses,
        processedIds,
        async (record) => {
          const result = await upsertCandidateFromEmailFull(record);
          await recordFingerprint({ tenantId: DEFAULT_TENANT_ID, type: 'email_message_id', hash: record.id, source: 'email' });
          if (result === 'dedup_skip') {
            console.log(`[EmailIngestionJob] Dedup skip for ${record.subject}`);
          }
        },
      );

      console.log(`[EmailIngestionJob] Complete: ${processed} processed, ${skipped} skipped, ${failed} failed`);
    } catch (err) {
      recordSyncFailure('email', 'polling', err);
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

      // Explicit since param takes priority; fall back to DB-backed last update timestamp.
      // This ensures daily-sync works even without an explicit since param, and avoids
      // the stale instance-level lastRunAt problem on serverless cold starts.
      let since = params?.since;
      // Only skip incremental filter when an explicit non-default startPage is provided (resume scenario)
      if (!since && !(params?.startPage && params.startPage > 1)) {
        try {
          since = await getLastCandidateUpdateBySource('ceipal');
        } catch (err) {
          console.warn('[CeipalIngestionJob] Could not load last sync timestamp, performing full fetch:', err instanceof Error ? err.message : err);
        }
      }

      const applicants = await fetchCeipalApplicants({
        startPage,
        maxPages,
        since,
      });

      console.log(`[CeipalIngestionJob] Fetched ${applicants.length} applicants (page ${startPage}, maxPages ${maxPages}${since ? `, since ${since.toISOString()}` : ''})`);

      if (applicants.length === 0) return;

      const candidates = applicants.map(mapCeipalApplicantToCandidate);

      // Fingerprint gate: filter out already-processed applicants
      const knownFingerprints = await loadRecentFingerprints(DEFAULT_TENANT_ID, 'ats_external_id');
      const newCandidates = candidates.filter((c) => {
        const ceipalId = (c as Record<string, unknown>).ceipalId;
        if (!ceipalId) return true; // No stable ID — cannot fingerprint, fall through to upsert dedup
        const extId = `ceipal:${ceipalId}`;
        if (knownFingerprints.has(extId)) {
          console.log(JSON.stringify({ event: 'fingerprint_hit', type: 'ats_external_id', source: 'ceipal', tenantId: DEFAULT_TENANT_ID, hash: extId.slice(0, 12) }));
          return false;
        }
        return true;
      });

      if (newCandidates.length === 0) {
        console.log(`[CeipalIngestionJob] All ${candidates.length} applicants already fingerprinted — skipping`);
        return;
      }

      console.log(`[CeipalIngestionJob] ${newCandidates.length} new of ${candidates.length} total (${candidates.length - newCandidates.length} skipped via fingerprint)`);
      const { inserted, failed } = await batchUpsertCandidatesFromATS(newCandidates);

      // Record fingerprints in batch — only for candidates with stable ceipalId
      const fingerprintEntries = newCandidates
        .filter((c) => (c as Record<string, unknown>).ceipalId)
        .map((c) => ({
          tenantId: DEFAULT_TENANT_ID,
          type: 'ats_external_id' as const,
          hash: `ceipal:${(c as Record<string, unknown>).ceipalId}`,
          source: 'ceipal' as const,
        }));
      if (fingerprintEntries.length > 0) {
        try {
          await recordFingerprintBatch(fingerprintEntries);
          console.log(`[CeipalIngestionJob] Recorded ${fingerprintEntries.length} fingerprints`);
        } catch (fpErr) {
          console.error('[CeipalIngestionJob] Fingerprint batch recording failed:', fpErr instanceof Error ? fpErr.message : fpErr);
          recordSyncFailure('ceipal', 'fingerprint-batch', fpErr);
        }
      }

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
   try {
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
    const PARALLEL_CHUNK = 10;

    for (let start = 0; start < files.length; start += PARALLEL_CHUNK) {
      const chunk = files.slice(start, start + PARALLEL_CHUNK);

      const chunkResults = await Promise.all(
        chunk.map(async (file) => {
          try {
            const buffer = await this.downloadFile(file.downloadUrl);

            // Fingerprint gate: skip LLM extraction if this exact file was already processed
            const fileHash = computeFileHash(buffer);
            if (await isAlreadyProcessed(DEFAULT_TENANT_ID, 'file_sha256', fileHash)) {
              console.log(JSON.stringify({ event: 'fingerprint_hit', type: 'file_sha256', source: 'onedrive', tenantId: DEFAULT_TENANT_ID, hash: fileHash.slice(0, 12) }));
              await this.deleteFromOneDrive(token, file.id, file.name);
              return { status: 'skipped' as const, file };
            }

            // Store PDF in Supabase Storage (source of truth) before extraction
            let storageUrl = '';
            if (db && batchId) {
              const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
              const fileSubmissionId = crypto.randomUUID().slice(0, 8);
              const storagePath = `resume-uploads/cbl-aero/${batchId}/${fileSubmissionId}/${safeName}`;
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
              await recordFingerprint({ tenantId: DEFAULT_TENANT_ID, type: 'file_sha256', hash: fileHash, source: 'onedrive', status: 'failed' });
              recordSyncFailure('onedrive', file.name, result.error ?? 'Extraction returned no data');
              if (storageUrl) {
                await this.deleteFromOneDrive(token, file.id, file.name);
              } else {
                console.warn(`[OneDrivePoller] Keeping ${file.name} in OneDrive — storage backup failed`);
              }
              return { status: 'failed' as const, file };
            }

            const ext = result.extraction;
            await recordFingerprint({ tenantId: DEFAULT_TENANT_ID, type: 'file_sha256', hash: fileHash, source: 'onedrive' });
            console.log(`[OneDrivePoller] Processed ${file.name} → ${ext.firstName} ${ext.lastName}`);

            if (storageUrl) {
              await this.deleteFromOneDrive(token, file.id, file.name);
            } else {
              console.warn(`[OneDrivePoller] Keeping ${file.name} in OneDrive — no storage backup`);
            }

            return { status: 'ok' as const, file, extraction: ext };
          } catch (err) {
            recordSyncFailure('onedrive', file.name, err);
            return { status: 'failed' as const, file };
          }
        })
      );

      // Batch-persist successful extractions via single RPC call per chunk
      const successes = chunkResults.filter((r) => r.status === 'ok' && r.extraction);
      const chunkFailed = chunkResults.filter((r) => r.status === 'failed').length;
      failed += chunkFailed;

      if (db && batchId && successes.length > 0) {
        const candidateRows = successes.map((r, i) => {
          const ext = r.extraction!;
          const email = typeof ext.email === 'string' ? ext.email.trim().toLowerCase() : null;
          return {
            row_number: imported + i + 1,
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
            extra_attributes: {},
          };
        });

        const { error: rpcError } = await db.rpc('process_import_chunk', {
          p_batch_id: batchId,
          p_candidates: candidateRows,
          p_error_rows: [],
          p_total_imported: imported,
          p_total_skipped: 0,
          p_total_errors: failed,
        });

        if (rpcError) {
          console.error(`[OneDrivePoller] RPC failed for chunk:`, rpcError.message);
          failed += successes.length;
        } else {
          imported += successes.length;
        }
      } else {
        imported += successes.length;
      }

      console.log(`[OneDrivePoller] Chunk ${Math.floor(start / PARALLEL_CHUNK) + 1}: ${successes.length} ok, ${chunkFailed} failed`);
    }

    if (db && batchId) {
      await db
        .from('import_batch')
        .update({ status: 'complete', imported, errors: failed, completed_at: new Date().toISOString() })
        .eq('id', batchId);
    }

    // Clean up empty subfolders after processing
    await this.deleteEmptySubfolders(token);

    console.log(`[OneDrivePoller] Complete: ${imported} imported, ${failed} failed out of ${files.length} files`);
   } catch (err) {
    recordSyncFailure('onedrive', 'polling', err);
   }
  }

  /** Max files to process per cron invocation — keeps each run under Render's 5-min timeout */
  private static MAX_FILES_PER_RUN = 200;
  /** Graph API page size */
  private static PAGE_SIZE = 200;

  private async listPdfFiles(token: string): Promise<Array<{ id: string; name: string; size: number; downloadUrl: string }>> {
    type GraphItem = {
      id: string;
      name: string;
      size: number;
      file?: { mimeType: string };
      folder?: { childCount: number };
      '@microsoft.graph.downloadUrl'?: string;
    };

    const allPdfs: Array<{ id: string; name: string; size: number; downloadUrl: string }> = [];
    const user = encodeURIComponent(this.driveUser);

    // BFS queue of folder URLs to scan (starts with the configured root folder)
    const folderQueue: string[] = [
      `https://graph.microsoft.com/v1.0/users/${user}/drive/root:/${this.folderPath}:/children?$top=${OneDriveResumePollerJob.PAGE_SIZE}`,
    ];

    while (folderQueue.length > 0 && allPdfs.length < OneDriveResumePollerJob.MAX_FILES_PER_RUN) {
      let url: string | null = folderQueue.shift()!;

      // Paginate through all items in this folder
      while (url && allPdfs.length < OneDriveResumePollerJob.MAX_FILES_PER_RUN) {
        const response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });

        if (!response.ok) {
          const text = await response.text();
          console.warn(`[OneDrivePoller] Folder listing failed (${response.status}): ${text}`);
          break;
        }

        const data = await response.json() as {
          value: GraphItem[];
          '@odata.nextLink'?: string;
        };

        for (const item of data.value ?? []) {
          // Queue subfolders for recursive scanning
          if (item.folder) {
            folderQueue.push(
              `https://graph.microsoft.com/v1.0/users/${user}/drive/items/${item.id}/children?$top=${OneDriveResumePollerJob.PAGE_SIZE}`
            );
            continue;
          }

          if (item.file && item.name.toLowerCase().endsWith('.pdf') && item['@microsoft.graph.downloadUrl']) {
            allPdfs.push({
              id: item.id,
              name: item.name,
              size: item.size,
              downloadUrl: item['@microsoft.graph.downloadUrl'],
            });
          }
        }

        url = data['@odata.nextLink'] ?? null;
      }
    }

    if (allPdfs.length >= OneDriveResumePollerJob.MAX_FILES_PER_RUN) {
      console.log(`[OneDrivePoller] ${allPdfs.length} PDFs found, capping to ${OneDriveResumePollerJob.MAX_FILES_PER_RUN} for this run`);
      return allPdfs.slice(0, OneDriveResumePollerJob.MAX_FILES_PER_RUN);
    }

    return allPdfs;
  }

  private async downloadFile(downloadUrl: string): Promise<Buffer> {
    const response = await fetchWithRetry(downloadUrl);
    if (!response.ok) {
      throw new Error(`File download failed (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async deleteFromOneDrive(token: string, fileId: string, filename: string): Promise<void> {
    const user = encodeURIComponent(this.driveUser);
    const url = `https://graph.microsoft.com/v1.0/users/${user}/drive/items/${fileId}`;

    const response = await fetchWithRetry(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok || response.status === 204) {
      console.log(`[OneDrivePoller] Deleted ${filename} from OneDrive`);
    } else {
      console.warn(`[OneDrivePoller] Failed to delete ${filename} from OneDrive (${response.status})`);
    }
  }

  /**
   * Walk subfolders of the configured root and delete any that are empty.
   * Processes deepest folders first (reverse BFS) so parent folders become
   * empty after their children are removed.
   */
  private async deleteEmptySubfolders(token: string): Promise<void> {
    const user = encodeURIComponent(this.driveUser);
    const rootUrl = `https://graph.microsoft.com/v1.0/users/${user}/drive/root:/${this.folderPath}:/children?$top=${OneDriveResumePollerJob.PAGE_SIZE}`;

    type FolderEntry = { id: string; name: string };

    // BFS to collect all subfolder IDs (not the root itself)
    const folderQueue: string[] = [rootUrl];
    const allSubfolders: FolderEntry[] = [];

    while (folderQueue.length > 0) {
      const url = folderQueue.shift()!;
      const response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) continue;

      const data = await response.json() as {
        value: Array<{ id: string; name: string; folder?: { childCount: number } }>;
        '@odata.nextLink'?: string;
      };

      for (const item of data.value ?? []) {
        if (item.folder) {
          allSubfolders.push({ id: item.id, name: item.name });
          folderQueue.push(
            `https://graph.microsoft.com/v1.0/users/${user}/drive/items/${item.id}/children?$top=${OneDriveResumePollerJob.PAGE_SIZE}`
          );
        }
      }

      if (data['@odata.nextLink']) {
        folderQueue.push(data['@odata.nextLink']);
      }
    }

    if (allSubfolders.length === 0) return;

    // Delete deepest first (reverse order since BFS goes top-down)
    for (const folder of allSubfolders.reverse()) {
      // Check if folder is now empty
      const checkUrl = `https://graph.microsoft.com/v1.0/users/${user}/drive/items/${folder.id}/children?$top=1`;
      const checkRes = await fetchWithRetry(checkUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!checkRes.ok) continue;

      const checkData = await checkRes.json() as { value: unknown[] };
      if ((checkData.value ?? []).length > 0) continue;

      // Folder is empty — delete it
      const delUrl = `https://graph.microsoft.com/v1.0/users/${user}/drive/items/${folder.id}`;
      const delRes = await fetchWithRetry(delUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (delRes.ok || delRes.status === 204) {
        console.log(`[OneDrivePoller] Deleted empty subfolder: ${folder.name}`);
      } else {
        console.warn(`[OneDrivePoller] Failed to delete subfolder ${folder.name} (${delRes.status})`);
      }
    }
  }
}

export class SavedSearchDigestJob implements SchedulerJob {
  name = 'SavedSearchDigestJob';

  async run() {
    try {
      const { listDigestEnabledSearches } = await import(
        '../../features/candidate-management/infrastructure/saved-search-repository'
      );
      const { listCandidates } = await import(
        '../../features/candidate-management/infrastructure/candidate-repository'
      );
      const { acquireGraphToken: getToken } = await import('../email/graph-auth');
      const { fetchWithRetry: fetchRetry } = await import('./fetch-with-retry');

      const MAX_DIGESTS_PER_RUN = 100;
      const INTER_SEND_DELAY_MS = 500;
      const allSearches = await listDigestEnabledSearches();
      const searches = allSearches.slice(0, MAX_DIGESTS_PER_RUN);
      if (allSearches.length > MAX_DIGESTS_PER_RUN) {
        console.warn(`[SavedSearchDigestJob] ${allSearches.length} digests enabled; processing first ${MAX_DIGESTS_PER_RUN}`);
      }
      console.log(`[SavedSearchDigestJob] Processing ${searches.length} digest-enabled saved searches`);

      for (const search of searches) {
        try {
          const params = {
            tenantId: search.tenantId,
            ...(search.filters as Record<string, string | boolean | undefined>),
            limit: 5,
          };

          const result = await listCandidates(params as Parameters<typeof listCandidates>[0]);
          if (result.items.length === 0) {
            console.log(`[SavedSearchDigestJob] No candidates for "${search.name}" — skipping email`);
            continue;
          }

          const rows = result.items.map((c, i) => {
            const skills = Array.isArray(c.skills)
              ? c.skills.slice(0, 3).map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join(', ')
              : '';
            return `<tr>
              <td style="padding:6px;border:1px solid #e5e7eb">${i + 1}</td>
              <td style="padding:6px;border:1px solid #e5e7eb">${c.firstName ?? ''} ${c.lastName ?? ''}</td>
              <td style="padding:6px;border:1px solid #e5e7eb">${c.jobTitle ?? '—'}</td>
              <td style="padding:6px;border:1px solid #e5e7eb">${c.location ?? '—'}</td>
              <td style="padding:6px;border:1px solid #e5e7eb">${c.availabilityStatus}</td>
              <td style="padding:6px;border:1px solid #e5e7eb">${skills || '—'}</td>
            </tr>`;
          }).join('\n');

          const date = new Date().toISOString().slice(0, 10);
          const html = `
            <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
              <h2 style="color:#1f2937">CBL Aero Daily Digest: "${search.name}"</h2>
              <p style="color:#6b7280">Top ${result.items.length} candidates matching your saved search — ${date}</p>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead><tr style="background:#f9fafb">
                  <th style="padding:6px;border:1px solid #e5e7eb;text-align:left">#</th>
                  <th style="padding:6px;border:1px solid #e5e7eb;text-align:left">Name</th>
                  <th style="padding:6px;border:1px solid #e5e7eb;text-align:left">Job Title</th>
                  <th style="padding:6px;border:1px solid #e5e7eb;text-align:left">Location</th>
                  <th style="padding:6px;border:1px solid #e5e7eb;text-align:left">Availability</th>
                  <th style="padding:6px;border:1px solid #e5e7eb;text-align:left">Skills</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table>
              <p style="margin-top:16px;color:#9ca3af;font-size:12px">— CBL Aero Recruiting Platform</p>
            </div>`;

          // Send email via Microsoft Graph
          const token = await getToken();
          const senderAddress = process.env.CBL_DIGEST_SENDER ?? 'submissions-inbox@cblsolutions.com';
          const sendUrl = `https://graph.microsoft.com/v1.0/users/${senderAddress}/sendMail`;

          const sendResponse = await fetchRetry(sendUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                subject: `CBL Aero Daily Digest: "${search.name}" — ${date}`,
                body: { contentType: 'HTML', content: html },
                toRecipients: [{ emailAddress: { address: search.actorEmail } }],
              },
            }),
          });

          if (!sendResponse.ok && sendResponse.status !== 202) {
            const errText = await sendResponse.text().catch(() => '(no body)');
            throw new Error(`Graph sendMail failed (${sendResponse.status}): ${errText}`);
          }

          console.log(`[SavedSearchDigestJob] Sent digest for "${search.name}" to ${search.actorEmail}`);
          // Throttle between sends to avoid Graph API rate limits
          await new Promise((r) => setTimeout(r, INTER_SEND_DELAY_MS));
        } catch (err) {
          console.error(`[SavedSearchDigestJob] Failed for search "${search.name}":`, err);
          recordSyncFailure('saved_search_digest', search.id, err);
        }
      }
    } catch (err) {
      console.error('[SavedSearchDigestJob] Fatal error:', err);
    }
  }
}

export function registerIngestionJobs(scheduler: { register(job: SchedulerJob): void }) {
  scheduler.register(new CeipalIngestionJob());
  scheduler.register(new EmailIngestionJob());
  scheduler.register(new OneDriveResumePollerJob());
  scheduler.register(new SavedSearchDigestJob());
}

// GlobalScheduler stub removed — deferred to Story 2.7. Use registerIngestionJobs() with a real scheduler.
