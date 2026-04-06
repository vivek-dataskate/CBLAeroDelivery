import React from "react";
import type { SyncError } from "@/modules/ingestion";

type Props = {
  errors: SyncError[];
};

export default function SyncErrorStatusCard({ errors }: Props) {
  return (
    <div className="rounded bg-slate-800 p-4 mb-4">
      <h2 className="text-lg font-bold mb-2 text-rose-300">Ingestion Sync Errors</h2>
      {errors.length === 0 ? (
        <div className="text-slate-400">No sync errors reported.</div>
      ) : (
        <ul className="divide-y divide-slate-700">
          {errors.map((err) => (
            <li key={err.id} className="py-2">
              <div className="text-slate-200 font-mono text-xs mb-1">[{err.source}] {err.recordId}</div>
              <div className="text-rose-200">{err.message}</div>
              <div className="text-slate-500 text-xs">{err.timestamp?.replace('T', ' ')?.slice(0, 19) ?? 'unknown'} UTC</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
