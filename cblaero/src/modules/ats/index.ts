import { IngestionEnvelope } from '../ingestion';
export { fetchCeipalApplicants, mapCeipalApplicantToCandidate } from './ceipal';
export type { CeipalApplicant } from './ceipal';

export interface ATSConnector {
  name: string;
  poll(): Promise<ATSRecord[]>;
}

export interface ATSRecord {
  id: string;
  candidate: Record<string, unknown>;
  updatedAt: string;
}

export function createATSIngestionEnvelope(record: ATSRecord): IngestionEnvelope {
  return {
    source: 'ats',
    receivedAtIso: record.updatedAt,
  };
}
