/**
 * Prints the live upstream tools/list result as JSON, for recording in
 * docs/fixtures/upstream-tools-list.json. Read-only: calls tools/list only.
 *   npm run discover > docs/fixtures/upstream-tools-list.json
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const url = new URL("https://api.argos.co.uk/mcp/sse");
const client = new Client({ name: "argos-muse-connector-discovery", version: "0" });
await client.connect(new SSEClientTransport(url));
const tools = await client.listTools();
console.log(
  JSON.stringify(
    { capturedAt: new Date().toISOString(), serverVersion: client.getServerVersion(), capabilities: client.getServerCapabilities(), ...tools },
    null,
    2,
  ),
);
await client.close();
