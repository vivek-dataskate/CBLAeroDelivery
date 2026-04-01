import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";

import {
  listCandidates,
} from "@/features/candidate-management/infrastructure/candidate-repository";
import type { AvailabilityStatus } from "@/features/candidate-management/contracts/candidate";

import {
  SESSION_COOKIE_NAME,
  authorizeAccess,
  AUTH_ISSUER,
  buildStepUpReauthenticateUrl,
  getAuthSigningSecret,
  isSessionFreshForStepUp,
  validateActiveSession,
  type AuthSession,
} from "@/modules/auth";
import {
  recordClientContextConfirmationEvent,
  recordStepUpAttemptEvent,
} from "@/modules/audit";
import {
  getSupabaseAdminClient,
  shouldUseInMemoryPersistenceForTests,
} from "@/modules/persistence";

type CandidatePostBody = {
  tenantId?: unknown;
  activeClientId?: unknown;
  crossClientConfirmationToken?: unknown;
  candidateIds?: unknown;
  action?: unknown;
  format?: unknown;
};

type SensitiveCandidateAction =
  | "candidate:communication-history-access"
  | "candidate:data-export";

const CROSS_CLIENT_CONFIRMATION_AUDIENCE = "cblaero-cross-client-confirmation";
const CROSS_CLIENT_CONFIRMATION_TTL_SECONDS = 5 * 60;

type CrossClientConfirmationPayload = JWTPayload & {
  actor_id: string;
  active_client_id: string;
  target_client_id: string;
  action: string;
  path: string;
  method: string;
  intent_hash: string;
};

const usedCrossClientConfirmationTokenExpirations = new Map<string, number>();

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

function asOptionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCandidateIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return [...new Set(normalized)].sort();
}

