import { describe, expect, it } from "vitest";
import { UnsecuredJWT } from "jose";
import { createTestApp, CALL_SEARCH, BASE } from "../helpers/app.js";
import { SEARCH_RESULT } from "../helpers/fixtures.js";
import { extractBearerToken } from "../../src/auth/bearer.js";
import { AuthError } from "../../src/auth/errors.js";

const tool = () => SEARCH_RESULT;

async function call(app: Awaited<ReturnType<typeof createTestApp>>, authorization?: string) {
  return app.rpc(CALL_SEARCH(1), authorization === undefined ? {} : { Authorization: authorization });
}

describe("bearer extraction", () => {
  it.each([
    ["missing", null, "invalid_request"],
    ["empty", "", "invalid_request"],
    ["wrong scheme", "Basic dXNlcjpwYXNz", "invalid_token"],
    ["scheme only", "Bearer", "invalid_token"],
    ["scheme with space only", "Bearer ", "invalid_token"],
    ["two tokens", "Bearer a b", "invalid_token"],
    ["illegal characters", "Bearer abc$def", "invalid_token"],
    ["oversized", `Bearer ${"a".repeat(9000)}`, "invalid_token"],
  ])("rejects %s", (_l, header, code) => {
    try {
      extractBearerToken(header);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).code).toBe(code);
      expect((e as AuthError).status).toBe(401);
    }
  });

  it("accepts a well-formed bearer token", () => {
    expect(extractBearerToken("Bearer abc.def-ghi_jkl")).toBe("abc.def-ghi_jkl");
  });
});

describe("authentication on /mcp (rejected before any upstream work)", () => {
  it("401 with RFC 9728 discovery header when no token is sent", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const res = await call(app);
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate")!;
    expect(www).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(www).toContain('scope="products:read"');
    expect(www).not.toContain("error=");
    expect(app.mock.requests).toHaveLength(0);
  });

  it("rejects a token merely because it starts with Bearer", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const res = await call(app, "Bearer not-a-jwt");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(app.mock.requests).toHaveLength(0);
  });

  const cases: [string, (t: Awaited<ReturnType<typeof createTestApp>>["tokens"]) => Promise<string>, number, string][] = [
    ["expired", (t) => t.sign({}, { expiresIn: Math.floor(Date.now() / 1000) - 120 }), 401, "invalid_token"],
    ["not yet valid (nbf)", (t) => t.sign({}, { notBefore: Math.floor(Date.now() / 1000) + 600 }), 401, "invalid_token"],
    ["wrong issuer", (t) => t.sign({ iss: "https://evil.example" }), 401, "invalid_token"],
    ["wrong audience", (t) => t.sign({ aud: "https://other-resource.example/mcp" }), 401, "invalid_token"],
    ["signed by an unknown key", (t) => t.sign({}, { foreignKey: true }), 401, "invalid_token"],
    ["missing exp", (t) => t.sign({}, { omit: ["exp"] }), 401, "invalid_token"],
    ["missing sub", (t) => t.sign({}, { omit: ["sub"] }), 401, "invalid_token"],
    ["unsigned (alg=none)", async () => new UnsecuredJWT({ iss: "https://auth.test.invalid", sub: "x" }).encode(), 401, "invalid_token"],
    ["insufficient scope", (t) => t.sign({ scope: "profile" }), 403, "insufficient_scope"],
    ["no scope at all", (t) => t.sign({}, { omit: ["scope"] }), 403, "insufficient_scope"],
  ];

  it.each(cases)("%s → %i", async (_l, make, status, code) => {
    const app = await createTestApp({ upstream: { tool } });
    const res = await call(app, `Bearer ${await make(app.tokens)}`);
    expect(res.status).toBe(status);
    expect(res.headers.get("www-authenticate")).toContain(`error="${code}"`);
    const body = await res.text();
    expect(body).not.toMatch(/eyJ/); // no token echo
    expect(app.mock.requests).toHaveLength(0);
  });

  it("accepts scopes in the scp array form", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const res = await call(app, `Bearer ${await app.tokens.sign({ scp: ["products:read"] }, { omit: ["scope"] })}`);
    expect(res.status).toBe(200);
  });

  it("accepts a valid token and reaches upstream", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const res = await call(app, `Bearer ${await app.tokens.sign()}`);
    expect(res.status).toBe(200);
    expect(app.mock.stats.toolCalls).toHaveLength(1);
  });

  it("fails closed with 503 when auth is not configured (no bypass mode)", async () => {
    const app = await createTestApp({ authConfigured: false, upstream: { tool } });
    const res = await call(app, `Bearer ${await app.tokens.sign()}`);
    expect(res.status).toBe(503);
    expect(app.mock.requests).toHaveLength(0);
    const health = await app.handlers.route(new Request(`${BASE}/health`));
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "not_ready", checks: { authConfigured: false } });
    const meta = await app.handlers.route(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`));
    expect(meta.status).toBe(503);
  });

  it("never accepts a token from the query string", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const token = await app.tokens.sign();
    const res = await app.handlers.route(
      new Request(`${BASE}/mcp?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(CALL_SEARCH(1)),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("caller/upstream credential separation", () => {
  it("never forwards the caller's token, cookies or identity headers upstream", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const token = await app.tokens.sign();
    const res = await app.rpc(CALL_SEARCH(1), {
      Authorization: `Bearer ${token}`,
      Cookie: "session=secret-cookie",
      "X-User-Context": '{"userId":"admin","tenant":"other"}',
      "X-Tenant-Id": "other-tenant",
      "X-Forwarded-For": "10.0.0.1",
    });
    expect(res.status).toBe(200);
    expect(app.mock.requests.length).toBeGreaterThan(0);
    for (const r of app.mock.requests) {
      const names = Object.keys(r.headers).map((h) => h.toLowerCase());
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("cookie");
      expect(names).not.toContain("x-user-context");
      expect(names).not.toContain("x-tenant-id");
      expect(names).not.toContain("x-forwarded-for");
      expect(JSON.stringify(r)).not.toContain(token);
      expect(JSON.stringify(r)).not.toContain("secret-cookie");
      expect(r.url).not.toContain(token);
    }
  });
});

describe("protected resource metadata (RFC 9728)", () => {
  it("publishes resource, authorization server and scopes", async () => {
    const app = await createTestApp();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await app.handlers.route(new Request(`${BASE}${path}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: `${BASE}/mcp`,
        authorization_servers: ["https://auth.test.invalid"],
        bearer_methods_supported: ["header"],
        scopes_supported: ["products:read"],
        resource_name: "Argos product search (read-only)",
      });
    }
  });
});
