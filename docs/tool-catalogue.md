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
| Output | `structuredContent` matching the advertised `outputSchema` (validated by the SDK before sending), plus one text block containing the same result as JSON for clients that ignore structured output. Error results carry text only. |
| Freshness | Live upstream call on every request; the connector does no caching. The upstream gives no freshness metadat## `search`

Search the Argos (UK) product catalogue by keywords.

**Input** (`additionalProperties: false`):

| Field | Type | Rules |
|---|---|---|
| `query` | string, required | Trimmed; 1–200 chars; no control characters |
| `limit` | integer, optional | 1–50; default 20 |

**Upstream:** `searchProducts { query, limit }`.

**Output schema:**

```json
{
  "products": [
    { "id": "hm128582", "name": "Quest 1.7L Cordless Kettle - Grey", "price": 15.99,
      "currency": "GBP", "url": "https://argos.co.uk/product/hm128582/" }
  ],
  "totalCount": 18
}
```

| Field | Source | Rule |
|---|---|---|
| `id`, `name` | `ID: …, Product: …` line | Name keeps commas; control characters stripped |
| `price` | `Price: …` | Number; `null` if absent. Never 0 for missing |
| `currency` | — | `GBP` whenever `price` is set (Argos is UK-only); `null` otherwise |
| `url` | derived | `https://argos.co.uk/product/{id}/`, the form Argos's own `fetchProduct` links use (approved rule) |
| `totalCount` | `Total Products Found: N` | As reported by Argos; `null` if Argos doesn't report it. **Whether N is total matches or the returned count is not yet verified** |

An empty search returns `{ "products": [], "totalCount": null }` (not an error).

## `getProducts`

Get details for **one** Argos product.

**Input:** `{ "id": string }`, 1–20 letters/digits (numeric Argos IDs and marketplace IDs such as `hm128582`).

**Upstream:** `fetchProduct { state: id }`.

**Output schema:**

```json
{
  "product": {
    "id": "8444015",
    "name": "Argos Home Mouse In Skeleton Felt Hanging Decoration",
    "url": "https://argos.co.uk/product/8444015/",
    "description": "Mice to meet you. …\nNot suitable for children under 3 years old.\nSize H11, W11, D8cm.",
    "price": 5,
    "currency": "GBP",
    "promotion": { "code": "VALUE_20_pc_spooky20", "label": null }
  }
}
```

| Field | Source | Rule |
|---|---|---|
| `name` | `Name:` | Required; if details exist without a name → parse error |
| `url` | `Link:` | Must be https on `argos.co.uk`/`www.argos.co.uk`, otherwise parse error. If Argos gives no link, it is derived from the ID |
| `description` | `Description:` (HTML) | Converted to plain text: scripts/styles/comments/iframes removed with their content, paragraphs and `<br>` become line breaks, `<li>` become `• ` bullets, entities decoded, `Â£` mojibake fixed, capped at 5,000 chars. Warnings, ages and dimensions are kept |
| `price`, `currency` | `Price:` | As for search; an unreadable price is a parse error |
| `promotion` | badge line (`Promotional badge:`, `Badge:`, `Promotion:`…) | `code` passed through exactly; `label` is always `null` (no verified mapping). No discount is ever inferred |

If Argos returns nothing recognisable, the result is an error: "Argos returned no details for product {id}…" (likely not found).

 when every ID
failed.

## Errors

| Situation | Response |
|---|---|
| Argos text in an unexpected format | `isError: true`, "Argos returned product data in an unexpected format… (reference: …)". Logged as `tool.parse_error` with a reason. No partial data is returned |
| Argos tool-level error (`isError`) | Passed through as an error, never as an empty result |
| Invalid arguments / unknown argument | Tool result `isError: true`, `MCP error -32602: Input validation error: …` (SDK). No upstream call. |
| Unknown tool name | Tool result `isError: true`, `MCP error -32602: Tool <name> not found`. No upstream call. |
| Upstream timeout | `isError: true`, "did not respond in time… (reference: <correlation id>)" |
| Upstream 429 | `isError: true`, "is busy. Please try again shortly." |
| Upstream 5xx / network | One retry of the connection, then `isError: true`, "currently unavailable" |
| Upstream 401/403 | `isError: true`, "currently unavailable" (logged as `unauthorized`) |
| Malformed upstream response / JSON-RPC error | `isError: true`, "returned an unexpected response" |
| Upstream `isError: true` | Passed through unchanged |

Upstream error bodies and messages are never returned to the caller.
