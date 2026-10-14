/**
 * HTTP-level error responses. Bodies use the JSON-RPC error shape with a null
 * id (as the MCP SDK does for transport errors) and never include stack
 * traces, upstream detail or token contents.
 */
export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  SERVER_ERROR: -32000,
} as const;

export function baseHeaders(correlationId: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Correlation-Id": correlationId,
  };
}

export function errorResponse(
  status: number,
  message: string,
  correlationId: string,
  opts: { code?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: opts.code ?? JSONRPC.SERVER_ERROR, message, data: { correlationId } },
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...baseHeaders(correlationId), ...opts.headers },
    },
  );
}
