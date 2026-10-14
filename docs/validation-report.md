# Validation Report

Date: 2026-10-14 · Branch: `claude/muse-connector` · Environment: build sandbox (Node 22.22.0, npm 10.9.4)

Only results from commands actually run are recorded here.

## Commands executed and results

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`, strict) | ✅ PASS (exit 0) |
| `npm run lint` (ESLint 10 + typescript-eslint) | ✅ PASS (exit 0, no findings) |
| `npm run build` | ✅ PASS (exit 0) |
| `npm test` | ✅ **116 passed**, 2 skipped (live, gated), 0 failed |
| — `tests/unit` | ✅ 32 passed |
| — `tests/auth` | ✅ 27 passed |
| — `tests/protocol` | ✅ 42 passed |
| — `tests/security` | ✅ 15 passed |
| `npm run test:live` (`ARGOS_LIVE_TESTS=1`) | ❌ FAIL, 2/2: `getaddrinfo ENOTFOUND api.argos.co.uk`. Environment egress blocked; **not** an upstream result |
| `curl https://api.argos.co.uk/mcp/sse` (GET and POST probes) | ⛔ Proxy `CONNECT` 403, egress policy denial |
| `npm audit` (prod and all) | ✅ 0 vulnerabilities |
| Pattern secret scan of committed files | ✅ No secrets (one dummy test JWT was refactored to avoid false positives). `gitleaks` itself was not run locally; it is configured in CI but has not run yet. |
| Local dev server smoke test (`node dist/scripts/dev-server.js`, real HTTP) | ✅ `/health` 503 not_ready; `GET /mcp` 405; `POST /mcp` 503 fail-closed; metadata 503 (auth unconfigured, as designed) |

## Acceptance criteria (CLAUDE.md §12)

| Criterion | Status | Evidence |
|---|---|---|
| Connector starts and builds | ✅ PASS | build + dev server smoke test |
| Type checking and linting pass | ✅ PASS | above |
| `search` discovered with the verified schema | 🟡 PARTIAL | Discovered with exactly the intended schema (protocol tests). Upstream schema not live-verified (B4) |
| `getProducts` discovered with the verified schema | 🟡 PARTIAL | As above |
| No unapproved tools exposed | ✅ PASS | `tools/list` = exactly 2; upstream-only tools (`searchProducts`, `fetchProducts`, `addToBasket`) rejected without upstream contact |
| Returned product facts match upstream data | 🟡 PARTIAL | Pass-through verified byte-for-byte against mock fixtures; not against live data |
| Auth validated using a confirmed provider configuration | ⛔ BLOCKED | Generic JWT validation tested; no provider confirmed (B2) |
| Invalid credentials rejected before upstream execution | ✅ PASS | 10 token-failure cases + malformed headers; mock records zero upstream requests |
| Tenant identity cannot be spoofed | ✅ PASS | Identity from validated `sub` only. `X-User-Context`/tenant headers ignored, not forwarded, and do not affect rate-limit keys |
| Tokens/sensitive data not in logs or URLs | ✅ PASS | Log-capture test; query-string tokens rejected; redaction unit tests |
| Empty results and upstream errors handled | ✅ PASS (mocked) | Empty search; 401/403/429/500/503; POST failure; timeouts; truncation; malformed; JSON-RPC error; partial results |
| Transport compatible with intended Meta integration | ⛔ BLOCKED | Streamable HTTP implemented; Meta requirement unverified (B3) |
| Streaming and cancellation where required | 🟡 PARTIAL | Disconnect → upstream abort + session close tested. JSON responses (no streaming needed). Cross-request `notifications/cancelled` unsupported in stateless mode (documented) |
| Timeouts, rate limits, payload limits tested | ✅ PASS | connect/call timeouts; per-subject + global 429 with Retry-After; 413 declared + streamed |
| No purchasing / account mutation exposed | ✅ PASS | Allowlist at both MCP server and upstream client; tests |
| Security checks and dependency auditing | 🟡 PARTIAL | npm audit clean; pattern scan clean; gitleaks configured in CI but not yet run |
| Deployment and rollback instructions tested | ⛔ BLOCKED | Written, not executed (no Vercel project decision) |
| Privacy and data-flow documentation reviewed | ⛔ BLOCKED | Draft written; human review required |
| Meta submission artefacts prepared | 🟡 PARTIAL | Checklist and tool catalogue; Argos-owned items outstanding |
| Final test report identifies pass/fail/blocked | ✅ | This document |

## Known limitations

- Rate limiting is per serverless instance.
- Each tool call opens a fresh upstream SSE session (one extra round trip).
- JSON-RPC batches are rejected.
- Only JWT access tokens are supported (no opaque-token introspection).
- Input limits (`limit` ≤ 50, ≤ 10 IDs, IDs ≤ 20 alphanumerics) are connector policy derived
  from reference evidence, not from a published upstream schema.
