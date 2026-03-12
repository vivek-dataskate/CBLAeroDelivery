import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";

import { AUTH_ISSUER, getAuthSigningSecret } from "./config";
import {
  AUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  type SessionRole,
} from "./session";

const AUTH_STATE_AUDIENCE = "cblaero-auth-state";

export type SsoConfig = {
  issuer: string;
  tokenIssuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  allowedEmailDomain: string;
  allowedTenantId: string | null;
};

export type AuthState = {
  state: string;
  nonce: string;
  rememberDevice: boolean;
  returnToPath: string;
};

export type InternalIdentity = {
  actorId: string;
  email: string;
  tenantId: string;
  role: SessionRole;
};

type TokenExchangeResponse = {
  id_token: string;
};

function getSigningKey(): Uint8Array {
  return new TextEncoder().encode(getAuthSigningSecret());
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getAppUrl(): string {
  return process.env.CBL_APP_URL?.trim() ?? "http://localhost:3000";
}

function normalizeReturnToPath(returnToPath: string | null | undefined): string {
  if (!returnToPath || !returnToPath.startsWith("/") || returnToPath.startsWith("//")) {
    return "/";
  }

  return returnToPath;
}

function normalizeRole(value: unknown): SessionRole {
  if (value === "admin") {
    return "admin";
  }

  if (value === "delivery-head" || value === "delivery_head") {
    return "delivery-head";
  }

  if (value === "compliance-officer" || value === "compliance_officer") {
    return "compliance-officer";
  }

  return "recruiter";
}

function extractEmail(payload: JWTPayload): string {
  const candidate =
    (typeof payload.email === "string" && payload.email) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username) ||
    (typeof payload.upn === "string" && payload.upn) ||
    null;

  if (!candidate) {
    throw new Error("Identity token did not include an email claim.");
  }

  return candidate.toLowerCase();
}

function assertAllowedDomain(email: string, allowedDomain: string): void {
  const [, domain = ""] = email.split("@");
  if (domain.toLowerCase() !== allowedDomain.toLowerCase()) {
    throw new Error("Email domain is not authorized for internal access.");
  }
}

function assertAllowedTenant(tenantId: string, allowedTenantId: string | null): void {
  if (!allowedTenantId) {
    return;
  }

  if (tenantId !== allowedTenantId) {
    throw new Error("Microsoft tenant is not authorized for internal access.");
  }
}

export function isRememberDeviceRequested(value: string | null): boolean {
  return value === "1" || value === "true";
}

export function getSsoConfig(): SsoConfig {
  const authorityBase = readRequiredEnv("CBL_SSO_ISSUER")
    .replace(/\/$/, "")
    .replace(/\/v2\.0$/, "");
  const tokenIssuer =
    process.env.CBL_SSO_TOKEN_ISSUER?.trim() ?? `${authorityBase}/v2.0`;
  const clientId = readRequiredEnv("CBL_SSO_CLIENT_ID");
  const clientSecret = readRequiredEnv("CBL_SSO_CLIENT_SECRET");
  const redirectUri =
    process.env.CBL_SSO_REDIRECT_URI?.trim() ?? `${getAppUrl()}/api/auth/callback`;

  return {
    issuer: authorityBase,
    tokenIssuer,
    clientId,
    clientSecret,
    redirectUri,
    authorizationEndpoint:
      process.env.CBL_SSO_AUTHORIZATION_ENDPOINT?.trim() ??
      `${authorityBase}/oauth2/v2.0/authorize`,
    tokenEndpoint:
      process.env.CBL_SSO_TOKEN_ENDPOINT?.trim() ?? `${authorityBase}/oauth2/v2.0/token`,
    jwksUri:
      process.env.CBL_SSO_JWKS_URI?.trim() ?? `${authorityBase}/discovery/v2.0/keys`,
    allowedEmailDomain: process.env.CBL_SSO_ALLOWED_EMAIL_DOMAIN?.trim() ?? "cblsolutions.com",
    allowedTenantId: process.env.CBL_SSO_ALLOWED_TENANT_ID?.trim() ?? null,
  };
}

