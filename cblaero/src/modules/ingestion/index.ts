export type IngestionSource = "csv" | "ats" | "email";

export type IngestionEnvelope = {
  source: IngestionSource;
  receivedAtIso: string;
};

export function createIngestionEnvelope(source: IngestionSource): IngestionEnvelope {
  return {
    source,
    receivedAtIso: new Date().toISOString(),
  };
}
