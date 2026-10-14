/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata, required by the MCP
 * authorization spec so clients can discover the authorization server.
 */
import type { Config } from "../config.js";
import type { AuthErrorCode } from "./errors.js";

export function resourceMetadataUrl(config: Config): string {
  return new URL("/.well-known/oauth-protected-resource/mcp", config.publicBaseUrl).toString();
}

export function protectedResourceMetadata(config: Config): Record<string, unknown> | null {
  if (!config.auth) return null;
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.auth.issuer],
    bearer_methods_supported: ["header"],
    ...(config.auth.requiredScopes.length > 0 ? { scopes_supported: config.auth.requiredScopes } : {}),
    resource_name: "Argos product search (read-only)",
  };
}

function quote(v: string): string {
  return `"${v.replace(/["\\]/g, "")}"`;
}

export function wwwAuthenticate(config: Config, error?: { code: AuthErrorCode; description: string }): string {
  const parts = [`resource_metadata=${quote(resourceMetadataUrl(config))}`];
  if (config.auth && config.auth.requiredScopes.length > 0) parts.push(`scope=${quote(config.auth.requiredScopes.join(" "))}`);
  // RFC 6750 §3.1: no error code when the request simply lacked credentials.
  if (error && error.code !== "invalid_request") {
    parts.push(`error=${quote(error.code)}`, `error_description=${quote(error.description)}`);
  }
  return `Bearer ${parts.join(", ")}`;
}
