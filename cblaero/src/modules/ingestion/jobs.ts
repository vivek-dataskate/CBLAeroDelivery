import { fetchCeipalApplicants, mapCeipalApplicantToCandidate } from '../ats';
import { MicrosoftGraphEmailParser } from '../email';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../persistence';
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

  async run() {
    try {
      // Determine where to resume: count existing ceipal candidates → starting page
      const startPage = await this.getResumePage();
      console.log(`[CeipalIngestionJob] Resuming from page ${startPage}`);

      // Fetch 1 page (50 records) per run, upsert immediately
      const applicants = await fetchCeipalApplicants({ maxPages: 1, startPage });

      if (applicants.length === 0) {
        console.log(`[CeipalIngestionJob] No more records at page ${startPage} — initial load may be complete`);
        return;
      }

      console.log(`[CeipalIngestionJob] Fetched ${applicants.length} applicants from page ${startPage}`);
      const candidates = applicants.map(mapCeipalApplicantToCandidate);
      const { inserted, failed } = await batchUpsertCandidatesFromATS(candidates);
      console.log(`[CeipalIngestionJob] Page ${startPage}: ${inserted} upserted, ${failed} failed`);
    } catch (err) {
      recordSyncFailure('ceipal', 'polling', err);
    }
  }

  private async getResumePage(): Promise<number> {
    if (!isSupabaseConfigured()) return 1;
    try {
      const db = getSupabaseAdminClient();
      const { count } = await db
        .from('candidates')
        .select('id', { count: 'exact', head: true })
        .eq('source', 'ceipal');
      const existingCount = count ?? 0;
      return Math.floor(existingCount / 50) + 1;
    } catch {
      return 1;
    }
  }
}

export function registerIngestionJobs(scheduler: { register(job: SchedulerJob): void }) {
  scheduler.register(new CeipalIngestionJob());
  scheduler.register(new EmailIngestionJob());
}

// Example stub for a global scheduler
export class GlobalScheduler {
  register(job: SchedulerJob) {
    // TODO: Integrate with real scheduling system (e.g., node-cron, BullMQ)
    console.log(`Registered job: ${job.name}`);
  }
}
