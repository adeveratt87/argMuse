# Upstream Contract — Argos MCP (`https://api.argos.co.uk/mcp/sse`)

Status: **PARTIALLY VERIFIED — live discovery BLOCKED**
Last reviewed: 2026-10-14

## Evidence levels used in this document

| Label | Meaning |
|---|---|
| **LIVE** | Observed by this project against the real upstream. *Nothing in this document has this label yet.* |
| **REFERENCE** | Taken from the production reference client `lib/argos-mcp.ts` in `adeveratt87/eeatcontent` (commit `a7cbdb9`), including its code comments that record real upstream responses. This is second-hand evidence: it shows what that client sends and what its authors saw, not a full contract. |
| **UNKNOWN** | Not established. Must not be assumed. |

## Why live discovery is blocked

Every attempt to reach `api.argos.co.uk` from the build environment was refused by the
environment's egress policy before reaching Argos (`CONNECT` → HTTP 403 from the
sandbox proxy, 2026-10-14). The refusal came from our own network sandbox, not from Argos, so it
tells us nothing about the upstream's behaviour.

To unblock, someone with authorised access must do one of these:

1. Allow `api.argos.co.uk` in this build environment's network settings, then run
   `npm run test:live` (see `tests/live/`).
2. Or run `GET /api/debug/mcp` and `GET /api/debug/mcp?q=kettle&id=<known id>` on the
   deployed EEAT Content Studio (behind studio sign-in). Commit the `toolsList`
   output, with any sensitive values removed, to `docs/fixtures/upstream-tools-list.json`.

## 1. Transport

| Item | Finding | Evidence |
|---|---|---|
| Transport | Legacy **HTTP+SSE (MCP 2024-11-05)**: `GET /mcp/sse` with `Accept: text/event-stream` opens a stream whose first event is `event: endpoint`, carrying a POST URL (relative or absolute). JSON-RPC requests are POSTed to that URL; responses arrive on the SSE stream as `message` events. | REFERENCE |
| Streamable HTTP support | Not known whether the upstream also accepts Streamable HTTP POSTs. | UNKNOWN |
| Protocol version | The reference client sends `protocolVersion: "2024-11-05"`. The version the server negotiates in its response is not recorded. | REFERENCE / UNKNOWN |
| Initialisation | `initialize` → `notifications/initialized` → `tools/call`, all on one SSE session. | REFERENCE |
| Sessions | Session identity is carried by the announced POST URL (its exact form is not recorded). There is one session per SSE connection. | REFERENCE |
| Endpoint latency | "When MCP is healthy the endpoint event lands in <1s" (reference comment). The reference times out after 8 s. | REFERENCE |
| Reconnection / resumability | No reconnection behaviour observed or documented. | UNKNOWN |
| Cancellation (`notifications/cancelled`) | Not observed. | UNKNOWN |
| Ping / keep-alive | Not observed. | UNKNOWN |

## 2. Authentication

| Item | Finding | Evidence |
|---|---|---|
| Credentials sent by reference client | **None.** No `Authorization` header, API key, cookie or tenant header. | REFERENCE |
| Implication | The upstream accepted unauthenticated requests from the EEAT Studio's Vercel egress at the time that code was written. It is **not** known whether that is by design, IP-restricted, rate-limited, or permitted by Argos terms for third-party re-exposure. | REFERENCE / UNKNOWN |
| `https://identity.argos.co.uk/oauth/tokeninfo` | Not referenced anywhere in the reference repository. Could not be reached from the build environment. **Treated as unverified; not implemented.** | UNKNOWN |
| Can the caller's (Meta/Muse) token be used upstream? | No upstream auth model exists to accept it. In any case, the MCP authorization spec says a server MUST NOT pass through tokens it receives. | Spec + REFERENCE |
| Per-user / tenant context upstream | No evidence the upstream accepts any user or tenant context. | UNKNOWN |

## 3. Tools

