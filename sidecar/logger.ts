/**
 * AgentCraft — structured leveled logger (Track A / Brain, plan §4.1 seam 1, lane L4).
 *
 * SEAM (stable signature — every lane imports `logger`):
 *   logger.log(level, msg, fields?) + level helpers (debug/info/warn/error) + child(bindings).
 *
 * L4 IMPL (this fills the Phase-1 skeleton; signatures are UNCHANGED so every existing call site keeps
 * working). What it adds over the passthrough:
 *   - LOG_LEVEL filtering (debug < info < warn < error; default "info"). A record below the threshold is
 *     dropped before any formatting/IO.
 *   - Two formats via LOG_FORMAT: "pretty" (default — a human line `LVL msg key=val …`) or "json" (one
 *     JSON object per line with ts/level/msg + fields, for shipping to a collector).
 *   - SECRET REDACTION on EVERY record (msg + fields) via security.redact — ELEVENLABS / AIVEN_PG /
 *     auth tokens / bearer headers / pg URIs never reach the log sink (plan §2 "secrets never logged"). This is
 *     the redaction layer the charter's secrets-audit calls for; the bare-console call sites that migrate
 *     onto this logger get redaction for free.
 *
 * Defensive: a logger that throws would be worse than the leak it prevents — every method is wrapped so a
 * formatting/serialization error degrades to a best-effort raw console call instead of bubbling.
 */
import { redact } from "./security.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Return a logger that merges `bindings` into every record's fields (request/agent context). */
  child(bindings: Record<string, unknown>): Logger;
}

/** Numeric severity so `LOG_LEVEL` can gate cheaply. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The configured floor (records below this are dropped). Read once at module load; defaults to "info". */
const MIN_LEVEL: number = (() => {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && raw in LEVEL_RANK) return LEVEL_RANK[raw as LogLevel];
  return LEVEL_RANK.info;
})();

/** "json" -> one JSON object per line; anything else -> the pretty human line. Default pretty. */
const JSON_MODE: boolean = process.env.LOG_FORMAT?.trim().toLowerCase() === "json";

/** Map a level to the console sink that matches its severity (preserves stderr for warn/error). */
function sink(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case "error":
      return console.error;
    case "warn":
      return console.warn;
    default:
      return console.log;
  }
}

/** Render a fields object as ` key=value` pairs for the pretty format (values redacted upstream). */
function prettyFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v == null) val = String(v);
    else if (typeof v === "object") {
      try {
        val = JSON.stringify(v);
      } catch {
        val = "[unserializable]";
      }
    } else {
      val = String(v);
    }
    // Quote values with whitespace so the line stays grep-friendly.
    parts.push(`${k}=${/\s/.test(val) ? JSON.stringify(val) : val}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

/**
 * L4 structured logger. Carries `bindings` that merge into every record. Each record is redacted, then
 * formatted per LOG_FORMAT. Below-threshold records short-circuit before any work.
 */
class StructuredLogger implements Logger {
  /** Declared explicitly (not a TS parameter property) so `node --experimental-strip-types` accepts it. */
  private readonly bindings: Record<string, unknown>;
  constructor(bindings: Record<string, unknown> = {}) {
    this.bindings = bindings;
  }

  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < MIN_LEVEL) return; // gated out — no formatting, no IO
    try {
      const merged = { ...this.bindings, ...(fields ?? {}) };
      // Redact the message and the whole merged field set in one pass.
      const safeMsg = redact(msg) as string;
      const safeFields = redact(merged) as Record<string, unknown>;
      const hasFields = Object.keys(safeFields).length > 0;

      if (JSON_MODE) {
        const rec: Record<string, unknown> = {
          ts: new Date().toISOString(),
          level,
          msg: safeMsg,
          ...safeFields,
        };
        sink(level)(JSON.stringify(rec));
      } else {
        const tag = level.toUpperCase().padEnd(5);
        sink(level)(`${tag} ${safeMsg}${hasFields ? prettyFields(safeFields) : ""}`);
      }
    } catch {
      // Logging must never throw. Last-resort: emit the raw (unformatted) message.
      try {
        sink(level)(msg);
      } catch {
        /* give up silently — there is nowhere left to report to */
      }
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StructuredLogger({ ...this.bindings, ...bindings });
  }
}

/** The single process-wide logger. */
export const logger: Logger = new StructuredLogger();
