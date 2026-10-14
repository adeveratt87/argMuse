/**
 * Connector HTTP entry points (Web-standard Request → Response).
 *
 * /mcp pipeline, in order — each step rejects before any later work happens:
 *   method → Origin → Content-Type → size → bearer auth → rate limit →
 *   JSON-RPC parse → MCP server (tool allowlist + input validation) → upstream
 */
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LIMITS, type Config } from "./config.js";
import { extractBearerToken } from "./auth/bearer.js";
import { AuthError } from "./auth/errors.js";
import type { Principal, TokenVerifier } from "./auth/jwt-verifier.js";
import { protectedResourceMetadata, wwwAuthenticate } from "./auth/resource-metadata.js";
import { createConnectorServer } from "./mcp/connector-server.js";
import { toolCatalogue } from "./mcp/tool-catalogue.js";
import type { Upstream } from "./mcp/upstream-client.js";
import { hashSubject, type Logger } from "./observability/logger.js";
import { baseHeaders, errorResponse, JSONRPC } from "./security/http-errors.js";
import { isOriginAllowed } from "./security/origin.js";
import type { RateLimiter } from "./security/rate-limit.js";

export interface AppDeps {
  config: Config;
  /** null when auth is not configured: /mcp then fails closed. */
  verifier: TokenVerifier | null;
  upstream: Upstream;
  logger: Logger;
  rateLimiter: RateLimiter;
}

class BodyTooLarge extends Error {}

