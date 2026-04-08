"use client";

import Link from "next/link";
import { useState, useCallback } from "react";

type CandidateRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  city: string | null;
  state: string | null;
  availabilityStatus: string;
  jobTitle: string | null;
  skills: unknown[];
  yearsOfExperience: string | null;
  source: string;
  createdAt: string;
};

type SavedSearchItem = {
  id: string;
  name: string;
  filters: Record<string, string>;
  digestEnabled: boolean;
};

const AVAILABILITY_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  passive: "bg-yellow-100 text-yellow-700",
  unavailable: "bg-gray-100 text-gray-500",
};

const FILTER_LABELS: Record<string, string> = {
  search: "Name",
  job_title: "Job Title",
  skills: "Skills",
  city: "City",
  state: "State",
  availability_status: "Availability",
  source: "Source",
  work_authorization: "Work Auth",
  years_of_experience: "Min Experience",
  created_after: "Added After",
  created_before: "Added Before",
};

function AvailabilityBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${AVAILABILITY_BADGE[status] ?? "bg-gray-100 text-gray-500"}`}>
      {status}
    </span>
  );
}

function SkillsCell({ skills }: { skills: unknown[] }) {
  const labels = skills.slice(0, 3).map((s) => (typeof s === "string" ? s : String(s)));
  const extra = skills.length > 3 ? skills.length - 3 : 0;
  return (
    <span>
      {labels.join(", ")}
      {extra > 0 && <span className="text-gray-400"> +{extra}</span>}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

export default function CandidatesPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sortedBy, setSortedBy] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const [savedSearches, setSavedSearches] = useState<SavedSearchItem[]>([]);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [showSavedPanel, setShowSavedPanel] = useState(false);

  const hasActiveFilters = Object.values(filters).some((v) => v.length > 0);

  const setFilter = (key: string, value: string) => setFilters((p) => ({ ...p, [key]: value }));

  const fetchCandidates = useCallback(
    async (cursor?: string, overrideFilters?: Record<string, string>) => {
      setLoading(true);
      setError(null);
      try {
        const activeFilters = overrideFilters ?? filters;
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(activeFilters)) {
          if (v) params.set(k, v);
        }
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "500");

        const url = `/api/internal/candidates?${params.toString()}`;
        console.log("[CandidateSearch] Fetching:", url);
        console.log("[CandidateSearch] Active filters:", JSON.stringify(activeFilters));

        const res = await fetch(url);
        console.log("[CandidateSearch] Response status:", res.status);

        const json = await res.json();
        console.log("[CandidateSearch] Response body:", JSON.stringify(json).slice(0, 500));

        if (!res.ok) {
          console.error("[CandidateSearch] API error:", json.error);
          setError(json.error?.message ?? "Search failed.");
          return;
        }

        const items = json.data as CandidateRow[];
        console.log("[CandidateSearch] Got", items.length, "candidates, nextCursor:", json.meta?.nextCursor ? "yes" : "no");
        if (cursor) {
          setCandidates((prev) => [...prev, ...items]);
        } else {
          setCandidates(items);
          setCurrentPage(1);
        }
        setNextCursor(json.meta?.nextCursor ?? null);
        setSortedBy(json.meta?.sortedBy ?? "");
      } catch (err) {
        console.error("[CandidateSearch] Network/parse error:", err);
        setError("Network error. Please check your connection.");
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  const handleSearch = () => { if (hasActiveFilters) fetchCandidates(); };
  const handleClear = () => { setFilters({}); setCandidates([]); setNextCursor(null); setCurrentPage(1); setSortedBy(""); setError(null); };
  const handleLoadMore = () => { if (nextCursor) fetchCandidates(nextCursor); };

  // Saved searches
  const loadSavedSearches = useCallback(async () => {
    try {
      const res = await fetch("/api/internal/saved-searches");
      const json = await res.json();
      if (res.ok) setSavedSearches(json.data ?? []);
    } catch { /* ignore */ }
  }, []);

  const handleSaveSearch = async () => {
    if (!saveName.trim()) return;
    try {
      const activeFilters: Record<string, string> = {};
      for (const [k, v] of Object.entries(filters)) { if (v) activeFilters[k] = v; }
      const res = await fetch("/api/internal/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), filters: activeFilters }),
      });
      if (!res.ok) { setError("Failed to save search."); return; }
      setSaveName("");
      setShowSaveModal(false);
      loadSavedSearches();
    } catch { setError("Failed to save search."); }
  };

  const handleLoadSavedSearch = (search: SavedSearchItem) => {
    setFilters(search.filters);
    setShowSavedPanel(false);
    fetchCandidates(undefined, search.filters);
  };

  const handleToggleDigest = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/internal/saved-searches/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digestEnabled: !enabled }),
      });
      if (!res.ok) { setError("Failed to update digest."); return; }
      loadSavedSearches();
    } catch { setError("Failed to update digest."); }
  };

  const handleDeleteSaved = async (id: string) => {
    try {
      const res = await fetch(`/api/internal/saved-searches/${id}`, { method: "DELETE" });
      if (!res.ok) { setError("Failed to delete saved search."); return; }
      loadSavedSearches();
    } catch { setError("Failed to delete saved search."); }
  };

  const sortLabel = sortedBy === "relevance" ? "Best Match" : sortedBy === "created_at:desc" ? "Most Recent" : sortedBy || "";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white px-6 py-3 shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div>
            <p className="text-xs text-gray-400">
              <Link href="/dashboard" className="hover:text-emerald-600">Dashboard</Link>
              {" / "}
              <span className="font-medium text-gray-700">Candidates</span>
            </p>
            <h1 className="text-lg font-bold text-gray-900">Candidate Search</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setShowSavedPanel(!showSavedPanel); if (!showSavedPanel) loadSavedSearches(); }}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            >
              Saved Searches
            </button>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50">
                Sign Out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-4">
        {/* Saved searches panel */}
        {showSavedPanel && savedSearches.length > 0 && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Saved Searches</h3>
            <div className="space-y-2">
              {savedSearches.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => handleLoadSavedSearch(s)} className="text-sm font-medium text-emerald-600 hover:text-emerald-700">
                      {s.name}
                    </button>
                    <span className="text-xs text-gray-400">
                      {Object.entries(s.filters).map(([k, v]) => `${FILTER_LABELS[k] ?? k}: ${v}`).join(" | ")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => handleToggleDigest(s.id, s.digestEnabled)}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.digestEnabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-500"}`}>
                      {s.digestEnabled ? "Digest On" : "Digest Off"}
                    </button>
                    <button type="button" onClick={() => handleDeleteSaved(s.id)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {showSavedPanel && savedSearches.length === 0 && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 text-center text-sm text-gray-400 shadow-sm">
            No saved searches yet. Search for candidates and click &quot;Save Search&quot; to create one.
          </div>
        )}

        {/* Filter panel */}
        <form onSubmit={(e) => { e.preventDefault(); handleSearch(); }} className="mb-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          {/* Row 1: Quick search */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <label className="sm:col-span-2">
              <span className="text-xs font-medium text-gray-600">Search by Name</span>
              <input type="text" value={filters.search ?? ""} onChange={(e) => setFilter("search", e.target.value)}
                placeholder="e.g. John Smith"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">Job Title</span>
              <input type="text" value={filters.job_title ?? ""} onChange={(e) => setFilter("job_title", e.target.value)}
                placeholder="e.g. Mechanic"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">Skills</span>
              <input type="text" value={filters.skills ?? ""} onChange={(e) => setFilter("skills", e.target.value)}
                placeholder="e.g. Aviation, Welding"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
          </div>

          {/* Row 2: Location + Dropdowns */}
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6">
            <label>
              <span className="text-xs font-medium text-gray-600">City</span>
              <input type="text" value={filters.city ?? ""} onChange={(e) => setFilter("city", e.target.value)}
                placeholder="e.g. Houston"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">State</span>
              <input type="text" value={filters.state ?? ""} onChange={(e) => setFilter("state", e.target.value)}
                placeholder="e.g. TX"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">Availability</span>
              <select value={filters.availability_status ?? ""} onChange={(e) => setFilter("availability_status", e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500">
                <option value="">Any</option>
                <option value="active">Active</option>
                <option value="passive">Passive</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">Min Experience</span>
              <input type="number" min="0" value={filters.years_of_experience ?? ""} onChange={(e) => setFilter("years_of_experience", e.target.value)}
                placeholder="Years"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">Work Auth</span>
              <input type="text" value={filters.work_authorization ?? ""} onChange={(e) => setFilter("work_authorization", e.target.value)}
                placeholder="e.g. US Citizen"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">Source</span>
              <select value={filters.source ?? ""} onChange={(e) => setFilter("source", e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500">
                <option value="">Any</option>
                <option value="ceipal">Ceipal ATS</option>
                <option value="csv_upload">CSV Upload</option>
                <option value="email">Email</option>
                <option value="resume_upload">Resume Upload</option>
              </select>
            </label>
          </div>

          {/* Row 3: Date range + actions */}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label>
              <span className="text-xs font-medium text-gray-600">Added After</span>
              <input type="date" value={filters.created_after ?? ""} onChange={(e) => setFilter("created_after", e.target.value)}
                className="mt-1 block rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <label>
              <span className="text-xs font-medium text-gray-600">Added Before</span>
              <input type="date" value={filters.created_before ?? ""} onChange={(e) => setFilter("created_before", e.target.value)}
                className="mt-1 block rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </label>
            <div className="flex gap-2 pb-0.5">
              <button type="submit" disabled={!hasActiveFilters || loading}
                className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50">
                {loading ? "Searching..." : "Search"}
              </button>
              <button type="button" onClick={handleClear}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
                Clear
              </button>
              {hasActiveFilters && (
                <button type="button" onClick={() => setShowSaveModal(true)}
                  className="rounded-md border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50">
                  Save Search
                </button>
              )}
            </div>
          </div>

          {/* Active filter pills */}
          {hasActiveFilters && (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-100 pt-3">
              {Object.entries(filters).filter(([, v]) => v).map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                  {FILTER_LABELS[k] ?? k}: {v}
                  <button type="button" onClick={() => setFilter(k, "")} className="ml-0.5 text-emerald-400 hover:text-emerald-600">&times;</button>
                </span>
              ))}
            </div>
          )}
        </form>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Results */}
        {candidates.length > 0 && (() => {
          const totalLoaded = candidates.length;
          const totalPages = Math.ceil(totalLoaded / pageSize);
          const startIdx = (currentPage - 1) * pageSize;
          const pageRows = candidates.slice(startIdx, startIdx + pageSize);
          const isLastPage = currentPage >= totalPages;
          const canLoadMore = isLastPage && nextCursor;

          return (
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
              {/* Results header */}
              <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-700">
                    {totalLoaded} candidate{totalLoaded !== 1 ? "s" : ""} loaded
                  </span>
                  {sortLabel && <span className="text-xs text-gray-400">| Sorted by: {sortLabel}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Rows per page:</span>
                  <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700">
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/50">
                      <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Name</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Job Title</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Location</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Experience</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Skills</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Added</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {pageRows.map((c) => (
                      <tr key={c.id} onClick={() => window.open(`/dashboard/recruiter/candidates/${c.id}`, '_blank')}
                        className="cursor-pointer text-sm text-gray-700 transition-colors hover:bg-emerald-50/40">
                        <td className="px-5 py-2.5">
                          <div className="font-medium text-gray-900">{c.firstName} {c.lastName}</div>
                          <div className="text-xs text-gray-400">{c.email ?? "—"}</div>
                        </td>
                        <td className="px-4 py-2.5">{c.jobTitle ?? "—"}</td>
                        <td className="px-4 py-2.5">
                          {c.city || c.state
                            ? `${c.city ?? ""}${c.city && c.state ? ", " : ""}${c.state ?? ""}`
                            : "—"}
                        </td>
                        <td className="px-4 py-2.5"><AvailabilityBadge status={c.availabilityStatus} /></td>
                        <td className="px-4 py-2.5 text-xs">
                          {c.yearsOfExperience ? `${c.yearsOfExperience} yr${c.yearsOfExperience === "1" ? "" : "s"}` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-xs"><SkillsCell skills={c.skills ?? []} /></td>
                        <td className="px-4 py-2.5 text-xs text-gray-400">{formatDate(c.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination controls */}
              <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
                <span className="text-xs text-gray-400">
                  Showing {startIdx + 1}–{Math.min(startIdx + pageSize, totalLoaded)} of {totalLoaded}{nextCursor ? "+" : ""}
                </span>
                <div className="flex items-center gap-2">
                  {/* Page navigation */}
                  <button type="button" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}
                    className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-30">
                    Prev
                  </button>
                  {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                    let page: number;
                    if (totalPages <= 7) { page = i + 1; }
                    else if (currentPage <= 4) { page = i + 1; }
                    else if (currentPage >= totalPages - 3) { page = totalPages - 6 + i; }
                    else { page = currentPage - 3 + i; }
                    return (
                      <button key={page} type="button" onClick={() => setCurrentPage(page)}
                        className={`rounded px-2.5 py-1 text-xs font-medium ${page === currentPage ? "bg-emerald-600 text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
                        {page}
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}
                    className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-30">
                    Next
                  </button>
                  {/* Load more from DB */}
                  {canLoadMore && (
                    <button type="button" onClick={handleLoadMore} disabled={loading}
                      className="ml-2 rounded-md bg-emerald-600 px-4 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                      {loading ? "Loading..." : "Load 500 More"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Empty states */}
        {!loading && !error && candidates.length === 0 && hasActiveFilters && (
          <div className="rounded-lg border border-gray-200 bg-white py-16 text-center shadow-sm">
            <p className="text-gray-500">No candidates found matching your filters.</p>
            <p className="mt-1 text-sm text-gray-400">Try broadening your search criteria.</p>
          </div>
        )}

        {!hasActiveFilters && candidates.length === 0 && !loading && (
          <div className="rounded-lg border border-gray-200 bg-white py-16 text-center shadow-sm">
            <p className="text-lg font-medium text-gray-700">Search for Candidates</p>
            <p className="mt-1 text-sm text-gray-400">Use the filters above to find candidates by name, skills, location, or other criteria.</p>
          </div>
        )}
      </div>

      {/* Save search modal */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowSaveModal(false)}>
          <div className="w-96 rounded-xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900">Save This Search</h3>
            <p className="mt-1 text-xs text-gray-500">Give your search a name to quickly run it again later.</p>
            <input type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Houston A&P Mechanics"
              className="mt-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              autoFocus onKeyDown={(e) => { if (e.key === "Enter") handleSaveSearch(); }} />
            <p className="mt-2 text-xs text-gray-400">Daily email digest with top 5 matching candidates will be enabled by default.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setShowSaveModal(false)} className="rounded-md px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
              <button type="button" onClick={handleSaveSearch} disabled={!saveName.trim()}
                className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
