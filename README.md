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

## Decisions (2026-10-14)

| # | Decision | Status |
|---|---|---|
| D-1 | **Tool mapping approved:** `search` → `searchProducts`, `getProducts` → `fetchProduct` (one call per ID) | ✅ Decided. Still to be confirmed against the live `tools/list` (B4) |
| D-2 | **Login: dedicated hosted OAuth provider** for this connector (not Argos customer accounts). Single scope `products:read`, ~1 h access tokens with refresh. Muse requires OAuth. | ✅ Decided. Vendor and tenant still to be chosen (B2) |
| D-3 | **Hosting: a dedicated Vercel project for the argMuse repo**, separate from the EEAT studio. Preview deployments act as staging. | ✅ Decided. Project not yet created (B5) |
| D-4 | **Rate limits:** per-instance in-app limits plus a Vercel Firewall per-IP rule | ✅ Decided (firewall rule in docs/deployment.md) |

## Open blockers

| # | Item | Who / what unblocks it |
|---|---|---|
| B2 | **Choose the OAuth provider and set it up.** It must issue JWT access tokens with audience `https://<connector>/mcp` (RFC 8707 resource indicators). It must support authorization code + PKCE S256, and dynamic client registration or Client ID Metadata Documents for Muse. Muse's redirect URIs must be allowed. Define the scope `products:read`. | Pick a vendor (e.g. Auth0/Okta), then set `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_REQUIRED_SCOPES=products:read` in Vercel. If the vendor only issues opaque tokens, introspection must be added. |
| B3 | **Confirm Meta/Muse requirements on the official portal:** client registration method, redirect URIs, resource parameter, transport | Someone with Meta portal access |
| B4 | **Live upstream contract** (egress to `api.argos.co.uk` is blocked in the build environment) | Allow the host in this environment's network settings, then `npm run test:live` / `npm run discover` |
| B5 | **Create the Vercel project.** The session's Vercel connection got `403 forbidden` on project creation. | Team owner imports `adeveratt87/argMuse` in Vercel (steps in docs/deployment.md) |
| B6 | **Argos authorisation** to expose the service via Meta, plus branding, terms, privacy policy, support/security contacts | Argos service owner, legal, brand |