function resolveExportFormat(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function buildCrossClientIntentHash(input: {
  targetClientId: string;
  action: string;
  candidateIds: string[];
  format: string | null;
}): string {
  const canonical = JSON.stringify({
    targetClientId: input.targetClientId,
    action: input.action,
    candidateIds: [...input.candidateIds],
    format: input.format,
  });

  return createHash("sha256").update(canonical).digest("base64url");
}

function resolveRequestedTenantId(payload: CandidatePostBody): string | null {
  return asOptionalTrimmedString(payload.tenantId);
}

function isInMemoryMode(): boolean {
  return shouldUseInMemoryPersistenceForTests();
}

function asEpochSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

function cleanupExpiredConfirmationTokens(nowEpochSec: number): void {
  for (const [jti, expiresAtEpochSec] of usedCrossClientConfirmationTokenExpirations.entries()) {
    if (expiresAtEpochSec <= nowEpochSec) {
      usedCrossClientConfirmationTokenExpirations.delete(jti);
    }
  }
}

function getAllowedClientIds(session: AuthSession): string[] {
  const allowed = session.clientIds ?? [session.tenantId];
  const unique = new Set<string>(allowed);
  unique.add(session.tenantId);
  return [...unique];
}

function toSigningKey(): Uint8Array {
  return new TextEncoder().encode(getAuthSigningSecret());
}

async function issueCrossClientConfirmationToken(input: {
  actorId: string;
  activeClientId: string;
  targetClientId: string;
  action: string;
  path: string;
  method: string;
  intentHash: string;
  nowMs?: number;
}): Promise<{ token: string; expiresAtIso: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const nowEpochSec = Math.floor(nowMs / 1000);
  const expiresAtEpochSec = nowEpochSec + CROSS_CLIENT_CONFIRMATION_TTL_SECONDS;

  const token = await new SignJWT({
    actor_id: input.actorId,
    active_client_id: input.activeClientId,
    target_client_id: input.targetClientId,
    action: input.action,
    path: input.path,
    method: input.method,
    intent_hash: input.intentHash,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(AUTH_ISSUER)
    .setAudience(CROSS_CLIENT_CONFIRMATION_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt(nowEpochSec)
    .setExpirationTime(expiresAtEpochSec)
    .sign(toSigningKey());

  return {
    token,
    expiresAtIso: new Date(expiresAtEpochSec * 1000).toISOString(),
  };
}

async function verifyCrossClientConfirmationToken(input: {
  token: string;
  actorId: string;
  activeClientId: string;
  targetClientId: string;
  action: string;
  path: string;
  method: string;
  intentHash: string;
}): Promise<{ jti: string; expiresAtEpochSec: number } | null> {
  try {
    const { payload } = await jwtVerify(input.token, toSigningKey(), {
      issuer: AUTH_ISSUER,
      audience: CROSS_CLIENT_CONFIRMATION_AUDIENCE,
      algorithms: ["HS256"],
    });

    const confirmation = payload as CrossClientConfirmationPayload;
    const jti = typeof confirmation.jti === "string" ? confirmation.jti : null;
    const expiresAtEpochSec = typeof confirmation.exp === "number" ? confirmation.exp : null;

    if (!jti || expiresAtEpochSec === null) {
      return null;
    }

    const claimsMatch =
      confirmation.actor_id === input.actorId &&
      confirmation.active_client_id === input.activeClientId &&
      confirmation.target_client_id === input.targetClientId &&
      confirmation.action === input.action &&
      confirmation.path === input.path &&
      confirmation.method === input.method &&
      confirmation.intent_hash === input.intentHash;

    if (!claimsMatch) {
      return null;
    }

    return {
      jti,
      expiresAtEpochSec,
    };
  } catch {
    return null;
  }
}

async function consumeCrossClientConfirmationToken(
  jti: string,
  expiresAtEpochSec: number,
): Promise<boolean> {
  if (isInMemoryMode()) {
    const nowEpochSec = asEpochSeconds(Date.now());
    cleanupExpiredConfirmationTokens(nowEpochSec);

    const existing = usedCrossClientConfirmationTokenExpirations.get(jti);
    if (existing && existing > nowEpochSec) {
      return false;
    }

    usedCrossClientConfirmationTokenExpirations.set(jti, expiresAtEpochSec);
    return true;
  }

  const nowIso = new Date().toISOString();
  const client = getSupabaseAdminClient();
  await client
    .from("cross_client_confirmation_token_uses")
    .delete()
    .lte("expires_at", nowIso);

  const { error } = await client.from("cross_client_confirmation_token_uses").insert({
    jti,
    expires_at: new Date(expiresAtEpochSec * 1000).toISOString(),
    consumed_at: nowIso,
  });

  if (!error) {
    return true;
  }

  if (error.code === "23505") {
    return false;
  }

  throw new Error(`Failed to consume cross-client confirmation token: ${error.message}`);
}

function resolveActionScope(payload: CandidatePostBody, session: AuthSession) {
  const requestedTenantId = resolveRequestedTenantId(payload);
  const allowedClientIds = getAllowedClientIds(session);
  const providedActiveClientId = asOptionalTrimmedString(payload.activeClientId);
  const activeClientId = providedActiveClientId ?? session.tenantId;

  if (!allowedClientIds.includes(activeClientId)) {
    return {
      error: NextResponse.json(
        {
          error: {
            code: "active_client_forbidden",
            message: "The active client scope must be one of your authorized client contexts.",
          },
        },
        { status: 403 },
      ),
      activeClientId,
      targetClientId: requestedTenantId ?? activeClientId,
      requestedTenantId,
    };
  }

  return {
    error: null,
    activeClientId,
    targetClientId: requestedTenantId ?? activeClientId,
    requestedTenantId,
  };
}

async function enforceCrossClientConfirmation(
  payload: CandidatePostBody,
  session: AuthSession,
  traceId: string,
  activeClientId: string,
  targetClientId: string,
  action: string,
  intentHash: string,
  path: string,
  method: string,
): Promise<NextResponse | null> {
  if (activeClientId === targetClientId) {
    return null;
  }

  const providedToken = asOptionalTrimmedString(payload.crossClientConfirmationToken);
  const tokenVerification =
    providedToken !== null
      ? await verifyCrossClientConfirmationToken({
          token: providedToken,
          actorId: session.actorId,
          activeClientId,
          targetClientId,
          action,
          intentHash,
          path,
          method,
        })
      : null;

  const confirmed = tokenVerification
    ? await consumeCrossClientConfirmationToken(
        tokenVerification.jti,
        tokenVerification.expiresAtEpochSec,
      )
    : false;

  if (!confirmed) {
    const challenge = await issueCrossClientConfirmationToken({
      actorId: session.actorId,
      activeClientId,
      targetClientId,
      action,
      intentHash,
      path,
      method,
    });

    await recordClientContextConfirmationEvent({
      traceId,
      actorId: session.actorId,
      role: session.role,
      tenantId: session.tenantId,
      activeClientId,
      targetClientId,
      action,
      path,
      method,
      outcome: "required",
    });

    return NextResponse.json(
      {
        error: {
          code: "cross_client_confirmation_required",
          message:
            "Explicit confirmation is required before executing this cross-client action.",
          activeClientId,
          targetClientId,
          confirmationToken: challenge.token,
          confirmationExpiresAt: challenge.expiresAtIso,
        },
      },
      { status: 409 },
    );
  }

  await recordClientContextConfirmationEvent({
    traceId,
    actorId: session.actorId,
    role: session.role,
    tenantId: session.tenantId,
    activeClientId,
    targetClientId,
    action,
    path,
    method,
    outcome: "confirmed",
  });

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

  const availabilityStatusRaw = request.nextUrl.searchParams.get("availability_status");
  const location = request.nextUrl.searchParams.get("location");
  const certType = request.nextUrl.searchParams.get("cert_type");
  const search = request.nextUrl.searchParams.get("search");

  const VALID_AVAILABILITY: ReadonlySet<string> = new Set(["active", "passive", "unavailable"]);
  if (availabilityStatusRaw && !VALID_AVAILABILITY.has(availabilityStatusRaw)) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_filter",
          message: `Invalid availability_status value. Must be one of: active, passive, unavailable.`,
        },
      },
      { status: 400 },
    );
  }
  const availabilityStatus = availabilityStatusRaw as AvailabilityStatus | null;

  const hasFilter = !!(availabilityStatus || location || certType || search);
  if (!hasFilter) {
    return NextResponse.json(
      {
        error: {
          code: "filter_required",
          message:
            "At least one pre-filter is required: availability_status, location, or cert_type.",
        },
      },
      { status: 400 },
    );
  }

  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 25)) : undefined;

  const result = await listCandidates({
    tenantId: session.tenantId,
    availabilityStatus: availabilityStatus ?? undefined,
    location: location ?? undefined,
    certType: certType ?? undefined,
    search: search ?? undefined,
    cursor,
    limit,
  });

  return NextResponse.json({
    data: result.items,
    meta: {
      tenantId: session.tenantId,
      activeClientId: session.tenantId,
      targetClientId: requestedTenantId ?? session.tenantId,
      readScope: "tenant-isolated",
      nextCursor: result.nextCursor,
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

  const {
    error: actionScopeError,
    activeClientId,
    targetClientId,
    requestedTenantId,
  } = resolveActionScope(payload, session);
  if (actionScopeError) {
    return actionScopeError;
  }

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

  const sensitiveAction = resolveSensitiveWriteAction(payload);
  const candidateIds = normalizeCandidateIds(payload.candidateIds);
  const exportFormat = resolveExportFormat(payload.format);
  const actionScope = sensitiveAction ?? "candidate:update";
  const confirmationIntentHash = buildCrossClientIntentHash({
    targetClientId,
    action: actionScope,
    candidateIds,
    format: sensitiveAction === "candidate:data-export" ? exportFormat ?? "csv" : null,
  });

  const stepUpResponse = await enforceStepUpForSensitiveOperation(
    request,
    session,
    traceId,
    sensitiveAction,
  );
  if (stepUpResponse) {
    return stepUpResponse;
  }

  const confirmationResponse = await enforceCrossClientConfirmation(
    payload,
    session,
    traceId,
    activeClientId,
    targetClientId,
    actionScope,
    confirmationIntentHash,
    request.nextUrl.pathname,
    request.method,
  );
  if (confirmationResponse) {
    return confirmationResponse;
  }

  if (sensitiveAction === "candidate:data-export") {
    const format = exportFormat ?? "csv";

    return NextResponse.json({
      data: {
        exportId: `exp-${crypto.randomUUID()}`,
        status: "queued",
        format,
        candidateCount: candidateIds.length,
        tenantId: targetClientId,
      },
      meta: {
        activeClientId,
        targetClientId,
        writeScope: "tenant-isolated",
      },
    });
  }

  return NextResponse.json({
    data: {
      updated: candidateIds.length,
      tenantId: targetClientId,
    },
    meta: {
      activeClientId,
      targetClientId,
      writeScope: "tenant-isolated",
    },
  });
}