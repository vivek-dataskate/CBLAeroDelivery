import { NextRequest, NextResponse } from "next/server";

import {
  SESSION_COOKIE_NAME,
  authorizeAccess,
  validateActiveSession,
} from "@/modules/auth";
import {
  getCandidateById,
  CandidateNotFoundError,
} from "@/features/candidate-management/infrastructure/candidate-repository";

function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

function toErrorCode(reason: "unauthenticated" | "forbidden_role" | "tenant_mismatch"): string {
  if (reason === "unauthenticated") return "unauthenticated";
  if (reason === "tenant_mismatch") return "tenant_forbidden";
  return "forbidden";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ candidateId: string }> },
) {
  const { candidateId } = await params;
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
        error: { code: "unauthenticated", message: "Authentication is required." },
      },
      { status: 401 },
    );
  }

  try {
    const candidate = await getCandidateById(candidateId, session.tenantId);
    return NextResponse.json({
      data: candidate,
      meta: {
        tenantId: session.tenantId,
        readScope: "tenant-isolated",
      },
    });
  } catch (err) {
    if (err instanceof CandidateNotFoundError) {
      return NextResponse.json(
        {
          error: {
            code: "not_found",
            message: "Candidate not found.",
          },
        },
        { status: 404 },
      );
    }
    throw err;
  }
}
