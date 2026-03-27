import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, issueSessionToken } from "@/modules/auth";
import {
  clearAuthorizationDenyEventsForTest,
  clearDataResidencyCheckEventsForTest,
  listAuthorizationDenyEvents,
  listDataResidencyCheckEvents,
} from "@/modules/audit";

import { GET } from "../route";

const ENV_KEYS = [
  "CBL_APPROVED_US_REGIONS",
  "CBL_DATA_REGION",
  "CBL_LOG_REGION",
  "CBL_BACKUP_REGION",
] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

const PERSISTENCE_KEYS = [
  "CBL_SUPABASE_URL",
  "CBL_SUPABASE_SERVICE_ROLE_KEY",
  "CBL_SUPABASE_SCHEMA",
] as const;

type PersistenceSnapshot = Partial<Record<(typeof PERSISTENCE_KEYS)[number], string | undefined>>;

function withSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

function buildRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}

function snapshotEnv(): EnvSnapshot {
  return {
    CBL_APPROVED_US_REGIONS: process.env.CBL_APPROVED_US_REGIONS,
    CBL_DATA_REGION: process.env.CBL_DATA_REGION,
    CBL_LOG_REGION: process.env.CBL_LOG_REGION,
    CBL_BACKUP_REGION: process.env.CBL_BACKUP_REGION,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (typeof value === "undefined") {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

describe("internal data residency compliance API", () => {
  let envSnapshot: EnvSnapshot;
  let persistenceSnapshot: PersistenceSnapshot;

  function snapshotPersistenceEnv(): PersistenceSnapshot {
    return {
      CBL_SUPABASE_URL: process.env.CBL_SUPABASE_URL,
      CBL_SUPABASE_SERVICE_ROLE_KEY: process.env.CBL_SUPABASE_SERVICE_ROLE_KEY,
      CBL_SUPABASE_SCHEMA: process.env.CBL_SUPABASE_SCHEMA,
    };
  }

  function restorePersistenceEnv(snapshot: PersistenceSnapshot): void {
    for (const key of PERSISTENCE_KEYS) {
      const value = snapshot[key];
      if (typeof value === "undefined") {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }
  }

  beforeEach(async () => {
    envSnapshot = snapshotEnv();
    persistenceSnapshot = snapshotPersistenceEnv();
    delete process.env.CBL_SUPABASE_URL;
    delete process.env.CBL_SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.CBL_SUPABASE_SCHEMA;
    await clearAuthorizationDenyEventsForTest();
    await clearDataResidencyCheckEventsForTest();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    restorePersistenceEnv(persistenceSnapshot);
  });

  it("returns 401 for unauthenticated request", async () => {
    const request = buildRequest("https://aerodelivery.onrender.com/api/internal/compliance/data-residency");
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");

    const denials = await listAuthorizationDenyEvents();
    expect(denials).toHaveLength(1);
    expect(denials[0].reason).toBe("unauthenticated");
  });

  it("denies recruiter from querying residency evidence", async () => {
    const recruiter = await issueSessionToken({
      actorId: "actor-rec-1",
      email: "recruiter@cblsolutions.com",
      tenantId: "tenant-a",
      role: "recruiter",
      rememberDevice: false,
    });

    const request = buildRequest(
      "https://aerodelivery.onrender.com/api/internal/compliance/data-residency",
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(recruiter.token),
          "x-trace-id": "trace-residency-forbidden",
        },
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");

    const denials = await listAuthorizationDenyEvents();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      traceId: "trace-residency-forbidden",
      reason: "forbidden_role",
    });
  });

  it("returns pass evidence for compliance officer with approved US regions", async () => {
    process.env.CBL_APPROVED_US_REGIONS = "us-east-1,us-west-2";
    process.env.CBL_DATA_REGION = "us-west-2";
    process.env.CBL_LOG_REGION = "us-east-1";
    process.env.CBL_BACKUP_REGION = "us-west-2";

    const complianceOfficer = await issueSessionToken({
      actorId: "actor-comp-1",
      email: "compliance@cblsolutions.com",
      tenantId: "tenant-a",
      role: "compliance-officer",
      rememberDevice: false,
    });

    const request = buildRequest(
      "https://aerodelivery.onrender.com/api/internal/compliance/data-residency",
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(complianceOfficer.token),
          "x-trace-id": "trace-residency-pass",
        },
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.current.status).toBe("pass");
    expect(body.data.current.violations).toEqual([]);

    const checks = await listDataResidencyCheckEvents("tenant-a");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      traceId: "trace-residency-pass",
      status: "pass",
      tenantId: "tenant-a",
    });
  });

  it("returns explicit failure details for non-approved region", async () => {
    process.env.CBL_APPROVED_US_REGIONS = "us-east-1,us-west-2";
    process.env.CBL_DATA_REGION = "eu-central-1";
    process.env.CBL_LOG_REGION = "us-east-1";
    process.env.CBL_BACKUP_REGION = "us-west-2";

    const admin = await issueSessionToken({
      actorId: "actor-admin-1",
      email: "admin@cblsolutions.com",
      tenantId: "tenant-a",
      role: "admin",
      rememberDevice: false,
    });

    const request = buildRequest(
      "https://aerodelivery.onrender.com/api/internal/compliance/data-residency",
      {
        method: "GET",
        headers: {
          cookie: withSessionCookie(admin.token),
          "x-trace-id": "trace-residency-fail",
        },
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(412);
    expect(body.error.code).toBe("data_residency_policy_failed");
    expect(body.error.message).toContain("CBL_DATA_REGION=eu-central-1");
    expect(body.error.message).toContain("approved USA regions: us-east-1, us-west-2");
    expect(body.data.current.status).toBe("fail");

    const checks = await listDataResidencyCheckEvents("tenant-a");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      traceId: "trace-residency-fail",
      status: "fail",
    });
  });
});
