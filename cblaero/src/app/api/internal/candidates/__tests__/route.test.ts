import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { clearAdminGovernanceStoreForTest } from "@/modules/admin";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/modules/auth";
import {
  clearAuthorizationDenyEventsForTest,
  clearStepUpAttemptEventsForTest,
  listAuthorizationDenyEvents,
  listStepUpAttemptEvents,
} from "@/modules/audit";

import { GET, POST } from "../route";

function buildRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}

function withSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

describe("internal candidates API authorization", () => {
  beforeEach(async () => {
    await clearAdminGovernanceStoreForTest();
    await clearAuthorizationDenyEventsForTest();
    await clearStepUpAttemptEventsForTest();
  });

  it("returns 401 for unauthenticated requests", async () => {
    const request = buildRequest("https://aerodelivery.onrender.com/api/internal/candidates");
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");

    const events = await listAuthorizationDenyEvents();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("unauthenticated");
  });

  it("returns 401 before parsing malformed write body when unauthenticated", async () => {
    const request = buildRequest("https://aerodelivery.onrender.com/api/internal/candidates", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{",
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");

    const events = await listAuthorizationDenyEvents();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("unauthenticated");
    expect(events[0].method).toBe("POST");
  });

  it("allows role-permitted tenant read", async () => {
    const issued = await issueSessionToken({
      actorId: "actor-admin",
      email: "admin@cblsolutions.com",
      tenantId: "tenant-a",
      role: "admin",
      rememberDevice: false,
    });

    const request = buildRequest(
      "https://aerodelivery.onrender.com/api/internal/candidates?tenantId=tenant-a",
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(issued.token),
        },
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta.tenantId).toBe("tenant-a");
    expect(Array.isArray(body.data)).toBe(true);
    expect(await listAuthorizationDenyEvents()).toHaveLength(0);
  });

  it("denies cross-tenant access attempts", async () => {
    const issued = await issueSessionToken({
      actorId: "actor-admin-2",
      email: "admin@cblsolutions.com",
      tenantId: "tenant-a",
      role: "admin",
      rememberDevice: false,
    });

    const request = buildRequest(
      "https://aerodelivery.onrender.com/api/internal/candidates?tenantId=tenant-b",
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(issued.token),
          "x-trace-id": "trace-cross-tenant",
        },
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("tenant_forbidden");

    const events = await listAuthorizationDenyEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace-cross-tenant",
      reason: "tenant_mismatch",
      requestedTenantId: "tenant-b",
      sessionTenantId: "tenant-a",
    });
  });

  it("denies recruiter write operations by role", async () => {
    const issued = await issueSessionToken({
      actorId: "actor-rec",
      email: "recruiter@cblsolutions.com",
      tenantId: "tenant-a",
      role: "recruiter",
      rememberDevice: false,
    });

    const request = buildRequest("https://aerodelivery.onrender.com/api/internal/candidates", {
      method: "POST",
      headers: {
        cookie: withSessionCookie(issued.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tenantId: "tenant-a",
        candidateIds: ["cand-1", "cand-2"],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");

    const events = await listAuthorizationDenyEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "forbidden_role",
      role: "recruiter",
      method: "POST",
    });
  });

  it("requires step-up for stale communication-history reads", async () => {
    const staleIssued = await issueSessionToken(
      {
        actorId: "actor-admin-stale-read",
        email: "admin@cblsolutions.com",
        tenantId: "tenant-a",
        role: "admin",
        rememberDevice: false,
      },
      Date.now() - 10 * 60 * 1000,
    );

    const request = buildRequest(
      "https://aerodelivery.onrender.com/api/internal/candidates?tenantId=tenant-a&view=communication-history",
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(staleIssued.token),
          "x-trace-id": "trace-stepup-read-challenged",
        },
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(428);
    expect(body.error.code).toBe("step_up_required");
    expect(typeof body.error.reauthenticateUrl).toBe("string");

    const events = await listStepUpAttemptEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace-stepup-read-challenged",
      action: "candidate:communication-history-access",
      outcome: "challenged",
      reason: "fresh_auth_required",
    });
  });

  it("allows fresh communication-history reads and records verified step-up", async () => {
    const freshIssued = await issueSessionToken({
      actorId: "actor-admin-fresh-read",
      email: "admin@cblsolutions.com",
      tenantId: "tenant-a",
      role: "admin",
      rememberDevice: false,
    });

    const request = buildRequest(
      "https://aerodelivery.onrender.com/api/internal/candidates?tenantId=tenant-a&includeCommunicationHistory=true",
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(freshIssued.token),
          "x-trace-id": "trace-stepup-read-verified",
        },
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);

    const events = await listStepUpAttemptEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace-stepup-read-verified",
      action: "candidate:communication-history-access",
      outcome: "verified",
      reason: null,
    });
  });

  it("requires step-up for stale export writes", async () => {
    const staleIssued = await issueSessionToken(
      {
        actorId: "actor-admin-stale-export",
        email: "admin@cblsolutions.com",
        tenantId: "tenant-a",
        role: "admin",
        rememberDevice: false,
      },
      Date.now() - 10 * 60 * 1000,
    );

    const request = buildRequest("https://aerodelivery.onrender.com/api/internal/candidates", {
      method: "POST",
      headers: {
        cookie: withSessionCookie(staleIssued.token),
        "content-type": "application/json",
        "x-trace-id": "trace-stepup-export-challenged",
      },
      body: JSON.stringify({
        tenantId: "tenant-a",
        action: "export",
        format: "csv",
        candidateIds: ["cand-1", "cand-2"],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(428);
    expect(body.error.code).toBe("step_up_required");

    const events = await listStepUpAttemptEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace-stepup-export-challenged",
      action: "candidate:data-export",
      outcome: "challenged",
      reason: "fresh_auth_required",
    });
  });

  it("allows fresh export writes and records verified step-up", async () => {
    const freshIssued = await issueSessionToken({
      actorId: "actor-admin-fresh-export",
      email: "admin@cblsolutions.com",
      tenantId: "tenant-a",
      role: "admin",
      rememberDevice: false,
    });

    const request = buildRequest("https://aerodelivery.onrender.com/api/internal/candidates", {
      method: "POST",
      headers: {
        cookie: withSessionCookie(freshIssued.token),
        "content-type": "application/json",
        "x-trace-id": "trace-stepup-export-verified",
      },
      body: JSON.stringify({
        tenantId: "tenant-a",
        action: "export",
        format: "csv",
        candidateIds: ["cand-3"],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("queued");
    expect(body.data.format).toBe("csv");
    expect(body.data.candidateCount).toBe(1);

    const events = await listStepUpAttemptEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace-stepup-export-verified",
      action: "candidate:data-export",
      outcome: "verified",
      reason: null,
    });
  });
});