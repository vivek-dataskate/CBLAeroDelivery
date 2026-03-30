#!/usr/bin/env python3
"""
CBLAero Migration Batch Rollback Script
========================================
Purges all candidate rows associated with a specific import batch
and marks the batch as rolled_back.

Runs in delete transactions of 10,000 rows to avoid lock contention at scale.

Environment variables (required):
  SUPABASE_URL                 Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY    Service-role key (backend only)
  CBL_SUPABASE_SCHEMA          Schema name (default: cblaero_app)

Usage:
  python rollback_batch.py --batch-id <uuid>
"""

import argparse
import json
import sys
import os

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SCHEMA = os.environ.get("CBL_SUPABASE_SCHEMA", "cblaero_app")

DELETE_CHUNK_SIZE = 10_000


def _validate_config() -> None:
    missing = [
        name
        for name, val in {
            "SUPABASE_URL": SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_SERVICE_ROLE_KEY,
        }.items()
        if not val
    ]
    if missing:
        print(json.dumps({"event": "config_error", "missing_vars": missing}), flush=True)
        sys.exit(1)


def _build_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def _fetch_batch(client: Client, batch_id: str) -> dict | None:
    result = (
        client.schema(SCHEMA)
        .from_("import_batch")
        .select("id, status, imported, tenant_id")
        .eq("id", batch_id)
        .execute()
    )
    if not result.data:
        return None
    return result.data[0]


def _delete_candidate_rows_in_chunks(client: Client, batch_id: str) -> int:
    """Delete candidates by source_batch_id in chunks to avoid lock contention."""
    total_deleted = 0

    while True:
        # Fetch IDs of the next chunk of pending_dedup rows for this batch.
        fetch_result = (
            client.schema(SCHEMA)
            .from_("candidates")
            .select("id")
            .eq("source_batch_id", batch_id)
            .eq("ingestion_state", "pending_dedup")
            .limit(DELETE_CHUNK_SIZE)
            .execute()
        )
        ids = [row["id"] for row in (fetch_result.data or [])]
        if not ids:
            break

        client.schema(SCHEMA).from_("candidates").delete().in_("id", ids).execute()
        total_deleted += len(ids)

        print(
            json.dumps(
                {
                    "event": "candidates_chunk_deleted",
                    "batch_id": batch_id,
                    "chunk_deleted": len(ids),
                    "total_deleted": total_deleted,
                }
            ),
            flush=True,
        )

        if len(ids) < DELETE_CHUNK_SIZE:
            break

    return total_deleted


def _delete_row_errors(client: Client, batch_id: str) -> int:
    total_deleted = 0

    while True:
        fetch_result = (
            client.schema(SCHEMA)
            .from_("import_row_error")
            .select("id")
            .eq("batch_id", batch_id)
            .limit(DELETE_CHUNK_SIZE)
            .execute()
        )
        ids = [row["id"] for row in (fetch_result.data or [])]
        if not ids:
            break

        client.schema(SCHEMA).from_("import_row_error").delete().in_("id", ids).execute()
        total_deleted += len(ids)

        print(
            json.dumps(
                {
                    "event": "row_errors_chunk_deleted",
                    "batch_id": batch_id,
                    "chunk_deleted": len(ids),
                    "total_deleted": total_deleted,
                }
            ),
            flush=True,
        )

        if len(ids) < DELETE_CHUNK_SIZE:
            break

    return total_deleted


def _mark_batch_rolled_back(client: Client, batch_id: str) -> None:
    client.schema(SCHEMA).from_("import_batch").update(
        {"status": "rolled_back"}
    ).eq("id", batch_id).execute()


def run_rollback(batch_id: str) -> None:
    _validate_config()
    client = _build_client()

    batch = _fetch_batch(client, batch_id)
    if batch is None:
        print(
            json.dumps({"event": "error", "error": f"Batch not found: {batch_id}"}),
            flush=True,
        )
        sys.exit(1)

    if batch["status"] == "rolled_back":
        print(
            json.dumps({"event": "already_rolled_back", "batch_id": batch_id}),
            flush=True,
        )
        return

    if batch["status"] == "running":
        # Refuse to roll back a mid-flight batch: the migration script is actively writing
        # candidates, so a concurrent delete races against active inserts and can leave
        # orphaned rows. Stop the Render job first, then roll back.
        print(
            json.dumps(
                {
                    "event": "error",
                    "error": "Batch is currently running. Stop the migration job before rolling back.",
                    "batch_id": batch_id,
                    "status": batch["status"],
                }
            ),
            flush=True,
        )
        sys.exit(1)

    print(
        json.dumps({"event": "rollback_started", "batch_id": batch_id, "status": batch["status"]}),
        flush=True,
    )

    deleted_candidates = _delete_candidate_rows_in_chunks(client, batch_id)
    deleted_errors = _delete_row_errors(client, batch_id)
    _mark_batch_rolled_back(client, batch_id)

    print(
        json.dumps(
            {
                "event": "rollback_complete",
                "batch_id": batch_id,
                "candidates_deleted": deleted_candidates,
                "row_errors_deleted": deleted_errors,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Rollback a CBLAero import batch")
    parser.add_argument("--batch-id", required=True, help="UUID of the import_batch to roll back")
    args = parser.parse_args()
    run_rollback(args.batch_id)
