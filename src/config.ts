/**
 * Environment configuration. Validation errors name the variable, never its
 * value, so misconfiguration can be logged without leaking secrets.
 */

/** Hosts the connector may ever call upstream. Not configurable at runtime. */
export const ALLOWED_UPSTREAM_HOSTS: readonly string[] = ["api.argos.co.uk"];

export const DEFAULT_UPSTREAM_URL = "https://api.argos.co.uk/mcp/sse";

/** Hard limits that are policy, not deployment tuning. */
export const LIMITS = {
  maxRequestBytes: 64 * 1024,
  maxBearerTokenLength: 8 * 1024,
  searchQueryMaxLength: 200,
  searchLimitMax: 50,
  searchLimitDefault: 20,
  getProductsMaxIds: 10,
  productIdMaxLength: 20,
  upstreamConcurrency: 4,
  maxTextBlockChars: 20_000,
  maxTotalTextChars: 100_000,
} as const;

export interface AuthConfig {
  issuer: string;
  jwksUrl: URL;
  audience: string;
  requiredScopes: string[];
  algorithms: string[];
}

export interface Config {
  publicBaseUrl: URL;
  resourceUrl: string;
  upstreamUrl: URL;
  /** null when not configured: the MCP endpoint then fails closed. */
  auth: AuthConfig | null;
  authConfigErrors: string[];
  allowedOrigins: string[];
  rateLimitPerSubjectPerMinute: number;
  rateLimitGlobalPerMinute: number;
  upstreamConnectTimeoutMs: number;
  upstreamCallTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const ASYMMETRIC_ALGS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

type Env = Record<string, string | undefined>;

function httpsUrl(env: Env, name: string, problems: string[], fallback?: string): URL | null {
  const raw = env[name]?.trim() || fallback;
  if (!raw) {
    problems.push(`${name} is required`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a valid URL`);
    return null;
  }
  if (url.protocol !== "https:") {
    problems.push(`${name} must use https`);
    return null;
  }
  if (url.username || url.password) {
    problems.push(`${name} must not contain credentials`);
    return null;
  }
  return url;
}

function positiveInt(env: Env, name: string, fallback: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} must be a positive integer`);
    return fallback;
  }
  return n;
}

function list(raw: string | undefined, sep: RegExp): string[] {
  return (raw ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateUpstreamUrl(url: URL): void {
  if (url.protocol !== "https:") throw new ConfigError(["ARGOS_MCP_URL must use https"]);
  if (!ALLOWED_UPSTREAM_HOSTS.includes(url.hostname) || (url.port !== "" && url.port !== "443")) {
    throw new ConfigError(["ARGOS_MCP_URL host is not in the upstream allowlist"]);
  }
}

/**
 * Parses configuration. Throws ConfigError for problems that make the whole
 * service unsafe to run. Missing auth config is NOT thrown: it is reported in
 * `authConfigErrors` and the MCP endpoint refuses traffic (fail closed) while
 * health/metadata endpoints still explain why.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const publicBaseUrl = httpsUrl(env, "PUBLIC_BASE_URL", problems);
  if (publicBaseUrl && (publicBaseUrl.pathname !== "/" || publicBaseUrl.search || publicBaseUrl.hash)) {
    problems.push("PUBLIC_BASE_URL must be an origin with no path, query or fragment");
  }

  const upstreamUrl = httpsUrl(env, "ARGOS_MCP_URL", problems, DEFAULT_UPSTREAM_URL);
  if (upstreamUrl) {
    try {
      validateUpstreamUrl(upstreamUrl);
    } catch (e) {
      problems.push(...(e as ConfigError).problems);
    }
  }

  const allowedOrigins = list(env.ALLOWED_ORIGINS, /,/);
  for (const o of allowedOrigins) {
    try {
      if (new URL(o).origin !== o) problems.push("ALLOWED_ORIGINS entries must be bare origins");
    } catch {
      problems.push("ALLOWED_ORIGINS contains an invalid origin");
    }
  }

  const logLevelRaw = (env.LOG_LEVEL ?? "info").trim();
  const logLevel = (["debug", "info", "warn", "error"] as const).find((l) => l === logLevelRaw) ?? "info";

  const config = {
    allowedOrigins,
    rateLimitPerSubjectPerMinute: positiveInt(env, "RATE_LIMIT_PER_SUBJECT_PER_MINUTE", 60, problems),
    rateLimitGlobalPerMinute: positiveInt(env, "RATE_LIMIT_GLOBAL_PER_MINUTE", 600, problems),
    upstreamConnectTimeoutMs: positiveInt(env, "UPSTREAM_CONNECT_TIMEOUT_MS", 8000, problems),
    upstreamCallTimeoutMs: positiveInt(env, "UPSTREAM_CALL_TIMEOUT_MS", 15000, problems),
    logLevel,
  };

  if (problems.length > 0 || !publicBaseUrl || !upstreamUrl) throw new ConfigError(problems);

  const resourceUrl = new URL("/mcp", publicBaseUrl).toString();

  // Auth: all-or-nothing. Partial configuration is treated as unconfigured.
  const authProblems: string[] = [];
  const issuer = env.AUTH_ISSUER?.trim();
  if (!issuer) authProblems.push("AUTH_ISSUER is required");
  else if (!issuer.startsWith("https://")) authProblems.push("AUTH_ISSUER must use https");
  const jwksUrl = httpsUrl(env, "AUTH_JWKS_URL", authProblems);
  const algorithms = list(env.AUTH_ALGORITHMS || "RS256,ES256", /,/);
  if (algorithms.length === 0 || algorithms.some((a) => !ASYMMETRIC_ALGS.has(a))) {
    authProblems.push("AUTH_ALGORITHMS must list asymmetric JWS algorithms only");
  }
  const auth: AuthConfig | null =
    authProblems.length === 0 && issuer && jwksUrl
      ? {
          issuer,
          jwksUrl,
          audience: env.AUTH_AUDIENCE?.trim() || resourceUrl,
          requiredScopes: list(env.AUTH_REQUIRED_SCOPES, /\s+/),
          algorithms,
        }
      : null;

  return {
    ...config,
    publicBaseUrl,
    resourceUrl,
    upstreamUrl,
    auth,
    authConfigErrors: authProblems,
  };
}
