/**
 * OAuth 2.1 resource-server token validation for JWT access tokens
 * (RFC 9068 style). Provider-agnostic: issuer, JWKS, audience and scopes all
 * come from configuration. No provider-specific endpoints are assumed.
 *
 * Opaque tokens (RFC 7662 introspection) are not supported until an
 * authorization server is confirmed — see README blockers.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthConfig } from "../config.js";
import { AuthError } from "./errors.js";

export interface Principal {
  subject: string;
  clientId?: string;
  scopes: string[];
  expiresAt?: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export function createJwtVerifier(
  auth: AuthConfig,
  opts: { keys?: JWTVerifyGetKey; clockToleranceSeconds?: number } = {},
): TokenVerifier {
  const keys =
    opts.keys ??
    createRemoteJWKSet(auth.jwksUrl, { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });

  return {
    async verify(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          issuer: auth.issuer,
          audience: auth.audience,
          algorithms: auth.algorithms,
          clockTolerance: opts.clockToleranceSeconds ?? 30,
          requiredClaims: ["exp", "sub"],
        }));
      } catch (err) {
        // Distinguish only what is safe to tell the caller.
        if (err instanceof joseErrors.JWTExpired) throw new AuthError(401, "invalid_token", "Token expired");
        if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) {
          // Key fetch problems are our side; still 401 so the client can retry auth.
          throw new AuthError(401, "invalid_token", "Token could not be validated");
        }
        throw new AuthError(401, "invalid_token", "Invalid token");
      }

      if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 256) {
        throw new AuthError(401, "invalid_token", "Invalid token");
      }

      const scopes = parseScopes(payload.scope, payload.scp);
      const missing = auth.requiredScopes.filter((s) => !scopes.includes(s));
      if (missing.length > 0) throw new AuthError(403, "insufficient_scope", "Insufficient scope");

      const clientId =
        typeof payload.client_id === "string" ? payload.client_id : typeof payload.azp === "string" ? payload.azp : undefined;

      return { subject: payload.sub, clientId, scopes, expiresAt: payload.exp };
    },
  };
}

function parseScopes(scope: unknown, scp: unknown): string[] {
  if (typeof scope === "string") return scope.split(" ").filter(Boolean);
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === "string");
  return [];
}
