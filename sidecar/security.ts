/**
 * AgentCraft — security utilities (Track A / Brain, lane L4: observability & security).
 *
 * This module is the home for the cross-cutting safety helpers the rest of the sidecar imports. It is
 * deliberately dependency-free (only the logger, which itself depends on `redact` here) so it can be
 * imported from anywhere — including config.ts and the boot path — without a cycle that matters at
 * runtime (the logger lazily uses `redact`; security.ts never calls the logger at module load).
 *
 * What lives here (plan §2 "Security" + §5 S3):
 *   - redact(): scrub secrets out of any value before it is logged or returned to a client. The billing
 *     scrub (scrubAnthropicEnv) keeps ANTHROPIC_* out of CHILDREN; this keeps ELEVENLABS / AIVEN_PG /
 *     auth tokens / bearer headers / pg URIs out of LOGS and ERROR ENVELOPES. They are different lines of
 *     defense and both are required.
 *   - assertBillingSafe(): the boot assertion the charter §0 calls for — if the auth probe resolved to
 *     `apikey`, the process was leaning on a metered key; we HARD-STOP (or, behind an explicit override,
 *     loudly warn) rather than keep spawning bypassPermissions children on someone's credit card.
 *   - originAllowed(): the WS/HTTP origin check helper — only localhost origins may drive this local
 *     agent host. NOT YET WIRED: it is an exported SEAM for the L3 WS layer (http/ws.ts) to call in its
 *     'connection'/upgrade path. As of this writing http/ws.ts authenticates on the hello token only and
 *     performs NO origin check, so the charter's "WS origin check" is implemented here but not yet
 *     enforced — wiring it requires an edit to the L3-owned ws.ts and is flagged to the orchestrator.
 *   - rateLimiter(): a tiny per-key token-bucket as an OPTIONAL per-key flood-guard seam. NOT the live
 *     WS rate limit: http/ws.ts (L3) already ships its own inline sliding-window limiter that IS wired.
 *     This is offered as an alternative L3 could consume to unify on one impl; today it has no caller.
 *
 * SECURITY CONTRACT: nothing in here may throw on a hot path. redact() is called on every log line and
 * every redacted response field; originAllowed() (once wired) runs per connection. Both must be
 * allocation-light and never crash.
 */
import type { AuthStatus } from "./contract.ts";

// --------------------------------------------------------------------------------------------------
// Secret redaction
// --------------------------------------------------------------------------------------------------

/**
 * Env var names whose VALUES must never appear in a log line or a client-facing error. We redact by
 * value (substring match) so a secret leaks no matter how it got into a string — e.g. a pg driver error
 * that embeds the full connection URI, or an ElevenLabs error that echoes the api key. Read once at
 * module load; if a secret is set after boot it simply isn't auto-redacted (the regex patterns below
 * still catch the common shapes).
 */
const SECRET_ENV_NAMES = [
  "ELEVENLABS_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AIVEN_PG_URI",
  "DATABASE_URL",
  "AIVEN_PG_CA_PEM",
  "AIVEN_PG_PASSWORD",
] as const;

/** Snapshot of the actual secret VALUES currently in env, longest-first so the longest match wins. */
function secretValues(): string[] {
  const vals: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name]?.trim();
    // Ignore short/empty values — redacting a 1-char "secret" would mangle every log line.
    if (v && v.length >= 8) vals.push(v);
  }
  return vals.sort((a, b) => b.length - a.length);
}

/**
 * Structural patterns that look like secrets regardless of whether we know the exact value. These cover
 * the cases SECRET_ENV_NAMES can't: a secret minted at runtime, a bearer header, a postgres URI with an
 * inline password, an ElevenLabs `xi-api-key` header echoed back in an error.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // postgres[ql]://user:password@host  -> redact the password segment only (host stays useful for ops)
  [/\b(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]+(@)/gi, "$1***$2"],
  // Authorization: Bearer <token>  /  xi-api-key: <key>  /  sk-ant-...  /  sk_...
  [/\b(bearer\s+)[A-Za-z0-9._\-]{12,}/gi, "$1***"],
  [/\b(xi-api-key["':\s]+)[A-Za-z0-9._\-]{12,}/gi, "$1***"],
  [/\bsk-ant-[A-Za-z0-9_\-]{8,}/g, "sk-ant-***"],
  [/\bxi-[A-Za-z0-9]{20,}/g, "xi-***"],
];

/** Cap the size of any single redacted string so a pathological/huge value can't blow up a log line. */
const MAX_REDACT_LEN = 8192;

