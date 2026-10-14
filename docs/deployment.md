# Deployment

> **Status:** not yet deployed. Decided: a dedicated Vercel project for this repo in the
> `adeveratt87's projects` team (README D-3). Creating it from the build session failed
> with `403 forbidden`, so a team owner must create it (below). The OAuth provider (README B2)
> is still to be chosen. None of the steps below have been executed against a real Vercel project.

## Create the project (team owner, one-off)

1. Vercel dashboard → **Add New… → Project** → import `adeveratt87/argMuse` into
   *adeveratt87's projects*. Name: `argmuse`.
2. Framework preset: **Other**. Leave the build command, output directory and install
   command at their defaults. The repo deliberately has no `build` script: Vercel compiles
   `api/*.ts` itself.
3. Root directory: repository root. Node.js version: 22.x.
4. Environment variables (Preview + Production), then deploy:
   - `PUBLIC_BASE_URL` = the project's URL, e.g. `https://argmuse.vercel.app` (no trailing slash)
   - leave the `AUTH_*` variables unset until the provider exists. `/mcp` will answer 503 (fail closed).
5. Branch `claude/muse-connector` (until merged) creates preview deployments. These are staging.
6. Deployment Protection: keep it on for previews. Production must be publicly reachable
   for Muse, and is protected by OAuth.

## Runtime

- Vercel Functions, **Node.js runtime** (not Edge). Node 22 (`engines.node >= 22`).
- Entry points (Web-standard `export default { fetch }`):

| File | Public route (via `vercel.json` rewrites) | Methods |
|---|---|---|
| `api/mcp.ts` | `/mcp` (also `/api/mcp`) | POST (others → 405) |
| `api/oauth-protected-resource.ts` | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | GET |
| `api/health.ts` | `/health` | GET |

- `api/mcp.ts`: `maxDuration: 30`, `memory: 1024`, `supportsCancellation: true` (Vercel aborts
  `request.signal` on client disconnect; the connector then aborts the upstream call).
- Responses are JSON (no SSE streaming), so there is no buffering concern.
  `Cache-Control: no-store` is set on every MCP response.
- Payload limit: 64 KiB (connector), below Vercel's 4.5 MB platform limit.

## Environment variables

See `.env.example` for the full list. Required in production:

| Variable | Notes |
|---|---|
| `PUBLIC_BASE_URL` | The production origin, e.g. `https://<project>.vercel.app` or the custom domain |
| `AUTH_ISSUER`, `AUTH_JWKS_URL` | **BLOCKED** until an authorization server is confirmed. Without them `/mcp` returns 503. |
| `AUTH_AUDIENCE` | Defaults to `${PUBLIC_BASE_URL}/mcp` |
| `AUTH_REQUIRED_SCOPES` | Set once scope names are defined by the AS |
| `ALLOWED_ORIGINS` | Only needed if a browser-based client must call `/mcp` |

There are no secrets today: the upstream needs no credentials, and auth uses public JWKS.

## Deploy

```bash
npm ci && npm run typecheck && npm run lint && npm test
vercel link                         # team: adeveratt87's projects, project: argmuse
vercel env add PUBLIC_BASE_URL preview
vercel env add AUTH_ISSUER preview  # etc.
vercel deploy                        # preview (staging)
# verify (below), then:
vercel deploy --prod
```

## Post-deploy verification

```bash
BASE=https://<deployment>
curl -i $BASE/health                                   # 200 {"status":"ok"} when auth configured
curl -i $BASE/.well-known/oauth-protected-resource/mcp # 200 metadata
curl -i -X POST $BASE/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'  # 401 + WWW-Authenticate
# With a real token from the AS:
npx @modelcontextprotocol/inspector   # connect to $BASE/mcp (Streamable HTTP) with bearer token
```

Also confirm that a Vercel deployment can reach `api.argos.co.uk`. The reference EEAT app suggests
it can, but that hasn't been verified for this project.

## Firewall rate limit (decision D-4)

In-app limits are per instance. Add a project-level rule in **Firewall → Rules**:

- If **Request Path** equals `/mcp` → **Rate Limit**: fixed window, 60 s, **120 requests per
  IP**, action **Deny (429)**.

Adjust once real traffic is known. This needs no code change.

## Monitoring

- Vercel runtime logs: filter on `"event":"tool.upstream_error"` (by `kind`) and
  `"event":"http.request"` with `status` ≥ 500.
- Suggested alerts: upstream error rate > 5% over 5 min; any `config.invalid` or
  `auth.not_configured` event; p95 latency > 10 s.

## Rollback

- `vercel rollback` (or promote the previous deployment in the dashboard). The connector
  is stateless, so rollback carries no data-migration risk.
- Emergency stop: remove `AUTH_ISSUER` and redeploy (or use `vercel env rm`). `/mcp` then fails closed with 503.

## Credential rotation

- The connector holds no secrets. JWKS keys rotate at the authorization server, and `jose`
  refetches on unknown `kid` (30 s cooldown).
- If upstream credentials are introduced later, store them as Vercel env vars and rotate
  them via `vercel env` + redeploy.
