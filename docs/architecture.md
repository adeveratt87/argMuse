# Architecture — Argos Muse Connector

Status: Phase B/C implementation (mock-tested). Live upstream and Meta onboarding are **BLOCKED**.

## 1. Request flow

```
Meta Muse (MCP client)
   │  HTTPS POST /mcp   (MCP Streamable HTTP, stateless, JSON responses)
   ▼
Vercel Function api/mcp.ts  (Node.js runtime, Web-standard fetch handler)
   │ 1. method allowlist (POST only; GET/DELETE → 405)
   │ 2. Origin check (403 if present and not allowlisted)
   │ 3. Content-Type allowlist (415) + body size limit (413)
   │ 4. Bearer token → JWT validation (iss, aud, exp, nbf, alg, scope) → 401 / 403
   │ 5. Rate limit: per validated subject + global (429 + Retry-After)
   │ 6. JSON-RPC parse (-32700), batch rejection (-32600)
   │ 7. MCP SDK McpServer — only `search` and `getProducts` are registered
   │ 8. zod input validation (SDK returns an error for invalid args)
   ▼
UpstreamClient (src/mcp/upstream-client.ts)
   │  fixed URL https://api.argos.co.uk/mcp/sse (host allowlist, https only)
   │  MCP SDK Client + legacy SSEClientTransport, no caller headers forwarded
   │  connect timeout, per-call timeout, abort on client disconnect
   ▼
Argos MCP (legacy HTTP+SSE): searchProducts / fetchProduct
   ▼
Output sanitiser: text blocks only, control chars stripped, size-capped
   ▼
JSON-RPC response to Muse (Cache-Control: no-store, X-Correlation-Id)
```

## 2. Key decisions

| # | Decision | Rationale | Status |
|---|---|---|---|
| D1 | **Facing Muse:** MCP Streamable HTTP, **stateless** (no `MCP-Session-Id`), `enableJsonResponse: true`. | Streamable HTTP is the current standard transport (spec 2025-11-25). Stateless mode survives serverless instance changes with no session store. Tool calls are request/response, so streaming is not needed. | Implemented. Meta's own transport requirement is **unverified** (B3). |
| D2 | **Facing Argos:** official SDK `SSEClientTransport` (legacy HTTP+SSE), one upstream session per inbound request, closed afterwards. | Only legacy SSE is evidenced upstream. Per-request sessions avoid in-memory state across instances. | Implemented against a mock of the REFERENCE wire format. |
| D3 | **Tool mapping** (approved 2026-10-14): `search` → `searchProducts {query, limit}`; `getProducts` → `fetchProduct {state: id}`, called once per ID (bounded concurrency) on the same upstream session. | These are the exposed names approved in CLAUDE.md, mapped to the only upstream tools evidenced. Per-ID calls give clear partial results and match how the reference client behaves in production. | Approved. Pending live confirmation. |
| D4 | **No response reshaping.** Upstream `text` blocks are passed through. Only these changes are applied: non-text blocks dropped, C0 control characters stripped, per-block and total size caps. | Avoids fabricating or dropping product facts. Parsing the upstream's semi-structured text would put guessed business logic in the connector. | Implemented and tested. |
| D5 | **Auth:** the connector is an OAuth 2.1 *resource server*. It validates JWT access tokens against a configured issuer/JWKS/audience/scopes and publishes RFC 9728 Protected Resource Metadata. It **fails closed** (503 `not_configured`) when unconfigured. There is no "auth disabled" mode. | MCP authorization spec: servers MUST validate audience, MUST implement RFC 9728, MUST NOT pass tokens through. No Argos identity endpoint is verified, so nothing provider-specific is hard-coded. | Implemented generically. Decided: dedicated hosted provider, scope `products:read`; vendor pending (README B2). |
| D6 | **Upstream credentials:** none. The caller token is never forwarded, and caller headers (`Authorization`, `Cookie`, `X-User-Context`, etc.) are never copied upstream. | Matches the evidenced upstream (unauthenticated) and the spec's no-passthrough rule. | Implemented and tested. If Argos requires server credentials later, they'll come from env (`ARGOS_UPSTREAM_*`) and never from the caller. |
| D7 | **Tenant isolation:** identity = validated `sub` (+ `client_id`/`azp`). Used only for rate limiting and logs (hashed). No tenant context is sent upstream. | Upstream has no evidenced tenant support. | Implemented. |
| D8 | **Rate limiting:** in-memory fixed window, per subject + global, per instance. | Smallest viable option. **Limitation:** limits are per Vercel instance, not global. A durable store (e.g. Redis/Upstash) needs a human decision (B6). | Approved for launch, plus a Vercel Firewall per-IP rule (docs/deployment.md). |
| D9 | **Runtime:** Vercel Node.js (not Edge), Web-standard `export default { fetch }`, `supportsCancellation: true`, `maxDuration: 30`. | Vercel docs: standalone functions support the `fetch` export. `supportsCancellation` aborts `request.signal` on client disconnect. The SDK's SSE client relies on Node-compatible `eventsource`. | Configured. Not yet deployed (B5). |
| D10 | **No caching** of tool results. | Results may be personalised in future, and caching would serve stale prices. The reference app's 3-day cache is a content-studio choice, not appropriate here. | Implemented (`Cache-Control: no-store`). |

## 3. Module layout

```
api/mcp.ts                     Vercel entry → src/app.ts handleMcp
api/health.ts                  readiness (no secrets, no upstream call)
api/oauth-protected-resource.ts RFC 9728 metadata
src/app.ts                     wires config → verifier → upstream → handlers
src/config.ts                  env parsing, upstream host allowlist, fail-closed auth config
src/server.ts                  HTTP pipeline (method/origin/content-type/size/auth/rate-limit) + MCP server per request
src/mcp/connector-server.ts    McpServer with exactly two tools
src/mcp/upstream-client.ts     legacy SSE client to Argos, timeouts, error mapping
src/tools/search.ts            schema + mapping for `search`
src/tools/get-products.ts      schema + mapping for `getProducts`
src/tools/sanitize.ts          output normalisation
src/auth/                      bearer extraction, JWT verifier, protected-resource metadata
src/security/                  origin check, rate limiter, safe HTTP/JSON-RPC errors
src/observability/logger.ts    structured JSON logs with redaction
tests/                         unit, auth, protocol, security (mock upstream), live (gated)
```

## 4. Transport translation and limitations

- **Cancellation.** If Muse disconnects, Vercel aborts `request.signal`. The connector then aborts the
  in-flight upstream call and closes the upstream SSE session. A JSON-RPC
  `notifications/cancelled` sent as a separate POST *cannot* reach the original request, because the
  server is stateless and may run on a different instance. It is acknowledged (202) and has no effect.
  This is a documented limitation of stateless Streamable HTTP.
- **Sessions.** No `MCP-Session-Id` is issued, so session expiry (404) does not apply.
- **Batches.** JSON-RPC arrays are rejected with `-32600`. Batching was removed in MCP
  2025-06-18. Rejecting it also keeps per-request upstream fan-out bounded.
- **Server-initiated messages.** GET returns 405, as the spec allows for servers that offer no SSE stream.
- **Upstream protocol version.** The SDK client negotiates. If Argos only accepts `2024-11-05`, the SDK
  accepts that version as supported.
- **Latency.** Each inbound call opens a fresh upstream SSE session, adding one round trip for
  `initialize`. The reference observed <1 s for this.

## 5. Unresolved decisions / blockers

See the "Blockers" table in `README.md` (kept in one place to avoid drift).
