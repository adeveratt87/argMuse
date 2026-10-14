/**
 * MCP Streamable HTTP: servers MUST validate Origin and return 403 when it is
 * present and invalid. Server-to-server callers send no Origin and are allowed
 * through to authentication. Origin is never treated as authentication.
 */
export function isOriginAllowed(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null) return true;
  return allowed.includes(origin);
}
