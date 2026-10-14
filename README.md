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

## Documentation

`https://argmuse.vercel.app/docs` is the public connector documentation for reviewers: connection, OAuth, tools, errors, limits, data handling and test steps. Its tool section is generated from `/docs/tools.json`, which returns exactly what `tools/list` advertises (taken from an in-process MCP client), so the published schemas cannot drift.

## Playground

`https://argmuse.vercel.app/` is a test console (`public/`) for the connector. It:

- checks every public endpoint, including that the advertised issuer exactly matches the authorization server's;
- signs in through WorkOS the same way Muse does: discovery, then authorization code + PKCE, with the client identified by a Client ID Metadata Document (`/oauth/client-metadata.json`) or Dynamic Client Registration;
- calls `search`, `getProducts` or raw JSON-RPC, showing product text as plain text.

The token exchange runs in the browser, so `https://argmuse.vercel.app` must be an allowed CORS origin in WorkOS. Tokens stay in the tab's sessionStorage.

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
| D-2 | **Login: WorkOS AuthKit** (dedicated, free tier), not Argos customer accounts. Staging environment `propitious-coral-38-staging.authkit.app`: email + password sign-in, CIMD and dynamic registration enabled, MCP resource `https://argmuse.vercel.app/mcp`. AuthKit offers no custom scopes (`openid profile email offline_access` only), so `AUTH_REQUIRED_SCOPES` is empty. Access is bounded by issuer, signature, audience and expiry. | ✅ Configured in WorkOS (metadata checked 2026-10-14). Not yet tested with a real token |
| D-3 | **Hosting: a dedicated Vercel project for the argMuse repo**, separate from the EEAT studio. Preview deployments act as staging. | ✅ Decided. Project not yet created (B5) |
| D-4 | **Rate limits:** per-instance in-app limits plus a Vercel Firewall per-IP rule | ✅ Decided (firewall rule in docs/deployment.md) |

## Open blockers

| # | Item | Who / what unblocks it |
|---|---|---|
| B2 | **End-to-end token test.** Deploy with the WorkOS values (docs/deployment.md), complete a sign-in through an MCP client, and confirm the connector accepts the token (`aud` = resource URL). If the Vercel URL is not `argmuse.vercel.app`, update the WorkOS MCP resource to match. | Vercel project (B5), then a test sign-in |
| B3 | **Confirm Meta/Muse requirements on the official portal:** client registration method, redirect URIs, resource parameter, transport | Someone with Meta portal access |
| B4 | **Live upstream contract** (egress to `api.argos.co.uk` is blocked in the build environment) | Allow the host in this environment's network settings, then `npm run test:live` / `npm run discover` |
| B5 | **Create the Vercel project.** The session's Vercel connection got `403 forbidden` on project creation. | Team owner imports `adeveratt87/argMuse` in Vercel (steps in docs/deployment.md) |
| B6 | **Argos authorisation** to expose the service via Meta, plus branding, terms, privacy policy, support/security contacts | Argos service owner, legal, brand |
