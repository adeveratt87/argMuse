# Validation Report

Date: 2026-10-14 · Branch: `claude/muse-connector` · Environment: build sandbox (Node 22.22.0, npm 10.9.4)

Only results from commands actually run are recorded here.

## Commands executed and results

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`, strict) | ✅ PASS (exit 0) |
| `npm run lint` (ESLint 10 + typescript-eslint) | ✅ PASS (exit 0, no findings) |
| `npm run build` (now `npm run compile`) | ✅ PASS (exit 0) |
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
| Auth validated using a confirmed provider configuration | ⛔ BLOCKED | Generic JWT validation tested; decided on a dedicated hosted provider, vendor not yet chosen (B2) |
| Invalid credentials rejected before upstream execution | ✅ PASS | 10 token-failure cases + malformed headers; mock records zero upstream requests |
| Tenant identity cannot be spoofed | ✅ PASS | Identity from validated `sub` only. `X-User-Context`/tenant headers ignored, not forwarded, and do not affect rate-limit keys |
| Tokens/sensitive data not in logs or URLs | ✅ PASS | Log-capture test; query-string tokens rejected; redaction unit tests |
| Empty results and upstream errors handled | ✅ PASS (mocked) | Empty search; 401/403/429/500/503; POST failure; timeouts; truncation; malformed; JSON-RPC error; partial results |
| Transport compatible with intended Meta integration | ⛔ BLOCKED | Streamable HTTP implemented; Meta requirement unverified (B3) |
| Streaming and cancellation where required | 🟡 PARTIAL | Disconnect → upstream abort + session close tested. JSON responses (no streaming needed). Cross-request `notifications/cancelled` unsupported in stateless mode (documented) |
| Timeouts, rate limits, payload limits tested | ✅ PASS | connect/call timeouts; per-subject + global 429 with Retry-After; 413 declared + streamed |
| No purchasing / account mutation exposed | ✅ PASS | Allowlist at both MCP server and upstream client; tests |
| Security checks and dependency auditing | 🟡 PARTIAL | npm audit clean; pattern scan clean; gitleaks configured in CI but not yet run |
| Deployment and rollback instructions tested | ⛔ BLOCKED | Written, not executed. Project decided (dedicated); creation failed 403 from the build session |
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

## Structured output (schema review, 2026-10-14)

Decisions: `getProducts` takes one ID and returns `{ product }`; search URLs are derived from the ID; a parse failure is an error result; the text block is the JSON of the structured result.

| Criterion (schema review §8) | Status | Evidence |
|---|---|---|
| Both tools have verified input schemas | 🟡 PARTIAL | Connector input schemas tested. Upstream schemas still unverified (live `tools/list` not captured) |
| Both tools advertise accurate output schemas | ✅ PASS | `tools/list` exposes `outputSchema` for both (protocol test) |
| search returns a typed product array | ✅ PASS | protocol + unit tests |
| getProducts returns structured product data | ✅ PASS | protocol + unit tests |
| Structured output validates against its schema | ✅ PASS | SDK validates every result before sending; Ajv independently validates real results against the advertised JSON Schema (`tests/protocol/output-schema.test.ts`) |
| Text compatibility output retained | ✅ PASS | Text block = JSON of the structured result (tested equal) |
| Prices numeric, currency consistent | ✅ PASS | `parsePrice` tests (`£`, `Â£`, thousands separators); `GBP` only when price is set |
| Missing prices and URLs not fabricated | ✅ PASS | Missing price → `null` (tested). URLs: only Argos links (host-checked) or the approved ID rule |
| HTML descriptions sanitised | ✅ PASS | `htmlToText` tests: scripts, styles, comments, iframes, event handlers, encoded tags removed |
| Safety warnings intact after sanitisation | ✅ PASS | Age warning, supervision note and dimensions preserved (tests) |
| Promotion codes not misrepresented | ✅ PASS | Code passed through; `label` always `null`; no discount inferred |
| Empty results differ from upstream failures | ✅ PASS | Empty → `products: []`; upstream `isError` → error result; unparseable → error result (tests) |
| Pagination and counts match upstream semantics | 🟡 PARTIAL | No pagination (none upstream). `totalCount` passes Argos's figure through, but whether it is total or returned is unverified |
| Invalid inputs rejected | ✅ PASS | protocol tests |
| Credentials and sensitive data never in logs | ✅ PASS | log-capture tests; parse errors log only a reason |
| Only the two read-only tools exposed | ✅ PASS | protocol tests |
| Integration tests against approved upstream | ⛔ BLOCKED | Build environment cannot reach `api.argos.co.uk`; live tests are updated for structured output and ready (`npm run test:live`) |
| End-to-end through the Meta connector flow | ⛔ BLOCKED | No Meta/Muse portal access yet |

Commands: `npm run typecheck` ✅, `npm run lint` ✅, `npm test` ✅ 162 passed / 2 skipped (live), `npm audit` ✅ 0 vulnerabilities, Playwright browser run of the playground ✅ (search and getProducts rendered from `structuredContent`, no HTML injected).
