import crypto from "node:crypto";

export class HttpAuthenticationError extends Error {
  readonly statusCode: 401 | 503;

  constructor(message: string, statusCode: 401 | 503) {
    super(message);
    this.name = "HttpAuthenticationError";
    this.statusCode = statusCode;
  }
}

export function authenticateHttpTenant(
  authorization: string | undefined,
  serializedTenantTokens: string | undefined
): string {
  const tenantTokens = parseTenantTokens(serializedTenantTokens);
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/i);
  const suppliedToken = match?.[1]?.trim();

  if (!suppliedToken) {
    throw new HttpAuthenticationError("Bearer authentication is required.", 401);
  }

  for (const [tenantId, expectedToken] of tenantTokens) {
    if (tokensMatch(suppliedToken, expectedToken)) {
      return tenantId;
    }
  }

  throw new HttpAuthenticationError("Invalid bearer token.", 401);
}

export function readTenantTokenConfiguration(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GENSKILL_MCP_TENANT_TOKENS ?? env.GENLAYER_MCP_TENANT_TOKENS;
}

function parseTenantTokens(serializedTenantTokens: string | undefined): Map<string, string> {
  if (!serializedTenantTokens) {
    throw new HttpAuthenticationError(
      "Tenant authentication is not configured. Set GENSKILL_MCP_TENANT_TOKENS.",
      503
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedTenantTokens);
  } catch {
    throw new HttpAuthenticationError("GENSKILL_MCP_TENANT_TOKENS must be valid JSON.", 503);
  }

  if (!isPlainObject(parsed)) {
    throw new HttpAuthenticationError(
      "GENSKILL_MCP_TENANT_TOKENS must be a JSON object mapping tenant IDs to bearer tokens.",
      503
    );
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new HttpAuthenticationError("At least one tenant bearer token must be configured.", 503);
  }

  const tenantTokens = new Map<string, string>();
  const configuredTokens = new Set<string>();
  for (const [tenantId, token] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId)) {
      throw new HttpAuthenticationError(`Invalid tenant ID "${tenantId}" in authentication configuration.`, 503);
    }
    if (typeof token !== "string" || token.length < 32) {
      throw new HttpAuthenticationError(
        `Bearer token for tenant "${tenantId}" must contain at least 32 characters.`,
        503
      );
    }
    if (configuredTokens.has(token)) {
      throw new HttpAuthenticationError("Each tenant must have a unique bearer token.", 503);
    }
    configuredTokens.add(token);
    tenantTokens.set(tenantId, token);
  }

  return tenantTokens;
}

function tokensMatch(supplied: string, expected: string): boolean {
  const suppliedDigest = crypto.createHash("sha256").update(supplied).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
