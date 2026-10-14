import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamError } from "../mcp/upstream-client.js";
import { capBlocks } from "./sanitize.js";

const MESSAGES: Record<UpstreamError["kind"], string> = {
  timeout: "The Argos product service did not respond in time. Please try again.",
  rate_limited: "The Argos product service is busy. Please try again shortly.",
  unavailable: "The Argos product service is currently unavailable.",
  unauthorized: "The Argos product service is currently unavailable.",
  protocol: "The Argos product service returned an unexpected response.",
  cancelled: "The request was cancelled.",
};

/** Tool-level error result: safe message plus correlation id, never upstream detail. */
export function upstreamErrorResult(err: UpstreamError, correlationId: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${MESSAGES[err.kind]} (reference: ${correlationId})` }],
  };
}

/** Argos data that could not be parsed into the advertised schema. Fails loudly, never half-parsed. */
export function parseErrorResult(correlationId: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Argos returned product data in an unexpected format, so it could not be read reliably. (reference: ${correlationId})`,
      },
    ],
  };
}

/** Argos's own tool-level error (isError: true) is passed through as an error, never as an empty result. */
export function upstreamToolError(texts: string[]): CallToolResult {
  const blocks = capBlocks(texts.filter(Boolean).map((text) => ({ type: "text" as const, text })));
  return { isError: true, content: blocks.length ? blocks : [{ type: "text", text: "Argos returned an error for this request." }] };
}

export function safeMessage(err: UpstreamError): string {
  return MESSAGES[err.kind];
}
