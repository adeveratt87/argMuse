import { describe, expect, it } from "vitest";
import { createTestApp, CALL_SEARCH } from "../helpers/app.js";
import { SEARCH_RESULT } from "../helpers/fixtures.js";
import type { MockUpstreamOptions } from "../helpers/mock-upstream.js";

async function searchWith(upstream: MockUpstreamOptions, extra: { callTimeoutMs?: number; connectTimeoutMs?: number } = {}) {
  const app = await createTestApp({ upstream, ...extra });
  const res = await app.rpc(CALL_SEARCH(7), { Authorization: `Bearer ${await app.tokens.sign()}` });
  const body = await res.json();
  return { app, res, body, text: body.result?.content?.[0]?.text as string | undefined };
}

describe("upstream failure handling", () => {
  it.each([
    [503, "currently unavailable"],
    [500, "currently unavailable"],
    [429, "busy"],
    [401, "currently unavailable"],
    [403, "currently unavailable"],
  ])("SSE open HTTP %i → safe tool error", async (status, phrase) => {
    const { res, body, text, app } = await searchWith({ openStatus: status });
    expect(res.status).toBe(200); // JSON-RPC succeeded; the tool failed
    expect(body.id).toBe(7);
    expect(body.result.isError).toBe(true);
    expect(text).toContain(phrase);
    expect(text).toMatch(/reference: [0-9a-f-]{36}/);
    expect(JSON.stringify(body)).not.toContain("internal detail");
    // Only 5xx/network is retried, and only once.
    const opens = app.mock.requests.filter((r) => r.method === "GET").length;
    expect(opens).toBe(status >= 500 ? 2 : 1);
  });

  it("message POST failure → safe tool error without upstream body text", async () => {
    const { body, text } = await searchWith({ postStatus: 502 });
    expect(body.result.isError).toBe(true);
    expect(text).toContain("currently unavailable");
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });

  it("endpoint never announced → connect timeout", async () => {
    const started = Date.now();
    const { body, text } = await searchWith({ neverAnnounce: true }, { connectTimeoutMs: 200 });
    expect(body.result.isError).toBe(true);
    expect(text).toMatch(/did not respond in time|currently unavailable/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("endpoint on a different origin is refused", async () => {
    const { body, app } = await searchWith({ endpoint: "https://evil.example/collect" });
    expect(body.result.isError).toBe(true);
    expect(app.mock.requests.some((r) => r.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("tool call that never answers → call timeout", async () => {
    const { body, text } = await searchWith({ tool: () => ({ kind: "hang" }) }, { callTimeoutMs: 200 });
    expect(body.result.isError).toBe(true);
    expect(text).toContain("did not respond in time");
  });

  it("stream truncated mid-call → error, not a hang", async () => {
    const started = Date.now();
    const { body } = await searchWith({ tool: () => ({ kind: "close" }) }, { callTimeoutMs: 500 });
    expect(body.result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("malformed upstream result → protocol error", async () => {
    const { body, text } = await searchWith({ tool: () => ({ kind: "malformed" }) });
    expect(body.result.isError).toBe(true);
    expect(text).toMatch(/unexpected response/);
  });

  it("upstream JSON-RPC error (e.g. schema change) → safe tool error", async () => {
    const { body, text } = await searchWith({ tool: () => ({ kind: "rpcError", code: -32602, message: "Unknown argument 'limit' (internal detail)" }) });
    expect(body.result.isError).toBe(true);
    expect(text).toMatch(/unexpected response/);
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });

  it("upstream isError results are passed through as errors", async () => {
    const { body } = await searchWith({ tool: () => ({ content: [{ type: "text", text: "No such category" }], isError: true }) });
    expect(body.result).toEqual({ content: [{ type: "text", text: "No such category" }], isError: true });
  });

  it("always closes the upstream session after the request", async () => {
    const { app } = await searchWith({ tool: () => SEARCH_RESULT });
    expect(app.mock.stats.opened).toBe(1);
    expect(app.mock.stats.closed).toBe(1);
  });
});

describe("cancellation", () => {
  it("client disconnect aborts the in-flight upstream call and closes the session", async () => {
    const app = await createTestApp({ upstream: { tool: () => ({ kind: "hang" }) }, callTimeoutMs: 10_000 });
    const ctrl = new AbortController();
    const started = Date.now();
    const pending = app.handlers.route(
      new Request("https://connector.test.invalid/mcp", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${await app.tokens.sign()}`,
        },
        body: JSON.stringify(CALL_SEARCH(1)),
      }),
    );
    // Wait until the upstream call is in flight, then disconnect.
    for (let i = 0; i < 100 && app.mock.stats.toolCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(app.mock.stats.toolCalls).toHaveLength(1);
    ctrl.abort();
    await pending.catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5000);
    for (let i = 0; i < 100 && app.mock.stats.closed === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(app.mock.stats.closed).toBe(1);
  });
});
