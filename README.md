# argMuse — Argos MCP connector for Meta Muse

A read-only MCP connector that wraps the Argos product MCP service
(`https://api.argos.co.uk/mcp/sse`) and exposes exactly two tools, `search` and
`getProducts`, to Meta Muse over MCP Streamable HTTP. It runs as Vercel Functions
(Node.js).

> **Status:** works and is fully tested against a mocked upstream. **Not production-ready.**
> Live upstream verification, the authorization server, Argos authorisation and Meta onboarding
> are all **BLOCKED** (see below). The connector has not been submitted to or approved by Meta.

Project rules: [`CLAUDE.md`](CLAUDE.md). Design: [`docs/architecture.md`](docs/architecture.md).
Upstream evidence: [`docs/upstream-contract.md`](docs/upstream-contract.md).

## How it works

```
Muse ──POST /mcp (Streamable HTTP, stateless, JSON)──▶ connector ──legacy HTTP+SSE──▶ Argos MCP
         bearer JWT validated, tools allowlisted,            no caller credentials or
         input validated, rate limited                       headers forwarded
```

| Connector tool | Upstream call |
|---|---|
| `search { query, limit? }` | `searchProducts { query, limit }` |
| `getProducts { ids[] }` | `fetchProduct { state: id }`, once per ID |

Details: [`docs/tool-catalogue.md`](docs/tool-catalogue.md).

## Development

Requires Node 22+.

```bash
npm ci
npm run typecheck
npm run lint
npm test                 # unit, auth, protocol, security (mocked upstream)
npm run test:live        # LIVE upstream contract tests; needs network access to api.argos.co.uk
npm run discover         # print live upstream tools/list (read-only)
cp .env.example .env     # then export the values
npm run dev              # http://127.0.0.1:3000/mcp
```

Without `AUTH_ISSUER`/`AUTH_JWKS_URL`, `/mcp` deliberately returns 503. There is no
"auth disabled" mode.

## Deployment

See [`docs/deployment.md`](docs/deployment.md). Privacy: [`docs/data-flow-and-privacy.md`](docs/data-flow-and-privacy.md).
Meta: [`docs/meta-submission-checklist.md`](docs/meta-submission-checklist.md).
Latest results: [`docs/validation-report.md`](docs/validation-report.md).

## Blockers and decisions needing human approval

| # | Item | Why it matters | Who / what unblocks it |
|---|---|---|---|
| B1 | **Tool name mapping.** CLAUDE.md names `search`/`getProducts`, but the only evidenced upstream tools are `searchProducts`/`fetchProduct`/`fetchProducts`. The connector exposes the CLAUDE.md names and maps them as shown above. | If Argos has a different intended mapping (e.g. `fetchProducts` batch), behaviour changes | Product owner approves mapping; live `tools/list` confirms names |
| B2 | **Authorization server.** `identity.argos.co.uk/oauth/tokeninfo` is unverified and was not implemented. The connector validates JWTs from *any* configured OAuth 2.1 AS, but none is chosen. | `/mcp` returns 503 until configured | Argos identity team picks the AS (and whether Muse users sign in with Argos accounts at all), defines scopes, registers Muse as a client. If the AS issues opaque tokens, introspection (RFC 7662) must be added. |
| B3 | **Meta requirements unverified.** Official Meta/Muse docs could not be fetched, and secondary sources conflict on transport and auth details. | Built to the most-cited profile; may need changes | Someone with portal access confirms requirements |
| B4 | **Live upstream contract.** Egress to `api.argos.co.uk` is blocked in the build environment. Schemas, limits, error behaviour and side-effect-freedom are from the reference client only. | Input limits and error mapping are provisional | Allow the host in environment network settings and run `npm run test:live` + `npm run discover`, or capture `/api/debug/mcp` output from the EEAT studio |
| B5 | **Authorisation to re-expose Argos data** to Meta via a third-party connector, plus branding, terms, privacy policy, support/security contacts. | Required for submission | Argos service owner, legal, brand |
| B6 | **Durable rate limiting.** Limits are per Vercel instance. | Global limits are approximate under scale-out | Decide whether a shared store (e.g. Redis) is warranted |
| B7 | **Public-data alternative.** Upstream appears to need no credentials and serves public catalogue data. An authless connector would be simpler, but CLAUDE.md requires authentication, so it was not built. | Scope/complexity trade-off | Product/security decision |
