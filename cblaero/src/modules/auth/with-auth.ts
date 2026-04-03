import { NextRequest, NextResponse } from "next/server";

import type { AuthSession } from "./session";
import type { ProtectedAction } from "./authorization";
import { authorizeAccess } from "./authorization";
import { validateActiveSession } from "./session";
import { extractSessionToken, toErrorCode } from "./api-helpers";

/**
 * Options controlling how withAuth enforces authentication and authorization.
 */
export type AuthOptions = {
  /** The RBAC action to authorize (e.g. 'candidate:read'). */
  action: ProtectedAction;
  /** When true, step-up (fresh auth) is enforced by the caller after auth passes. */
  requireStepUp?: boolean;
  /** When true, the session must have been issued recently (same as requireStepUp semantically). */
  requireFreshAuth?: boolean;
};

/**
 * The authenticated context injected into the handler after auth succeeds.
 */
export type AuthenticatedContext<T = Record<string, string>> = {
  session: AuthSession;
  request: NextRequest;
  params: T;
  traceId: string;
};

/**
 * A route handler that receives an authenticated context.
 * The handler only runs after session validation and RBAC pass.
 */
export type AuthenticatedHandler<T = Record<string, string>> = (
  ctx: AuthenticatedContext<T>,
) => Promise<NextResponse>;

/**
 * Wraps a Next.js route handler with session validation, RBAC authorization, and audit logging.
 *
 * Replaces the inline pattern:
 *   extractSessionToken → validateActiveSession → authorizeAccess → error check → null guard
 *
 * Usage:
 *   export const GET = withAuth(async ({ session, request, traceId }) => {
 *     // Business logic only — auth already enforced
 *     return NextResponse.json({ data: ... });
 *   }, { action: 'candidate:read' });
 */
export function withAuth<T = Record<string, string>>(
  handler: AuthenticatedHandler<T>,
  options: AuthOptions,
): (request: NextRequest, context?: { params?: Promise<T> }) => Promise<NextResponse> {
  return async (request: NextRequest, context?: { params?: Promise<T> }) => {
    const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
    const requestedTenantId =
      request.headers.get("x-active-client-id")?.trim() ||
      request.nextUrl.searchParams.get("tenantId") ||
      null;

    const session = await validateActiveSession(extractSessionToken(request));

    const authz = await authorizeAccess({
      session,
      action: options.action,
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
            message: `Access denied for ${options.action} operation.`,
          },
        },
        { status: authz.status },
      );
    }

    // authorizeAccess only returns allowed:true when session is non-null.
    // This guard satisfies TypeScript's type narrowing.
    if (!session) {
      return NextResponse.json(
        { error: { code: "unauthenticated", message: "Authentication is required." } },
        { status: 401 },
      );
    }

    const params = context?.params ? await context.params : ({} as T);

    return handler({ session, request, params, traceId });
  };
}
