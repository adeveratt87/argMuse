/**
 * Production wiring. Built once per function instance and reused across
 * invocations (no per-user state is kept between requests except the
 * per-instance rate-limit counters).
 */
import { loadConfig } from "./config.js";
import { createJwtVerifier } from "./auth/jwt-verifier.js";
import { createUpstream } from "./mcp/upstream-client.js";
import { createLogger } from "./observability/logger.js";
import { createRateLimiter } from "./security/rate-limit.js";
import { createHandlers } from "./server.js";

export type Handlers = ReturnType<typeof createHandlers>;

let handlers: Handlers | null = null;

export function getHandlers(): Handlers {
  if (handlers) return handlers;
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  if (!config.auth) logger.error("config.auth_not_configured", { problems: config.authConfigErrors });
  handlers = createHandlers({
    config,
    verifier: config.auth ? createJwtVerifier(config.auth) : null,
    upstream: createUpstream({
      url: config.upstreamUrl,
      connectTimeoutMs: config.upstreamConnectTimeoutMs,
      callTimeoutMs: config.upstreamCallTimeoutMs,
      logger,
    }),
    logger,
    rateLimiter: createRateLimiter({
      perKeyPerMinute: config.rateLimitPerSubjectPerMinute,
      globalPerMinute: config.rateLimitGlobalPerMinute,
    }),
  });
  return handlers;
}

/** Wraps an entry point so configuration errors produce a safe 500. */
export function entry(pick: (h: Handlers) => (req: Request) => Response | Promise<Response>) {
  return {
    async fetch(req: Request): Promise<Response> {
      let h: Handlers;
      try {
        h = getHandlers();
      } catch (err) {
        const problems = (err as { problems?: string[] }).problems ?? ["unknown"];
        createLogger().error("config.invalid", { problems });
        return new Response(JSON.stringify({ error: "Connector is misconfigured" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return pick(h)(req);
    },
  };
}
