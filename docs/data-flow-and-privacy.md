# Data Flow and Privacy

> **Status: DRAFT — this document describes what the code does today. It has not been
> reviewed by Argos privacy, security or legal, and does not by itself establish policy
> compliance.** Retention periods for Vercel logs and Meta processing terms must be confirmed
> by their owners before submission.

## 1. Data received from Muse

| Element | Purpose | Notes |
|---|---|---|
| `Authorization: Bearer <JWT>` | Authenticate and authorise the caller | Validated in memory, never stored, never logged, never forwarded |
| JWT claims `iss`, `aud`, `exp`, `nbf`, `sub`, `scope`/`scp`, `client_id`/`azp` | Validation, rate limiting | `sub` is hashed (SHA-256, truncated) before logging or use as a rate-limit key |
| JSON-RPC body: tool name and arguments (`query`, `limit`, `ids`) | Execute the tool | Search text may contain whatever the user typed, including personal data. **Not logged.** |
| Network metadata (IP, User-Agent) | Handled by Vercel's edge | Not read by connector code |
| Any other headers (`Cookie`, `X-User-Context`, tenant IDs…) | None | Ignored and never forwarded |

## 2. Data sent to each party

| Recipient | What | Why |
|---|---|---|
| **Argos MCP** (`api.argos.co.uk`) | `query` + `limit`, or product IDs. Standard MCP `initialize` metadata (client name `argos-muse-connector`). | Required to perform the search or lookup. **No user identity, token or caller header is sent.** |
| **Meta / Muse** | Tool results: Argos product text (IDs, names, prices, links, HTML descriptions) | The purpose of the connector |
| **Vercel** | Hosts the function and holds structured logs (below) | Hosting |
| **Monitoring providers** | None configured | — |

## 3. Stored, logged, cached

- **Stored:** nothing. There is no database and no session store.
- **Cached:** nothing. Tool responses are `Cache-Control: no-store`. The only cache is
  the JWKS public key set (`jose`, ≤10 min), which contains no personal data.
- **In memory:** per-instance rate-limit counters keyed by hashed subject, kept for ≤60 s per window.
- **Logged** (JSON lines to stdout → Vercel logs): timestamp, level, event, correlation ID,
  HTTP method and status, latency, JSON-RPC method, tool name, result block count,
  error *kind*, hashed subject. Search text, product IDs, tokens, cookies and upstream error
  bodies are **not** logged. A redaction layer (`src/observability/logger.ts`) also strips
  sensitive keys, `Bearer …` strings and JWT-shaped strings as a safety net.
- **Analytics:** none.

## 4. Retention and deletion

- Connector: no persistent data, so there is nothing to delete beyond logs.
- Vercel logs: retention follows the Vercel plan and any log drains configured. **TO
  CONFIRM** with the account owner. Logs contain hashed subjects only.

## 5. Access control

- Vercel project access controls who can read logs and environment variables (team RBAC).
- Secrets (none required today beyond auth configuration, which is public metadata) are
  stored only in Vercel environment variables.

## 6. Privacy requests and incidents

- Because the connector stores no user data and logs only hashed subjects, subject-access
  and deletion requests concern Meta (conversation data) and Argos (if any upstream
  logging exists, **unknown**). **TO CONFIRM:** the routing contacts.
- Incidents: see `docs/deployment.md` (rollback, credential rotation). **TO CONFIRM:** the security
  contact.

## 7. Product content

Product descriptions, images and links are **passed through** as text exactly as Argos
returns them. They are not cached or rewritten. Descriptions contain HTML. Non-text content
blocks (e.g. images) are dropped. Product text is untrusted, and tool descriptions tell
the model to treat it as data.

## 8. Regional / eligibility restrictions

Argos is a UK retailer: prices are GBP and availability is UK-only. Whether Meta restricts
the connector by region or account type is **UNKNOWN** (Meta documentation could not be
verified; see the Meta submission checklist).
