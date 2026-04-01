# Story 2.2a: Implement Recruiter PDF Resume Upload with LLM Extraction

Status: backlog

## Story

As a recruiter,
I want to upload PDF resumes (single or multiple via folder) and have the system extract candidate data automatically,
So that I can ingest candidates without manually converting resumes into CSV format.

## Acceptance Criteria

1. **Given** a recruiter on the upload page, **when** the page loads, **then** a mode selector offers "Upload CSV" (existing flow) and "Upload Resumes" (new flow); selecting either reveals the corresponding upload interface.

2. **Given** a recruiter selects "Upload Resumes" mode, **when** they use the file picker, **then** the input accepts `.pdf` files only (single file via click, multiple files via multi-select, or folder via `webkitdirectory`). Non-PDF files are rejected client-side with the message: "Only PDF files are supported. Please convert Word, RTF, or other formats to PDF before uploading."

3. **Given** one or more PDF files are selected, **when** the recruiter confirms upload, **then** the system creates an `import_batch` record with `source=resume_upload` and `status=processing`, stores each PDF in Supabase Storage (`candidate-attachments` bucket, path `resume-uploads/{tenant_id}/{batch_id}/{filename}`), and begins LLM extraction.

4. **Given** PDF files are being processed, **when** extraction is in progress, **then** the UI displays a progress tracker showing: total files, files processed, files failed, and per-file status (queued/processing/complete/failed). Files are processed in internal batches of 50 to bound concurrent LLM cost and memory. There is no hard cap on total file count.

5. **Given** a PDF file is processed by the LLM extraction service, **when** extraction succeeds, **then** a `candidate_submissions` row is created with: the Supabase Storage URL for the raw PDF, the full LLM extraction JSON, `source=resume_upload`, and the `import_batch_id`. The extracted candidate data is queued for the review step.

6. **Given** all files in a batch have been processed (or failed), **when** the extraction phase completes, **then** the recruiter is shown a review step with extracted candidate data displayed in editable card layout — one card per successfully parsed PDF. Each card shows extracted fields (name, email, phone, location, skills, certifications, experience) and allows the recruiter to edit, accept, or reject the candidate before committing.

7. **Given** the recruiter accepts (or edits and accepts) a parsed candidate, **when** the candidate is committed, **then** the record is persisted to the `candidates` table with `source=resume_upload`, `ingestion_state=pending_enrichment`, and `source_batch_id` linking to the `import_batch`. The `candidate_submissions` row is updated with the resulting `candidate_id`.

8. **Given** a PDF that fails extraction (encrypted, scanned-image-only without OCR text, corrupted, or empty), **when** the failure is detected, **then** the file is flagged in the progress tracker with an actionable error message (e.g., "This PDF appears to be a scanned image without extractable text") and the recruiter can skip it. The `candidate_submissions` row is still created with the error detail and no `candidate_id`.

9. **Given** all recruiter review decisions are finalized, **when** the batch completes, **then** the `import_batch` record is updated to `status=complete` with final `imported`, `skipped`, and `errors` counts. The UI shows a summary.

10. **Given** any resume upload API call, **when** the recruiter's session is missing or their role is not in `{recruiter, delivery-head, admin}`, **then** the API responds with the standard auth error shape (`401`/`403`).

## Tasks / Subtasks

- [ ] Refactor existing LLM extraction into unified `candidate-extraction` service (AC: 3, 5)
  - [ ] Create `cblaero/src/features/candidate-management/application/candidate-extraction.ts`
  - [ ] Define common interface: `extractCandidateFromDocument(content, contentType, metadata) → CandidateExtraction[]`
  - [ ] Move LLM prompt and `CandidateExtraction` type from `cblaero/src/modules/email/nlp-extract-and-upload.ts` into the new service
  - [ ] Add `pdf` content type pre-processor: extract text from PDF buffer using `pdf-parse` (or equivalent lightweight library)
  - [ ] Retain `email_body` content type pre-processor wrapping existing email cleaning logic
  - [ ] Update `cblaero/src/modules/email/nlp-extract-and-upload.ts` to delegate to the unified service (no duplication)
  - [ ] Update `cblaero/src/modules/ingestion/index.ts` `IngestionSource` type to include `"resume_upload"`

