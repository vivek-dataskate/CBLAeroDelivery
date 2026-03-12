import { NextRequest, NextResponse } from "next/server";

import {
  AUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  exchangeAuthorizationCode,
  issueSessionToken,
  shouldUseSecureCookies,
  verifyAndMapIdentityClaims,
  verifyAuthStateToken,
} from "@/modules/auth";
import { registerOrSyncUserFromSession } from "@/modules/admin";

function getPublicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  if (forwardedHost) {
    const proto = forwardedProto || "https";
    return `${proto}://${forwardedHost}`;
  }

  const configuredAppUrl = process.env.CBL_APP_URL?.trim();
  if (configuredAppUrl) {
    try {
      return new URL(configuredAppUrl).origin;
    } catch {
      // Fall through to runtime request origin.
    }
  }

  return request.nextUrl.origin;
}

function clearAuthStateCookie(response: NextResponse): void {
  response.cookies.set({
    name: AUTH_STATE_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
  });
}

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");

  if (!state || !code) {
    return NextResponse.json(
      { error: { code: "invalid_callback", message: "Missing code or state." } },
      { status: 400 },
    );
  }

  const authStateCookie = request.cookies.get(AUTH_STATE_COOKIE_NAME)?.value;
  if (!authStateCookie) {
    return NextResponse.json(
      { error: { code: "missing_state", message: "SSO state cookie not found." } },
      { status: 400 },
    );
  }

  const authState = await verifyAuthStateToken(authStateCookie);
  if (!authState || authState.state !== state) {
    return NextResponse.json(
      { error: { code: "state_mismatch", message: "Invalid SSO state." } },
      { status: 401 },
    );
  }

  try {
    const exchanged = await exchangeAuthorizationCode(code);
    const identity = await verifyAndMapIdentityClaims(exchanged.id_token, authState.nonce);

    const issued = await issueSessionToken({
      actorId: identity.actorId,
      email: identity.email,
      tenantId: identity.tenantId,
      role: identity.role,
      rememberDevice: authState.rememberDevice,
    });
    await registerOrSyncUserFromSession(issued.session);

    const destination = new URL(authState.returnToPath, `${getPublicOrigin(request)}/`);
    const response = NextResponse.redirect(destination);

    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: issued.token,
      httpOnly: true,
      secure: shouldUseSecureCookies(),
      sameSite: "lax",
      path: "/",
      maxAge: issued.ttlSeconds,
    });
    clearAuthStateCookie(response);

    return response;
  } catch {
    return NextResponse.json(
      { error: { code: "auth_failed", message: "Unable to complete SSO login." } },
      { status: 401 },
    );
  }
}
