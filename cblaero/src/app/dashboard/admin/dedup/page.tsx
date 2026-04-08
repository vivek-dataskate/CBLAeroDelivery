"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

type ReviewItem = {
  id: number;
  candidateAId: string;
  candidateBId: string;
  confidenceScore: number;
  fieldDiffs: Record<string, { a: unknown; b: unknown }>;
  status: string;
  createdAt: string;
};

type DedupStats = {
  autoMerged: number;
  manualMerged: number;
  manualRejected: number;
  keptSeparate: number;
  pendingReview: number;
};

type CandidateProfile = {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  location: string | null;
  skills: string[];
  source: string | null;
  createdAt: string;
};

type ExpandedReview = {
  review: ReviewItem;
  candidateA: CandidateProfile | null;
  candidateB: CandidateProfile | null;
};

function candidateLabel(c: CandidateProfile | null): string {
  if (!c) return "Unknown";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return name || c.email || "Unknown";
}

export default function DedupReviewDashboard() {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [stats, setStats] = useState<DedupStats | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedCache, setExpandedCache] = useState<Map<number, ExpandedReview>>(new Map());
  const [loadingExpand, setLoadingExpand] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [reviewsRes, statsRes] = await Promise.all([
        fetch("/api/internal/dedup/reviews"),
        fetch("/api/internal/dedup/stats"),
      ]);
      if (reviewsRes.ok) { const r = await reviewsRes.json(); setReviews(r.data ?? []); }
      if (statsRes.ok) { const s = await statsRes.json(); setStats(s.data ?? null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleExpand = async (reviewId: number) => {
    if (expandedId === reviewId) { setExpandedId(null); return; }
    setExpandedId(reviewId);

    // Use cache if available
    if (expandedCache.has(reviewId)) return;

    setLoadingExpand(true);
    try {
      const res = await fetch(`/api/internal/dedup/reviews/${reviewId}`);
      if (res.ok) {
        const data = await res.json();
        setExpandedCache((prev) => new Map(prev).set(reviewId, data.data));
      }
    } catch { /* ignore */ }
    finally { setLoadingExpand(false); }
  };

  const handleResolve = async (reviewId: number, decision: "approved" | "rejected") => {
    const actionLabel = decision === "approved" ? "merge" : "keep separate";
    setActionLoading(reviewId);
    setError(null);
    try {
      const res = await fetch(`/api/internal/dedup/reviews/${reviewId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const json = await res.json();
        setError(json.error?.message ?? `Failed to ${actionLabel}`);
        return;
      }
      // Remove from list and clear expanded state
      setReviews((prev) => prev.filter((r) => r.id !== reviewId));
      if (expandedId === reviewId) setExpandedId(null);
      setExpandedCache((prev) => { const next = new Map(prev); next.delete(reviewId); return next; });
      // Refresh stats
      const statsRes = await fetch("/api/internal/dedup/stats");
      if (statsRes.ok) { const s = await statsRes.json(); setStats(s.data ?? null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : `${actionLabel} failed`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleBulkApprove = async () => {
    for (const id of [...selected]) { await handleResolve(id, "approved"); }
    setSelected(new Set());
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  // Build display label for each review from expanded cache or fieldDiffs
  function reviewLabel(r: ReviewItem): string {
    const cached = expandedCache.get(r.id);
    if (cached) {
      const nameA = candidateLabel(cached.candidateA);
      const nameB = candidateLabel(cached.candidateB);
      return `${nameA}  ↔  ${nameB}`;
    }
    // Fallback: show email or name from fieldDiffs if available
    const emailDiff = r.fieldDiffs.email;
    if (emailDiff) {
      return `${emailDiff.a ?? "?"} ↔ ${emailDiff.b ?? "?"}`;
    }
    const nameDiff = r.fieldDiffs.first_name;
    if (nameDiff) {
      return `${nameDiff.a ?? "?"} ↔ ${nameDiff.b ?? "?"}`;
    }
    return `Candidate A ↔ B`;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
          <p className="mt-3 text-sm text-gray-500">Loading review queue...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-6 text-gray-800 md:px-8">
      <main className="mx-auto w-full max-w-5xl">

        {/* Header */}
        <header className="flex items-center justify-between border-b border-gray-200 pb-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-400">CBL Aero</p>
            <h1 className="mt-0.5 text-lg font-semibold text-gray-900">Dedup Review Queue</h1>
          </div>
          <Link href="/dashboard" className="rounded-md border border-gray-300 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-100">
            Dashboard
          </Link>
        </header>

        {error && (
          <div className="mt-3 flex items-center justify-between rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-600">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
          </div>
        )}

        {/* Legend */}
        <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-800">
          <p className="font-semibold">How dedup review works:</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px]">
            <li><strong>Merge</strong> — These ARE the same person. Combine into one record, keeping the best data from each.</li>
            <li><strong>Keep Separate</strong> — These are NOT the same person. Mark both as active, no merge.</li>
          </ul>
        </div>

        {/* Stats */}
        {stats && (
          <section className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
            {[
              { label: "Auto-Merged", value: stats.autoMerged, color: "text-green-600" },
              { label: "Manual Merged", value: stats.manualMerged, color: "text-blue-600" },
              { label: "Kept Separate", value: stats.keptSeparate, color: "text-gray-500" },
              { label: "Rejected", value: stats.manualRejected, color: "text-orange-600" },
              { label: "Pending", value: stats.pendingReview, color: "text-amber-600 font-bold" },
            ].map(({ label, value, color }) => (
              <article key={label} className="rounded-lg border border-gray-200 bg-white p-3">
                <p className="text-[9px] uppercase tracking-wider text-gray-400">{label}</p>
                <p className={`mt-0.5 text-lg font-bold ${color}`}>{value}</p>
              </article>
            ))}
          </section>
        )}

        {/* Bulk actions */}
        {reviews.length > 0 && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
            <span className="text-[11px] text-gray-500">{reviews.length} pending review{reviews.length === 1 ? "" : "s"}</span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => {
                  const highConf = reviews.filter((r) => r.confidenceScore >= 90).map((r) => r.id);
                  setSelected(new Set(highConf));
                }}
                className="rounded border border-gray-300 px-2.5 py-1 text-[10px] text-gray-600 hover:bg-gray-100"
              >
                Select all &ge;90%
              </button>
              {selected.size > 0 && (
                <button onClick={handleBulkApprove} className="rounded bg-green-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-green-500">
                  Merge {selected.size} selected
                </button>
              )}
            </div>
          </div>
        )}

        {/* Review list */}
        {reviews.length === 0 ? (
          <div className="mt-8 rounded-lg border border-gray-200 bg-white py-12 text-center">
            <p className="text-sm text-gray-500">No pending reviews.</p>
            <p className="mt-1 text-xs text-gray-400">All duplicate candidates have been resolved.</p>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {reviews.map((r, idx) => {
              const isExpanded = expandedId === r.id;
              const cached = expandedCache.get(r.id);
              const isActioning = actionLoading === r.id;

              return (
                <div key={r.id} className={`rounded-lg border bg-white transition-shadow ${isExpanded ? "border-emerald-300 shadow-md" : "border-gray-200"}`}>
                  {/* Row header */}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} className="h-3.5 w-3.5 rounded border-gray-300" />

                    <span className="w-6 text-center text-[10px] font-bold text-gray-300">{idx + 1}</span>

                    <button onClick={() => handleExpand(r.id)} className="flex flex-1 items-center gap-3 text-left min-w-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-800">{reviewLabel(r)}</p>
                        <p className="mt-0.5 text-[10px] text-gray-400">
                          {Object.keys(r.fieldDiffs).length} field difference{Object.keys(r.fieldDiffs).length === 1 ? "" : "s"}
                          {" · "}
                          {new Date(r.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        r.confidenceScore >= 90 ? "bg-green-100 text-green-700" :
                        r.confidenceScore >= 80 ? "bg-yellow-100 text-yellow-700" :
                        "bg-orange-100 text-orange-700"
                      }`}>
                        {r.confidenceScore}%
                      </span>
                    </button>

                    <div className="flex gap-1.5 shrink-0 ml-2">
                      <button
                        onClick={() => handleResolve(r.id, "approved")}
                        disabled={isActioning}
                        className="rounded-md bg-green-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-green-500 disabled:opacity-50"
                      >
                        {isActioning ? "..." : "Merge"}
                      </button>
                      <button
                        onClick={() => handleResolve(r.id, "rejected")}
                        disabled={isActioning}
                        className="rounded-md border border-gray-300 px-3 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                      >
                        Keep Separate
                      </button>
                    </div>
                  </div>

                  {/* Expanded: side-by-side comparison */}
                  {isExpanded && (
                    <div className="border-t border-gray-100 px-4 py-4 bg-gray-50/50">
                      {loadingExpand && !cached ? (
                        <p className="py-4 text-center text-xs text-gray-400">Loading candidate details...</p>
                      ) : cached ? (
                        <>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {[
                              { label: "Candidate A", candidate: cached.candidateA, id: r.candidateAId },
                              { label: "Candidate B", candidate: cached.candidateB, id: r.candidateBId },
                            ].map(({ label, candidate: c, id }) => (
                              <div key={label} className="rounded-lg border border-gray-200 bg-white p-4">
                                <div className="mb-3 flex items-center justify-between">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</p>
                                  <a
                                    href={`/dashboard/recruiter/candidates/${id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[10px] font-medium text-emerald-600 hover:text-emerald-700"
                                  >
                                    View Profile →
                                  </a>
                                </div>
                                {c ? (
                                  <dl className="space-y-1.5 text-[12px]">
                                    <FieldRow label="Name" value={`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()} />
                                    <FieldRow label="Email" value={c.email} />
                                    <FieldRow label="Phone" value={c.phone} />
                                    <FieldRow label="Job Title" value={c.jobTitle} />
                                    <FieldRow label="Location" value={c.location} />
                                    <FieldRow label="Source" value={c.source} />
                                    <FieldRow label="Added" value={new Date(c.createdAt).toLocaleDateString()} />
                                    {Array.isArray(c.skills) && c.skills.length > 0 && (
                                      <div>
                                        <dt className="text-[10px] text-gray-400">Skills</dt>
                                        <dd className="mt-0.5 flex flex-wrap gap-1">
                                          {c.skills.slice(0, 5).map((s, i) => (
                                            <span key={i} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{s}</span>
                                          ))}
                                          {c.skills.length > 5 && <span className="text-[10px] text-gray-400">+{c.skills.length - 5} more</span>}
                                        </dd>
                                      </div>
                                    )}
                                  </dl>
                                ) : <p className="text-xs text-gray-400">Candidate not found</p>}
                              </div>
                            ))}
                          </div>

                          {/* Field differences */}
                          {Object.keys(cached.review.fieldDiffs).length > 0 && (
                            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-amber-700">Field Differences</p>
                              <div className="space-y-1">
                                {Object.entries(cached.review.fieldDiffs).map(([field, diff]) => (
                                  <div key={field} className="flex items-baseline gap-2 text-[11px]">
                                    <span className="w-24 shrink-0 font-medium text-gray-500">{field}</span>
                                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">{String(diff.a ?? "—")}</span>
                                    <span className="text-gray-300">→</span>
                                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700">{String(diff.b ?? "—")}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="py-4 text-center text-xs text-gray-400">Failed to load details. Click to retry.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-[10px] text-gray-400">{label}</dt>
      <dd className="text-gray-700">{value}</dd>
    </div>
  );
}
