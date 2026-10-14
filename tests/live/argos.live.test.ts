/**
 * LIVE upstream contract tests. Skipped unless ARGOS_LIVE_TESTS=1.
 * Run from an environment permitted to reach api.argos.co.uk:
 *   npm run test:live
 * Failures here mean docs/upstream-contract.md is out of date.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { DEFAULT_UPSTREAM_URL } from "../../src/config.js";
import { createUpstream } from "../../src/mcp/upstream-client.js";
import { createLogger } from "../../src/observability/logger.js";
import { runSearch } from "../../src/tools/search.js";
import { runGetProducts } from "../../src/tools/get-products.js";

const LIVE = process.env.ARGOS_LIVE_TESTS === "1";
const url = new URL(DEFAULT_UPSTREAM_URL);

describe.skipIf(!LIVE)("LIVE Argos MCP upstream", () => {
  it("lists searchProducts and fetchProduct", { timeout: 30_000 }, async () => {
    const client = new Client({ name: "argos-muse-connector-contract-test", version: "0" });
    await client.connect(new SSEClientTransport(url));
    const { tools } = await client.listTools();
    await client.close();
    const names = tools.map((t) => t.name);
    expect(names).toContain("searchProducts");
    expect(names).toContain("fetchProduct");
  });

  it("search and getProducts work end-to-end through the connector's upstream client", { timeout: 60_000 }, async () => {
    const upstream = createUpstream({ url, connectTimeoutMs: 8000, callTimeoutMs: 20_000, logger: createLogger("warn") });
    const signal = new AbortController().signal;
    const session = upstream.session(signal);
    try {
      const search = await runSearch({ query: "kettle", limit: 5 }, session, signal);
      expect(search.isError).toBe(false);
      const text = search.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const id = /ID:\s*([A-Za-z0-9]+)/.exec(text)?.[1];
      expect(id, "search output no longer matches 'ID: x, Product: y, Price: z'").toBeTruthy();

      const detail = await runGetProducts({ ids: [id!] }, session, signal);
      expect(detail.isError).toBe(false);
      const d = detail.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      expect(d).toContain(`Product Information for ${id}`);
    } finally {
      await session.close();
    }
  });
});