- [ ] Build PDF resume upload API route: `POST /api/internal/recruiter/resume-upload` (AC: 3, 4, 8, 10)
  - [ ] Create `cblaero/src/app/api/internal/recruiter/resume-upload/route.ts`
  - [ ] Accept `multipart/form-data` with multiple `file` fields; validate each is `application/pdf` or filename ends `.pdf`
  - [ ] Reject non-PDF files server-side with HTTP 422 and clear error message
  - [ ] Authenticate via `validateActiveSession` + `authorizeAccess` with action `"recruiter:csv-upload"` (reuse existing permission)
  - [ ] Create `import_batch` with `source=resume_upload`, `status=processing`
  - [ ] For each PDF: store in Supabase Storage at `resume-uploads/{tenant_id}/{batch_id}/{filename}`
  - [ ] Process files in batches of 50: call unified extraction service per file
  - [ ] Create `candidate_submissions` row per file with: storage URL, extraction JSON (or error), `source=resume_upload`, `import_batch_id`
  - [ ] Return extraction results (per-file success/failure + extracted data) for client-side review step
  - [ ] Response shape: `{data: {batchId, files: [{filename, status, extraction?, error?}]}, meta: {}}`

- [ ] Build review confirmation API route: `POST /api/internal/recruiter/resume-upload/[batchId]/confirm` (AC: 7, 9)
  - [ ] Create `cblaero/src/app/api/internal/recruiter/resume-upload/[batchId]/confirm/route.ts`
  - [ ] Accept JSON body with array of confirmed candidates (each with optional edits) and array of rejected file IDs
  - [ ] For each confirmed candidate: upsert to `candidates` via `process_import_chunk` RPC with `source=resume_upload`, `ingestion_state=pending_enrichment`
  - [ ] Update `candidate_submissions` rows with resulting `candidate_id` for accepted, mark rejected as skipped
  - [ ] Update `import_batch` to `status=complete` with final counts
  - [ ] Authenticate + authorize; enforce tenant scope

- [ ] Build batch status lookup route: `GET /api/internal/recruiter/resume-upload/[batchId]` (AC: 4)
  - [ ] Create `cblaero/src/app/api/internal/recruiter/resume-upload/[batchId]/route.ts`
  - [ ] Return batch status, file count, processed count, error count, per-file status summary
  - [ ] Authenticate + authorize; enforce tenant scope

- [ ] Extend recruiter upload UI with mode selector and PDF flow (AC: 1, 2, 4, 6)
  - [ ] Modify `cblaero/src/app/dashboard/recruiter/upload/page.tsx` to add mode selector tabs ("Upload CSV" / "Upload Resumes")
  - [ ] Create `cblaero/src/app/dashboard/recruiter/upload/ResumeUploadWizard.tsx` — client component with steps:
    - **Step 1 — File Select:** file input with `accept=".pdf"` and `multiple` attribute; optional folder mode via `webkitdirectory`; display selected file count and names; show clear PDF-only messaging
    - **Step 2 — Extraction Progress:** submit files to `POST /api/internal/recruiter/resume-upload`; poll `GET .../[batchId]` for progress; show per-file status cards (queued/processing/complete/failed) with error messages for failures
    - **Step 3 — Review & Confirm:** editable candidate cards for each successful extraction; accept/edit/reject per candidate; submit confirmed candidates to `POST .../[batchId]/confirm`; show final summary
  - [ ] Reuse `BatchProgressCard` visual pattern from CSV upload flow for progress display

