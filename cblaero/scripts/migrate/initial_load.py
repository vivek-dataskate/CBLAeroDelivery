#!/usr/bin/env python3
"""
CBLAero Initial 1M Candidate Record Migration Script
=====================================================
Runs as a Render one-off job using the Supabase service-role key.
Loads legacy candidate records from a CSV file in bounded chunks of
MIGRATION_CHUNK_SIZE rows per transaction.

Environment variables (required):
  SUPABASE_URL                 Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY    Service-role key (backend only — never expose to client)
  CBL_SUPABASE_SCHEMA          Schema name (default: cblaero_app)
  MIGRATION_TENANT_ID          Tenant ID to assign all imported records
  MIGRATION_SOURCE_FILE        Absolute path to the source CSV file

Environment variables (optional):
  MIGRATION_CHUNK_SIZE         Rows per transaction (default: 1000)
  MIGRATION_ERROR_THRESHOLD_PCT Per-chunk error rate that triggers pause (default: 5)
  MIGRATION_ACTOR_ID           Actor ID of admin who triggered the migration (audit trail)

CSV expected columns (all optional except name + one of email/phone):
  name, email, phone, location, skills, certifications, experience,
  availability_status

Usage:
  python initial_load.py
"""

import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SCHEMA = os.environ.get("CBL_SUPABASE_SCHEMA", "cblaero_app")
TENANT_ID = os.environ.get("MIGRATION_TENANT_ID", "")
SOURCE_FILE = os.environ.get("MIGRATION_SOURCE_FILE", "")
CHUNK_SIZE = int(os.environ.get("MIGRATION_CHUNK_SIZE", "1000"))
ERROR_THRESHOLD_PCT = float(os.environ.get("MIGRATION_ERROR_THRESHOLD_PCT", "5"))
ACTOR_ID = os.environ.get("MIGRATION_ACTOR_ID", "")


