import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";
import {
  listDataResidencyCheckEvents,
  recordDataResidencyCheckEvent,
} from "@/modules/audit";
import { evaluateUsaDataResidencyPolicy } from "@/modules/persistence/data-residency";

function toErrorCode(reason: "unauthenticated" | "forbidden_role" | "tenant_mismatch"): string {
  if (reason === "unauthenticated") {
    return "unauthenticated";
  }

  if (reason === "tenant_mismatch") {
    return "tenant_forbidden";
  }

  return "forbidden";
}

function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function GET(request: NextRequest) {
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const requestedTenantId = request.nextUrl.searchParams.get("tenantId");
  const session = await validateActiveSession(extractSessionToken(request));

  const authz = await authorizeAccess({
    session,
    action: "compliance:read-data-residency",
    requestedTenantId,
    path: request.nextUrl.pathname,
    method: request.method,
    traceId,
  });

  if (!authz.allowed) {
    return NextResponse.json(
      {
        error: {
          code: toErrorCode(authz.reason),
          message: "Access denied for data residency compliance evidence query.",
        },
      },
      { status: authz.status },
    );
  }

  if (!session) {
    return NextResponse.json(
      {
        error: {
          code: "unauthenticated",
          message: "Authentication is required.",
        },
      },
      { status: 401 },
    );
  }

  const tenantId = requestedTenantId ?? session.tenantId;
  const validation = evaluateUsaDataResidencyPolicy();
  const status = validation.valid ? "pass" : "fail";

  await recordDataResidencyCheckEvent({
    traceId,
    actorId: session.actorId,
    tenantId,
    status,
    approvedRegions: validation.approvedRegions,
    checkedTargets: validation.targets,
    violations: validation.violations,
  });

  if (!validation.valid) {
    return NextResponse.json(
      {
        data: {
          current: {
            status,
            approvedRegions: validation.approvedRegions,
            checkedTargets: validation.targets,
            violations: validation.violations,
          },
          checks: [],
        },
        meta: {
          tenantId,
          count: 0,
        },
        error: {
          code: "data_residency_policy_failed",
          message: `USA data residency policy gate failed: ${validation.violations.join(" ")}`,
        },
      },
      { status: 412 },
    );
  }

  const events = await listDataResidencyCheckEvents(tenantId);
  const latestChecks = events.slice(0, 50).reverse();

  const responseBody = {
    data: {
      current: {
        status,
        approvedRegions: validation.approvedRegions,
        checkedTargets: validation.targets,
        violations: validation.violations,
      },
      checks: latestChecks,
    },
    meta: {
      tenantId,
      count: latestChecks.length,
    },
  };

  return NextResponse.json(responseBody);
}
