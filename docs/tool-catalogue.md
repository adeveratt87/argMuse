# Tool Catalogue

The connector exposes exactly two tools. Both are **read-only**. Any other tool name is
rejected by the MCP server before any upstream contact (tested in
`tests/protocol/mcp.test.ts`).

Common properties:

| Property | Value |
|---|---|
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` |
| Side effects | None in the connector. Upstream side effects: none observed; **not confirmed by Argos** (see upstream-contract §3). |
| Auth | Valid bearer JWT from the configured authorization server, carrying `AUTH_REQUIRED_SCOPES`. Scope names are **BLOCKED** pending AS decision. |
| Rate limits | Per validated subject: `RATE_LIMIT_PER_SUBJECT_PER_MINUTE` (default 60). Global: `RATE_LIMIT_GLOBAL_PER_MINUTE` (default 600). Per Vercel instance. |
| Data sensitivity | Inputs: search text may contain personal data typed by the user (not logged). Outputs: public catalogue data. |
| Output | MCP `content` text blocks only. Upstream text is passed through unchanged except for control-character stripping and size caps (20,000 chars per block, 100,000 total, marked `[truncated by connector]`). |
| Freshness | Live upstream call on every request; the connector does no caching. The upstream gives no freshness metadata, so none is added. |

## `search`

Search the Argos (UK) product catalogue by keywords.

**Input schema** (JSON Schema as advertised in `tools/list`; `additionalProperties: false`):

| Field | Type | Rules |
|---|---|---|
| `query` | string, required | Trimmed; 1–200 chars; no control characters |
| `limit` | integer, optional | 1–50; default 20 (connector policy, since the upstream maximum is unknown) |

**Upstream mapping:** `searchProducts` with `{ query, limit }`.

**Output:** upstream text blocks, e.g. a line in the form
`ID: 7615436, Product: <name>, Price: 119.0` (format as recorded by the reference client).
If upstream returns no text blocks, the connector returns
`"No products were returned by Argos for this search."` with `isError: false`.

## `getProducts`

Get product details for 1–10 Argos product IDs.

**Input schema** (`additionalProperties: false`):

| Field | Type | Rules |
|---|---|---|
| `ids` | string[], required | 1–10 items; each 1–20 letters/digits (numeric Argos IDs and alphanumeric marketplace SKUs). Duplicates removed. |

**Upstream mapping:** one `fetchProduct` call per ID with `{ state: "<id>" }`, at most 4 in
parallel on a single upstream session.

**Output:** for each ID, the upstream text blocks (e.g. `Product Information for …`,
`Name: …`, `Link: …`, `Description: <HTML>`, `Price: …`). Partial failures produce a
per-ID line, `Product <id>: could not be retrieved. <safe reason>` or
`Product <id>: no details were returned by Argos.` `isError` is `true` only when every ID
failed.

## Errors

| Situation | Response |
|---|---|
| Invalid arguments / unknown argument | Tool result `isError: true`, `MCP error -32602: Input validation error: …` (SDK). No upstream call. |
| Unknown tool name | Tool result `isError: true`, `MCP error -32602: Tool <name> not found`. No upstream call. |
| Upstream timeout | `isError: true`, "did not respond in time… (reference: <correlation id>)" |
| Upstream 429 | `isError: true`, "is busy. Please try again shortly." |
| Upstream 5xx / network | One retry of the connection, then `isError: true`, "currently unavailable" |
| Upstream 401/403 | `isError: true`, "currently unavailable" (logged as `unauthorized`) |
| Malformed upstream response / JSON-RPC error | `isError: true`, "returned an unexpected response" |
| Upstream `isError: true` | Passed through unchanged |

Upstream error bodies and messages are never returned to the caller.