> ⚠️ **Name mismatch with CLAUDE.md.** The reference client never calls tools named
> `search` or `getProducts`. It calls `searchProducts`, `fetchProduct` and
> `fetchProducts`. The full `tools/list` output (descriptions, `inputSchema`,
> annotations, any other tools) is **not** recorded in the reference repository.

### 3.1 `searchProducts` (REFERENCE)

- Arguments sent: `{ "query": string, "limit": number }`. The reference clamps `limit` to ≤ 100
  and normally asks for up to 40.
- Whether `limit` is required, its upstream maximum, and any other parameters (filters,
  sort, pagination): **UNKNOWN**.
- Response: `result.content` is an array of `{ type: "text", text }` blocks. Products
  appear as lines in the form
  `ID: 7615436, Product: Bush 32 Inch ... TiVo Freely TV, Price: 119.0`, "plus a
  couple of header lines" whose exact text is not recorded.
- IDs are numeric for Argos products and alphanumeric for marketplace SKUs (e.g.
  `FTAH5B29`).
- Empty result: a bare SKU typed as free text returns no hits ("the underlying
  search literally never returns a hit for a bare code"). The exact empty-result
  payload is **UNKNOWN**.
- Side effects: none observed; the name and usage suggest read-only. **Not confirmed by Argos.**

### 3.2 `fetchProduct` (REFERENCE)

- Arguments sent: `{ "state": "<product id>" }`. The parameter really is named
  `state`; this is recorded upstream behaviour, not a typo.
- Response: separate text blocks, e.g.
  `Product Information for 7482652`, `Name: …`, `Link: https://argos.co.uk/product/7482652/`,
  `Description: <p>…HTML…</p>`, `Price: £199.0`.
- Known quirk: `£` sometimes arrives as `Â£` (UTF-8 mojibake).
- Description contains **HTML** from the product catalogue. Treat it as untrusted.
- Missing / invalid ID behaviour: **UNKNOWN**. The reference catches all errors per ID.

### 3.3 `fetchProducts` (REFERENCE, limited)

- Arguments sent by the debug route: `{ "state": "A,B,C" }` (comma-joined IDs).
- The production code deliberately avoids it: "per-product responses are easier to
  parse reliably than a multi-product blob". Response shape is **UNKNOWN**.

### 3.4 Other tools

Whether the upstream exposes other tools (basket, account, etc.) is **UNKNOWN**. The
connector is designed to make this irrelevant: it has a hard-coded allowlist and never
forwards unknown tool names.

## 4. Errors, limits and behaviour

| Scenario | Finding |
|---|---|
| HTTP 401/403/429/5xx on SSE open | UNKNOWN (the reference treats any non-2xx as failure) |
| `Retry-After` | UNKNOWN |
| Rate limits | UNKNOWN |
| JSON-RPC error codes for bad args | UNKNOWN |
| `isError: true` tool results | UNKNOWN |
| Truncated streams | UNKNOWN. The reference relies on its 30 s per-call timeout. |
| Response freshness / caching | The reference caches search results for 3 days and product detail for 6 h on its own side. The upstream gives no freshness metadata. |

## 5. Authorisation to re-expose Argos data

**BLOCKED.** No evidence in either repository that Argos has approved exposing this MCP
service to Meta/Muse through a third-party connector. This needs written approval from the Argos
service owner, plus legal and brand sign-off.

## 6. What the connector assumes (and how it fails safe)

The connector uses only the REFERENCE facts above: tool names, argument names, legacy
SSE transport, and no upstream credentials. It does **not** parse or reshape product text.
It passes upstream text blocks through with only size limits and control-character stripping
applied (see `docs/tool-catalogue.md`). If the live contract differs:

- Upstream rejects our arguments → the tool returns a safe error and the contract test
  in `tests/live/` fails, prompting an update here.
- Upstream renames a tool → calls fail closed (no fallback to other tool names).
