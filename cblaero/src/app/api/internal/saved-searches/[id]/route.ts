import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAccess,
  extractSessionToken,
  toErrorCode,
  validateActiveSession,
} from "@/modules/auth";
import {
  updateSavedSearch,
  deleteSavedSearch,
  SavedSearchNotFoundError,
} from "@/features/candidate-management/infrastructure/saved-search-repository";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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

  let body: { name?: string; digestEnabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "name must be a non-empty string." } },
      { status: 400 },
    );
  }
  if (body.digestEnabled !== undefined && typeof body.digestEnabled !== "boolean") {
    return NextResponse.json(
      { error: { code: "validation_error", message: "digestEnabled must be a boolean." } },
      { status: 400 },
    );
  }

  try {
    const updated = await updateSavedSearch(id, session.actorId, session.tenantId, {
      name: body.name?.trim(),
      digestEnabled: body.digestEnabled,
    });
    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof SavedSearchNotFoundError) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Saved search not found." } },
        { status: 404 },
      );
    }
    throw err;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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

  try {
    await deleteSavedSearch(id, session.actorId, session.tenantId);
    return NextResponse.json({ data: { deleted: true } });
  } catch (err) {
    if (err instanceof SavedSearchNotFoundError) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Saved search not found." } },
        { status: 404 },
      );
    }
    throw err;
  }
}
