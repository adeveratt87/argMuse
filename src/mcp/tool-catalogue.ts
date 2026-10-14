/**
 * The exact tool definitions the connector advertises in tools/list, obtained
 * from a real in-process MCP client. Used by the public documentation so the
 * published schemas can never drift from what Muse actually receives.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../observability/logger.js";
import { createConnectorServer, SERVER_INFO } from "./connector-server.js";
import { UpstreamError, type UpstreamSession } from "./upstream-client.js";

export interface ToolCatalogue {
  server: typeof SERVER_INFO;
  instructions: string | undefined;
  tools: Tool[];
}

// Listing tools never touches the upstream; this guard makes that explicit.
const noUpstream: UpstreamSession = {
  callTool: () => Promise.reject(new UpstreamError("protocol", "catalogue does not call upstream")),
  close: () => Promise.resolve(),
};

let cached: Promise<ToolCatalogue> | null = null;

export function toolCatalogue(): Promise<ToolCatalogue> {
  cached ??= (async () => {
    const server = createConnectorServer({
      upstream: noUpstream,
      logger: createLogger("error", () => undefined),
      correlationId: "catalogue",
      requestSignal: new AbortController().signal,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "argmuse-docs", version: "0" });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      return { server: SERVER_INFO, instructions: client.getInstructions(), tools };
    } finally {
      await client.close();
      await server.close();
    }
  })();
  cached.catch(() => (cached = null));
  return cached;
}