async function readBodyLimited(req: Request, max: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) throw new BodyTooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const [type] = value.split(";");
  return type?.trim().toLowerCase() === "application/json";
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export function createHandlers(deps: AppDeps) {
  const { config, verifier, upstream, rateLimiter } = deps;

  async function handleMcp(req: Request): Promise<Response> {
    const correlationId = randomUUID();
    const log = deps.logger.child({ correlationId });
    const started = Date.now();
    const finish = (res: Response, extra: Record<string, unknown> = {}) => {
      log.info("http.request", { method: req.method, status: res.status, ms: Date.now() - started, ...extra });
      return res;
    };

    // 1. Methods. Stateless server: no GET stream, no sessions to DELETE.
    if (req.method !== "POST") {
      return finish(
        errorResponse(405, "Method not allowed", correlationId, { headers: { Allow: "POST" } }),
      );
    }

    // 2. Origin (DNS-rebinding protection; not authentication). The connector's
    // own origin is always allowed so the same-origin playground page works.
    if (!isOriginAllowed(req.headers.get("origin"), [config.publicBaseUrl.origin, ...config.allowedOrigins])) {
      return finish(errorResponse(403, "Origin not allowed", correlationId));
    }

    // 3. Content type.
    if (!isJsonContentType(req.headers.get("content-type"))) {
      return finish(errorResponse(415, "Content-Type must be application/json", correlationId));
    }

    // 4. Cheap size pre-check (declared length) before auth work.
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > LIMITS.maxRequestBytes) {
      return finish(errorResponse(413, "Request body too large", correlationId));
    }

    // 5. Authentication — fail closed when not configured.
    if (!verifier || !config.auth) {
      log.error("auth.not_configured", { problems: config.authConfigErrors });
      return finish(errorResponse(503, "Connector authentication is not configured", correlationId));
    }
    let principal: Principal;
    try {
      principal = await verifier.verify(extractBearerToken(req.headers.get("authorization")));
    } catch (err) {
      if (err instanceof AuthError) {
        return finish(
          errorResponse(err.status, err.status === 401 ? "Unauthorized" : "Forbidden", correlationId, {
            headers: { "WWW-Authenticate": wwwAuthenticate(config, { code: err.code, description: err.description }) },
          }),
          { auth: err.code },
        );
      }
      log.error("auth.unexpected_error", { error: err });
      return finish(errorResponse(500, "Internal error", correlationId));
    }
    const subjectHash = hashSubject(`${config.auth.issuer}|${principal.subject}`);

    // 6. Rate limiting keyed on the *validated* subject only.
    const decision = rateLimiter.check(subjectHash);
    if (!decision.allowed) {
      return finish(
        errorResponse(429, "Too many requests", correlationId, { headers: { "Retry-After": String(decision.retryAfterSeconds) } }),
        { subject: subjectHash },
      );
    }

    // 7. Body + JSON-RPC shape.
    let parsed: unknown;
    try {
      const text = await readBodyLimited(req, LIMITS.maxRequestBytes);
      parsed = JSON.parse(text);
    } catch (err) {
      if (err instanceof BodyTooLarge) return finish(errorResponse(413, "Request body too large", correlationId));
      return finish(errorResponse(400, "Parse error", correlationId, { code: JSONRPC.PARSE_ERROR }));
    }
    if (Array.isArray(parsed)) {
      return finish(errorResponse(400, "JSON-RPC batches are not supported", correlationId, { code: JSONRPC.INVALID_REQUEST }));
    }
    if (!parsed || typeof parsed !== "object") {
      return finish(errorResponse(400, "Invalid Request", correlationId, { code: JSONRPC.INVALID_REQUEST }));
    }
    const rpcMethod = typeof (parsed as { method?: unknown }).method === "string" ? (parsed as { method: string }).method : undefined;

    // 8. MCP handling: fresh stateless server + transport per request.
    const requestSignal = req.signal;
    const upstreamSession = upstream.session(requestSignal);
    const server = createConnectorServer({
      upstream: upstreamSession,
      logger: log.child({ subject: subjectHash }),
      correlationId,
      requestSignal,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req, { parsedBody: parsed });
      // JSON mode: the body is fully computed once handleRequest resolves.
      const body = await res.arrayBuffer();
      return finish(withHeaders(new Response(body, res), baseHeaders(correlationId)), {
        rpcMethod,
        subject: subjectHash,
      });
    } catch (err) {
      log.error("mcp.unexpected_error", { error: err });
      return finish(errorResponse(500, "Internal error", correlationId));
    } finally {
      await upstreamSession.close();
      await server.close().catch(() => undefined);
    }
  }

  function handleProtectedResourceMetadata(req: Request): Response {
    const correlationId = randomUUID();
    if (req.method !== "GET") return errorResponse(405, "Method not allowed", correlationId, { headers: { Allow: "GET" } });
    const metadata = protectedResourceMetadata(config);
    if (!metadata) return errorResponse(503, "Connector authentication is not configured", correlationId);
    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { "Content-Type": "application/json", ...baseHeaders(correlationId), "Cache-Control": "public, max-age=300" },
    });
  }

  function handleHealth(req: Request): Response {
    const correlationId = randomUUID();
    if (req.method !== "GET") return errorResponse(405, "Method not allowed", correlationId, { headers: { Allow: "GET" } });
    const ready = config.auth !== null;
    // No secrets, no config values, no upstream call.
    return new Response(JSON.stringify({ status: ready ? "ok" : "not_ready", checks: { authConfigured: ready } }), {
      status: ready ? 200 : 503,
      headers: { "Content-Type": "application/json", ...baseHeaders(correlationId) },
    });
  }

  /**
   * OAuth Client ID Metadata Document for the browser playground (public/).
   * The document's own URL is the client_id, so an authorization server that
   * supports CIMD can identify the playground without prior registration.
   */
  function handleClientMetadata(req: Request): Response {
    const correlationId = randomUUID();
    if (req.method !== "GET") return errorResponse(405, "Method not allowed", correlationId, { headers: { Allow: "GET" } });
    const origin = config.publicBaseUrl.origin;
    const body = {
      client_id: `${origin}/oauth/client-metadata.json`,
      client_name: "argMuse Playground",
      client_uri: `${origin}/`,
      redirect_uris: [`${origin}/`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...baseHeaders(correlationId), "Cache-Control": "public, max-age=300" },
    });
  }

  /** Public, read-only tool definitions (same as tools/list) for the documentation page. */
  async function handleToolsCatalogue(req: Request): Promise<Response> {
    const correlationId = randomUUID();
    if (req.method !== "GET") return errorResponse(405, "Method not allowed", correlationId, { headers: { Allow: "GET" } });
    const catalogue = await toolCatalogue();
    return new Response(JSON.stringify({ endpoint: config.resourceUrl, ...catalogue }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...baseHeaders(correlationId), "Cache-Control": "public, max-age=300" },
    });
  }

  /** Path router used by the local dev server and tests (Vercel routes by file). */
  async function route(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/mcp" || pathname === "/api/mcp") return handleMcp(req);
    if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
      return handleProtectedResourceMetadata(req);
    }
    if (pathname === "/health" || pathname === "/api/health") return handleHealth(req);
    if (pathname === "/oauth/client-metadata.json" || pathname === "/api/client-metadata") return handleClientMetadata(req);
    if (pathname === "/docs/tools.json" || pathname === "/api/tools-catalogue") return handleToolsCatalogue(req);
    return errorResponse(404, "Not found", randomUUID());
  }

  return { handleMcp, handleProtectedResourceMetadata, handleHealth, handleClientMetadata, handleToolsCatalogue, route };
}
