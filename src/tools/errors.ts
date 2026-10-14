import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamError } from "../mcp/upstream-client.js";

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

export function safeMessage(err: UpstreamError): string {
  return MESSAGES[err.kind];
}
