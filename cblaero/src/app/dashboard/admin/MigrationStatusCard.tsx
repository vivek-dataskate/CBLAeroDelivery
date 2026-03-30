import Link from "next/link";

import { getSupabaseAdminClient, shouldUseInMemoryPersistenceForTests } from "@/modules/persistence";
import { recordImportBatchAccessEvent } from "@/modules/audit";

type MigrationStatusCardProps = {
  tenantId: string;
  actorId?: string;
};

type ImportBatchSummary = {
  id: string;
  source: string;
  status: string;
  totalRows: number;
  imported: number;
  errors: number;
  startedAt: string;
  completedAt: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  validating: "Validating",
  complete: "Complete",
  paused_on_error_threshold: "Paused — error threshold exceeded",
  rolled_back: "Rolled back",
};

const STATUS_COLORS: Record<string, string> = {
  running: "text-cyan-300",
  validating: "text-slate-300",
  complete: "text-emerald-300",
  paused_on_error_threshold: "text-amber-300",
  rolled_back: "text-slate-400",
};

function progressPercent(imported: number, totalRows: number): number {
  if (totalRows <= 0) return 0;
  return Math.min(100, Math.round((imported / totalRows) * 100));
}

function formatElapsedMs(startedAt: string, completedAt: string | null): string {
  const startedMs = Number(new Date(startedAt));
  if (!Number.isFinite(startedMs)) {
    return "N/A";
  }

  const endMs = completedAt ? Number(new Date(completedAt)) : Date.now();
  if (!Number.isFinite(endMs) || endMs < startedMs) {
    return "N/A";
  }

  const elapsedSec = Math.floor((endMs - startedMs) / 1000);
  const hours = Math.floor(elapsedSec / 3600);
  const minutes = Math.floor((elapsedSec % 3600) / 60);
  const seconds = elapsedSec % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

async function fetchLatestMigrationBatch(tenantId: string): Promise<ImportBatchSummary | null> {
  if (shouldUseInMemoryPersistenceForTests()) {
    return null;
  }

  const client = getSupabaseAdminClient();
  const { data } = await client
    .from("import_batch")
    .select("id, source, status, total_rows, imported, errors, started_at, completed_at")
    .eq("tenant_id", tenantId)
    .eq("source", "migration")
    .order("started_at", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0];
  return {
    id: row.id as string,
    source: row.source as string,
    status: row.status as string,
    totalRows: row.total_rows as number,
    imported: row.imported as number,
    errors: row.errors as number,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | null,
  };
}

export default async function MigrationStatusCard({
  tenantId,
  actorId,
}: MigrationStatusCardProps) {
  const batch = await fetchLatestMigrationBatch(tenantId);

  if (actorId) {
    const traceId = crypto.randomUUID();
    try {
      await recordImportBatchAccessEvent({
        traceId,
        actorId,
        tenantId,
        batchId: batch?.id ?? null,
        action: "list_import_batches",
      });
    } catch (error) {
      console.error("[dashboard/admin] failed to persist audit event; rendering page anyway", {
        traceId,
        actorId,
        tenantId,
        batchId: batch?.id ?? null,
        error,
      });
    }
  }

  if (!batch) {
    return (
      <section className="mt-8 rounded-2xl border border-white/10 bg-slate-950/65 p-5">
        <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Initial Migration</p>
        <p className="mt-2 text-sm text-slate-400">No migration data available.</p>
        <p className="mt-1 text-xs text-slate-500">
          The system is awaiting initial data import. Please contact your administrator if this message persists.
        </p>
      </section>
    );
  }

  const pct = progressPercent(batch.imported, batch.totalRows);
  const statusLabel = STATUS_LABELS[batch.status] ?? batch.status;
  const statusColor = STATUS_COLORS[batch.status] ?? "text-slate-300";
  const elapsedLabel = formatElapsedMs(batch.startedAt, batch.completedAt);

  return (
    <section className="mt-8 rounded-2xl border border-white/10 bg-slate-950/65 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Initial Migration</p>
        {/* Links to the JSON API detail endpoint — intentional for MVP.
            Replace href with a dedicated UI route when a batch detail page is built. */}
        <Link
          href={`/api/internal/admin/import-batches/${batch.id}`}
          className="text-xs text-cyan-300 hover:text-cyan-200"
        >
          View detail →
        </Link>
      </div>

      <p className={`mt-2 text-sm font-medium ${statusColor}`}>{statusLabel}</p>

      <div className="mt-3 h-2 w-full rounded-full bg-slate-800">
        <div
          className="h-2 rounded-full bg-cyan-500 transition-all"
          style={{ width: `${pct}%` }}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-400">
        <span>
          <span className="text-white">{batch.imported.toLocaleString()}</span> imported
        </span>
        <span>
          <span className="text-white">{batch.totalRows.toLocaleString()}</span> total
        </span>
        {batch.errors > 0 && (
          <span>
            <span className="text-amber-300">{batch.errors.toLocaleString()}</span> errors
          </span>
        )}
        <span>
          <span className="text-white">{elapsedLabel}</span> elapsed
        </span>
        <span className="ml-auto text-slate-500">Batch {batch.id.slice(0, 8)}…</span>
      </div>
    </section>
  );
}
