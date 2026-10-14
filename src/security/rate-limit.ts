/**
 * Fixed-window in-memory rate limiter. Per Vercel instance only — see
 * docs/architecture.md D8. Memory is bounded by evicting expired windows and
 * capping tracked keys.
 */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

interface Window {
  start: number;
  count: number;
}

export function createRateLimiter(opts: {
  perKeyPerMinute: number;
  globalPerMinute: number;
  now?: () => number;
  maxKeys?: number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const windowMs = 60_000;
  const keys = new Map<string, Window>();
  let global: Window = { start: now(), count: 0 };

  const retryAfter = (w: Window, t: number) => Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));

  return {
    check(key) {
      const t = now();
      if (t - global.start >= windowMs) global = { start: t, count: 0 };

      let w = keys.get(key);
      if (!w || t - w.start >= windowMs) {
        if (!w && keys.size >= maxKeys) {
          for (const [k, v] of keys) if (t - v.start >= windowMs) keys.delete(k);
          // Still full: refuse rather than grow without bound.
          if (keys.size >= maxKeys) return { allowed: false, retryAfterSeconds: 60 };
        }
        w = { start: t, count: 0 };
        keys.set(key, w);
      }

      if (global.count >= opts.globalPerMinute) return { allowed: false, retryAfterSeconds: retryAfter(global, t) };
      if (w.count >= opts.perKeyPerMinute) return { allowed: false, retryAfterSeconds: retryAfter(w, t) };
      w.count++;
      global.count++;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
