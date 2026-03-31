import { IngestionEnvelope } from '../ingestion';

export interface ATSConnector {
  name: string;
  poll(): Promise<ATSRecord[]>;
}

export interface ATSRecord {
  id: string;
  candidate: any; // Replace with actual candidate type
  updatedAt: string;
}

export class GreenhouseATSConnector implements ATSConnector {
  name = 'Greenhouse';

  async poll(): Promise<ATSRecord[]> {
    // Simulate Greenhouse API polling
    // In real implementation, replace with actual API call
    return [
      {
        id: 'gh-123',
        candidate: {
          name: 'Jane Doe',
          email: 'jane.doe@example.com',
        },
        updatedAt: new Date().toISOString(),
      },
    ];
  }
}

export function createATSIngestionEnvelope(record: ATSRecord): IngestionEnvelope {
  return {
    source: 'ats',
    receivedAtIso: record.updatedAt,
  };
}
