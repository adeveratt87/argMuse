import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, LIMITS } from "../../src/config.js";
import { createLogger, redact } from "../../src/observability/logger.js";
import { createRateLimiter } from "../../src/security/rate-limit.js";
import { capBlocks, textBlocks, TRUNCATION_NOTE } from "../../src/tools/sanitize.js";
import { searchInput, toUpstreamSearchArgs } from "../../src/tools/search.js";
import { getProductsInput, toUpstreamFetchArgs } from "../../src/tools/get-products.js";
import { createUpstream, toUpstreamError, UpstreamError } from "../../src/mcp/upstream-client.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const BASE_ENV = { PUBLIC_BASE_URL: "https://c.example" };

describe("config", () => {
  it("defaults upstream to the Argos SSE endpoint", () => {
    expect(loadConfig(BASE_ENV).upstreamUrl.toString()).toBe("https://api.argos.co.uk/mcp/sse");
  });

  it.each([
    ["http scheme", "http://api.argos.co.uk/mcp/sse"],
    ["non-allowlisted host", "https://evil.example/mcp/sse"],
    ["lookalike host", "https://api.argos.co.uk.evil.example/mcp/sse"],
    ["non-default port", "https://api.argos.co.uk:8443/mcp/sse"],
    ["embedded credentials", "https://u:p@api.argos.co.uk/mcp/sse"],
  ])("rejects upstream URL with %s", (_l, url) => {
    expect(() => loadConfig({ ...BASE_ENV, ARGOS_MCP_URL: url })).toThrow(ConfigError);
  });

  it("requires an https PUBLIC_BASE_URL origin", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_BASE_URL: "http://c.example" })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_BASE_URL: "https://c.example/path" })).toThrow(ConfigError);
  });

  it("config errors never include values", () => {
    try {
      loadConfig({ PUBLIC_BASE_URL: "https://c.example", ARGOS_MCP_URL: "https://secret-host.internal/x" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-host");
    }
  });

  it("auth is null (fail closed) when partially configured", () => {
    const c = loadConfig({ ...BASE_ENV, AUTH_ISSUER: "https://idp.example" });
    expect(c.auth).toBeNull();
    expect(c.authConfigErrors).toContain("AUTH_JWKS_URL is required");
  });

  it("rejects symmetric/none algorithms", () => {
    const c = loadConfig({ ...BASE_ENV, AUTH_ISSUER: "https://idp.example", AUTH_JWKS_URL: "https://idp.example/jwks", AUTH_ALGORITHMS: "HS256" });
    expect(c.auth).toBeNull();
  });

  it("audience defaults to the MCP resource URL", () => {
    const c = loadConfig({ ...BASE_ENV, AUTH_ISSUER: "https://idp.example", AUTH_JWKS_URL: "https://idp.example/jwks" });
    expect(c.auth?.audience).toBe("https://c.example/mcp");
    expect(c.auth?.requiredScopes).toEqual([]);
  });
});

describe("upstream client guards", () => {
  const logger = createLogger("error", () => undefined);
  it("refuses to construct for a non-allowlisted URL", () => {
    expect(() => createUpstream({ url: new URL("https://evil.example/sse"), connectTimeoutMs: 1, callTimeoutMs: 1, logger })).toThrow();
  });

  it("refuses to call non-allowlisted upstream tool names", async () => {
    const up = createUpstream({ url: new URL("https://api.argos.co.uk/mcp/sse"), connectTimeoutMs: 1, callTimeoutMs: 1, logger, fetch: async () => new Response(null, { status: 500 }) });
    const s = up.session(new AbortController().signal);
    await expect(s.callTool("addToBasket" as never, {}, new AbortController().signal)).rejects.toMatchObject({ kind: "protocol" });
    await s.close();
  });

  it.each([
    [new SseError(429, "x", {} as never), "rate_limited"],
    [new SseError(503, "x", {} as never), "unavailable"],
    [new SseError(401, "x", {} as never), "unauthorized"],
    [new McpError(ErrorCode.RequestTimeout, "t"), "timeout"],
    [new McpError(ErrorCode.ConnectionClosed, "c"), "unavailable"],
    [new McpError(-32602, "bad"), "protocol"],
    [new Error("Error POSTing to endpoint (HTTP 429): slow down"), "rate_limited"],
    [Object.assign(new Error("t"), { name: "TimeoutError" }), "timeout"],
    ["weird", "unavailable"],
  ])("maps %s → %s", (err, kind) => {
    const mapped = toUpstreamError(err);
    expect(mapped).toBeInstanceOf(UpstreamError);
    expect(mapped.kind).toBe(kind);
    expect(mapped.message).not.toContain("slow down");
  });

  it("maps anything to cancelled once the signal is aborted", () => {
    const c = new AbortController();
    c.abort();
    expect(toUpstreamError(new Error("boom"), c.signal).kind).toBe("cancelled");
  });
});

