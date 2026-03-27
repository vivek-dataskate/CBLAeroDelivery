import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  validateActiveSessionMock: vi.fn(),
  authorizeAccessMock: vi.fn(),
  recordDataResidencyCheckEventMock: vi.fn(),
  listDataResidencyCheckEventsMock: vi.fn(),
}));

vi.mock("@/modules/auth", () => ({
  SESSION_COOKIE_NAME: "cbl_session",
  validateActiveSession: mocks.validateActiveSessionMock,
  authorizeAccess: mocks.authorizeAccessMock,
}));

vi.mock("@/modules/audit", () => ({
  recordDataResidencyCheckEvent: mocks.recordDataResidencyCheckEventMock,
  listDataResidencyCheckEvents: mocks.listDataResidencyCheckEventsMock,
}));

import { GET } from "../route";

describe("data residency endpoint production semantics", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CBL_APPROVED_US_REGIONS", "us-east-1,us-west-2");
    vi.stubEnv("CBL_DATA_REGION", "eu-central-1");
    vi.stubEnv("CBL_LOG_REGION", "us-east-1");
    vi.stubEnv("CBL_BACKUP_REGION", "us-west-2");

    mocks.validateActiveSessionMock.mockResolvedValue({
      actorId: "actor-admin-1",
      tenantId: "tenant-a",
      role: "admin",
    });

    mocks.authorizeAccessMock.mockResolvedValue({
      allowed: true,
    });

    mocks.recordDataResidencyCheckEventMock.mockResolvedValue(undefined);
    mocks.listDataResidencyCheckEventsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns explicit policy failure and skips historical list query", async () => {
    const request = new NextRequest(
      "https://aerodelivery.onrender.com/api/internal/compliance/data-residency",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(412);
    expect(body.error.code).toBe("data_residency_policy_failed");
    expect(body.error.message).toContain("CBL_DATA_REGION=eu-central-1");
    expect(mocks.listDataResidencyCheckEventsMock).not.toHaveBeenCalled();
  });
});