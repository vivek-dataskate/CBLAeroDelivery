"use client";

import { useState } from "react";

import CsvUploadWizard from "./CsvUploadWizard";
import ResumeUploadWizard from "./ResumeUploadWizard";

type UploadMode = "csv" | "resume";

export default function UploadModeSelector() {
  const [mode, setMode] = useState<UploadMode>("csv");

  return (
    <div className="space-y-6">
      <div className="flex gap-2 rounded-xl border border-white/10 bg-slate-950/65 p-1">
        <button
          type="button"
          onClick={() => setMode("csv")}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition ${
            mode === "csv"
              ? "bg-cyan-600/30 text-cyan-100 border border-cyan-400/40"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          Upload CSV
        </button>
        <button
          type="button"
          onClick={() => setMode("resume")}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition ${
            mode === "resume"
              ? "bg-cyan-600/30 text-cyan-100 border border-cyan-400/40"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          Upload Resumes
        </button>
      </div>

      {mode === "csv" ? <CsvUploadWizard /> : <ResumeUploadWizard />}
    </div>
  );
}
