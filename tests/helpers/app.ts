import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/auth/jwt-verifier.js";
import { createUpstream } from "../../src/mcp/upstream-client.js";
import { createLogger } from "../../src/observability/logger.js";
import { createRateLimiter } from "../../src/security/rate-limit.js";
import { createHandlers } from "../../src/server.js";
import { createMockUpstream, type MockUpstreamOptions } from "./mock-upstream.js";
import { AUDIENCE, ISSUER, createTokenFactory } from "./tokens.js";

export const BASE = "https://connector.test.invalid";

export async function createTestApp(
  opts: {
    upstream?: MockUpstreamOptions;
    env?: Record<string, string>;
    authConfigured?: boolean;
    perKeyPerMinute?: number;
    globalPerMinute?: number;
    callTimeoutMs?: number;
    connectTimeoutMs?: number;
  } = {},
) {
  const tokens = await createTokenFactory();
  const env: Record<string, string> = {
    PUBLIC_BASE_URL: BASE,
    ...(opts.authConfigured === false
      ? {}
      : { AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: `${ISSUER}/jwks`, AUTH_AUDIENCE: AUDIENCE, AUTH_REQUIRED_SCOPES: "products:read" }),
    ...opts.env,
  };
  const config = loadConfig(env);
  const logs: string[] = [];
  const logger = createLogger("debug", (l) => logs.push(l));
  const mock = createMockUpstream(opts.upstream);
  const handlers = createHandlers({
    config,
    verifier: config.auth ? createJwtVerifier(config.auth, { keys: tokens.keys }) : null,
    upstream: createUpstream({
      url: config.upstreamUrl,
      connectTimeoutMs: opts.connectTimeoutMs ?? 1000,
      callTimeoutMs: opts.callTimeoutMs ?? 1000,
      logger,
      fetch: mock.fetch,
    }),
    logger,
    rateLimiter: createRateLimiter({
      perKeyPerMinute: opts.perKeyPerMinute ?? 1000,
      globalPerMinute: opts.globalPerMinute ?? 10_000,
    }),
  });

  const fetchToApp = (url: string | URL, init?: RequestInit) => handlers.route(new Request(url, init));

  async function connectClient(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: fetchToApp,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test-muse", version: "0" });
    await client.connect(transport);
    return client;
  }

  function rpc(body: unknown, headers: Record<string, string> = {}, method = "POST") {
    return handlers.route(
      new Request(`${BASE}/mcp`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: method === "GET" || method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  return { handlers, config, logs, mock, tokens, connectClient, rpc };
}

export const CALL_SEARCH = (id: number, args: Record<string, unknown> = { query: "kettle" }) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "search", arguments: args },
});
