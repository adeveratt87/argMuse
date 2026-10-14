/**
 * In-process mock of the Argos legacy HTTP+SSE MCP server, exposed as a
 * `fetch` implementation so no network or ports are used. Wire behaviour
 * follows the REFERENCE contract: GET opens an SSE stream whose first event
 * is `endpoint`; JSON-RPC POSTs are answered on that stream.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UPSTREAM_TOOLS_LIST } from "./fixtures.js";

export type ToolBehaviour =
  | CallToolResult
  | { kind: "hang" }
  | { kind: "close" }
  | { kind: "malformed" }
  | { kind: "rpcError"; code: number; message: string }
  | { kind: "delay"; ms: number; result: CallToolResult };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface MockUpstreamOptions {
  openStatus?: number;
  openHeaders?: Record<string, string>;
  neverAnnounce?: boolean;
  endpoint?: string;
  postStatus?: number;
  tool?: (name: string, args: Record<string, unknown>) => ToolBehaviour;
}

export function createMockUpstream(opts: MockUpstreamOptions = {}) {
  const requests: RecordedRequest[] = [];
  const sessions = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const stats = { opened: 0, closed: 0, toolCalls: [] as { name: string; args: Record<string, unknown> }[] };
  const enc = new TextEncoder();
  let seq = 0;

  const send = (sid: string, data: unknown) => {
    const c = sessions.get(sid);
    if (!c) return;
    try {
      c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      /* stream closed */
    }
  };

  async function fetchImpl(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const method = (init.method ?? "GET").toUpperCase();
    const rec: RecordedRequest = { method, url: url.toString(), headers };
    requests.push(rec);

    if (method === "GET" && url.pathname === "/mcp/sse") {
      if (opts.openStatus && opts.openStatus !== 200) {
        return new Response("upstream error body with internal detail", { status: opts.openStatus, headers: opts.openHeaders });
      }
      const sid = `s${++seq}`;
      stats.opened++;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sessions.set(sid, controller);
          if (!opts.neverAnnounce) {
            controller.enqueue(enc.encode(`event: endpoint\ndata: ${opts.endpoint ?? `/mcp/messages?sessionId=${sid}`}\n\n`));
          }
          init.signal?.addEventListener("abort", () => {
            if (sessions.delete(sid)) stats.closed++;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
        cancel() {
          if (sessions.delete(sid)) stats.closed++;
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }

    if (method === "POST" && url.pathname === "/mcp/messages") {
      const sid = url.searchParams.get("sessionId") ?? "";
      const msg = JSON.parse(String(init.body)) as { id?: number | string; method: string; params?: Record<string, unknown> };
      rec.body = msg;
      if (opts.postStatus) return new Response("post failed with internal detail", { status: opts.postStatus });
      if (!sessions.has(sid)) return new Response("unknown session", { status: 404 });
      if (msg.id === undefined) return new Response(null, { status: 202 });

      queueMicrotask(async () => {
        if (msg.method === "initialize") {
          send(sid, {
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock-argos", version: "0" } },
          });
          return;
        }
        if (msg.method === "tools/list") {
          send(sid, { jsonrpc: "2.0", id: msg.id, result: UPSTREAM_TOOLS_LIST });
          return;
        }
        if (msg.method === "tools/call") {
          const name = String(msg.params?.name);
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          stats.toolCalls.push({ name, args });
          const b = opts.tool?.(name, args) ?? { kind: "rpcError", code: -32601, message: "unknown tool" };
          if ("kind" in b) {
            if (b.kind === "hang") return;
            if (b.kind === "close") {
              const c = sessions.get(sid);
              sessions.delete(sid);
              stats.closed++;
              c?.close();
              return;
            }
            if (b.kind === "malformed") {
              send(sid, { jsonrpc: "2.0", id: msg.id, result: { content: "not-an-array" } });
              return;
            }
            if (b.kind === "rpcError") {
              send(sid, { jsonrpc: "2.0", id: msg.id, error: { code: b.code, message: b.message } });
              return;
            }
            if (b.kind === "delay") {
              const d = b as { ms: number; result: CallToolResult };
              setTimeout(() => send(sid, { jsonrpc: "2.0", id: msg.id, result: d.result }), d.ms);
              return;
            }
          }
          send(sid, { jsonrpc: "2.0", id: msg.id, result: b });
          return;
        }
        send(sid, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      });
      return new Response(null, { status: 202 });
    }

    return new Response("not found", { status: 404 });
  }

  return { fetch: fetchImpl, requests, stats };
}
