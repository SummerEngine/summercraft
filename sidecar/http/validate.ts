/**
 * AgentCraft — input validation + error envelope (Track A / Brain, plan §3 L3, §2 "API surface").
 *
 * Phase-2 hardening seam owned by L3. Everything here is PURE + defensive: a validator never throws,
 * it returns a tagged `{ ok }` result the route maps to a status. The §0 "all input validated" box is
 * met by routing every untrusted scalar (agent_id, prompt, pagination params, JSON bodies, WS frames)
 * through these helpers before it reaches the session/git/store layers.
 *
 * Why a single module: the same bounds must hold on BOTH the HTTP routes and the WS frames (a WS
 * `spawn`/`command` is just as untrusted as a POST body), so the limits live in ONE place and both
 * surfaces import them — they can't drift.
 *
 * NOTHING here changes the public contract.ts shapes; it only rejects malformed input earlier and more
 * consistently. The error ENVELOPE stays exactly `{ error: string }` (frozen for B/C/D) — this module
 * just standardizes HOW that envelope is produced and guarantees the message is client-safe (no raw
 * exception text / internal paths leaked).
 */

// --------------------------------------------------------------------------------------------------
// Limits (single source of truth; HTTP + WS both import these).
// --------------------------------------------------------------------------------------------------

/** Max bytes we will buffer for any JSON request body. A multi-GB POST must not OOM the process. */
export const MAX_BODY_BYTES = 256 * 1024; // 256 KiB — prompts are text, not uploads.

/** Max bytes for a single WS frame (a spawn/command/relay). Same rationale as the HTTP body cap. */
export const MAX_WS_FRAME_BYTES = 64 * 1024;

/** Max length of a prompt string (chars). Long enough for a real task, bounded so it can't be abused. */
export const MAX_PROMPT_CHARS = 16 * 1024;

/** Max length of an agent_id / repo_id. Ids are short slugs, never free text. */
export const MAX_ID_CHARS = 128;

/** Max length of a label / free-form display string accepted from a client. */
export const MAX_LABEL_CHARS = 200;

/** Max length of a filesystem path accepted from a client (repo_path on WS spawn). */
export const MAX_PATH_CHARS = 4096;

/** Default + hard-cap page sizes for paginated list endpoints (events, transcript). */
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;

/**
 * Agent/repo id charset: the SAME safe slug the store uses for its on-disk filenames
 * (session-store.ts `safe()` allows [A-Za-z0-9._-]). Validating to this charset means a client can
 * never smuggle a path-traversal id (`../../etc`) or a shell metacharacter into a git cwd / filename.
 */
const ID_RE = /^[A-Za-z0-9._-]+$/;

// --------------------------------------------------------------------------------------------------
// Result type + envelope.
// --------------------------------------------------------------------------------------------------

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** A client-safe error envelope. The shape is frozen (`{error:string}`); this just builds it. */
export interface ErrorEnvelope {
  error: string;
}

/** Build the consistent, client-safe error envelope. The message is assumed already sanitized. */
export function errorEnvelope(message: string): ErrorEnvelope {
  return { error: message };
}

/**
 * Reduce an unknown thrown value to a SHORT, client-safe message. Internal exception text can carry
 * absolute paths / connection strings, so for the generic 500 path we return a fixed string and let the
 * caller log the detail server-side. Use `clientSafeError(e, fallback)` at any boundary that returns a
 * thrown error to a client (§2 "secrets never sent to a client").
 */
export function clientSafeError(_e: unknown, fallback = "internal error"): string {
  return fallback;
}

// --------------------------------------------------------------------------------------------------
// Scalar validators (never throw; return a tagged result).
// --------------------------------------------------------------------------------------------------

/** Validate an agent_id / repo_id: non-empty, bounded, safe slug charset. */
export function validateId(raw: unknown, field = "agent_id"): Validated<string> {
  if (typeof raw !== "string") return { ok: false, error: `${field} must be a string` };
  const v = raw.trim();
  if (!v) return { ok: false, error: `${field} is required` };
  if (v.length > MAX_ID_CHARS) return { ok: false, error: `${field} too long (max ${MAX_ID_CHARS})` };
  if (!ID_RE.test(v)) return { ok: false, error: `${field} has invalid characters` };
  return { ok: true, value: v };
}

/** Validate a prompt: non-empty after trim, bounded length. */
export function validatePrompt(raw: unknown): Validated<string> {
  if (typeof raw !== "string") return { ok: false, error: "prompt must be a string" };
  const v = raw.trim();
  if (!v) return { ok: false, error: "missing prompt" };
  if (v.length > MAX_PROMPT_CHARS) {
    return { ok: false, error: `prompt too long (max ${MAX_PROMPT_CHARS} chars)` };
  }
  return { ok: true, value: v };
}

/** Validate an optional free-form string (label/title): bounded, trimmed; empty -> undefined. */
export function validateOptionalText(raw: unknown, max = MAX_LABEL_CHARS, field = "text"): Validated<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: `${field} must be a string` };
  const v = raw.trim();
  if (!v) return { ok: true, value: undefined };
  if (v.length > max) return { ok: false, error: `${field} too long (max ${max})` };
  return { ok: true, value: v };
}

/** Validate a repo_path string: non-empty, bounded. (Existence/safety is enforced downstream in the
 *  worktree manager, which refuses-on-unsafe; here we just bound the untrusted string.) */
export function validatePath(raw: unknown, field = "repo_path"): Validated<string> {
  if (typeof raw !== "string") return { ok: false, error: `${field} must be a string` };
  const v = raw.trim();
  if (!v) return { ok: false, error: `${field} is required` };
  if (v.length > MAX_PATH_CHARS) return { ok: false, error: `${field} too long` };
  return { ok: true, value: v };
}

/**
 * Parse a pagination param (limit/offset) from a query string. Returns a CLAMPED integer in [min, max]
 * so a hostile `?limit=-1` / `?offset=1e9` / `?limit=abc` can never blow past the bounds. Missing or
 * unparseable -> the supplied default.
 *
 * `min` defaults to 1 (the transcript route wants "at least one row" — `?limit=0` there is a no-op
 * request, so flooring to 1 is correct). The /world events_limit/locks_limit caps pass `min=0` because
 * there 0 is a meaningful request ("omit the array contents", e.g. an agents-only HUD); without this the
 * documented "may request fewer" lower bound was silently wrong (0 returned 1 row).
 */
export function parseLimit(
  raw: string | null,
  def = DEFAULT_PAGE_LIMIT,
  max = MAX_PAGE_LIMIT,
  min = 1,
): number {
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Parse a non-negative offset (default 0), bounded only at the low end. */
export function parseOffset(raw: string | null): number {
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}
