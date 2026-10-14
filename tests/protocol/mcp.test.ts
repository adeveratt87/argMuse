import { describe, expect, it } from "vitest";
import { createTestApp, CALL_SEARCH } from "../helpers/app.js";
import { EMPTY_SEARCH_RESULT, SEARCH_RESULT, productDetail } from "../helpers/fixtures.js";
import type { ToolBehaviour } from "../helpers/mock-upstream.js";

const happy = (name: string, args: Record<string, unknown>): ToolBehaviour => {
  if (name === "searchProducts") return SEARCH_RESULT;
  if (name === "fetchProduct") return productDetail(String(args.state));
  return { kind: "rpcError", code: -32601, message: "unknown" };
};

describe("MCP protocol (Streamable HTTP, stateless)", () => {
  it("initializes and advertises only the tools capability", async () => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const client = await app.connectClient(await app.tokens.sign());
    expect(client.getServerVersion()).toMatchObject({ name: "argos-muse-connector" });
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeUndefined();
    expect(caps?.prompts).toBeUndefined();
    await client.close();
  });

  it("discovers exactly search and getProducts with read-only annotations", async () => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const client = await app.connectClient(await app.tokens.sign());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["getProducts", "search"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.inputSchema.type).toBe("object");
    }
    const search = tools.find((t) => t.name === "search")!;
    expect(search.inputSchema.required).toEqual(["query"]);
    expect(search.inputSchema.additionalProperties).toBe(false);
    const gp = tools.find((t) => t.name === "getProducts")!;
    expect(gp.inputSchema.required).toEqual(["ids"]);
    // No upstream session is needed for discovery.
    expect(app.mock.stats.opened).toBe(0);
  });

  it("search maps to upstream searchProducts and passes Argos text through unchanged", async () => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const client = await app.connectClient(await app.tokens.sign());
    const res = await client.callTool({ name: "search", arguments: { query: "  tv  ", limit: 5 } });
    expect(res.isError).toBe(false);
    expect(res.content).toEqual(SEARCH_RESULT.content);
    expect(app.mock.stats.toolCalls).toEqual([{ name: "searchProducts", args: { query: "tv", limit: 5 } }]);
  });

  it("search applies the default limit", async () => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const client = await app.connectClient(await app.tokens.sign());
    await client.callTool({ name: "search", arguments: { query: "tv" } });
    expect(app.mock.stats.toolCalls[0]?.args).toEqual({ query: "tv", limit: 20 });
  });

  it("search returns a clear non-error message for empty results", async () => {
    const app = await createTestApp({ upstream: { tool: () => EMPTY_SEARCH_RESULT } });
    const client = await app.connectClient(await app.tokens.sign());
    const res = await client.callTool({ name: "search", arguments: { query: "zzzz" } });
    expect(res.isError).toBe(false);
    expect(res.content).toEqual([{ type: "text", text: "No products were returned by Argos for this search." }]);
  });

  it("getProducts fans out to fetchProduct(state=id) on ONE upstream session, deduplicating IDs", async () => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const client = await app.connectClient(await app.tokens.sign());
    const res = await client.callTool({ name: "getProducts", arguments: { ids: ["7482652", "FTAH5B29", "7482652"] } });
    expect(res.isError).toBe(false);
    expect(app.mock.stats.toolCalls.map((c) => c.args)).toEqual([{ state: "7482652" }, { state: "FTAH5B29" }]);
    expect(app.mock.stats.opened).toBe(1);
    expect(app.mock.stats.closed).toBe(1);
    const text = (res.content as { text: string }[]).map((b) => b.text).join("\n");
    expect(text).toContain("Product Information for 7482652");
    expect(text).toContain("Product Information for FTAH5B29");
    expect(text).toContain("Price: Â£199.0"); // upstream quirk preserved, not "fixed"
  });

  it("getProducts reports partial results per ID without failing the whole call", async () => {
    const app = await createTestApp({
      upstream: {
        tool: (name, args) =>
          args.state === "1111111" ? { kind: "rpcError", code: -32000, message: "internal upstream detail" } : happy(name, args),
      },
    });
    const client = await app.connectClient(await app.tokens.sign());
    const res = await client.callTool({ name: "getProducts", arguments: { ids: ["7482652", "1111111"] } });
    expect(res.isError).toBe(false);
    const text = (res.content as { text: string }[]).map((b) => b.text).join("\n");
    expect(text).toContain("Product 1111111: could not be retrieved.");
    expect(text).not.toContain("internal upstream detail");
  });

  it("getProducts with every ID failing is an error result", async () => {
    const app = await createTestApp({ upstream: { tool: () => ({ content: [], isError: true }) } });
    const client = await app.connectClient(await app.tokens.sign());
    const res = await client.callTool({ name: "getProducts", arguments: { ids: ["123"] } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "Product 123: no details were returned by Argos." }]);
  });

  it("rejects unknown tools without contacting upstream, even ones the upstream offers", async () => {
    const app = await createTestApp({ upstream: { tool: happy } });
    for (const name of ["searchProducts", "fetchProducts", "addToBasket", "checkout"]) {
      const res = await app.rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, {
        Authorization: `Bearer ${await app.tokens.sign()}`,
      });
      const body = await res.json();
      expect(body.result?.isError, name).toBe(true);
      expect(body.result.content[0].text, name).toMatch(/Tool .+ not found/);
    }
    expect(app.mock.stats.opened).toBe(0);
  });

  it.each([
    ["missing query", {}],
    ["empty query", { query: "   " }],
    ["oversized query", { query: "x".repeat(201) }],
    ["control characters", { query: "tv\u0000" }],
    ["limit too high", { query: "tv", limit: 51 }],
    ["non-integer limit", { query: "tv", limit: 2.5 }],
    ["unknown parameter", { query: "tv", url: "https://evil.example" }],
  ])("search rejects invalid input: %s", async (_label, args) => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const res = await app.rpc(CALL_SEARCH(1, args), { Authorization: `Bearer ${await app.tokens.sign()}` });
    const body = await res.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Input validation error");
    expect(app.mock.stats.toolCalls).toHaveLength(0);
  });

  it.each([
    ["empty list", { ids: [] }],
    ["too many ids", { ids: Array.from({ length: 11 }, (_, i) => String(1000 + i)) }],
    ["id with punctuation", { ids: ["123/../456"] }],
    ["id too long", { ids: ["1".repeat(21)] }],
    ["not an array", { ids: "123" }],
  ])("getProducts rejects invalid input: %s", async (_label, args) => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const res = await app.rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "getProducts", arguments: args } },
      { Authorization: `Bearer ${await app.tokens.sign()}` },
    );
    const body = await res.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Input validation error");
    expect(app.mock.stats.toolCalls).toHaveLength(0);
  });

  it("preserves JSON-RPC request ids", async () => {
    const app = await createTestApp({ upstream: { tool: happy } });
    const res = await app.rpc({ jsonrpc: "2.0", id: "abc-42", method: "tools/list" }, { Authorization: `Bearer ${await app.tokens.sign()}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.id).toBe("abc-42");
  });

  it("answers notifications with 202 and no session id (stateless)", async () => {
    const app = await createTestApp();
    const res = await app.rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { Authorization: `Bearer ${await app.tokens.sign()}` });
    expect(res.status).toBe(202);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("returns -32700 for malformed JSON and -32600 for batches", async () => {
    const app = await createTestApp();
    const auth = { Authorization: `Bearer ${await app.tokens.sign()}` };
    const bad = await app.rpc("{not json", auth);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    const batch = await app.rpc([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], auth);
    expect(batch.status).toBe(400);
    expect((await batch.json()).error.code).toBe(-32600);
  });

  it("returns method-not-found for unsupported JSON-RPC methods", async () => {
    const app = await createTestApp();
    const res = await app.rpc({ jsonrpc: "2.0", id: 9, method: "resources/list" }, { Authorization: `Bearer ${await app.tokens.sign()}` });
    expect((await res.json()).error.code).toBe(-32601);
  });

  it("rejects GET (no server-initiated stream) and DELETE with 405", async () => {
    const app = await createTestApp();
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await app.rpc(undefined, { Authorization: `Bearer ${await app.tokens.sign()}` }, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("rejects a client that does not accept JSON (406)", async () => {
    const app = await createTestApp();
    const res = await app.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${await app.tokens.sign()}`,
      Accept: "text/html",
    });
    expect(res.status).toBe(406);
  });
});
