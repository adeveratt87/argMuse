import { LIMITS } from "../config.js";
import { AuthError } from "./errors.js";

// RFC 6750 b64token. Exactly one scheme, one space, one token.
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

/**
 * Extracts the bearer token from the Authorization header. Tokens are only
 * accepted from the header — never from query parameters or bodies.
 */
export function extractBearerToken(header: string | null): string {
  if (header === null || header === "") {
    throw new AuthError(401, "invalid_request", "Missing bearer token");
  }
  if (header.length > LIMITS.maxBearerTokenLength + 7) {
    throw new AuthError(401, "invalid_token", "Malformed bearer token");
  }
  const m = BEARER.exec(header);
  if (!m?.[1]) throw new AuthError(401, "invalid_token", "Malformed bearer token");
  return m[1];
}
