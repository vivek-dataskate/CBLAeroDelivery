import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAccess,
  extractSessionToken,
  toErrorCode,
  validateActiveSession,
} from "@/modules/auth";
import {
  listSavedSearches,
  createSavedSearch,
} from "@/features/candidate-management/infrastructure/saved-search-repository";

export async function GET(request: NextRequest) {
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const session = await validateActiveSession(extractSessionToken(request));

  const authz = await authorizeAccess({
    session,
    action: "candidate:read",
    path: request.nextUrl.pathname,
    method: request.method,
    traceId,
  });

  if (!authz.allowed) {
    return NextResponse.json(
      { error: { code: toErrorCode(authz.reason), message: "Access denied." } },
      { status: authz.status },
    );
  }

  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Authentication is required." } },
      { status: 401 },
    );
  }

  const searches = await listSavedSearches(session.actorId, session.tenantId);

  return NextResponse.json({
    data: searches,
    meta: { tenantId: session.tenantId },
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
      { error: { code: toErrorCode(authz.reason), message: "Access denied." } },
      { status: authz.status },
    );
  }

  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Authentication is required." } },
      { status: 401 },
    );
  }

  let body: { name?: string; filters?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "name is required." } },
      { status: 400 },
    );
  }

  if (!body.filters || typeof body.filters !== "object") {
    return NextResponse.json(
      { error: { code: "validation_error", message: "filters object is required." } },
      { status: 400 },
    );
  }

  const search = await createSavedSearch({
    tenantId: session.tenantId,
    actorId: session.actorId,
    actorEmail: session.email,
    name: body.name.trim(),
    filters: body.filters,
  });

  return NextResponse.json({ data: search }, { status: 201 });
}
