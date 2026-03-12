import { NextRequest, NextResponse } from "next/server";

import {
  SESSION_COOKIE_NAME,
  revokeSession,
  shouldUseSecureCookies,
  validateActiveSession,
} from "@/modules/auth";

async function handleLogout(request: NextRequest): Promise<NextResponse> {
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const session = await validateActiveSession(sessionToken);

  if (session) {
    revokeSession(session.sessionId, session.expiresAtEpochSec);
  }

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}

export async function GET(request: NextRequest) {
  return handleLogout(request);
}

export async function POST(request: NextRequest) {
  return handleLogout(request);
}
