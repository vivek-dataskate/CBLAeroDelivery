import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, authorizeAccess, validateActiveSession } from "@/modules/auth";
import { listAuthorizationDenyEvents } from "@/modules/audit";

function toErrorCode(reason: "unauthenticated" | "forbidden_role" | "tenant_mismatch"): string {
  if (reason === "unauthenticated") {
    return "unauthenticated";
  }

  if (reason === "tenant_mismatch") {
    return "tenant_forbidden";
  }

  return "forbidden";
}

export async function GET(request: NextRequest) {
  const requestedTenantId = request.nextUrl.searchParams.get("tenantId");
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const session = await validateActiveSession(sessionToken);

  const authz = await authorizeAccess({
    session,
    action: "audit:read-denials",
    requestedTenantId,
    path: request.nextUrl.pathname,
    method: request.method,
    traceId: request.headers.get("x-trace-id"),
  });

  if (!authz.allowed) {
    return NextResponse.json(
      {
        error: {
          code: toErrorCode(authz.reason),
          message: "Access denied for authorization deny audit query.",
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

  const events = (await listAuthorizationDenyEvents()).filter((event) => {
    if (!requestedTenantId) {
      return event.sessionTenantId === session.tenantId;
    }

    return event.sessionTenantId === requestedTenantId;
  });

  return NextResponse.json({
    data: events,
    meta: {
      count: events.length,
      tenantId: session.tenantId,
    },
  });
}