import Link from "next/link";

import { recordImportBatchAccessEvent } from "@/modules/audit";
import {
  getLatestMigrationBatch,
  type ImportBatch,
} from "@/features/candidate-management/infrastructure/import-batch-repository";

type MigrationStatusCardProps = {
  tenantId: string;
  actorId?: string;
  traceId?: string;
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

export default async function MigrationStatusCard({
  tenantId,
  actorId,
  traceId: parentTraceId,
}: MigrationStatusCardProps) {
  // Use parent page's traceId for correlation chain; fall back to component-level UUID
  const traceId = parentTraceId ?? crypto.randomUUID();

  // Audit BEFORE data fetch so access is recorded even if fetch fails
  if (actorId) {
    try {
      await recordImportBatchAccessEvent({
        traceId,
        actorId,
        tenantId,
        batchId: null,
        action: "list_import_batches",
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        module: "dashboard/admin/MigrationStatusCard",
        action: "audit_event_persist",
        traceId,
        actorId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  let batch: Awaited<ReturnType<typeof getLatestMigrationBatch>> = null;
  try {
    batch = await getLatestMigrationBatch(tenantId);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      module: "dashboard/admin/MigrationStatusCard",
      action: "fetch_latest_migration_batch",
      traceId,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
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
