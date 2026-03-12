export type AuditEnvelope = {
  traceId: string;
  actorId: string | null;
  tenantId: string | null;
};

export function createAuditEnvelope(traceId: string): AuditEnvelope {
  return {
    traceId,
    actorId: null,
    tenantId: null,
  };
}