export async function issueAuthStateToken(
  state: AuthState,
  nowMs = Date.now(),
): Promise<string> {
  const nowEpochSec = Math.floor(nowMs / 1000);
  const expiresAtEpochSec = nowEpochSec + AUTH_STATE_COOKIE_MAX_AGE_SECONDS;

  return new SignJWT({
    state: state.state,
    nonce: state.nonce,
    remember_device: state.rememberDevice,
    return_to_path: normalizeReturnToPath(state.returnToPath),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(AUTH_ISSUER)
    .setAudience(AUTH_STATE_AUDIENCE)
    .setIssuedAt(nowEpochSec)
    .setExpirationTime(expiresAtEpochSec)
    .sign(getSigningKey());
}

export async function verifyAuthStateToken(
  authStateToken: string,
  nowMs = Date.now(),
): Promise<AuthState | null> {
  try {
    const { payload } = await jwtVerify(authStateToken, getSigningKey(), {
      issuer: AUTH_ISSUER,
      audience: AUTH_STATE_AUDIENCE,
      algorithms: ["HS256"],
      currentDate: new Date(nowMs),
    });

    const state = typeof payload.state === "string" ? payload.state : null;
    const nonce = typeof payload.nonce === "string" ? payload.nonce : null;
    const rememberDevice = payload.remember_device === true;
    const returnToPath =
      typeof payload.return_to_path === "string" ? payload.return_to_path : "/";

    if (!state || !nonce) {
      return null;
    }

    return {
      state,
      nonce,
      rememberDevice,
      returnToPath: normalizeReturnToPath(returnToPath),
    };
  } catch {
    return null;
  }
}

export async function createSsoAuthorizationRequest(options: {
  rememberDevice: boolean;
  returnToPath?: string | null;
}): Promise<{ authorizationUrl: URL; authStateToken: string }> {
  const config = getSsoConfig();
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const rememberDevice = options.rememberDevice;
  const returnToPath = normalizeReturnToPath(options.returnToPath);

  const authStateToken = await issueAuthStateToken({
    state,
    nonce,
    rememberDevice,
    returnToPath,
  });

  const authorizationUrl = new URL(config.authorizationEndpoint);
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("scope", "openid profile email");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);

  return {
    authorizationUrl,
    authStateToken,
  };
}

export async function exchangeAuthorizationCode(
  code: string,
): Promise<TokenExchangeResponse> {
  const config = getSsoConfig();
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.id_token !== "string" || payload.id_token.length === 0) {
    throw new Error("Token exchange response is missing id_token.");
  }

  return {
    id_token: payload.id_token,
  };
}

export async function verifyAndMapIdentityClaims(
  idToken: string,
  expectedNonce: string,
): Promise<InternalIdentity> {
  const config = getSsoConfig();
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.tokenIssuer,
    audience: config.clientId,
    algorithms: ["RS256", "RS384", "RS512"],
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error("Identity token nonce mismatch.");
  }

  const email = extractEmail(payload);
  assertAllowedDomain(email, config.allowedEmailDomain);

  const actorIdCandidate =
    (typeof payload.oid === "string" && payload.oid) ||
    (typeof payload.sub === "string" && payload.sub) ||
    null;

  if (!actorIdCandidate) {
    throw new Error("Identity token did not include an actor identifier.");
  }

  const tenantId =
    (typeof payload.tid === "string" && payload.tid) ||
    (typeof payload.tenant_id === "string" && payload.tenant_id) ||
    "internal";
  assertAllowedTenant(tenantId, config.allowedTenantId);

  let roleSource: unknown = payload.role;
  if (Array.isArray(payload.roles) && payload.roles.length > 0) {
    roleSource = payload.roles[0];
  }

  return {
    actorId: actorIdCandidate,
    email,
    tenantId,
    role: normalizeRole(roleSource),
  };
}
