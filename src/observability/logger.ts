/**
 * Structured JSON logger with redaction. Never pass raw headers, tokens or
 * full tool arguments; the redactor is a safety net, not a licence.
 */
import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /authori[sz]ation|token|cookie|secret|password|passwd|api[-_]?key|credential|session[-_]?id|jwt|bearer/i;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const REDACTED = "[REDACTED]";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return value.replace(BEARER, `Bearer ${REDACTED}`).replace(JWT, REDACTED);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Stable, non-reversible identifier for correlating a subject across logs. */
export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(
  level: LogLevel = "info",
  sink: LogSink = (line) => console.log(line),
  base: Record<string, unknown> = {},
): Logger {
  const emit = (lvl: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = redact({ ts: new Date().toISOString(), level: lvl, event, ...base, ...fields });
    sink(JSON.stringify(record));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (fields) => createLogger(level, sink, { ...base, ...fields }),
  };
}
