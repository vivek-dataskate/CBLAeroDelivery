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

export default function DedupReviewDashboard() {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [stats, setStats] = useState<DedupStats | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedData, setExpandedData] = useState<{ review: ReviewItem; candidateA: CandidateProfile | null; candidateB: CandidateProfile | null } | null>(null);
  const [loading, setLoading] = useState(true);
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
    try {
      const res = await fetch(`/api/internal/dedup/reviews/${reviewId}`);
      if (res.ok) { const data = await res.json(); setExpandedData(data.data); }
    } catch { /* ignore */ }
  };

  const handleResolve = async (reviewId: number, decision: "approved" | "rejected") => {
    try {
      const res = await fetch(`/api/internal/dedup/reviews/${reviewId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (res.ok) {
        setReviews((prev) => prev.filter((r) => r.id !== reviewId));
        setExpandedId(null);
        fetchData();
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Action failed"); }
  };

  const handleBulkApprove = async () => {
    for (const id of [...selected]) { await handleResolve(id, "approved"); }
    setSelected(new Set());
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  if (loading) return <div className="min-h-screen bg-gray-50 p-8 text-gray-600 text-xs">Loading...</div>;

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-6 text-gray-800 md:px-8">
      <main className="mx-auto w-full max-w-5xl">

        {/* Header */}
        <header className="flex items-center justify-between border-b border-gray-200 pb-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-400">CBL Aero</p>
            <h1 className="mt-0.5 text-lg font-semibold text-gray-900">Dedup Review Queue</h1>
          </div>
          <Link href="/dashboard/admin" className="rounded-md border border-gray-300 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-100">
            Admin Console
          </Link>
        </header>

        {error && <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-600">{error}</div>}

        {/* Stats */}
        {stats && (
          <section className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
            {[
              { label: "Auto-Merged", value: stats.autoMerged, color: "text-green-600" },
              { label: "Manual Merged", value: stats.manualMerged, color: "text-blue-600" },
              { label: "Rejected", value: stats.manualRejected, color: "text-orange-600" },
              { label: "Kept Separate", value: stats.keptSeparate, color: "text-gray-500" },
              { label: "Pending", value: stats.pendingReview, color: "text-amber-600" },
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
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => {
                const highConf = reviews.filter((r) => r.confidenceScore >= 90).map((r) => r.id);
                setSelected(new Set(highConf));
              }}
              className="rounded border border-gray-300 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-100"
            >
              Select all &ge;90%
            </button>
            {selected.size > 0 && (
              <button onClick={handleBulkApprove} className="rounded bg-green-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-green-500">
                Approve {selected.size} selected
              </button>
            )}
          </div>
        )}

        {/* Review list */}
        {reviews.length === 0 ? (
          <p className="mt-6 text-center text-xs text-gray-400">No pending reviews.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {reviews.map((r) => (
              <div key={r.id} className="rounded-lg border border-gray-200 bg-white">
                <div className="flex items-center gap-2 px-3 py-2">
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} className="h-3 w-3" />
                  <button onClick={() => handleExpand(r.id)} className="flex flex-1 items-center justify-between text-left min-w-0">
                    <span className="text-[11px] font-medium text-gray-700">Review #{r.id}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400">{Object.keys(r.fieldDiffs).length} diffs</span>
                      <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${
                        r.confidenceScore >= 90 ? "bg-green-50 text-green-700 border border-green-200" :
                        r.confidenceScore >= 80 ? "bg-yellow-50 text-yellow-700 border border-yellow-200" :
                        "bg-orange-50 text-orange-700 border border-orange-200"
                      }`}>
                        {r.confidenceScore}%
                      </span>
                    </div>
                  </button>
                  <div className="flex gap-1 ml-2">
                    <button onClick={() => handleResolve(r.id, "approved")} className="rounded bg-green-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-green-500">Merge</button>
                    <button onClick={() => handleResolve(r.id, "rejected")} className="rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100">Reject</button>
                  </div>
                </div>

                {/* Expanded: side-by-side */}
                {expandedId === r.id && expandedData && (
                  <div className="border-t border-gray-100 px-3 py-3">
                    <div className="grid grid-cols-2 gap-3">
                      {[expandedData.candidateA, expandedData.candidateB].map((c, idx) => (
                        <div key={idx} className="rounded border border-gray-100 bg-gray-50 p-2.5">
                          <p className="mb-1.5 text-[10px] font-semibold text-gray-400">Candidate {idx === 0 ? "A" : "B"}</p>
                          {c ? (
                            <div className="space-y-0.5 text-[11px]">
                              <Row label="Name" value={`${c.firstName ?? ""} ${c.lastName ?? ""}`} />
                              <Row label="Email" value={c.email} />
                              <Row label="Phone" value={c.phone} />
                              <Row label="Job" value={c.jobTitle} />
                              <Row label="Location" value={c.location} />
                              <Row label="Skills" value={Array.isArray(c.skills) ? c.skills.slice(0, 3).join(", ") : null} />
                              <Row label="Source" value={c.source} />
                            </div>
                          ) : <p className="text-[10px] text-gray-400">Not found</p>}
                        </div>
                      ))}
                    </div>
                    {Object.keys(expandedData.review.fieldDiffs).length > 0 && (
                      <div className="mt-2">
                        <p className="mb-1 text-[10px] font-semibold text-amber-600">Differences</p>
                        <div className="space-y-0.5 text-[10px]">
                          {Object.entries(expandedData.review.fieldDiffs).map(([field, diff]) => (
                            <div key={field} className="flex gap-1">
                              <span className="w-20 text-gray-400">{field}</span>
                              <span className="text-red-500">{String(diff.a ?? "null")}</span>
                              <span className="text-gray-300">vs</span>
                              <span className="text-green-600">{String(diff.b ?? "null")}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-1.5">
      <span className="w-12 flex-shrink-0 text-gray-400">{label}</span>
      <span className="text-gray-700">{value || "—"}</span>
    </div>
  );
}
