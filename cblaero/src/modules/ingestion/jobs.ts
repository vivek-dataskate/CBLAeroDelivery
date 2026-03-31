import { GreenhouseATSConnector, fetchCeipalApplicants, mapCeipalApplicantToCandidate } from '../ats';
import { MicrosoftGraphEmailParser } from '../email';
import { recordSyncFailure, upsertCandidateFromATS, upsertCandidateFromEmailFull } from './index';

export interface SchedulerJob {
  name: string;
  run(): Promise<void>;
}

export class ATSIngestionJob implements SchedulerJob {
  name = 'ATSIngestionJob';
  private connector = new GreenhouseATSConnector();

  async run() {
    try {
      const records = await this.connector.poll();
      for (const record of records) {
        try {
          await upsertCandidateFromATS(record.candidate);
        } catch (err) {
          recordSyncFailure('ats', record.id, err);
        }
      }
    } catch (err) {
      recordSyncFailure('ats', 'polling', err);
    }
  }
}

export class EmailIngestionJob implements SchedulerJob {
  name = 'EmailIngestionJob';
  private parser = new MicrosoftGraphEmailParser();
  // Configurable list of inbound email addresses — override via CBL_SUBMISSION_INBOXES env var (comma-separated)
  private get inboxAddresses(): string[] {
    const env = process.env.CBL_SUBMISSION_INBOXES;
    if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
    return ['submissions@cbl.aero'];
  }

  async run() {
    try {
      const records = await this.parser.parseInbox(this.inboxAddresses);
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
}

/**
 * Ceipal ATS ingestion — polls all applicants (or incremental since last run).
 * Set CEIPAL_API_KEY, CEIPAL_USERNAME, CEIPAL_PASSWORD, CEIPAL_ENDPOINT_KEY in Render.
 */
export class CeipalIngestionJob implements SchedulerJob {
  name = 'CeipalIngestionJob';

  async run(since?: Date) {
    try {
      const applicants = await fetchCeipalApplicants({ since });
      console.log(`[CeipalIngestionJob] Fetched ${applicants.length} applicants`);
      for (const applicant of applicants) {
        const id = applicant.email_address ?? `${applicant.first_name}-${applicant.last_name}`;
        try {
          await upsertCandidateFromATS(mapCeipalApplicantToCandidate(applicant));
        } catch (err) {
          recordSyncFailure('ceipal', id, err);
        }
      }
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
