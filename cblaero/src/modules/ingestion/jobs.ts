import { fetchCeipalApplicants, mapCeipalApplicantToCandidate } from '../ats';
import { MicrosoftGraphEmailParser } from '../email';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../persistence';
import { recordSyncFailure, upsertCandidateFromATS, upsertCandidateFromEmailFull } from './index';

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
  private lastRunAt: Date | undefined;

  async run() {
    try {
      const applicants = await fetchCeipalApplicants({ since: this.lastRunAt });
      console.log(`[CeipalIngestionJob] Fetched ${applicants.length} applicants`);
      for (const applicant of applicants) {
        const id = applicant.email_address ?? `${applicant.first_name}-${applicant.last_name}`;
        try {
          await upsertCandidateFromATS(mapCeipalApplicantToCandidate(applicant));
        } catch (err) {
          recordSyncFailure('ceipal', id, err);
        }
      }
      this.lastRunAt = new Date();
    } catch (err) {
      recordSyncFailure('ceipal', 'polling', err);
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
