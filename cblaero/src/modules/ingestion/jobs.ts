import { GreenhouseATSConnector } from '../ats';
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
  // Configurable list of inbound email addresses
  private inboxAddresses = [
    'submissions@cbl.aero',
    // Add more addresses as needed
  ];

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

export function registerIngestionJobs(scheduler: { register(job: SchedulerJob): void }) {
  scheduler.register(new ATSIngestionJob());
  scheduler.register(new EmailIngestionJob());
}

// Example stub for a global scheduler
export class GlobalScheduler {
  register(job: SchedulerJob) {
    // TODO: Integrate with real scheduling system (e.g., node-cron, BullMQ)
    console.log(`Registered job: ${job.name}`);
  }
}