- [ ] Write tests (AC: 1–10)
  - [ ] Unit tests for unified `candidate-extraction` service: PDF pre-processing, email pre-processing, LLM mock extraction
  - [ ] Integration tests for `POST /api/internal/recruiter/resume-upload`: auth (401/403), non-PDF rejection (422), valid PDF upload, multi-file batch, extraction failure handling
  - [ ] Integration tests for `POST .../[batchId]/confirm`: confirm flow, reject flow, tenant isolation
  - [ ] Integration tests for `GET .../[batchId]`: status lookup, tenant isolation
  - [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` in `cblaero/`

## Dev Notes

### Unified Candidate Extraction Service (Architectural Decision)

**This story introduces a unified `candidate-extraction` service** as a key architectural refinement. Currently, LLM extraction logic lives in `cblaero/src/modules/email/nlp-extract-and-upload.ts` — tightly coupled to the email parsing flow. This story refactors it into a shared service at `cblaero/src/features/candidate-management/application/candidate-extraction.ts`.

**Why:** The system now has multiple unstructured-content ingestion paths (email body parsing from Story 2.3, PDF resume upload from this story) and will likely add more in the future (LinkedIn exports, ATS record normalization). Duplicating the LLM extraction prompt and schema per path creates maintenance burden and drift risk. Centralizing it means:
- One LLM prompt/schema to maintain — changes apply uniformly
- One `CandidateExtraction` type definition shared across all parsers
- Content pre-processing is pluggable per content type (PDF text extraction vs email body cleaning)
- New document types only need a pre-processor and route; extraction core and downstream pipeline are reused

**How to apply:** The `extractCandidateFromDocument(content, contentType, metadata)` interface accepts a `contentType` discriminator (`'pdf' | 'email_body' | 'email_attachment'`). Each type has a pre-processor that normalizes content to plain text before the shared LLM call. After refactoring, `nlp-extract-and-upload.ts` becomes a thin wrapper that calls the unified service with `contentType: 'email_body'`.

### Existing Infrastructure to Reuse

- **`CandidateExtraction` type** — currently in `cblaero/src/modules/email/nlp-extract-and-upload.ts:11-63`. Move to the unified service; re-export from the old location for backwards compatibility during the refactor.
- **`EXTRACTION_PROMPT`** — currently in `cblaero/src/modules/email/nlp-extract-and-upload.ts:70+`. Move to unified service; generalize slightly (remove email-specific `isSubmission` check for PDF path — all uploaded PDFs are assumed to be candidate resumes).
- **`uploadAttachmentToStorage()`** — already in `nlp-extract-and-upload.ts`. Reuse for storing PDF files in the `candidate-attachments` bucket.
- **`candidate_submissions` table** — already exists from Story 2.3 with columns for raw file URL, extraction JSON, source, and candidate linkage. Resume uploads create rows in this table with `source=resume_upload`.
- **`import_batch` table** — used by CSV upload (Story 2.2) and migration (Story 2.1). Resume uploads create batches with `source=resume_upload`.
- **`process_import_chunk` RPC** — the confirmed candidates from the review step are persisted via this RPC, same as CSV uploads.

### PDF Text Extraction

- Add a lightweight PDF text extraction library (e.g., `pdf-parse` or `pdfjs-dist`) to extract readable text from PDF buffers before passing to the LLM.
- If a PDF yields zero extractable text (scanned image without OCR), flag it as a failure with an actionable message rather than sending empty content to the LLM.
- Do NOT add heavyweight OCR dependencies (Tesseract, etc.) in this story — that's a future enhancement. For now, only text-based PDFs are supported.

### Processing Architecture

- Files are processed **server-side in internal batches of 50** to bound concurrent LLM API calls and memory.
- The upload route processes files synchronously within the request (similar to CSV upload approach for <=10k rows). For very large folder uploads, consider a background worker approach in a future story.
- The two-phase flow (upload+extract → review → confirm) means the route returns extraction results without persisting candidates — persistence only happens after the recruiter confirms in the second API call.

### Authorization

- Reuse the existing `"recruiter:csv-upload"` permission action — the same roles (recruiter, delivery-head, admin) that can upload CSV should be able to upload resumes. No new permission action needed.
- Consider renaming to a more general `"recruiter:upload"` action in a future cleanup story if the permission surface grows.

### `IngestionSource` Type

- Update `cblaero/src/modules/ingestion/index.ts` line 4 to add `"resume_upload"` to the `IngestionSource` union type.

### Previous Story Intelligence

- **Story 2.3 parser patterns:** The `EXTRACTION_PROMPT` in `nlp-extract-and-upload.ts` uses Claude Haiku 4.5 with a structured JSON schema. The same model and approach work for PDF content — the prompt just needs minor generalization to handle resume text (not email-formatted text).
- **Story 2.2 UI patterns:** The `CsvUploadWizard.tsx` three-step wizard pattern (file select → validation → submit) maps cleanly to the resume flow (file select → extraction progress → review & confirm). Reuse the component structure and styling conventions.
- **Story 2.2 batch progress:** `BatchProgressCard.tsx` handles polling and progress display. Extend or create a parallel component for per-file extraction progress.

### File Structure for This Story

New files:
- `cblaero/src/features/candidate-management/application/candidate-extraction.ts` — unified extraction service
- `cblaero/src/features/candidate-management/application/__tests__/candidate-extraction.test.ts` — extraction service tests
- `cblaero/src/app/api/internal/recruiter/resume-upload/route.ts` — POST: upload PDFs + extract
- `cblaero/src/app/api/internal/recruiter/resume-upload/[batchId]/route.ts` — GET: batch status
- `cblaero/src/app/api/internal/recruiter/resume-upload/[batchId]/confirm/route.ts` — POST: confirm candidates
- `cblaero/src/app/api/internal/recruiter/resume-upload/__tests__/route.test.ts` — upload route tests
- `cblaero/src/app/api/internal/recruiter/resume-upload/[batchId]/__tests__/route.test.ts` — status + confirm tests
- `cblaero/src/app/dashboard/recruiter/upload/ResumeUploadWizard.tsx` — client component

Modified files:
- `cblaero/src/modules/email/nlp-extract-and-upload.ts` — refactor to delegate to unified service
- `cblaero/src/modules/ingestion/index.ts` — add `"resume_upload"` to `IngestionSource`
- `cblaero/src/app/dashboard/recruiter/upload/page.tsx` — add mode selector tabs

### References

- [Source: docs/planning_artifacts/architecture.md — Candidate Data Ingestion Architecture, Path 2b]
- [Source: docs/planning_artifacts/architecture.md — Unified Candidate Extraction Service]
- [Source: docs/planning_artifacts/ux-design-specification.md — §7 Data Import and Sync Console, PDF resume upload]
- [Source: docs/planning_artifacts/prd.md — FR1b]
- [Source: docs/planning_artifacts/epics.md — Story 2.2a]
- [Source: cblaero/src/modules/email/nlp-extract-and-upload.ts — existing LLM parser, CandidateExtraction type, EXTRACTION_PROMPT]
- [Source: cblaero/src/modules/ingestion/index.ts — IngestionSource type, ingestion pipeline]
- [Source: cblaero/src/app/api/internal/recruiter/csv-upload/route.ts — CSV upload route pattern]
- [Source: cblaero/src/app/dashboard/recruiter/upload/CsvUploadWizard.tsx — wizard UI pattern]
- [Source: docs/implementation_artifacts/stories/2-2-implement-recruiter-csv-upload-wizard-and-validation.md — CSV upload story reference]
- [Source: docs/implementation_artifacts/stories/2-3-implement-ats-and-email-ingestion-connectors.md — email parser story reference]
- [Source: docs/planning_artifacts/sprint-change-proposal-2026-03-31.md — approved change proposal]

FR/NFR mapping:
- FR1b (Epic 2 — recruiter PDF resume upload with LLM extraction)
- FR1 (Epic 2 — shared ingestion pipeline)
- NFR34 (Tier 1 scale: 50-100 recruiters, sub-second query latency)

Story size: **M** (3-4 dev days)
