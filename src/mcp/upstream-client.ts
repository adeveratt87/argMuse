/**
 * Client for the Argos MCP upstream (legacy HTTP+SSE, MCP 2024-11-05 style),
 * built on the official SDK. One upstream session per inbound request; it is
 * opened lazily on the first tool call and closed when the request ends.
 *
 * Security properties:
 * - The upstream URL is fixed by configuration and host-allowlisted; every
 *   outbound request (SSE GET and message POSTs) is checked against it.
 * - Redirects are refused.
 * - No caller-supplied header, token or identity is ever sent upstream.
 * - Only the tool names in UPSTREAM_TOOLS can be called.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateUpstreamUrl } from "../config.js";
import type { Logger } from "../observability/logger.js";

/** The only upstream tools this connector may call (see docs/upstream-contract.md). */
export const UPSTREAM_TOOLS = ["searchProducts", "fetchProduct"] as const;
export type UpstreamToolName = (typeof UPSTREAM_TOOLS)[number];

export type UpstreamErrorKind = "unavailable" | "timeout" | "rate_limited" | "unauthorized" | "protocol" | "cancelled";

export class UpstreamError extends Error {
  constructor(
    public readonly kind: UpstreamErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface UpstreamSession {
  callTool(name: UpstreamToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface Upstream {
  /** Returns a session that connects on first use. */
  session(signal: AbortSignal): UpstreamSession;
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface UpstreamOptions {
  url: URL;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  logger: Logger;
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  clientVersion?: string;
}

function guardedFetch(base: FetchLike, allowedOrigin: string): FetchLike {
  return async (url, init) => {
    const target = new URL(url);
    if (target.origin !== allowedOrigin) {
      throw new UpstreamError("protocol", "Refused request to non-allowlisted upstream origin");
    }
    return base(target, { ...init, redirect: "error" });
  };
}

function statusFromMessage(message: string): number | undefined {
  const m = /\(HTTP (\d{3})\)/.exec(message);
  return m?.[1] ? Number(m[1]) : undefined;
}

function kindForStatus(status: number | undefined): UpstreamErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  return "unavailable";
}

/** Maps any failure to an UpstreamError with a message safe to log (no upstream body text). */
export function toUpstreamError(err: unknown, signal?: AbortSignal): UpstreamError {
  if (err instanceof UpstreamError) return err;
  if (signal?.aborted) return new UpstreamError("cancelled", "Request cancelled");
  if (err instanceof SseError) {
    return new UpstreamError(kindForStatus(err.code), `Upstream stream error${err.code ? ` (HTTP ${err.code})` : ""}`, err.code);
  }
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return new UpstreamError("timeout", "Upstream request timed out");
    if (err.code === ErrorCode.ConnectionClosed) return new UpstreamError("unavailable", "Upstream connection closed");
    return new UpstreamError("protocol", `Upstream JSON-RPC error ${err.code}`);
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return new UpstreamError("timeout", "Upstream request timed out");
    if (err.name === "AbortError") return new UpstreamError("cancelled", "Request cancelled");
    if (err.name === "ZodError" || err.name === "$ZodError") return new UpstreamError("protocol", "Malformed upstream response");
    const status = statusFromMessage(err.message);
    if (status) return new UpstreamError(kindForStatus(status), `Upstream HTTP ${status}`, status);
  }
  return new UpstreamError("unavailable", "Upstream request failed");
}

export function createUpstream(opts: UpstreamOptions): Upstream {
  validateUpstreamUrl(opts.url);
  const fetchImpl = guardedFetch(opts.fetch ?? fetch, opts.url.origin);

  async function connect(signal: AbortSignal): Promise<{ client: Client; transport: SSEClientTransport }> {
    const transport = new SSEClientTransport(opts.url, { fetch: fetchImpl, redirectPolicy: "same-origin" });
    const client = new Client({ name: "argos-muse-connector", version: opts.clientVersion ?? "0.1.0" }, { capabilities: {} });
    const timeout = AbortSignal.timeout(opts.connectTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        client.connect(transport, { signal: combined, timeout: opts.connectTimeoutMs }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(timeout.aborted && !signal.aborted ? new UpstreamError("timeout", "Upstream connect timed out") : new UpstreamError("cancelled", "Request cancelled"));
          if (combined.aborted) onAbort();
          else combined.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      return { client, transport };
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw toUpstreamError(err, signal);
    } finally {
      if (onAbort) combined.removeEventListener("abort", onAbort);
    }
  }

  return {
    session(requestSignal) {
      let connecting: Promise<{ client: Client; transport: SSEClientTransport }> | null = null;
      let closed = false;

      const ensure = () => {
        if (closed) return Promise.reject(new UpstreamError("cancelled", "Session closed"));
        connecting ??= (async () => {
          try {
            return await connect(requestSignal);
          } catch (err) {
            const e = toUpstreamError(err, requestSignal);
            // One bounded retry: only for a failed connection (safe, read-only), never on 4xx or cancellation.
            if (e.kind !== "unavailable" || (e.status !== undefined && e.status < 500)) throw e;
            opts.logger.warn("upstream.connect_retry", { kind: e.kind, status: e.status });
            return connect(requestSignal);
          }
        })();
        return connecting;
      };

      return {
        async callTool(name, args, signal) {
          if (!UPSTREAM_TOOLS.includes(name)) throw new UpstreamError("protocol", "Upstream tool not allowlisted");
          const combined = AbortSignal.any([requestSignal, signal]);
          const { client } = await ensure();
          try {
            const result = await client.callTool({ name, arguments: args }, undefined, {
              signal: combined,
              timeout: opts.callTimeoutMs,
            });
            if (!("content" in result) || !Array.isArray(result.content)) {
              throw new UpstreamError("protocol", "Malformed upstream response");
            }
            return result as CallToolResult;
          } catch (err) {
            throw toUpstreamError(err, combined);
          }
        },
        async close() {
          closed = true;
          if (!connecting) return;
          try {
            const { client } = await connecting;
            await client.close();
          } catch {
            /* connection never established or already closed */
          }
        },
      };
    },
  };
}