describe("tool input mapping", () => {
  it("search trims query and applies default limit", () => {
    expect(toUpstreamSearchArgs(searchInput.parse({ query: "  kettle " }))).toEqual({ query: "kettle", limit: LIMITS.searchLimitDefault });
  });
  it("getProducts maps id to the upstream `state` argument", () => {
    expect(toUpstreamFetchArgs("FTAH5B29")).toEqual({ state: "FTAH5B29" });
  });
  it("getProducts accepts numeric and alphanumeric IDs", () => {
    expect(getProductsInput.parse({ ids: ["7482652", "FTAH5B29"] }).ids).toHaveLength(2);
  });
});

describe("output normalisation", () => {
  it("keeps only text blocks and strips control characters but not newlines/tabs", () => {
    const blocks = textBlocks({
      content: [
        { type: "text", text: "a\u0000b\u001bc\nd\te\u009f" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource_link", uri: "https://x", name: "x" },
      ],
    });
    expect(blocks).toEqual([{ type: "text", text: "abc\nd\te" }]);
  });

  it("does not alter HTML or prices", () => {
    const blocks = textBlocks({ content: [{ type: "text", text: "Description: <p>Hi</p>" }, { type: "text", text: "Price: Â£199.0" }] });
    expect(blocks.map((b) => b.text)).toEqual(["Description: <p>Hi</p>", "Price: Â£199.0"]);
  });

  it("caps block and total size and marks truncation", () => {
    const big = { type: "text" as const, text: "x".repeat(LIMITS.maxTextBlockChars + 10) };
    const out = capBlocks(Array.from({ length: 8 }, () => big));
    const total = out.reduce((n, b) => n + b.text.length, 0);
    expect(total).toBeLessThan(LIMITS.maxTotalTextChars + 500);
    expect(out[0]?.text.endsWith(TRUNCATION_NOTE)).toBe(true);
    expect(out.at(-1)?.text).toContain(TRUNCATION_NOTE);
  });
});

describe("log redaction", () => {
  it("redacts sensitive keys, bearer strings and JWTs at any depth", () => {
    // Dummy, unsigned-looking JWT ({"alg":"RS256"}.{"sub":"x"}.signature), assembled to avoid secret-scanner noise.
    const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ4In0", "c2lnbmF0dXJl"].join(".");
    const out = JSON.stringify(
      redact({
        authorization: "Bearer abc",
        nested: { access_token: "t", cookie: "c", note: `header was Bearer ${jwt}`, list: [jwt] },
        apiKey: "k",
        safe: "kettle",
      }),
    );
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("abc");
    expect(out).toContain("kettle");
    expect(out).not.toMatch(/"t"|"c"|"k"/);
  });

  it("emits one JSON object per line and honours level", () => {
    const lines: string[] = [];
    const log = createLogger("warn", (l) => lines.push(l));
    log.info("skip");
    log.warn("keep", { token: "x" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", event: "keep", token: "[REDACTED]" });
  });
});

describe("rate limiter", () => {
  it("resets after the window and bounds tracked keys", () => {
    let t = 0;
    const rl = createRateLimiter({ perKeyPerMinute: 1, globalPerMinute: 100, now: () => t, maxKeys: 2 });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    expect(rl.check("b").allowed).toBe(true);
    expect(rl.check("c").allowed).toBe(false); // key table full
    t = 60_000;
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("c").allowed).toBe(true); // expired entries evicted
  });
});
