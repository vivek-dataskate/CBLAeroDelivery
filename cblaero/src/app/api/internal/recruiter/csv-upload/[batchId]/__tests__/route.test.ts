import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, issueSessionToken } from "@/modules/auth";
import {
  clearAuthorizationDenyEventsForTest,
  clearImportBatchAccessEventsForTest,
} from "@/modules/audit";

import { GET } from "../route";
import { clearCsvUploadStoreForTest, seedCsvUploadBatchForTest } from "../../shared";

const BASE_URL = "https://aerodelivery.onrender.com";

function withSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

function buildRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}

describe("GET /api/internal/recruiter/csv-upload/[batchId]", () => {
  beforeEach(async () => {
    clearCsvUploadStoreForTest();
    await clearAuthorizationDenyEventsForTest();
    await clearImportBatchAccessEventsForTest();
  });

  it("returns 404 for unknown batch ID", async () => {
    const issued = await issueSessionToken({
      actorId: "actor-recruiter-1",
      email: "recruiter@cblsolutions.com",
      tenantId: "tenant-alpha",
      role: "recruiter",
      rememberDevice: false,
    });

    const request = buildRequest(`${BASE_URL}/api/internal/recruiter/csv-upload/unknown-batch`, {
      method: "GET",
      headers: {
        cookie: withSessionCookie(issued.token),
      },
    });

    const response = await GET(request, {
      params: Promise.resolve({ batchId: "unknown-batch" }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for cross-tenant batch access", async () => {
    seedCsvUploadBatchForTest({
      id: "batch-tenant-alpha-1",
      tenant_id: "tenant-alpha",
      source: "csv_upload",
      status: "complete",
      total_rows: 3,
      imported: 3,
      skipped: 0,
      errors: 0,
      error_threshold_pct: 5,
      created_by_actor_id: "actor-recruiter-1",
      started_at: "2026-03-30T12:00:00.000Z",
      completed_at: "2026-03-30T12:00:05.000Z",
    });

    const issued = await issueSessionToken({
      actorId: "actor-recruiter-2",
      email: "other@cblsolutions.com",
      tenantId: "tenant-beta",
      role: "recruiter",
      rememberDevice: false,
    });

    const request = buildRequest(
      `${BASE_URL}/api/internal/recruiter/csv-upload/batch-tenant-alpha-1`,
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(issued.token),
        },
      },
    );

    const response = await GET(request, {
      params: Promise.resolve({ batchId: "batch-tenant-alpha-1" }),
    });

    expect(response.status).toBe(404);
  });

  it("returns seeded batch status payload", async () => {
    seedCsvUploadBatchForTest({
      id: "batch-tenant-alpha-2",
      tenant_id: "tenant-alpha",
      source: "csv_upload",
      status: "running",
      total_rows: 8,
      imported: 3,
      skipped: 0,
      errors: 1,
      error_threshold_pct: 5,
      created_by_actor_id: "actor-recruiter-3",
      started_at: "2026-03-30T12:00:00.000Z",
      completed_at: null,
    });

    const issued = await issueSessionToken({
      actorId: "actor-recruiter-3",
      email: "recruiter@cblsolutions.com",
      tenantId: "tenant-alpha",
      role: "recruiter",
      rememberDevice: false,
    });

    const request = buildRequest(
      `${BASE_URL}/api/internal/recruiter/csv-upload/batch-tenant-alpha-2`,
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(issued.token),
        },
      },
    );

    const response = await GET(request, {
      params: Promise.resolve({ batchId: "batch-tenant-alpha-2" }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.batchId).toBe("batch-tenant-alpha-2");
    expect(body.data.status).toBe("running");
    expect(body.data.imported).toBe(3);
    expect(body.data.totalRows).toBe(8);
    expect(body.data.errors).toBe(1);
    expect(typeof body.data.elapsedMs === "number" || body.data.elapsedMs === null).toBe(true);
  });
});
