"use client";

import Link from "next/link";
import { useState, useCallback } from "react";

type CandidateRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  location: string | null;
  availabilityStatus: string;
  jobTitle: string | null;
  skills: unknown[];
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

function AvailabilityBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${AVAILABILITY_BADGE[status] ?? "bg-gray-100 text-gray-500"}`}
    >
      {status}
    </span>
  );
}

function SkillsCell({ skills }: { skills: unknown[] }) {
  const labels = skills
    .slice(0, 3)
    .map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
  const extra = skills.length > 3 ? skills.length - 3 : 0;
  return (
    <span>
      {labels.join(", ")}
      {extra > 0 && <span className="text-gray-400"> +{extra} more</span>}
    </span>
  );
}

export default function CandidatesPage() {
  // Filter state
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sortedBy, setSortedBy] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [totalShown, setTotalShown] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Saved searches
  const [savedSearches, setSavedSearches] = useState<SavedSearchItem[]>([]);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [showSavedPanel, setShowSavedPanel] = useState(false);

  const filterFields = [
    { key: "availability_status", label: "Availability", type: "select", options: ["active", "passive", "unavailable"] },
    { key: "employment_type", label: "Employment", type: "select", options: ["full-time", "contract", "part-time"] },
    { key: "source", label: "Source", type: "select", options: ["csv", "email", "ceipal", "resume_upload"] },
    { key: "location", label: "Location", type: "text" },
    { key: "job_title", label: "Job Title", type: "text" },
    { key: "skills", label: "Skills", type: "text" },
    { key: "search", label: "Name", type: "text" },
    { key: "city", label: "City", type: "text" },
    { key: "state", label: "State", type: "text" },
    { key: "work_authorization", label: "Work Auth", type: "text" },
    { key: "years_of_experience", label: "Min YoE", type: "text" },
  ];

  const hasActiveFilters = Object.values(filters).some((v) => v.length > 0);

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
        params.set("limit", "25");

        const res = await fetch(`/api/internal/candidates?${params.toString()}`);
        const json = await res.json();

        if (!res.ok) {
          setError(json.error?.message ?? "Search failed. Please try again.");
          return;
        }

        const items = json.data as CandidateRow[];
        if (cursor) {
          setCandidates((prev) => [...prev, ...items]);
          setTotalShown((prev) => prev + items.length);
        } else {
          setCandidates(items);
          setTotalShown(items.length);
        }
        setNextCursor(json.meta?.nextCursor ?? null);
        setSortedBy(json.meta?.sortedBy ?? "");
      } catch {
        setError("Network error. Please check your connection.");
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  const handleSearch = () => {
    if (!hasActiveFilters) return;
    fetchCandidates();
  };

  const handleClear = () => {
    setFilters({});
    setCandidates([]);
    setNextCursor(null);
    setTotalShown(0);
    setSortedBy("");
  };

  const handleLoadMore = () => {
    if (nextCursor) fetchCandidates(nextCursor);
  };

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
      for (const [k, v] of Object.entries(filters)) {
        if (v) activeFilters[k] = v;
      }
      await fetch("/api/internal/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), filters: activeFilters }),
      });
      setSaveName("");
      setShowSaveModal(false);
      loadSavedSearches();
    } catch { /* ignore */ }
  };

  const handleLoadSavedSearch = (search: SavedSearchItem) => {
    setFilters(search.filters);
    setShowSavedPanel(false);
    // Fetch directly with the saved filters (avoids stale state from setFilters)
    fetchCandidates(undefined, search.filters);
  };

  const handleToggleDigest = async (id: string, enabled: boolean) => {
    await fetch(`/api/internal/saved-searches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digestEnabled: !enabled }),
    });
    loadSavedSearches();
  };

  const handleDeleteSaved = async (id: string) => {
    await fetch(`/api/internal/saved-searches/${id}`, { method: "DELETE" });
    loadSavedSearches();
  };

  const sortLabel =
    sortedBy === "relevance"
      ? "Best Match"
      : sortedBy === "created_at:desc"
        ? "Most Recent"
        : sortedBy || "—";

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white px-6 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div>
            <p className="text-xs text-gray-500">
              <Link href="/dashboard" className="hover:text-emerald-600">
                Dashboard
              </Link>
              {" / "}
              <span className="text-gray-900">Candidates</span>
            </p>
            <h1 className="mt-1 text-lg font-semibold text-gray-900">Candidates</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setShowSavedPanel(!showSavedPanel);
                if (!showSavedPanel) loadSavedSearches();
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Saved Searches
            </button>
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Sign Out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl">
        {/* Saved searches panel */}
        {showSavedPanel && (
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">Saved Searches</h3>
            {savedSearches.length === 0 ? (
              <p className="mt-2 text-xs text-gray-400">No saved searches yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {savedSearches.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 text-xs">
                    <button
                      type="button"
                      onClick={() => handleLoadSavedSearch(s)}
                      className="font-medium text-emerald-600 hover:text-emerald-700"
                    >
                      {s.name}
                    </button>
                    <span className="text-gray-400">
                      {Object.entries(s.filters)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ")}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleToggleDigest(s.id, s.digestEnabled)}
                      className={`rounded px-2 py-0.5 ${s.digestEnabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}
                    >
                      {s.digestEnabled ? "Digest ON" : "Digest OFF"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteSaved(s.id)}
                      className="text-red-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Filter bar */}
        <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
          <div className="flex flex-wrap items-end gap-3">
            {filterFields.map((f) =>
              f.type === "select" ? (
                <label key={f.key} className="text-xs text-gray-600">
                  {f.label}
                  <select
                    value={filters[f.key] ?? ""}
                    onChange={(e) => setFilters((p) => ({ ...p, [f.key]: e.target.value }))}
                    className="mt-0.5 block w-28 rounded border border-gray-300 px-2 py-1 text-xs text-gray-900"
                  >
                    <option value="">All</option>
                    {f.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label key={f.key} className="text-xs text-gray-600">
                  {f.label}
                  <input
                    type="text"
                    value={filters[f.key] ?? ""}
                    onChange={(e) => setFilters((p) => ({ ...p, [f.key]: e.target.value }))}
                    placeholder={f.label}
                    className="mt-0.5 block w-28 rounded border border-gray-300 px-2 py-1 text-xs text-gray-900 placeholder:text-gray-400"
                  />
                </label>
              ),
            )}
            <button
              type="button"
              onClick={handleSearch}
              disabled={!hasActiveFilters || loading}
              className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {loading ? "Loading…" : "Search"}
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="rounded px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900"
            >
              Clear
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => setShowSaveModal(true)}
                className="rounded border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
              >
                Save Search
              </button>
            )}
          </div>

          {/* Active filter pills */}
          {hasActiveFilters && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(filters)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                  >
                    {k}={v}
                    <button
                      type="button"
                      onClick={() => setFilters((p) => ({ ...p, [k]: "" }))}
                      className="ml-0.5 text-emerald-400 hover:text-emerald-600"
                    >
                      ×
                    </button>
                  </span>
                ))}
            </div>
          )}
        </div>

        {/* Sort indicator */}
        {sortedBy && (
          <div className="border-b border-gray-100 px-6 py-2">
            <span className="text-xs text-gray-500">Sorted by: {sortLabel}</span>
          </div>
        )}

        {/* Results table */}
        {candidates.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-6 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    First Name
                  </th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Last Name
                  </th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Availability
                  </th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Email
                  </th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Location
                  </th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Job Role
                  </th>
                  <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Skills
                  </th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer border-b border-gray-100 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <td className="px-6 py-2">{c.firstName}</td>
                    <td className="px-4 py-2">{c.lastName}</td>
                    <td className="px-4 py-2">
                      <AvailabilityBadge status={c.availabilityStatus} />
                    </td>
                    <td className="px-4 py-2 text-xs">{c.email ?? "—"}</td>
                    <td className="px-4 py-2">{c.location ?? "—"}</td>
                    <td className="px-4 py-2">{c.jobTitle ?? "—"}</td>
                    <td className="px-4 py-2 text-xs">
                      <SkillsCell skills={c.skills ?? []} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && candidates.length === 0 && hasActiveFilters && (
          <div className="px-6 py-12 text-center text-sm text-gray-400">
            No candidates found. Try adjusting your filters.
          </div>
        )}

        {!hasActiveFilters && candidates.length === 0 && (
          <div className="px-6 py-12 text-center text-sm text-gray-400">
            Apply at least one filter to search candidates.
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center justify-between px-6 py-4">
          <span className="text-sm text-gray-500">
            {totalShown > 0 ? `Showing ${totalShown} candidates` : ""}
          </span>
          {nextCursor && (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loading}
              className="rounded bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
            >
              {loading ? "Loading…" : "Load More"}
            </button>
          )}
        </div>
      </div>

      {/* Save search modal */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-80 rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-900">Save Search</h3>
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Search name"
              className="mt-3 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              autoFocus
            />
            <p className="mt-2 text-xs text-gray-500">
              Daily email digest will be enabled by default.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="rounded px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveSearch}
                disabled={!saveName.trim()}
                className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
