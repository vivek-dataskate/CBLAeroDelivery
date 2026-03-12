import { NextRequest, NextResponse } from "next/server";

import {
  SESSION_COOKIE_NAME,
  authorizeAccess,
  buildStepUpReauthenticateUrl,
  isSessionFreshForStepUp,
  validateActiveSession,
  type AuthSession,
} from "@/modules/auth";
import { recordStepUpAttemptEvent } from "@/modules/audit";

type CandidatePostBody = {
  tenantId?: unknown;
  candidateIds?: unknown;
  action?: unknown;
  format?: unknown;
};

type SensitiveCandidateAction =
  | "candidate:communication-history-access"
  | "candidate:data-export";

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

function parseBooleanInput(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveSensitiveReadAction(request: NextRequest): SensitiveCandidateAction | null {
  const view = request.nextUrl.searchParams.get("view")?.trim().toLowerCase() ?? null;
  const includeCommunicationHistory = parseBooleanInput(
    request.nextUrl.searchParams.get("includeCommunicationHistory"),
  );

  if (
    includeCommunicationHistory ||
    view === "communication-history" ||
    view === "communication_history"
  ) {
    return "candidate:communication-history-access";
  }

  return null;
}

function resolveSensitiveWriteAction(payload: CandidatePostBody): SensitiveCandidateAction | null {
  if (typeof payload.action !== "string") {
    return null;
  }

  const normalized = payload.action.trim().toLowerCase();
  if (
    normalized === "export" ||
    normalized === "data-export" ||
    normalized === "data_export"
  ) {
    return "candidate:data-export";
  }

  return null;
}

async function enforceStepUpForSensitiveOperation(
  request: NextRequest,
  session: AuthSession,
  traceId: string,
  sensitiveAction: SensitiveCandidateAction | null,
): Promise<NextResponse | null> {
  if (!sensitiveAction) {
    return null;
  }

  if (!isSessionFreshForStepUp(session)) {
    await recordStepUpAttemptEvent({
      traceId,
      actorId: session.actorId,
      tenantId: session.tenantId,
      role: session.role,
      path: request.nextUrl.pathname,
      method: request.method,
      action: sensitiveAction,
      outcome: "challenged",
      reason: "fresh_auth_required",
    });

    return NextResponse.json(
      {
        error: {
          code: "step_up_required",
          message: "Fresh authentication is required for this sensitive operation.",
          reauthenticateUrl: buildStepUpReauthenticateUrl(request.nextUrl.pathname),
        },
      },
      { status: 428 },
    );
  }

  await recordStepUpAttemptEvent({
    traceId,
    actorId: session.actorId,
    tenantId: session.tenantId,
    role: session.role,
    path: request.nextUrl.pathname,
    method: request.method,
    action: sensitiveAction,
    outcome: "verified",
    reason: null,
  });

  return null;
}

export async function GET(request: NextRequest) {
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const requestedTenantId = request.nextUrl.searchParams.get("tenantId");
  const session = await validateActiveSession(extractSessionToken(request));

  const authz = await authorizeAccess({
    session,
    action: "candidate:read",
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
          message: "Access denied for candidate read operation.",
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

  const stepUpResponse = await enforceStepUpForSensitiveOperation(
    request,
    session,
    traceId,
    resolveSensitiveReadAction(request),
  );
  if (stepUpResponse) {
    return stepUpResponse;
  }

  return NextResponse.json({
    data: [
      {
        candidateId: "cand-001",
        tenantId: session.tenantId,
        status: "active",
      },
    ],
    meta: {
      tenantId: session.tenantId,
      readScope: "tenant-isolated",
    },
  });
}

export async function POST(request: NextRequest) {
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const session = await validateActiveSession(extractSessionToken(request));

  const authz = await authorizeAccess({
    session,
    action: "candidate:write",
    path: request.nextUrl.pathname,
    method: request.method,
    traceId,
  });

  if (!authz.allowed) {
    return NextResponse.json(
      {
        error: {
          code: toErrorCode(authz.reason),
          message: "Access denied for candidate write operation.",
        },
      },
      { status: authz.status },
    );
  }

  let payload: CandidatePostBody;
  try {
    payload = (await request.json()) as CandidatePostBody;
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  const requestedTenantId =
    typeof payload.tenantId === "string" && payload.tenantId.trim().length > 0
      ? payload.tenantId.trim()
      : null;

  if (requestedTenantId) {
    const tenantAuthz = await authorizeAccess({
      session,
      action: "candidate:write",
      requestedTenantId,
      path: request.nextUrl.pathname,
      method: request.method,
      traceId,
    });

    if (!tenantAuthz.allowed) {
      return NextResponse.json(
        {
          error: {
            code: toErrorCode(tenantAuthz.reason),
            message: "Access denied for candidate write operation.",
          },
        },
        { status: tenantAuthz.status },
      );
    }
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

  const sensitiveAction = resolveSensitiveWriteAction(payload);
  const stepUpResponse = await enforceStepUpForSensitiveOperation(
    request,
    session,
    traceId,
    sensitiveAction,
  );
  if (stepUpResponse) {
    return stepUpResponse;
  }

  const candidateIds = Array.isArray(payload.candidateIds)
    ? payload.candidateIds.filter((item): item is string => typeof item === "string")
    : [];

  if (sensitiveAction === "candidate:data-export") {
    const format =
      typeof payload.format === "string" && payload.format.trim().length > 0
        ? payload.format.trim().toLowerCase()
        : "csv";

    return NextResponse.json({
      data: {
        exportId: `exp-${crypto.randomUUID()}`,
        status: "queued",
        format,
        candidateCount: candidateIds.length,
        tenantId: session.tenantId,
      },
      meta: {
        writeScope: "tenant-isolated",
      },
    });
  }

  return NextResponse.json({
    data: {
      updated: candidateIds.length,
      tenantId: session.tenantId,
    },
    meta: {
      writeScope: "tenant-isolated",
    },
  });
}