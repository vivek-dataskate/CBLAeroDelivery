"use client";

import { useState } from "react";

import CsvUploadWizard from "./CsvUploadWizard";
import ResumeUploadWizard from "./ResumeUploadWizard";

type UploadMode = "csv" | "resume";

export default function UploadModeSelector() {
  const [mode, setMode] = useState<UploadMode>("csv");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        <button
          type="button"
          onClick={() => setMode("csv")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
            mode === "csv"
              ? "bg-white text-slate-800 shadow-sm border border-slate-200"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Upload CSV
        </button>
        <button
          type="button"
          onClick={() => setMode("resume")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
            mode === "resume"
              ? "bg-white text-slate-800 shadow-sm border border-slate-200"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Upload Resumes
        </button>
      </div>

      {mode === "csv" ? <CsvUploadWizard /> : <ResumeUploadWizard />}
    </div>
  );
}
