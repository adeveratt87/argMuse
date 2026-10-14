# Meta Muse Submission Checklist

> **Meta approval has not been sought or received.** Meta's official documentation
> (`dev.meta.ai/products/connectors`, `muse.ai/platform`, `muse.ai/platform/docs`) could not be
> retrieved from the build environment (DNS failure, 2026-10-14). Everything below that
> describes Meta's requirements is **UNVERIFIED** and comes from third-party sources. It must be
> rechecked against the live portal before submission.

## What secondary sources report (unverified)

| Topic | Reported | Source type |
|---|---|---|
| Programme | "Muse Connector Platform" opened 2026-09-18 at `muse.ai/platform` | Third-party blogs |
| Submission types | "Existing MCP" (hosted endpoint + documentation) or "Raw API" | Third-party blogs |
| Transport | Public HTTPS, Streamable HTTP; stdio/localhost not supported | Third-party guides (conflicting) |
| Auth | OAuth authorization code + PKCE S256. Client registration via DCR, Client ID Metadata Documents, or static registration. Some report static bearer keys. | Third-party guides (conflicting) |
| Review | Meta reviews "functional, security, and legal requirements" and runs "end to end testing" | Quoted by third parties |

The connector was built to match the most-cited combination: Streamable HTTP, an OAuth 2.1
resource server, and RFC 9728 metadata. It contains no Meta-specific logic.

## Checklist

| Item | Status |
|---|---|
| Confirm programme eligibility and requirements on the official portal | ⛔ BLOCKED (docs unreachable) |
| Written authorisation from Argos to expose this service via Meta | ⛔ BLOCKED |
| Authorization server chosen; scopes defined; Muse registered as a client | ⛔ BLOCKED |
| Connector overview and use cases | ✅ README.md |
| Tool catalogue (schemas, classification, errors, limits) | ✅ docs/tool-catalogue.md (schemas provisional until live verification) |
| Endpoint + auth configuration | 🟡 Documented; no deployed URL yet |
| Privacy / data-processing information | 🟡 Draft in docs/data-flow-and-privacy.md; needs privacy/legal review |
| Branding, terms, privacy policy URL, support + security contacts, maintainer | ⛔ Needs Argos owners |
| Reviewer test account + representative test data | ⛔ Depends on AS decision |
| Test instructions for `search` / `getProducts` | 🟡 docs/deployment.md "Post-deploy verification"; finalise after deploy |
| Tests: empty results, invalid input, expired credentials, upstream failures | ✅ Automated (mocked upstream), see validation-report.md |
| Live upstream contract tests | ⛔ BLOCKED (egress) |
| Staging deployment + deployed tests | ⛔ BLOCKED |
| Meta onboarding flow exercised end-to-end | ⛔ BLOCKED |
| Monitoring, incident response, rotation, rollback docs | ✅ docs/deployment.md (untested) |

Reviewer credentials must go through Meta's official secure submission channel. Never
commit them.