/**
 * Redact secrets out of one string. Exact known values first, then structural patterns. Never throws.
 * `secrets` is the per-redact() snapshot of env secret values (longest-first) threaded down from the
 * top-level call so we build+sort the list ONCE per redact() — not once per string field. The structural
 * SECRET_PATTERNS still run unconditionally, so a runtime-minted secret is covered regardless of the
 * snapshot. Callers that hit this directly (none today) get a fresh snapshot via the default arg.
 */
function redactString(s: string, secrets: string[] = secretValues()): string {
  let out = s.length > MAX_REDACT_LEN ? s.slice(0, MAX_REDACT_LEN) + "…[truncated]" : s;
  try {
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join("***");
    }
    for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  } catch {
    /* redaction is best-effort; never let it crash a log call */
  }
  return out;
}

/**
 * Deep-redact any value before it is logged or serialized into a response. Strings are scrubbed;
 * objects/arrays are walked (with a depth cap so a cyclic structure can't recurse forever); other
 * primitives pass through. Returns a NEW value — never mutates the caller's object.
 *
 * The env secret-value list is snapshotted ONCE at the top-level call and threaded through the recursion
 * (`secrets`), so a single structured log line with N string fields builds+sorts the list once, not N+1
 * times. This is on the logger hot path; the snapshot keeps the per-line allocation flat without losing
 * coverage (the structural patterns still run per string).
 */
export function redact(value: unknown, depth = 0, secrets: string[] = secretValues()): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (value == null || typeof value !== "object") return value;
  if (depth >= 6) return "[…]"; // hard depth cap: don't follow deep/cyclic graphs
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, secrets));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Redact by key name too: a field literally named token/secret/password/authorization is always
    // sensitive. NOTE: signed_url is deliberately NOT here — it is the short-lived URL the voice client
    // NEEDS as payload (categorically unlike a stored credential), and blanket-'***'ing it would silently
    // break the voice dive the moment a response body is passed through redact(). Its value isn't a secret
    // to scrub; the env-value + bearer/xi-key patterns still scrub any real token embedded in a URL.
    if (/^(authorization|token|secret|password|api[_-]?key)$/i.test(k)) {
      out[k] = typeof v === "string" && v ? "***" : v;
    } else {
      out[k] = redact(v, depth + 1, secrets);
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------------
// Boot billing assertion (charter §0: hard-stop on a leaked metered key)
// --------------------------------------------------------------------------------------------------

/**
 * Set AGENTCRAFT_ALLOW_APIKEY=1 to DOWNGRADE the apikey hard-stop to a loud warning. This exists ONLY
 * for a dev who knowingly wants to run on a metered key (e.g. no subscription handy) and is NOT for the
 * demo machine. The default — and the safe path — is a hard process exit.
 */
function apikeyOverrideEnabled(): boolean {
  return process.env.AGENTCRAFT_ALLOW_APIKEY === "1";
}

/**
 * The boot billing assertion. Called once the auth probe has resolved. The probe (auth.ts) determines
 * whether spawned Claude children answer with the metered ANTHROPIC_* vars scrubbed:
 *   - subscription -> children run on the Pro/Max OAuth plan. Safe. (no-op)
 *   - unknown      -> probe inconclusive (e.g. timed out). We log a warning but do NOT hard-stop, since a
 *                     transient probe failure must not brick the demo; the per-child scrub still holds.
 *   - apikey       -> a child leaned on a metered key. This is the one the charter says hard-stops. We
 *                     EXIT the process (code 87) unless AGENTCRAFT_ALLOW_APIKEY=1 downgrades it to a warn.
 *
 * Returns true if the process is safe to continue (subscription/unknown/overridden), false if it would
 * have hard-stopped (only reachable when the override is on; the default path calls process.exit and
 * never returns). The boolean lets a test exercise the decision without killing the test runner —
 * pass `{ exit:false }` to suppress the real exit and inspect the return value instead.
 *
 * SCOPE: this is the DETECTIVE alarm, not the PREVENTIVE control. The actual billing control is the
 * per-child scrubAnthropicEnv() (which removes ANTHROPIC_* from every spawned child unconditionally) —
 * that is what guarantees no metered key reaches a child. This assertion is wired post-listen on the
 * background auth probe (server.ts), so it can fire up to ~65s after boot and does NOT gate the spawn
 * path: it is the boot-time hard-stop the charter §0 asks for, layered ON TOP of the scrub, never a
 * substitute for it. Do not refactor a caller to rely on this as a spawn gate.
 */
export function assertBillingSafe(
  status: AuthStatus,
  opts: { exit?: boolean; logError?: (m: string) => void; logWarn?: (m: string) => void } = {},
): boolean {
  const exit = opts.exit ?? true;
  const logError = opts.logError ?? ((m) => console.error(m));
  const logWarn = opts.logWarn ?? ((m) => console.warn(m));

  if (status.mode === "subscription") return true;

  if (status.mode === "unknown") {
    logWarn(
      "[security] billing assertion: auth probe INCONCLUSIVE (unknown). " +
        "Per-child env scrub still in force; not hard-stopping. Re-check /auth/status before the demo.",
    );
    return true;
  }

  // status.mode === "apikey" — the HARD STOP.
  if (apikeyOverrideEnabled()) {
    logWarn(
      "[security] ⚠ billing assertion: APIKEY mode but AGENTCRAFT_ALLOW_APIKEY=1 — continuing on a " +
        "METERED key by explicit override. This burns credit; NEVER set this on the demo machine.",
    );
    return false; // unsafe, but allowed to continue
  }

  logError(
    "[security] ✖ BILLING HARD STOP: auth probe resolved to APIKEY — a spawned Claude child leaned on a " +
      "metered ANTHROPIC_* key. Refusing to keep spawning bypassPermissions agents on a metered key. " +
      "Fix: log into the Pro/Max subscription (claude /login) so the scrubbed-env probe answers. " +
      "Override (dev only): AGENTCRAFT_ALLOW_APIKEY=1.",
  );
  if (exit) process.exit(87);
  return false;
}

// --------------------------------------------------------------------------------------------------
// Origin check (WS + HTTP): only localhost may drive the local agent host
// --------------------------------------------------------------------------------------------------

/** Hosts we treat as "this machine" for the origin check. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * True if `origin` is a localhost origin (or absent). The sidecar binds to 127.0.0.1, but a malicious
 * web page open in the user's browser could still try to drive it via fetch/WS using the user's loopback
 * access; the token gates that, and this is defense-in-depth on top.
 *
 * A MISSING Origin header returns true: native clients (Godot HTTPRequest, the voice page loaded from
 * file://, server-to-server curl) legitimately send no Origin, and rejecting those would break the
 * existing contract. We only reject a PRESENT, NON-localhost origin.
 *
 * WIRING STATUS: this is the SEAM the WS origin check is meant to consume. It is NOT yet called by
 * http/ws.ts (L3-owned) — the WS handshake currently authenticates on the hello token alone. Enforcing
 * the origin check means having ws.ts reject a connection whose `origin` header fails this test; that
 * edit lives in the L3 lane and is flagged to the orchestrator.
 */
export function originAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true; // no Origin -> native/non-browser caller; allowed
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    // Unparseable Origin (some clients send "null" for file://). Treat the literal "null" as allowed
    // (file:// voice page) and anything else unparseable as rejected.
    return origin === "null";
  }
  return LOCAL_HOSTS.has(host);
}

