"use client";

import { useCallback, useRef, useState } from "react";

type FileStatus = "queued" | "processing" | "complete" | "failed";

interface ExtractionResult {
  filename: string;
  status: FileStatus;
  extraction?: Record<string, unknown>;
  error?: string;
  submissionId?: string;
}

interface CandidateCard {
  submissionId: string;
  filename: string;
  extraction: Record<string, unknown>;
  accepted: boolean;
  rejected: boolean;
  edits: Record<string, string>;
}

type WizardStep = 1 | 2 | 3;

const DISPLAY_FIELDS = [
  { key: "firstName", label: "First Name" },
  { key: "lastName", label: "Last Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "location", label: "Location" },
  { key: "jobTitle", label: "Job Title" },
  { key: "client", label: "Client" },
  { key: "employmentType", label: "Employment Type" },
  { key: "skills", label: "Skills" },
  { key: "certifications", label: "Certifications" },
  { key: "aircraftExperience", label: "Aircraft Experience" },
  { key: "hasAPLicense", label: "A&P License" },
  { key: "yearsOfExperience", label: "Experience" },
  { key: "workAuthorization", label: "Work Auth" },
  { key: "clearance", label: "Clearance" },
  { key: "currentRate", label: "Rate" },
];

export default function ResumeUploadWizard() {
  const [step, setStep] = useState<WizardStep>(1);
  const [files, setFiles] = useState<File[]>([]);
  const [folderMode, setFolderMode] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [results, setResults] = useState<ExtractionResult[]>([]);
  const [cards, setCards] = useState<CandidateCard[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [summary, setSummary] = useState<{ imported: number; skipped: number; errors: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const onFilesSelected = useCallback((selectedFiles: FileList | null) => {
    if (!selectedFiles) return;
    const pdfFiles: File[] = [];
    const rejected: string[] = [];

    for (let i = 0; i < selectedFiles.length; i++) {
      const f = selectedFiles[i];
      if (f.name.toLowerCase().endsWith(".pdf")) {
        pdfFiles.push(f);
      } else {
        rejected.push(f.name);
      }
    }

    if (rejected.length > 0) {
      setError(
        `Only text-based PDF files are supported (no scanned images). Please convert other formats to PDF before uploading. Rejected: ${rejected.join(", ")}`
      );
    } else {
      setError(null);
    }

    setFiles(pdfFiles);
    setBatchId(null);
    setResults([]);
    setCards([]);
    setSummary(null);
  }, []);

  const onUpload = async () => {
    if (files.length === 0) {
      setError("Select at least one PDF file.");
      return;
    }

    setUploading(true);
    setError(null);
    setStep(2);

    const formData = new FormData();
    for (const f of files) {
      formData.append("file", f);
    }

    try {
      const response = await fetch("/api/internal/recruiter/resume-upload", {
        method: "POST",
        body: formData,
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? "Upload failed.");
        return;
      }

      const uploadedBatchId = payload.data.batchId as string;
      setBatchId(uploadedBatchId);
      setResults(payload.data.files);

      const successFiles = payload.data.files.filter(
        (f: ExtractionResult) => f.status === "complete" && f.extraction
      );
      const failedFiles = payload.data.files.filter(
        (f: ExtractionResult) => f.status === "failed"
      );

      // Auto-confirm for bulk uploads (6+ files) — skip review step
      if (files.length >= 6) {
        const confirmed = successFiles.map((f: ExtractionResult) => ({
          submissionId: f.submissionId,
        }));
        const rejected: string[] = [];

        try {
          const confirmRes = await fetch(
            `/api/internal/recruiter/resume-upload/${uploadedBatchId}/confirm`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confirmed, rejected }),
            }
          );
          const confirmPayload = await confirmRes.json();
          if (confirmRes.ok) {
            setSummary({
              imported: confirmPayload.data.imported,
              skipped: confirmPayload.data.skipped,
              errors: failedFiles.length,
            });
            setStep(3);
            return;
          }
        } catch {
          // Fall through to manual review if auto-confirm fails
        }
      }

      // Manual review for small uploads (< 6 files)
      const successCards: CandidateCard[] = successFiles.map((f: ExtractionResult) => ({
        submissionId: f.submissionId ?? "",
        filename: f.filename,
        extraction: f.extraction as Record<string, unknown>,
        accepted: true,
        rejected: false,
        edits: {},
      }));

      setCards(successCards);
      setStep(3);
    } catch {
      setError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const toggleCard = (index: number, action: "accept" | "reject") => {
    setCards((prev) =>
      prev.map((card, i) => {
        if (i !== index) return card;
        if (action === "accept") return { ...card, accepted: true, rejected: false };
        return { ...card, accepted: false, rejected: true };
      })
    );
  };

  const editCardField = (index: number, key: string, value: string) => {
    setCards((prev) =>
      prev.map((card, i) => {
        if (i !== index) return card;
        return { ...card, edits: { ...card.edits, [key]: value } };
      })
    );
  };

  const onConfirm = async () => {
    if (!batchId) return;
    setConfirming(true);
    setError(null);

    const confirmed = cards
      .filter((c) => c.accepted)
      .map((c) => ({
        submissionId: c.submissionId,
        edits: Object.keys(c.edits).length > 0 ? c.edits : undefined,
      }));

    const rejected = cards.filter((c) => c.rejected).map((c) => c.submissionId);

    try {
      const response = await fetch(`/api/internal/recruiter/resume-upload/${batchId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed, rejected }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? "Confirmation failed.");
        return;
      }

      setSummary(payload.data);
    } catch {
      setError("Confirmation failed. Please try again.");
    } finally {
      setConfirming(false);
    }
  };

  const completeCount = results.filter((r) => r.status === "complete").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  return (
    <div className="space-y-6">
      {/* Step 1: File Select */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Step 1 - Select Resumes</p>

        <div className="mt-3 flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={folderMode}
              onChange={(e) => {
                setFolderMode(e.target.checked);
                setFiles([]);
              }}
              className="rounded border-slate-300"
            />
            Folder mode
          </label>
        </div>

        <div className="mt-3 rounded-lg border border-dashed border-slate-300 p-5">
          {folderMode ? (
            <input
              ref={folderInputRef}
              type="file"
              accept=".pdf"
              multiple
              // @ts-expect-error — webkitdirectory is non-standard but widely supported
              webkitdirectory=""
              onChange={(e) => onFilesSelected(e.target.files)}
              className="text-sm text-slate-700"
            />
          ) : (
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              multiple
              onChange={(e) => onFilesSelected(e.target.files)}
              className="text-sm text-slate-700"
            />
          )}
          <p className="mt-2 text-xs text-slate-400">
            PDF files only (text-based, not scanned images). Select individual files or use folder mode to upload an entire directory.
          </p>
        </div>

        {files.length > 0 && (
          <div className="mt-3">
            <p className="text-sm text-slate-600">{files.length} resume{files.length !== 1 ? "s" : ""} selected</p>
            <div className="mt-1 max-h-32 overflow-y-auto text-xs text-slate-400">
              {files.slice(0, 20).map((f) => (
                <p key={f.name}>{f.name}</p>
              ))}
              {files.length > 20 && <p>...and {files.length - 20} more</p>}
            </div>
          </div>
        )}

        {error && step === 1 && <p className="mt-3 text-sm text-rose-600">{error}</p>}

        <button
          type="button"
          disabled={files.length === 0 || uploading}
          onClick={() => void onUpload()}
          className="mt-4 rounded-lg border border-emerald-600 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? "Uploading & Extracting..." : "Upload & Extract"}
        </button>
      </section>

      {/* Step 2: Extraction Progress */}
      {step >= 2 && results.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Step 2 - Extraction Results</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-3">
            <p>Total: <span className="font-medium text-slate-800">{results.length}</span></p>
            <p>Complete: <span className="font-medium text-emerald-600">{completeCount}</span></p>
            <p>Failed: <span className="font-medium text-rose-600">{failedCount}</span></p>
          </div>

          {failedCount > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-xs uppercase text-slate-400">Failed Files:</p>
              {results.filter((r) => r.status === "failed").map((r) => (
                <div key={r.filename} className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs">
                  <span className="font-medium text-rose-700">{r.filename}</span>
                  <span className="ml-2 text-rose-500">{r.error}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Step 3: Review & Confirm */}
      {step >= 3 && !summary && cards.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Step 3 - Review & Confirm</p>
          <p className="mt-2 text-xs text-slate-400">
            Review extracted candidates. Edit fields if needed, then accept or reject each.
          </p>

          <div className="mt-4 space-y-4">
            {cards.map((card, index) => (
              <div
                key={card.submissionId}
                className={`rounded-xl border p-4 ${
                  card.rejected
                    ? "border-rose-200 bg-rose-50 opacity-60"
                    : card.accepted
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">{card.filename}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => toggleCard(index, "accept")}
                      className={`rounded px-3 py-1 text-xs ${
                        card.accepted
                          ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                          : "text-slate-400 hover:text-emerald-600"
                      }`}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleCard(index, "reject")}
                      className={`rounded px-3 py-1 text-xs ${
                        card.rejected
                          ? "bg-rose-100 text-rose-700 border border-rose-300"
                          : "text-slate-400 hover:text-rose-600"
                      }`}
                    >
                      Reject
                    </button>
                  </div>
                </div>

                {!card.rejected && (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {DISPLAY_FIELDS.map(({ key, label }) => {
                      const rawValue = card.extraction[key];
                      const value = Array.isArray(rawValue)
                        ? rawValue.join(", ")
                        : typeof rawValue === "string"
                        ? rawValue
                        : typeof rawValue === "boolean"
                        ? (rawValue ? "Yes" : "No")
                        : "";
                      return (
                        <label key={key} className="text-xs">
                          <span className="text-slate-400">{label}</span>
                          <input
                            type="text"
                            defaultValue={value}
                            onChange={(e) => editCardField(index, key, e.target.value)}
                            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

          {cards.length > 0 && cards.every((c) => c.accepted && Object.keys(c.edits).length === 0) && (
            <p className="mt-3 text-xs text-amber-600">
              All candidates are auto-accepted. Please review the extracted data before confirming — LLM extraction may contain errors.
            </p>
          )}

          <button
            type="button"
            disabled={confirming || cards.filter((c) => c.accepted).length === 0}
            onClick={() => void onConfirm()}
            className="mt-4 rounded-lg border border-emerald-600 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {confirming ? "Confirming..." : `Confirm ${cards.filter((c) => c.accepted).length} Candidates`}
          </button>
        </section>
      )}

      {/* Summary */}
      {summary && (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
          <p className="text-xs uppercase tracking-[0.15em] text-emerald-600">Upload Complete</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-3">
            <p>Imported: <span className="font-medium text-emerald-600">{summary.imported}</span></p>
            <p>Skipped: <span className="font-medium text-amber-600">{summary.skipped}</span></p>
            <p>Errors: <span className="font-medium text-rose-600">{summary.errors}</span></p>
          </div>
        </section>
      )}
    </div>
  );
}
