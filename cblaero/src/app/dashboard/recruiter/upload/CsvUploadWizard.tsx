"use client";

import { useMemo, useState } from "react";

import BatchProgressCard from "./BatchProgressCard";

type CanonicalField =
  | "name"
  | "email"
  | "phone"
  | "location"
  | "skills"
  | "availability_status"
  | "(additional_attribute)";

type ValidationSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateDetectedCount: number;
  byErrorCode: {
    missing_identity: number;
    invalid_format: number;
    row_limit_exceeded: number;
  };
};

type ParsedCsv = {
  headers: string[];
  rows: Array<Record<string, string>>;
};

const MAX_ROWS = 10_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FIELD_OPTIONS: CanonicalField[] = [
  "name",
  "email",
  "phone",
  "location",
  "skills",
  "availability_status",
  "(additional_attribute)",
];

const FIELD_ALIASES: Record<string, CanonicalField> = {
  name: "name",
  full_name: "name",
  fullname: "name",
  email: "email",
  email_address: "email",
  phone: "phone",
  phone_number: "phone",
  mobile: "phone",
  location: "location",
  city: "location",
  skills: "skills",
  skill: "skills",
  availability: "availability_status",
  availability_status: "availability_status",
};

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseCsv(text: string): ParsedCsv {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function inferMapping(headers: string[]): Record<string, CanonicalField> {
  const map: Record<string, CanonicalField> = {};
  for (const header of headers) {
    map[header] = FIELD_ALIASES[normalizeHeader(header)] ?? "(additional_attribute)";
  }
  return map;
}

function phoneLooksValid(value: string): boolean {
  const digits = value.replace(/\D+/g, "");
  return digits.length >= 7;
}

function validateRows(
  parsed: ParsedCsv,
  mapping: Record<string, CanonicalField>,
): ValidationSummary {
  const summary: ValidationSummary = {
    totalRows: parsed.rows.length,
    validRows: 0,
    invalidRows: 0,
    duplicateDetectedCount: 0,
    byErrorCode: {
      missing_identity: 0,
      invalid_format: 0,
      row_limit_exceeded: parsed.rows.length > MAX_ROWS ? parsed.rows.length - MAX_ROWS : 0,
    },
  };

  const seenIdentity = new Set<string>();

  for (let index = 0; index < parsed.rows.length; index += 1) {
    const row = parsed.rows[index];

    const mappedValue = (field: CanonicalField) => {
      const header = Object.keys(mapping).find((key) => mapping[key] === field);
      return header ? row[header] ?? "" : "";
    };

    const name = mappedValue("name").trim();
    const email = mappedValue("email").trim().toLowerCase();
    const phone = mappedValue("phone").trim();

    if (!name || (!email && !phone)) {
      summary.byErrorCode.missing_identity += 1;
      summary.invalidRows += 1;
      continue;
    }

    if ((email && !EMAIL_REGEX.test(email)) || (phone && !phoneLooksValid(phone))) {
      summary.byErrorCode.invalid_format += 1;
      summary.invalidRows += 1;
      continue;
    }

    const identityKey = email || phone.replace(/\D+/g, "");
    if (seenIdentity.has(identityKey)) {
      summary.duplicateDetectedCount += 1;
    } else {
      seenIdentity.add(identityKey);
    }

    summary.validRows += 1;
  }

  return summary;
}

function requiredMappingsSatisfied(mapping: Record<string, CanonicalField>): boolean {
  const values = Object.values(mapping);
  return values.includes("name") && (values.includes("email") || values.includes("phone"));
}

export default function CsvUploadWizard() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv>({ headers: [], rows: [] });
  const [previewRows, setPreviewRows] = useState<Array<Record<string, string>>>([]);
  const [mapping, setMapping] = useState<Record<string, CanonicalField>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);

  const validationSummary = useMemo(() => validateRows(parsed, mapping), [parsed, mapping]);

  const softLimitWarning = parsed.rows.length > MAX_ROWS;

  const onFileSelected = async (nextFile: File | null) => {
    setSubmitError(null);
    setBatchId(null);

    if (!nextFile) {
      setFile(null);
      setParsed({ headers: [], rows: [] });
      setPreviewRows([]);
      setMapping({});
      setStep(1);
      return;
    }

    const text = await nextFile.text();
    const parsedCsv = parseCsv(text);

    setFile(nextFile);
    setParsed(parsedCsv);
    setPreviewRows(parsedCsv.rows.slice(0, 5));
    setMapping(inferMapping(parsedCsv.headers));
    setStep(2);
  };

  const onUpload = async () => {
    if (!file) {
      setSubmitError("Choose a CSV file before uploading.");
      return;
    }

    if (softLimitWarning) {
      setSubmitError(`CSV exceeds ${MAX_ROWS.toLocaleString()} row limit. Split the file and retry.`);
      return;
    }

    if (!requiredMappingsSatisfied(mapping)) {
      setSubmitError("Map name and at least one of email or phone before uploading.");
      return;
    }

    setUploading(true);
    setSubmitError(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("columnMap", JSON.stringify(mapping));

    try {
      const response = await fetch("/api/internal/recruiter/csv-upload", {
        method: "POST",
        body: formData,
      });

      const payload = await response.json();
      if (!response.ok) {
        if (payload?.error?.code === "row_limit_exceeded") {
          setSubmitError(
            payload?.error?.message ??
              `CSV exceeds ${MAX_ROWS.toLocaleString()} row limit. Split the file and retry.`,
          );
        } else {
          setSubmitError(payload?.error?.message ?? "Upload failed.");
        }
        return;
      }

      setBatchId(String(payload.data.batchId));
    } catch {
      setSubmitError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
        <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Step 1 - File Select</p>
        <div className="mt-3 rounded-xl border border-dashed border-slate-600 p-5">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              void onFileSelected(selected);
            }}
            className="text-sm text-slate-200"
          />
          <p className="mt-2 text-xs text-slate-400">
            Max {MAX_ROWS.toLocaleString()} rows per upload.
          </p>
          {file ? <p className="mt-2 text-xs text-slate-300">Selected: {file.name}</p> : null}
          {softLimitWarning ? (
            <p className="mt-2 text-xs text-amber-300">
              This file appears to exceed {MAX_ROWS.toLocaleString()} rows and will be rejected on upload.
            </p>
          ) : null}
        </div>
      </section>

      {step >= 2 ? (
        <section className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
          <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Step 2 - Column Mapping</p>
          <p className="mt-2 text-xs text-slate-400">
            Columns mapped as <b>Additional Attribute</b> are retained as additional attributes under candidate <b>extra_attributes</b> (JSON).
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {parsed.headers.map((header) => (
              <label key={header} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-slate-200">{header}</span>
                <select
                  value={mapping[header] ?? "(additional_attribute)"}
                  onChange={(event) => {
                    const value = event.target.value as CanonicalField;
                    setMapping((current) => ({ ...current, [header]: value }));
                  }}
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                >
                  {FIELD_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === "(additional_attribute)" ? "Additional Attribute" : option}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {!requiredMappingsSatisfied(mapping) ? (
            <p className="mt-3 text-xs text-amber-300">
              Required mapping: name and at least one of email or phone.
            </p>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-xs text-slate-300">
              <thead>
                <tr className="text-left text-slate-400">
                  {parsed.headers.map((header) => (
                    <th key={header} className="pr-4 pb-2 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, index) => (
                  <tr key={`${index}-${row[parsed.headers[0]] ?? "row"}`}>
                    {parsed.headers.map((header) => (
                      <td key={`${index}-${header}`} className="pr-4 py-1 align-top text-slate-300">
                        {row[header] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={() => setStep(3)}
            disabled={!requiredMappingsSatisfied(mapping)}
            className="mt-4 rounded-lg border border-cyan-300/40 px-3 py-2 text-sm text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next: Validation Preview
          </button>
        </section>
      ) : null}

      {step >= 3 ? (
        <section className="rounded-2xl border border-white/10 bg-slate-950/65 p-5">
          <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Step 3 - Validation Preview</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-200 md:grid-cols-2">
            <p>
              Total rows: <span className="text-white">{validationSummary.totalRows.toLocaleString()}</span>
            </p>
            <p>
              Valid rows: <span className="text-emerald-300">{validationSummary.validRows.toLocaleString()}</span>
            </p>
            <p>
              Invalid rows: <span className="text-amber-300">{validationSummary.invalidRows.toLocaleString()}</span>
            </p>
            <p>
              Duplicate candidate detected: <span className="text-white">{validationSummary.duplicateDetectedCount.toLocaleString()}</span>
            </p>
          </div>

          <div className="mt-3 text-xs text-slate-400">
            <p>missing_identity: {validationSummary.byErrorCode.missing_identity}</p>
            <p>invalid_format: {validationSummary.byErrorCode.invalid_format}</p>
            <p>row_limit_exceeded: {validationSummary.byErrorCode.row_limit_exceeded}</p>
          </div>

          {submitError ? <p className="mt-3 text-sm text-rose-300">{submitError}</p> : null}

          <button
            type="button"
            disabled={uploading}
            onClick={() => {
              void onUpload();
            }}
            className="mt-4 rounded-lg border border-emerald-300/40 px-4 py-2 text-sm text-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload CSV"}
          </button>
        </section>
      ) : null}

      {batchId ? <BatchProgressCard batchId={batchId} /> : null}
    </div>
  );
}