def _validate_config() -> None:
    missing = [
        name
        for name, val in {
            "SUPABASE_URL": SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_SERVICE_ROLE_KEY,
            "MIGRATION_TENANT_ID": TENANT_ID,
            "MIGRATION_SOURCE_FILE": SOURCE_FILE,
        }.items()
        if not val
    ]
    if missing:
        print(
            json.dumps(
                {"event": "config_error", "missing_vars": missing}
            ),
            flush=True,
        )
        sys.exit(1)

    if not os.path.isfile(SOURCE_FILE):
        print(
            json.dumps({"event": "config_error", "error": f"Source file not found: {SOURCE_FILE}"}),
            flush=True,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Supabase client
# ---------------------------------------------------------------------------

def _build_client() -> Client:
    """Create the Supabase client using the service-role key.

    The service-role key bypasses RLS. It must never be used from browser
    code or exposed as a NEXT_PUBLIC_ variable. This script runs exclusively
    as a Render one-off job on the backend.
    """
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


# ---------------------------------------------------------------------------
# Row parsing
# ---------------------------------------------------------------------------

VALID_AVAILABILITY = {"active", "passive", "unavailable"}


def _parse_json_field(raw: str | None, fallback: Any) -> Any:
    if not raw or not raw.strip():
        return fallback
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return fallback


def _parse_row(row: dict[str, str], row_number: int, batch_id: str) -> tuple[dict | None, dict | None]:
    """Parse and validate a single CSV row.

    Returns (candidate_record, error_record). Exactly one will be non-None.
    """
    name = (row.get("name") or "").strip()
    email = (row.get("email") or "").strip() or None
    phone = (row.get("phone") or "").strip() or None

    if not name:
        return None, {
            "batch_id": batch_id,
            "row_number": row_number,
            "raw_data": row,
            "error_code": "missing_name",
            "error_detail": "Row is missing required field: name",
        }

    if not email and not phone:
        return None, {
            "batch_id": batch_id,
            "row_number": row_number,
            "raw_data": row,
            "error_code": "missing_identity",
            "error_detail": "Row must have at least one of: email, phone",
        }

    raw_availability = (row.get("availability_status") or "").strip().lower()
    availability_status = raw_availability if raw_availability in VALID_AVAILABILITY else "passive"
    now_iso = datetime.now(timezone.utc).isoformat()

    candidate = {
        "tenant_id": TENANT_ID,
        "name": name,
        "email": email,
        "phone": phone,
        "location": (row.get("location") or "").strip() or None,
        "skills": _parse_json_field(row.get("skills"), []),
        "certifications": _parse_json_field(row.get("certifications"), []),
        "experience": _parse_json_field(row.get("experience"), []),
        "availability_status": availability_status,
        "ingestion_state": "pending_dedup",
        "source": "migration",
        "source_batch_id": batch_id,
        "updated_at": now_iso,
    }
    return candidate, None


# ---------------------------------------------------------------------------
# Batch management
# ---------------------------------------------------------------------------

def _create_import_batch(client: Client, total_rows: int) -> str:
    result = (
        client.schema(SCHEMA)
        .from_("import_batch")
        .insert(
            {
                "tenant_id": TENANT_ID,
                "source": "migration",
                "status": "running",
                "total_rows": total_rows,
                "imported": 0,
                "skipped": 0,
                "errors": 0,
                "error_threshold_pct": int(ERROR_THRESHOLD_PCT),
                "created_by_actor_id": ACTOR_ID or None,
                "started_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        .select("id")
        .execute()
    )
    return result.data[0]["id"]


def _complete_batch(client: Client, batch_id: str, imported: int, skipped: int, errors: int) -> None:
    client.schema(SCHEMA).from_("import_batch").update(
        {
            "status": "complete",
            "imported": imported,
            "skipped": skipped,
            "errors": errors,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("id", batch_id).execute()


def _pause_batch(client: Client, batch_id: str, imported: int, skipped: int, errors: int) -> None:
    client.schema(SCHEMA).from_("import_batch").update(
        {
            "status": "paused_on_error_threshold",
            "imported": imported,
            "skipped": skipped,
            "errors": errors,
        }
    ).eq("id", batch_id).execute()


# ---------------------------------------------------------------------------
# CSV row counting
# ---------------------------------------------------------------------------

def _count_csv_rows(path: str) -> int:
    # Pre-counts rows for progress display (total_rows denominator in the admin card).
    # This adds a single sequential read before processing begins — an accepted trade-off
    # for a one-time 1M-row job where real-time progress visibility matters to the admin.
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return sum(1 for _ in reader)


# ---------------------------------------------------------------------------
# Chunk processing (parse → upsert → error write)
# ---------------------------------------------------------------------------

def _process_chunk(
    client: Client,
    chunk: list[dict[str, str]],
    chunk_num: int,
    base_row: int,
    batch_id: str,
    total_imported: int,
    total_skipped: int,
    total_errors: int,
) -> tuple[int, int]:
    """Parse, upsert, and write errors for a single chunk of CSV rows.

    Returns (chunk_imported, chunk_errors).

    Error accounting:
    - Parse failures (missing name/identity) are captured first.
    - On upsert failure, only the rows that were actually attempted (valid candidates)
      are marked as upsert_failure — parse-failed rows are NOT double-counted.
    """
    candidates: list[dict] = []
    error_rows: list[dict] = []

    for i, csv_row in enumerate(chunk):
        abs_row = base_row + i
        candidate, error = _parse_row(csv_row, abs_row, batch_id)
        if candidate:
            candidate["row_number"] = abs_row
            candidate["raw_data"] = csv_row
            candidates.append(candidate)
        else:
            error_rows.append(error)

    try:
        result = (
            client.schema(SCHEMA)
            .rpc(
                "process_import_chunk",
                {
                    "p_batch_id": batch_id,
                    "p_candidates": candidates,
                    "p_error_rows": error_rows,
                    "p_total_imported": total_imported,
                    "p_total_skipped": total_skipped,
                    "p_total_errors": total_errors,
                },
            )
            .execute()
        )

        row = result.data[0] if isinstance(result.data, list) and result.data else result.data
        chunk_imported = int((row or {}).get("imported", 0))
        chunk_errors = int((row or {}).get("errors", 0))
        return chunk_imported, chunk_errors
    except Exception as exc:  # noqa: BLE001
        print(
            json.dumps(
                {
                    "event": "chunk_rpc_error",
                    "batch_id": batch_id,
                    "chunk": chunk_num,
                    "error": str(exc),
                }
            ),
            flush=True,
        )
        raise


def _chunk_error_rate_exceeded(chunk_errors: int, chunk_size: int) -> bool:
    if chunk_size <= 0:
        return False
    return (chunk_errors / chunk_size) > (ERROR_THRESHOLD_PCT / 100)


# ---------------------------------------------------------------------------
# Main migration loop
# ---------------------------------------------------------------------------

def run_migration() -> None:
    _validate_config()
    client = _build_client()

    start_time = time.monotonic()

    print(json.dumps({"event": "counting_rows", "source_file": SOURCE_FILE}), flush=True)
    total_rows = _count_csv_rows(SOURCE_FILE)
    print(json.dumps({"event": "row_count", "total_rows": total_rows}), flush=True)

    batch_id = _create_import_batch(client, total_rows)
    print(
        json.dumps({"event": "batch_created", "batch_id": batch_id, "total_rows": total_rows}),
        flush=True,
    )
    print(
        json.dumps(
            {
                "event": "transaction_mode_notice",
                "batch_id": batch_id,
                "mode": "supabase_rpc_single_call",
                "atomic_per_chunk": True,
                "note": "Each chunk is processed in a single SQL RPC transaction.",
            }
        ),
        flush=True,
    )

    total_imported = 0
    # total_skipped is always 0: the upsert strategy is ON CONFLICT DO UPDATE (not ignore),
    # so re-run duplicates overwrite rather than skip. No distinct "skip" path exists today.
    total_skipped = 0
    total_errors = 0
    chunk_num = 0

    with open(SOURCE_FILE, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        chunk: list[dict[str, str]] = []
        row_number = 0

        for row in reader:
            row_number += 1
            chunk.append(dict(row))

            if len(chunk) < CHUNK_SIZE:
                continue

            chunk_num += 1
            chunk_start = time.monotonic()
            base_row = row_number - len(chunk) + 1

            chunk_imported, chunk_errors = _process_chunk(
                client,
                chunk,
                chunk_num,
                base_row,
                batch_id,
                total_imported,
                total_skipped,
                total_errors,
            )

            total_imported += chunk_imported
            total_errors += chunk_errors
            elapsed = round(time.monotonic() - chunk_start, 2)

            print(
                json.dumps(
                    {
                        "event": "chunk_complete",
                        "batch_id": batch_id,
                        "chunk": chunk_num,
                        "imported": chunk_imported,
                        "skipped": 0,
                        "errors": chunk_errors,
                        "elapsed_s": elapsed,
                        "total_imported": total_imported,
                        "total_errors": total_errors,
                    }
                ),
                flush=True,
            )

            # Error threshold check — pause if chunk error rate exceeds threshold
            chunk_error_rate = (chunk_errors / len(chunk)) if chunk else 0
            if _chunk_error_rate_exceeded(chunk_errors, len(chunk)):
                _pause_batch(client, batch_id, total_imported, total_skipped, total_errors)
                print(
                    json.dumps(
                        {
                            "event": "paused_on_error_threshold",
                            "batch_id": batch_id,
                            "chunk": chunk_num,
                            "chunk_error_rate_pct": round(chunk_error_rate * 100, 2),
                            "threshold_pct": ERROR_THRESHOLD_PCT,
                            "action": "Run rollback_batch.py to purge partial batch or fix source data and retry",
                        }
                    ),
                    flush=True,
                )
                sys.exit(1)

            chunk = []

        # Process final partial chunk (< CHUNK_SIZE rows remaining)
        if chunk:
            chunk_num += 1
            chunk_start = time.monotonic()
            base_row = row_number - len(chunk) + 1

            chunk_imported, chunk_errors = _process_chunk(
                client,
                chunk,
                chunk_num,
                base_row,
                batch_id,
                total_imported,
                total_skipped,
                total_errors,
            )

            total_imported += chunk_imported
            total_errors += chunk_errors
            elapsed = round(time.monotonic() - chunk_start, 2)

            print(
                json.dumps(
                    {
                        "event": "chunk_complete",
                        "batch_id": batch_id,
                        "chunk": chunk_num,
                        "imported": chunk_imported,
                        "skipped": 0,
                        "errors": chunk_errors,
                        "elapsed_s": elapsed,
                    }
                ),
                flush=True,
            )

            chunk_error_rate = (chunk_errors / len(chunk)) if chunk else 0
            if _chunk_error_rate_exceeded(chunk_errors, len(chunk)):
                _pause_batch(client, batch_id, total_imported, total_skipped, total_errors)
                print(
                    json.dumps(
                        {
                            "event": "paused_on_error_threshold",
                            "batch_id": batch_id,
                            "chunk": chunk_num,
                            "chunk_error_rate_pct": round(chunk_error_rate * 100, 2),
                            "threshold_pct": ERROR_THRESHOLD_PCT,
                        }
                    ),
                    flush=True,
                )
                sys.exit(1)

    _complete_batch(client, batch_id, total_imported, total_skipped, total_errors)
    total_elapsed = round(time.monotonic() - start_time, 2)

    print(
        json.dumps(
            {
                "event": "migration_complete",
                "batch_id": batch_id,
                "total_imported": total_imported,
                "total_skipped": total_skipped,
                "total_errors": total_errors,
                "total_rows": total_rows,
                "chunks": chunk_num,
                "elapsed_s": total_elapsed,
                "next_step": "Run async deduplication worker over this batch (Story 2.5)",
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    run_migration()
