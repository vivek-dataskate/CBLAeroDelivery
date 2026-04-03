"use client";

import React, { useEffect, useState, useCallback } from "react";

interface DailyUsageRow {
  date: string;
  model: string;
  promptName: string | null;
  promptVersion: string | null;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface UsageTotals {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface BudgetInfo {
  dailyCostUsd: number;
  threshold: number;
  exceeded: boolean;
}

interface AiUsageData {
  daily: DailyUsageRow[];
  totals: UsageTotals;
  budget: BudgetInfo;
}

export default function AiCostDashboard() {
  const [data, setData] = useState<AiUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/admin/ai-usage?days=${days}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      setData(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AI usage data");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  if (loading) {
    return (
      <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/65 p-6">
        <h2 className="text-lg font-semibold text-cyan-200">AI Cost Dashboard</h2>
        <p className="mt-2 text-sm text-slate-400">Loading usage data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-6 rounded-2xl border border-rose-300/20 bg-slate-950/65 p-6">
        <h2 className="text-lg font-semibold text-rose-300">AI Cost Dashboard</h2>
        <p className="mt-2 text-sm text-rose-200">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  // Group daily data by date for the bar chart
  const dateGroups = new Map<string, { models: Map<string, number>; total: number }>();
  for (const row of data.daily) {
    let group = dateGroups.get(row.date);
    if (!group) {
      group = { models: new Map(), total: 0 };
      dateGroups.set(row.date, group);
    }
    const prev = group.models.get(row.model) ?? 0;
    group.models.set(row.model, prev + row.estimatedCostUsd);
    group.total += row.estimatedCostUsd;
  }

  const maxDailyCost = Math.max(...[...dateGroups.values()].map((g) => g.total), 0.01);

  // Unique models for color coding
  const allModels = [...new Set(data.daily.map((r) => r.model))];
  const modelColors: Record<string, string> = {};
  const colorPalette = [
    "bg-cyan-500",
    "bg-violet-500",
    "bg-amber-500",
    "bg-emerald-500",
    "bg-rose-500",
  ];
  allModels.forEach((m, i) => {
    modelColors[m] = colorPalette[i % colorPalette.length];
  });

  // Per-prompt version comparison (AC 4)
  const promptVersionMap = new Map<
    string,
    { version: string; callCount: number; estimatedCostUsd: number; inputTokens: number; outputTokens: number }
  >();
  for (const row of data.daily) {
    const key = `${row.promptName ?? "unknown"}|${row.promptVersion ?? "?"}`;
    const entry = promptVersionMap.get(key) ?? {
      version: row.promptVersion ?? "?",
      callCount: 0,
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    entry.callCount += row.callCount;
    entry.estimatedCostUsd += row.estimatedCostUsd;
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    promptVersionMap.set(key, entry);
  }

  return (
    <div className="mt-6 space-y-4">
      {/* Header + controls */}
      <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-950/65 p-5">
        <h2 className="text-lg font-semibold text-cyan-200">AI Cost Dashboard</h2>
        <div className="flex gap-2">
          {[1, 7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                days === d
                  ? "border-cyan-200/70 bg-cyan-500/20 text-cyan-100"
                  : "border-white/20 text-slate-300 hover:border-cyan-200/50"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Budget alert */}
      {data.budget.exceeded && (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          Budget alert: Today&apos;s AI spend (${data.budget.dailyCostUsd.toFixed(2)}) exceeds threshold ($
          {data.budget.threshold.toFixed(2)}/day)
        </div>
      )}

      {/* Total spend summary */}
      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard label="Total Calls" value={data.totals.callCount.toLocaleString()} />
        <SummaryCard label="Input Tokens" value={data.totals.inputTokens.toLocaleString()} />
        <SummaryCard label="Output Tokens" value={data.totals.outputTokens.toLocaleString()} />
        <SummaryCard
          label="Est. Cost"
          value={`$${data.totals.estimatedCostUsd.toFixed(4)}`}
          highlight={data.budget.exceeded}
        />
      </div>

      {/* Daily cost bar chart (CSS-based, no chart library needed) */}
      <div className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
        <h3 className="mb-3 text-sm font-medium text-slate-300">Daily Cost by Model</h3>
        {dateGroups.size === 0 ? (
          <p className="text-sm text-slate-500">No usage data for this period.</p>
        ) : (
          <div className="space-y-2">
            {[...dateGroups.entries()].map(([date, group]) => (
              <div key={date} className="flex items-center gap-3">
                <span className="w-20 text-xs text-slate-400">{date.slice(5)}</span>
                <div className="flex flex-1 gap-0.5">
                  {allModels.map((model) => {
                    const cost = group.models.get(model) ?? 0;
                    if (cost === 0) return null;
                    const widthPct = Math.max((cost / maxDailyCost) * 100, 2);
                    return (
                      <div
                        key={model}
                        className={`${modelColors[model]} h-5 rounded-sm`}
                        style={{ width: `${widthPct}%` }}
                        title={`${model}: $${cost.toFixed(4)}`}
                      />
                    );
                  })}
                </div>
                <span className="w-20 text-right text-xs text-slate-400">
                  ${group.total.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Legend */}
        {allModels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-3">
            {allModels.map((model) => (
              <span key={model} className="flex items-center gap-1 text-xs text-slate-400">
                <span className={`${modelColors[model]} inline-block h-2.5 w-2.5 rounded-sm`} />
                {model.replace("claude-", "").replace("-20251001", "")}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Per-prompt version comparison (AC 4) */}
      {promptVersionMap.size > 0 && (
        <div className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
          <h3 className="mb-3 text-sm font-medium text-slate-300">
            Prompt Version Comparison
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead>
                <tr className="border-b border-white/10 text-slate-500">
                  <th className="pb-2 pr-4">Prompt</th>
                  <th className="pb-2 pr-4">Version</th>
                  <th className="pb-2 pr-4 text-right">Calls</th>
                  <th className="pb-2 pr-4 text-right">Input Tokens</th>
                  <th className="pb-2 pr-4 text-right">Output Tokens</th>
                  <th className="pb-2 text-right">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {[...promptVersionMap.entries()].map(([key, entry]) => {
                  const [promptName] = key.split("|");
                  return (
                    <tr key={key} className="border-b border-white/5">
                      <td className="py-1.5 pr-4 font-mono">{promptName}</td>
                      <td className="py-1.5 pr-4">
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-cyan-200">
                          {entry.version}
                        </span>
                      </td>
                      <td className="py-1.5 pr-4 text-right">{entry.callCount}</td>
                      <td className="py-1.5 pr-4 text-right">
                        {entry.inputTokens.toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        {entry.outputTokens.toLocaleString()}
                      </td>
                      <td className="py-1.5 text-right">
                        ${entry.estimatedCostUsd.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <article
      className={`rounded-2xl border p-4 ${
        highlight
          ? "border-amber-400/30 bg-amber-500/10"
          : "border-white/10 bg-slate-950/65"
      }`}
    >
      <p className="text-xs uppercase tracking-[0.15em] text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${highlight ? "text-amber-200" : "text-white"}`}>
        {value}
      </p>
    </article>
  );
}