// --------------------------------------------------------------------------------------------------
// Per-key rate limiter (token bucket) — WS per-socket flood protection
// --------------------------------------------------------------------------------------------------

export interface RateLimiter {
  /** Returns true if this event is allowed (a token was available), false if it should be dropped. */
  take(key: string, cost?: number): boolean;
  /** Forget a key's bucket (call on socket close so the map doesn't grow unbounded). */
  forget(key: string): void;
}

/**
 * Create a token-bucket rate limiter. Each `key` (e.g. a WS socket id) gets `capacity` tokens that
 * refill at `refillPerSec`. A burst up to `capacity` is allowed; sustained traffic is capped at the
 * refill rate. Pure in-memory, monotonic-clock based, never throws.
 *
 * Defaults (capacity 20, refill 10/s) are generous for a human driving the HUD but stop a script that
 * tries to enqueue thousands of spawn/command frames a second.
 *
 * WIRING STATUS: this is an OPTIONAL seam, NOT the live WS flood guard. http/ws.ts (L3) already enforces
 * a per-socket sliding-window limiter inline (20 frames / 1s) and does not import this. This token-bucket
 * is offered so L3 could unify on one implementation if desired; until then it has no caller. Do not
 * assume the WS rate limit flows through here.
 */
export function rateLimiter(capacity = 20, refillPerSec = 10): RateLimiter {
  interface Bucket {
    tokens: number;
    last: number; // ms (Date.now-based monotonic-ish; fine for rate limiting)
  }
  const buckets = new Map<string, Bucket>();

  return {
    take(key: string, cost = 1): boolean {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, last: now };
        buckets.set(key, b);
      }
      // Refill based on elapsed time since last check.
      const elapsedSec = Math.max(0, (now - b.last) / 1000);
      b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
      b.last = now;
      if (b.tokens >= cost) {
        b.tokens -= cost;
        return true;
      }
      return false;
    },
    forget(key: string): void {
      buckets.delete(key);
    },
  };
}
