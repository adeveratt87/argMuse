import { describe, expect, it } from "vitest";
import { createTestApp, CALL_SEARCH, BASE } from "../helpers/app.js";
import { SEARCH_RESULT } from "../helpers/fixtures.js";

const tool = () => SEARCH_RESULT;

describe("HTTP hardening", () => {
  it("403 for a disallowed Origin (before auth), allows configured origins and no-Origin callers", async () => {
    const app = await createTestApp({ upstream: { tool }, env: { ALLOWED_ORIGINS: "https://muse.example" } });
    const token = await app.tokens.sign();
    const evil = await app.rpc(CALL_SEARCH(1), { Origin: "https://evil.example", Authorization: `Bearer ${token}` });
    expect(evil.status).toBe(403);
    const ok = await app.rpc(CALL_SEARCH(1), { Origin: "https://muse.example", Authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    const none = await app.rpc(CALL_SEARCH(1), { Authorization: `Bearer ${token}` });
    expect(none.status).toBe(200);
  });

  it("Origin is never a substitute for authentication", async () => {
    const app = await createTestApp({ upstream: { tool }, env: { ALLOWED_ORIGINS: "https://muse.example" } });
    const res = await app.rpc(CALL_SEARCH(1), { Origin: "https://muse.example" });
    expect(res.status).toBe(401);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""])(
    "415 for Content-Type %j",
    async (ct) => {
      const app = await createTestApp();
      const res = await app.rpc(CALL_SEARCH(1), { "Content-Type": ct, Authorization: `Bearer ${await app.tokens.sign()}` });
      expect(res.status).toBe(415);
    },
  );

  it("accepts application/json with a charset parameter", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const res = await app.rpc(CALL_SEARCH(1), { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${await app.tokens.sign()}` });
    expect(res.status).toBe(200);
  });

  it("413 for a declared oversized body, before authentication", async () => {
    const app = await createTestApp();
    const res = await app.rpc(CALL_SEARCH(1), { "Content-Length": String(1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("413 for an oversized streamed body without Content-Length", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const big = JSON.stringify(CALL_SEARCH(1, { query: "x".repeat(70 * 1024) }));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const res = await app.handlers.route(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        body: stream,
        duplex: "half",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${await app.tokens.sign()}` },
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(app.mock.requests).toHaveLength(0);
  });

  it("per-subject rate limit returns 429 with Retry-After; other subjects unaffected", async () => {
    const app = await createTestApp({ upstream: { tool }, perKeyPerMinute: 2 });
    const alice = await app.tokens.sign({ sub: "alice" });
    const bob = await app.tokens.sign({ sub: "bob" });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await app.rpc(CALL_SEARCH(i), { Authorization: `Bearer ${alice}` })).status);
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await app.rpc(CALL_SEARCH(9), { Authorization: `Bearer ${alice}` });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await app.rpc(CALL_SEARCH(10), { Authorization: `Bearer ${bob}` })).status).toBe(200);
  });

  it("rate limit keys on the validated subject, not caller-supplied identity headers", async () => {
    const app = await createTestApp({ upstream: { tool }, perKeyPerMinute: 1 });
    const token = await app.tokens.sign({ sub: "alice" });
    expect((await app.rpc(CALL_SEARCH(1), { Authorization: `Bearer ${token}`, "X-User-Context": "u1" })).status).toBe(200);
    expect((await app.rpc(CALL_SEARCH(2), { Authorization: `Bearer ${token}`, "X-User-Context": "u2" })).status).toBe(429);
  });

  it("global rate limit applies across subjects", async () => {
    const app = await createTestApp({ upstream: { tool }, globalPerMinute: 2 });
    const s = [];
    for (const sub of ["a", "b", "c"]) s.push((await app.rpc(CALL_SEARCH(1), { Authorization: `Bearer ${await app.tokens.sign({ sub })}` })).status);
    expect(s).toEqual([200, 200, 429]);
  });

  it("unauthenticated requests do not consume rate limit", async () => {
    const app = await createTestApp({ upstream: { tool }, globalPerMinute: 1 });
    for (let i = 0; i < 5; i++) expect((await app.rpc(CALL_SEARCH(1))).status).toBe(401);
    expect((await app.rpc(CALL_SEARCH(1), { Authorization: `Bearer ${await app.tokens.sign()}` })).status).toBe(200);
  });

  it("unknown paths are 404", async () => {
    const app = await createTestApp();
    expect((await app.handlers.route(new Request(`${BASE}/admin`))).status).toBe(404);
  });
});

describe("no secrets in logs or responses", () => {
  it("logs never contain tokens, cookies, identity headers or search text; responses carry no stack traces", async () => {
    const app = await createTestApp({ upstream: { openStatus: 503 } });
    const token = await app.tokens.sign();
    const bad = await app.tokens.sign({ aud: "https://wrong" });
    const responses = [
      await app.rpc(CALL_SEARCH(1, { query: "my home address 1 Acacia Avenue" }), {
        Authorization: `Bearer ${token}`,
        Cookie: "sid=supersecretcookie",
        "X-User-Context": "victim",
      }),
      await app.rpc(CALL_SEARCH(2), { Authorization: `Bearer ${bad}` }),
      await app.rpc("{broken", { Authorization: `Bearer ${token}` }),
    ];
    const allLogs = app.logs.join("\n");
    expect(app.logs.length).toBeGreaterThan(0);
    for (const secret of [token, bad, "supersecretcookie", "Acacia", "victim"]) expect(allLogs).not.toContain(secret);
    expect(allLogs).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}\./);
    for (const r of responses) {
      const text = await r.text();
      expect(text).not.toMatch(/\bat .+\.(ts|js):\d+/); // stack frames
      expect(text).not.toContain(token);
      expect(r.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Every log line is valid JSON with a correlation id for request events.
    for (const line of app.logs) {
      const rec = JSON.parse(line);
      if (rec.event === "http.request") expect(rec.correlationId).toBeTruthy();
    }
  });
});

describe("playground support", () => {
  it("allows the connector's own origin without configuring ALLOWED_ORIGINS", async () => {
    const app = await createTestApp({ upstream: { tool } });
    const res = await app.rpc(CALL_SEARCH(1), { Origin: BASE, Authorization: `Bearer ${await app.tokens.sign()}` });
    expect(res.status).toBe(200);
    const other = await app.rpc(CALL_SEARCH(1), { Origin: "https://argmuse.vercel.app.evil.example", Authorization: `Bearer ${await app.tokens.sign()}` });
    expect(other.status).toBe(403);
  });

  it("serves a Client ID Metadata Document whose client_id is its own URL", async () => {
    const app = await createTestApp();
    const res = await app.handlers.route(new Request(`${BASE}/oauth/client-metadata.json`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      client_id: `${BASE}/oauth/client-metadata.json`,
      client_name: "argMuse Playground",
      client_uri: `${BASE}/`,
      redirect_uris: [`${BASE}/`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const post = await app.handlers.route(new Request(`${BASE}/oauth/client-metadata.json`, { method: "POST" }));
    expect(post.status).toBe(405);
  });
});
