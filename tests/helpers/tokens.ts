import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

export const ISSUER = "https://auth.test.invalid";
export const AUDIENCE = "https://connector.test.invalid/mcp";

export async function createTokenFactory() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const other = await generateKeyPair("RS256");

  async function sign(
    claims: JWTPayload = {},
    opts: { expiresIn?: string | number; notBefore?: string | number; foreignKey?: boolean; omit?: string[] } = {},
  ): Promise<string> {
    const payload: JWTPayload = { iss: ISSUER, aud: AUDIENCE, sub: "user-123", scope: "products:read", ...claims };
    for (const k of opts.omit ?? []) delete payload[k];
    const jwt = new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt();
    if (!opts.omit?.includes("exp")) jwt.setExpirationTime(opts.expiresIn ?? "5m");
    if (opts.notBefore !== undefined) jwt.setNotBefore(opts.notBefore);
    return jwt.sign(opts.foreignKey ? other.privateKey : privateKey);
  }

  return { keys, sign };
}
