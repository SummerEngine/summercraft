/**
 * AgentCraft — AgentSession: one live Claude Agent SDK session per character (Track A spine).
 *
 * This is the load-bearing file of the whole submission. It:
 *   - drives @anthropic-ai/claude-agent-sdk `query()` in STREAMING-INPUT mode (an AsyncIterable of
 *     SDKUserMessage we control) so the same session can take follow-up prompts and be interrupted;
 *   - spawns the Claude child with `env: scrubAnthropicEnv()` (NEVER raw process.env) — the single
 *     load-bearing billing-safety rule. If the metered ANTHROPIC_* vars leaked in, every
 *     "subscription" agent would silently bill the API key/gateway (plan §2, §8 risk #1);
 *   - runs in the character's worktree (cwd) and exposes the Aiven HTTP MCP under `mcpServers.aiven`
 *     so the agent can coordinate via Kafka+Postgres (Track D);
 *   - normalizes stream-json SDK messages into the frozen ServerEvent union + AgentState transitions,
 *     publishing everything through the in-proc store/bus.
 *
 * It deliberately does NOT enforce concurrency or own the registry — session-manager.ts does that.
 */
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { scrubAnthropicEnv, scrubbedVarsPresent } from "./env-scrub.mjs";
import { store, type AgentRecord } from "./session-store.ts";
import { processRegistry } from "./process-registry.ts";
import { produceCoordEvent } from "./aiven/kafka.ts";
import { markPending } from "./pr.ts";
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";
import { HOST, PORT } from "./contract.ts";
import type { AgentState, CharacterKind, CoordEvent } from "./contract.ts";

const pexec = promisify(exec);

/**
 * Hard timeout (ms) for the post-turn worktree dirty-check `git status`. A wedged/locked/huge repo must
 * never delay the `done` pulse or hang the session — on timeout the check degrades to "not dirty" (no
 * pending emitted), exactly like a non-git worktree.
 */
const DIRTY_CHECK_TIMEOUT_MS = 5_000;

/**
 * Aiven MCP attachment is ADA-ONLY and OPT-IN PER SESSION (see the constructor). The global
 * AGENTCRAFT_AIVEN_MCP_URL is intentionally NOT read here: pointing the SDK at an unreachable/slow MCP
 * server HANGS session startup (the agent never processes its first turn — there is no MCP-connect
 * timeout), so it must never auto-attach to ordinary coding agents. Only a session that explicitly passes
 * `aivenMcpUrl` (the data operator, operator.ts) attaches the MCP. demo.sh exports that env process-wide so
 * the operator path can resolve it via aivenMcpUrl(); blanket-inheriting it would re-introduce the hang.
 */

/** Resolve the Claude binary explicitly so the SDK doesn't depend on PATH of the spawning shell. */
const CLAUDE_BIN =
  process.env.AGENTCRAFT_CLAUDE_BIN ??
  process.env.CLAUDE_CODE_PATH ??
  "claude";

/**
 * Persistence directive shared by both system prompts. Agents were giving up after a single failed search
 * (e.g. one `grep` for a repo, then "I could only find a demo platform"). This forces them to exhaust
 * real strategies before concluding something can't be done.
 */
const PERSISTENCE_PROMPT = [
  "Be persistent: when asked to find or do something, keep investigating before you conclude it can't be done.",
  "Try multiple search strategies (different names/paths/extensions), read config and manifest files,",
  "and follow references — do NOT give up after one failed grep or a single empty result.",
].join(" ");

/**
 * Lane A: teach the agent to REGISTER any local dev server it starts so the sidecar can track its pid+port,
 * surface a clickable "open it", and KILL it on teardown (otherwise the server orphans after the turn). The
 * agent runs in `bypassPermissions`, so a one-line curl after backgrounding the server is reliable. ${agentId}
 * is filled per session. The register hook is best-effort — if the agent forgets, printing the URL still
 * surfaces a (non-killable) service via emitServiceFromText.
 */
function serviceRegisterPrompt(agentId: string): string {
  return [
    "When you start a local dev server (e.g. `npm run dev`), run it in the BACKGROUND and REGISTER it so it",
    "can be tracked and cleaned up: start it with `&`, capture its pid via `$!`, then once it is listening",
    `POST its url to the local sidecar, e.g.: \`curl -s -X POST http://${HOST}:${PORT}/agents/${agentId}/service`,
    `-H 'content-type: application/json' -d '{"url":"http://localhost:5173","port":5173,"pid":'"$!"'}'\`.`,
    "Do this for every server you bring up so it is not orphaned when the session ends.",
  ].join(" ");
}

/** Coordination system prompt (Track D owns the detail; A injects the hook so it's never missing). */
const COORDINATION_PROMPT = [
  "You are one of several SummerCraft coding agents sharing a set of repos.",
  "Coordinate through the `aiven` MCP server (Kafka topic agent.coordination + Postgres world_state).",
  "Before editing a file: read the file_locks table; if the file is locked by another agent, do NOT",
  "edit it — pick other work and report that you are blocked. To claim a file, INSERT a file_locks row",
  "then produce a `file_claimed` event. Release the lock and emit `released` when you finish. Send a",
  "heartbeat periodically so the world knows you are alive. Keep replies short and action-oriented.",
  PERSISTENCE_PROMPT,
].join(" ");

/** System prompt when Aiven coordination is OFF (the default until Aiven is provisioned). */
const BASE_PROMPT = [
  "You are a SummerCraft coding agent working inside one repository.",
  "Do exactly what the user asks using your tools. Keep replies short and action-oriented.",
  PERSISTENCE_PROMPT,
].join(" ");

/**
 * Hard per-turn timeout (ms). The typed path had NO turn timeout (only the voice runAgentTurn guarded
 * itself) — a wedged turn keeps `busy=true` forever and the session can never take another prompt. When a
 * turn exceeds this, we interrupt it and fail it cleanly so the session frees up. Generous: real agent
 * turns (multi-tool edits) can legitimately run minutes. (gap: "Missing per-call timeouts on SDK turns".)
 */
const TURN_TIMEOUT_MS = Number(process.env.AGENTCRAFT_TURN_TIMEOUT_MS) || 5 * 60_000;

/**
 * MCP reachability-probe timeout (ms). Before attaching the Aiven HTTP MCP we POST a tiny request and bound
 * it with this AbortController timeout. The SDK has NO MCP-connect timeout — a reachable-but-slow or hung
 * endpoint blocks the query() handshake forever and the session never reaches its first turn (the known
 * "sticks at moving" wedge, see the header). Probing first turns a dead/slow MCP into a graceful degrade
 * (run WITHOUT coordination) instead of an indefinite hang. Short on purpose: a healthy shim answers in ms.
 */
const MCP_PROBE_TIMEOUT_MS = Number(process.env.AGENTCRAFT_MCP_PROBE_TIMEOUT_MS) || 1_500;

/**
 * 429 / rate-limit backoff + circuit breaker (around turns). A Max subscription throttles; a turn that
 * fails with an overloaded/429 subtype must not be hammered. We track consecutive rate-limit failures and,
 * past a threshold, OPEN a circuit that refuses new turns (cheaply, with a clear status) until a cooldown
 * elapses — so we stop pounding a throttled account. (gap: "No 429/rate-limit retry, backoff, or circuit
 * breaker".) Policy: a breaker-OPEN turn is REFUSED and DROPPED — there is no auto re-dispatch. The session
 * exposes the detection (isRateLimitText) + the breaker gate (isBreakerOpen / breakerCooldownRemainingMs);
 * the supervisor backs off RESPAWNS on a rate-limit DEATH, but it does not re-issue a refused prompt — the
 * caller (the human, via the InteractionPanel or voice) re-asks after the cooldown.
 */
const RL_BREAKER_THRESHOLD = 3; // consecutive rate-limit turns before the breaker opens
const RL_BREAKER_BASE_COOLDOWN_MS = 15_000; // first open cooldown; doubles per re-trip up to the cap
const RL_BREAKER_MAX_COOLDOWN_MS = 5 * 60_000;

export interface AgentSessionInit {
  agentId: string;
  repoId: string;
  /** cwd the SDK runs in — a worktree, or the repo root fallback (see worktree-manager). */
  cwd: string;
  characterKind: CharacterKind;
  label: string;
  /**
   * Override the system prompt for this session (e.g. the Autonomous Data Operator persona). When unset,
   * the session uses COORDINATION_PROMPT if an Aiven MCP is wired, else BASE_PROMPT.
   */
  systemPrompt?: string;
  /**
   * Per-session Aiven MCP URL. Overrides the global AGENTCRAFT_AIVEN_MCP_URL. Lets the data-operator
   * agent attach the Aiven MCP even when ordinary coordination is off — and keeps the "only attach a
   * REACHABLE endpoint" rule (a dead MCP hangs startup) in one place: attach iff the resolved URL is set.
   */
  aivenMcpUrl?: string;
}

type Resolver = () => void;

/** How a turn finished. `result` carries the success summary; `error` carries the failure reason. */
export type TurnEnd =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

/** A queued user turn: the prompt text plus the id that scopes its deltas/end callback. */
interface QueuedTurn {
  id: string;
  text: string;
}

/**
 * Lifecycle signals the supervisor (supervisor.ts) subscribes to. Kept INTERNAL (a Node EventEmitter on
 * the session) — NOT a public ServerEvent, so contract.ts is untouched. The supervisor decides restart
 * policy from these; the world still only sees the existing `error`/`status` ServerEvents.
 *   - "dead":        the SDK stream threw / ended; the underlying Query is a corpse and must be disposed.
 *   - "rate_limited": a turn failed with a 429/overloaded subtype (drives backoff).
 *   - "turn_timeout": a turn exceeded TURN_TIMEOUT_MS and was force-failed.
 */
export type SessionSignal = "dead" | "rate_limited" | "turn_timeout";

/** Recognize a rate-limit / overload failure from an SDK result subtype or error text. Heuristic. */
function isRateLimitText(s: string): boolean {
  const t = s.toLowerCase();
  return (
    t.includes("429") ||
    t.includes("rate limit") ||
    t.includes("rate_limit") ||
    t.includes("overloaded") ||
    t.includes("too many requests") ||
    t.includes("quota")
  );
}

/**
 * Probe an HTTP MCP endpoint for reachability before the SDK attaches it. The SDK's query() handshake has
 * NO connect timeout, so a dead/slow MCP hangs session startup indefinitely (the agent never takes its
 * first turn). We POST a tiny MCP `initialize` request bounded by MCP_PROBE_TIMEOUT_MS: ANY answered HTTP
 * response (even a 4xx/JSON-RPC error) proves the endpoint is alive and answering, which is all we need —
 * the real handshake will follow. Returns false on timeout/network error/abort, so the caller degrades to
 * "no MCP attached" instead of wedging. Never throws.
 */
async function probeMcpReachable(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MCP_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe",
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
      }),
      signal: ctrl.signal,
    });
    // Drain so the socket can be reused/closed cleanly; we don't care about the body, only that it answered.
    void res.text().catch(() => {});
    return true;
  } catch {
    return false; // timeout / connection refused / DNS — treat as unreachable, degrade gracefully
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drives a single streaming-input Claude query. One AgentSession == one persistent `query()`.
 * Prompts are pushed onto an internal async queue; the SDK consumes them as user turns.
 */
export class AgentSession extends EventEmitter {
  readonly agentId: string;
  readonly repoId: string;
  readonly cwd: string;
  readonly characterKind: CharacterKind;
  readonly label: string;
  private readonly systemPromptOverride?: string;
  private readonly aivenMcpUrl: string;

  private q: Query | null = null;
  /**
   * Sync once-guard for start(). `this.q` is set ASYNCHRONOUSLY (after an optional MCP reachability probe),
   * so guarding start() on `this.q` alone would let a second synchronous start() slip through and double-
   * launch the query before the first probe resolves. `started` flips synchronously in start() so it's the
   * authoritative idempotency gate; queued prompts sit safely in the inbox until consume() begins draining.
   */
  private started = false;
  /** Pending turns not yet yielded to the SDK (FIFO). */
  private inbox: QueuedTurn[] = [];
  /** Resolver that wakes the input generator when a new prompt arrives. */
  private wake: Resolver | null = null;
  /** Set when the session is shutting down so the input generator can terminate. */
  private closed = false;
  /** True while a turn is in flight (between a pushed prompt and its result). */
  private busy = false;
  /**
   * Set once the SDK stream throws/ends (consume() catch). A dead session's Query is a corpse — it can
   * never take another turn — so the supervisor disposes + (optionally) restarts it instead of leaving a
   * `has()==true` session that dispatchPrompt would route prompts into. (gap: "No agent-child supervision".)
   */
  private dead = false;
  /** Per-turn watchdog timers keyed by turn id, so a wedged turn is force-failed after TURN_TIMEOUT_MS. */
  private turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Dedup key of the currently in-flight / most-recently-queued prompt, so a double-clicked POST or a
   * retried WS `command` enqueuing the SAME text while it's still pending is ignored rather than run twice.
   * Cleared when that turn terminates. (gap: "No command idempotency / dedupe".)
   */
  private inflightDedupeKeys = new Set<string>();
  /** turn id -> its dedupe key, so we can release the key exactly when that turn ends. */
  private turnDedupeKey = new Map<string, string>();
  /** Consecutive rate-limited turns; resets on any successful turn. Drives the circuit breaker. */
  private rlConsecutive = 0;
  /** Epoch ms until which the rate-limit breaker is OPEN (refusing turns); 0 = closed. */
  private breakerOpenUntil = 0;
  /** How many times the breaker has tripped (for exponential cooldown). */
  private breakerTrips = 0;
  /**
   * Turn ids handed to the SDK but not yet terminated by a `result`/error, oldest first. Turns run
   * strictly sequentially in one streaming session, so the active turn is always `activeTurns[0]`.
   */
  private activeTurns: string[] = [];
  /**
   * Per-turn delta sinks. A tap registered via onDelta(turnId, fn) only receives deltas for ITS turn,
   * so a voice turn can never pick up a prior typed turn's assistant text (turn-isolation).
   */
  private turnDeltaSinks = new Map<string, Set<(text: string) => void>>();
  /** Per-turn end callbacks, fired exactly once when that turn's `result`/error arrives. */
  private turnEndSinks = new Map<string, Set<(end: TurnEnd) => void>>();
  /** Monotonic turn counter for unique ids. */
  private turnSeq = 0;

  constructor(init: AgentSessionInit) {
    super();
    this.agentId = init.agentId;
    this.repoId = init.repoId;
    this.cwd = path.resolve(init.cwd);
    this.characterKind = init.characterKind;
    this.label = init.label;
    this.systemPromptOverride = init.systemPrompt;
    // ADA-ONLY MCP: only attach the Aiven MCP to a session that EXPLICITLY passes aivenMcpUrl (the data
    // operator does — operator.ts spawns Ada with aivenMcpUrl()). We deliberately do NOT fall back to the
    // global AGENTCRAFT_AIVEN_MCP_URL here: ordinary coding agents (a1/a2/a3) are spawned WITHOUT this
    // field, and a down/slow MCP HANGS session startup (there is no MCP-connect timeout — see start()),
    // wedging them on spawn. demo.sh exports that env process-wide for the shim, so inheriting it would
    // leak the MCP onto every agent. Opt-in only keeps the hang risk on the one session that needs it.
    this.aivenMcpUrl = (init.aivenMcpUrl ?? "").trim();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** True once the SDK stream died — the supervisor disposes/restarts these (see SessionSignal "dead"). */
  get isDead(): boolean {
    return this.dead;
  }

  /**
   * Close the breaker if its cooldown has elapsed (half-open: the next turn probes the throttle again).
   * The ONE place that mutates breaker state on read, so isBreakerOpen / breakerCooldownRemainingMs below
   * are PURE reads — a caller can sample both in sequence and they stay mutually consistent (no "open but
   * 0s remaining" from the getter flipping the breaker shut between two reads).
   */
  private closeBreakerIfElapsed(): void {
    if (this.breakerOpenUntil !== 0 && Date.now() >= this.breakerOpenUntil) {
      this.breakerOpenUntil = 0;
      this.rlConsecutive = 0;
    }
  }

  /**
   * Whether the rate-limit circuit breaker is currently OPEN (refusing new turns). When open, callers
   * must NOT push a prompt: it is refused and DROPPED — nothing auto-reschedules it, the caller (human via
   * the InteractionPanel / voice) re-asks after the cooldown. Pure read; the breaker auto-closes on the next
   * state-changing op (a turn result, or an explicit closeBreakerIfElapsed()).
   */
  get isBreakerOpen(): boolean {
    this.closeBreakerIfElapsed();
    return this.breakerOpenUntil !== 0;
  }

  /** Ms until the breaker would close (0 when closed). Lets the supervisor schedule a retry precisely. */
  get breakerCooldownRemainingMs(): number {
    return this.breakerOpenUntil === 0 ? 0 : Math.max(0, this.breakerOpenUntil - Date.now());
  }

  /** Subscribe to a lifecycle signal (dead / rate_limited / turn_timeout). Returns an unsubscribe fn. */
  onSignal(fn: (signal: SessionSignal, detail: string) => void): () => void {
    const wrapped = (signal: SessionSignal, detail: string) => fn(signal, detail);
    this.on("signal", wrapped);
    return () => this.off("signal", wrapped);
  }

  /** Emit a lifecycle signal to the supervisor. Never throws (a bad listener can't break the session). */
  private signal(signal: SessionSignal, detail: string): void {
    try {
      this.emit("signal", signal, detail);
    } catch {
      /* a faulty supervisor listener must not break the session */
    }
  }

  /**
   * Start the underlying streaming query and begin consuming SDK messages. Idempotent.
   * Throws synchronously only if the SDK import is unusable; runtime errors surface as `error` events.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // beginQuery() is async only because of the optional MCP reachability probe. Queued prompts park in the
    // inbox until consume() drains them, so deferring query() a few ms past start() is invisible to callers.
    void this.beginQuery();
  }

  /**
   * Build options + launch the streaming query. When an Aiven MCP URL is set we PROBE it first (bounded by
   * MCP_PROBE_TIMEOUT_MS): if it doesn't answer, we DROP the attach and fall back to BASE_PROMPT rather than
   * hand the SDK a dead endpoint that would hang the handshake forever (no MCP-connect timeout exists). This
   * makes a slow/down shim a graceful degrade ("running without coordination") instead of a wedged session.
   */
  private async beginQuery(): Promise<void> {
    // BILLING SAFETY: scrub metered Anthropic vars from the child env. This is the whole ballgame.
    const env = scrubAnthropicEnv() as Record<string, string | undefined>;
    const leaked = scrubbedVarsPresent(); // present in OUR env; proves the scrub is doing work
    if (leaked.length) {
      store.publish({
        type: "status",
        agent_id: this.agentId,
        state: "waiting",
        status_line: `billing-guard: scrubbed ${leaked.join(", ")} from child env`,
      });
    }

    // Aiven MCP is opt-in (constructor: ADA-only). Even when a URL is set, attach ONLY if it's reachable —
    // pointing the SDK at a dead/slow HTTP MCP hangs startup, so we never attach an unprobed endpoint.
    const requested = this.aivenMcpUrl !== "";
    const aivenOn = requested && (await probeMcpReachable(this.aivenMcpUrl));
    if (requested && !aivenOn) {
      // The closed() race: if the session was disposed while we were probing, don't launch a query.
      if (this.closed) return;
      store.publish({
        type: "status",
        agent_id: this.agentId,
        state: "waiting",
        status_line: "aiven MCP unreachable — running without coordination",
      });
      metrics.inc("mcp_attach_skipped_unreachable");
      logger.warn("aiven MCP unreachable on startup — degrading (no MCP attached)", { agent_id: this.agentId });
    }
    if (this.closed) return; // disposed mid-probe; nothing to launch

    const options: Record<string, unknown> = {
      cwd: this.cwd,
      env, // REPLACES process.env in the child — must be the scrubbed copy
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      permissionMode: "bypassPermissions", // unattended demo agents do real work
      includePartialMessages: false,
      // NEVER pass --bare: bare mode ignores CLAUDE_CODE_OAUTH_TOKEN (plan §2). The SDK default is fine.
      // An explicit per-session prompt (e.g. the operator persona) wins; else coordination/base by Aiven.
      // Lane A: a coding agent (no persona override) also gets the dev-server REGISTER instruction so a
      // server it spins up is tracked + killed on teardown. A persona override (Ada) is deliberate and left
      // untouched — she runs data missions, not dev servers.
      systemPrompt: this.systemPromptOverride ??
        `${aivenOn ? COORDINATION_PROMPT : BASE_PROMPT} ${serviceRegisterPrompt(this.agentId)}`,
    };
    if (aivenOn) {
      options.mcpServers = { aiven: { type: "http", url: this.aivenMcpUrl } };
    }
    this.q = query({
      // Streaming-input mode: our generator yields SDKUserMessages on demand.
      prompt: this.inputStream(),
      options,
    });

    // Consume the SDK message stream in the background; normalize into ServerEvents.
    void this.consume();
  }

  /**
   * The streaming-input generator. Yields a user message for each queued prompt, parking on `wake`
   * when the inbox is empty. Terminates when the session is closed.
   */
  private async *inputStream(): AsyncIterable<{
    type: "user";
    message: { role: "user"; content: string };
    parent_tool_use_id: null;
  }> {
    while (!this.closed) {
      if (this.inbox.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        if (this.closed) return;
      }
      const turn = this.inbox.shift();
      if (turn == null) continue;
      this.busy = true;
      // Mark this turn active so the next `result`/error correlates back to it (FIFO).
      this.activeTurns.push(turn.id);
      yield {
        type: "user",
        message: { role: "user", content: turn.text },
        parent_tool_use_id: null,
      };
    }
  }

  /**
   * Queue a prompt as the next user turn. The session must be started first. Returns the turn id so a
   * caller (e.g. the voice shim) can scope onDelta()/onTurnEnd() to exactly THIS turn — the deltas and
   * the terminal result of a prior in-flight turn never bleed into it.
   */
  prompt(text: string): string {
    const id = `t${++this.turnSeq}`;
    if (this.closed) return id;

    // IDEMPOTENCY/DEDUPE: a double-clicked POST or a retried WS `command` can enqueue the SAME prompt text
    // while the prior copy is still pending/in-flight. Collapse it to the existing turn instead of running
    // the work (and burning a live slot/quota) twice. Identical text only — a deliberate re-ask after the
    // first finishes is allowed (the key is released when that turn ends). (gap: "No command idempotency".)
    const dedupeKey = createHash("sha1").update(text).digest("hex");
    if (this.inflightDedupeKeys.has(dedupeKey)) {
      const existing = this.findTurnByDedupeKey(dedupeKey);
      metrics.inc("duplicate_prompt_ignored");
      logger.info("ignored duplicate in-flight prompt", { agent_id: this.agentId, dedupe: dedupeKey.slice(0, 8) });
      // Return the EXISTING turn id so a caller's onDelta/onTurnEnd still resolve on the real turn.
      return existing ?? id;
    }

    this.inflightDedupeKeys.add(dedupeKey);
    this.turnDedupeKey.set(id, dedupeKey);
    this.inbox.push({ id, text });
    void store.appendTranscript(this.agentId, {
      ts: new Date().toISOString(),
      role: "user",
      text,
    });
    // Arm a per-turn watchdog so a wedged turn (no result ever) is force-failed and the session frees up.
    this.armTurnWatchdog(id);
    // Optimistic transition so the world reacts immediately (the result event confirms/clears it).
    void this.setState("moving", "received prompt", { current_task: truncate(text, 80) });
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
    return id;
  }

  /** Find a still-pending/in-flight turn id by its dedupe key (inbox + active turns). */
  private findTurnByDedupeKey(key: string): string | undefined {
    for (const [turnId, k] of this.turnDedupeKey) {
      if (k === key) return turnId;
    }
    return undefined;
  }

  /**
   * Arm a watchdog for `turnId`: if it hasn't terminated within TURN_TIMEOUT_MS, interrupt the in-flight
   * turn and fail it cleanly so the session stops being `busy` forever. Only the OLDEST active turn is
   * ever in flight (sequential), so interrupting cancels the right one. The timer is cleared in
   * endActiveTurn(); we also clear any stale timer before re-arming.
   */
  private armTurnWatchdog(turnId: string): void {
    this.clearTurnTimer(turnId);
    const timer = setTimeout(() => {
      this.turnTimers.delete(turnId);
      // Only act if this turn is still in flight (it's the active one and hasn't ended).
      if (!this.activeTurns.includes(turnId)) return;
      const detail = `turn exceeded ${TURN_TIMEOUT_MS}ms`;
      logger.warn("turn timeout — interrupting", { agent_id: this.agentId, turn: turnId });
      metrics.inc("turn_timeout");
      store.publish({ type: "error", agent_id: this.agentId, message: `turn timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s` });
      this.signal("turn_timeout", detail);
      // Interrupt frees the SDK; fail just this turn (and any older stuck ones) so waiters unblock.
      void this.interrupt();
    }, TURN_TIMEOUT_MS);
    // Don't let a pending watchdog keep the process alive on shutdown.
    if (typeof timer.unref === "function") timer.unref();
    this.turnTimers.set(turnId, timer);
  }

  /** Clear a turn's watchdog timer if present. */
  private clearTurnTimer(turnId: string): void {
    const t = this.turnTimers.get(turnId);
    if (t) {
      clearTimeout(t);
      this.turnTimers.delete(turnId);
    }
  }

  /**
   * Tap normalized assistant text deltas for ONE turn (used by the voice shim's runAgentTurn).
   * Pass the turn id returned by prompt(); the sink only fires for that turn. Returns an unsubscribe
   * fn. Multiple sinks may attach to the same turn.
   */
  onDelta(turnId: string, fn: (text: string) => void): () => void {
    let set = this.turnDeltaSinks.get(turnId);
    if (!set) {
      set = new Set();
      this.turnDeltaSinks.set(turnId, set);
    }
    set.add(fn);
    return () => {
      const s = this.turnDeltaSinks.get(turnId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.turnDeltaSinks.delete(turnId);
    };
  }

  /**
   * Fire `fn` exactly once when THIS turn terminates (its own `result` or error) — never on a prior or
   * later turn's terminal event. Returns an unsubscribe fn. If the turn already ended, this never fires
   * (the caller should treat a still-pending wait via its own timeout).
   */
  onTurnEnd(turnId: string, fn: (end: TurnEnd) => void): () => void {
    let set = this.turnEndSinks.get(turnId);
    if (!set) {
      set = new Set();
      this.turnEndSinks.set(turnId, set);
    }
    set.add(fn);
    return () => {
      const s = this.turnEndSinks.get(turnId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.turnEndSinks.delete(turnId);
    };
  }

  /** Interrupt the in-flight turn (streaming-input mode only). Best-effort. */
  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch {
      /* nothing in flight, or transport already gone */
    }
    this.busy = false;
    // Drop turns still QUEUED in the inbox (never yielded, so not in activeTurns): an interrupt means "stop",
    // and a queued turn would otherwise run after the interrupt AND — worse — leak its dedupe key forever
    // (failAllTurns only releases ACTIVE turns), silently swallowing an identical re-ask for the session's
    // life. Release each queued turn's dedupe key, mirroring close(). (gap: dedupe key leak on interrupt.)
    for (const t of this.inbox) {
      const key = this.turnDedupeKey.get(t.id);
      if (key) {
        this.turnDedupeKey.delete(t.id);
        this.inflightDedupeKeys.delete(key);
      }
      this.clearTurnTimer(t.id);
    }
    this.inbox.length = 0;
    this.failAllTurns("interrupted");
    await this.setState("waiting", "interrupted");
  }

  /** Shut the session down: stop the input generator and dispose the query. */
  async close(): Promise<void> {
    this.closed = true;
    // Lane A: reap any dev server this agent spun up that should have outlived the TURN but must NOT outlive
    // the SESSION. close() is the single teardown path for stop()/sendAway()/new-session/dispose, so killing
    // here (SIGTERM, best-effort, never throws) is the one place that guarantees a registered server isn't
    // zombied past the agent. Un-registered servers are the deferred part of this lane (see process-registry).
    try {
      processRegistry.killForAgent(this.agentId);
    } catch {
      /* registry kill is best-effort; never block close() */
    }
    // Clear every pending watchdog so no timer fires (or keeps the loop alive) after close.
    for (const t of this.turnTimers.values()) clearTimeout(t);
    this.turnTimers.clear();
    // Drop dedupe keys for turns that never ran (still in the inbox) so nothing leaks across a restart.
    this.inbox.length = 0;
    this.inflightDedupeKeys.clear();
    this.turnDedupeKey.clear();
    this.failAllTurns("session closed");
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w(); // unblock the generator so it can return
    }
    // Bound the SDK teardown. q.interrupt()/q.return() can HANG on a wedged turn — and close() is awaited by
    // newSession(), which is awaited by the /new-session HTTP handler, so a hang here makes "New chat"
    // silently fall back to the old (stuck) session ("reloads the same chat"). Detach the query ref FIRST so
    // a fresh session can never touch the dying one, then race the teardown against a hard cap: if it doesn't
    // finish, abandon it (the orphaned child is reaped by the OS / a later worktree prune) so a reset ALWAYS
    // completes promptly. Releasing the async generator ends the underlying child process when it cooperates.
    const q = this.q;
    this.q = null;
    await Promise.race([
      (async () => {
        try { await q?.interrupt(); } catch { /* ignore */ }
        try { await (q as unknown as AsyncGenerator)?.return?.(undefined); } catch { /* ignore */ }
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)), // 3s cap — a wedged query can't hang the reset
    ]);
  }

  /**
   * Drain the SDK message stream, normalizing each message into ServerEvents + state transitions.
   * Any thrown error is reported as an `error` event and flips the agent back to waiting (never throws
   * out of here — that would kill the session-manager's caller).
   */
  private async consume(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const msg of this.q) {
        this.handleMessage(msg);
      }
      // The stream ENDED cleanly (the SDK closed the child). A streaming-input session shouldn't end on
      // its own while we're still open — treat an unexpected end like a death so the supervisor can
      // dispose + restart instead of leaving a corpse that dispatchPrompt would route into.
      if (!this.closed) {
        this.markDead("session stream ended unexpectedly");
      }
    } catch (e) {
      const detail = errMsg(e);
      store.publish({
        type: "error",
        agent_id: this.agentId,
        message: `session stream error: ${detail}`,
      });
      await this.setState("waiting", "stream error");
      this.busy = false;
      // Fail every in-flight turn so per-turn waiters (voice) unblock instead of hanging to timeout.
      this.failAllTurns(`session stream error: ${detail}`);
      // A thrown stream is a dead Query — flag it and signal the supervisor (which disposes + restarts).
      this.markDead(`session stream error: ${detail}`);
    }
  }

  /**
   * Mark the session dead: its underlying Query can never take another turn. Idempotent. Emits the
   * "dead" signal exactly once so the supervisor disposes this session and applies its restart policy.
   * If the death looks rate-limit-related, also signal that so the supervisor backs off rather than
   * immediately respawning into the same throttle.
   */
  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.busy = false;
    metrics.inc("session_dead");
    logger.warn("session marked dead", { agent_id: this.agentId, reason });
    if (isRateLimitText(reason)) {
      this.tripRateLimit(reason);
    }
    this.signal("dead", reason);
  }

  /**
   * Record a rate-limit failure. Past RL_BREAKER_THRESHOLD consecutive rate-limit turns, OPEN the circuit
   * breaker for an exponentially-growing cooldown (capped) so we stop hammering a throttled Max account.
   * Always emits the "rate_limited" signal so the supervisor can schedule a backed-off retry. Idempotent-ish:
   * re-tripping while already open just lengthens the cooldown (exponential). (gap: "No 429 … circuit breaker".)
   */
  private tripRateLimit(reason: string): void {
    this.rlConsecutive += 1;
    metrics.inc("rate_limited_turn");
    logger.warn("rate-limited turn", { agent_id: this.agentId, consecutive: this.rlConsecutive, reason });
    if (this.rlConsecutive >= RL_BREAKER_THRESHOLD) {
      const cooldown = Math.min(
        RL_BREAKER_MAX_COOLDOWN_MS,
        RL_BREAKER_BASE_COOLDOWN_MS * 2 ** this.breakerTrips,
      );
      this.breakerTrips += 1;
      this.breakerOpenUntil = Date.now() + cooldown;
      metrics.inc("rate_limit_breaker_open");
      logger.warn("rate-limit breaker OPEN", { agent_id: this.agentId, cooldown_ms: cooldown });
      store.publish({
        type: "error",
        agent_id: this.agentId,
        message: `rate-limited — pausing ${Math.round(cooldown / 1000)}s before retry`,
      });
    }
    this.signal("rate_limited", reason);
  }

  /** Fail every currently in-flight turn with `reason` (stream death / interrupt / close). */
  private failAllTurns(reason: string): void {
    while (this.activeTurns.length) this.endActiveTurn({ ok: false, reason });
  }

  /** Map one SDK stream-json message onto the frozen ServerEvent union. */
  private handleMessage(msg: any): void {
    switch (msg?.type) {
      case "assistant": {
        const blocks = msg?.message?.content ?? [];
        for (const block of blocks) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.length) {
            this.emitText(block.text);
            void this.setState("working", "thinking");
          } else if (block?.type === "tool_use") {
            const tool = String(block.name ?? "tool");
            const detail = summarizeToolInput(block.input);
            store.publish({
              type: "tool_start",
              agent_id: this.agentId,
              tool,
              detail,
            });
            // Mid-turn HUD pulse (Lane-A observability): a short human line of WHAT it's doing right now,
            // so D can render "Bash: npm run dev" / "Edit: index.html" live. Reuses the already-redacted
            // `detail` (tool_start) so NO code/diff/file content leaks — only tool name + a tiny summary.
            store.publish({
              type: "tool_activity",
              agent_id: this.agentId,
              tool,
              summary: detail ? `${tool}: ${detail}` : tool,
              ts: new Date().toISOString(),
            });
            void this.setState("working", `running ${tool}`);
            // Surface Aiven coordination tool calls as `aiven` events so the world can render them.
            const coord = asCoordEvent(this.agentId, tool, block.input);
            if (coord) store.publish({ type: "aiven", agent_id: this.agentId, event: coord });
          }
        }
        break;
      }

      case "user": {
        // In streaming mode, tool_result blocks come back as a user message. Treat each as a tool_end.
        const blocks = msg?.message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block?.type === "tool_result") {
              store.publish({
                type: "tool_end",
                agent_id: this.agentId,
                tool: String(block?.tool_use_id ?? "tool"),
                ok: block?.is_error !== true,
              });
            }
          }
        }
        break;
      }

      case "result": {
        this.busy = false;
        const ok = msg?.subtype === "success";
        const summary = String(msg?.result ?? (ok ? "done" : msg?.subtype ?? "error"));
        if (ok) {
          // A clean turn closes any rate-limit streak AND resets the breaker's penalty memory, so the
          // exponential cooldown is per-INCIDENT, not per-session: a healthy stretch of successful turns
          // earns the agent back its short first-trip backoff instead of being pinned at the 5-min cap for
          // the rest of the session because of one earlier rough patch. (breakerTrips drove 2**trips.)
          this.rlConsecutive = 0;
          this.breakerTrips = 0;
          metrics.inc("turn_success");
          // Resolve THIS turn's end sinks before broadcasting, so a per-turn waiter wins its own turn.
          this.endActiveTurn({ ok: true, summary });
          store.publish({ type: "result", agent_id: this.agentId, summary });
          // SERVICE event (Lane-A, best-effort): if the turn's answer mentions a localhost URL, the agent
          // likely started a dev server — surface it as a structured {url,port} so D can show an "open it"
          // affordance and the voice can tell the user. Parsed from the result TEXT only (the minimal,
          // reliable path); NO code/diff. Limitation: it can't see a server started silently with no URL in
          // the answer — that needs a future agent-callable register hook. See emitServiceFromText().
          this.emitServiceFromText(summary);
          // Anonymized activity pulse (DATA_MODEL.md "Activity → shared world"): a content-free work event
          // — only a magnitude + the dotted hierarchy path — that drives the Aiven-backed shared/multiplayer
          // world. Emitted on the local bus now (B/D can see the flow); the Aiven Kafka→Postgres sync +
          // cross-user worlds are the gated next workstream. NO code/diff/file ever leaves the machine.
          this.emitActivity("done", summary.length);
          void store.appendTranscript(this.agentId, {
            ts: new Date().toISOString(),
            role: "agent",
            text: summary,
          });
          // `done` is a one-shot pulse; the manager/world bounces it back to waiting after the beat.
          void this.setState("done", truncate(summary, 80));
          // PR/approve/pending flow (plan §3 L3, Phase 3): when a turn finishes leaving UNCOMMITTED changes
          // in the worktree, that is the human-gate moment — the agent has produced work that wants review
          // before it lands. Emit a `pending` ServerEvent (through the store bus → WS fan-out → D's HUD).
          // Detached + best-effort so it never delays the `done` pulse or hangs the session; a non-git /
          // clean / unreadable worktree simply emits nothing.
          void this.maybeEmitPending();
        } else {
          const subtype = String(msg?.subtype ?? "failed");
          const reason = `turn ${subtype}: ${summary}`;
          metrics.inc("turn_error");
          // 429/overload detection: a throttled turn trips the rate-limit breaker (backoff is owned by the
          // supervisor, which watches the "rate_limited" signal). Other errors don't touch the breaker.
          if (isRateLimitText(subtype) || isRateLimitText(summary)) {
            this.tripRateLimit(reason);
          }
          this.endActiveTurn({ ok: false, reason });
          store.publish({
            type: "error",
            agent_id: this.agentId,
            message: reason,
          });
          void this.setState("waiting", `error: ${subtype}`);
        }
        break;
      }

      // system/init, status, progress, etc. — heartbeat the record so the world sees liveness.
      default: {
        if (msg?.type === "system" || msg?.type === "status") {
          void store.heartbeat(this.agentId);
        }
        break;
      }
    }
  }

  /**
   * Emit an assistant text delta to the bus (caption) and to the ACTIVE turn's delta sinks (voice).
   * Deltas route only to the in-flight turn (`activeTurns[0]`), so a tap registered for a different
   * turn never sees them — this is the turn-isolation guarantee the voice path depends on.
   */
  private emitText(text: string): void {
    store.publish({ type: "text", agent_id: this.agentId, text });
    const activeTurn = this.activeTurns[0];
    if (!activeTurn) return;
    const sinks = this.turnDeltaSinks.get(activeTurn);
    if (!sinks) return;
    for (const sink of sinks) {
      try {
        sink(text);
      } catch {
        /* a bad sink must not break the stream */
      }
    }
  }

  /** Fire (and clear) the end callbacks for the oldest in-flight turn. Called on each `result`/error. */
  private endActiveTurn(end: TurnEnd): void {
    const turnId = this.activeTurns.shift();
    if (!turnId) return;
    // Release this turn's watchdog + dedupe key so the slot frees and an identical re-ask is allowed.
    this.clearTurnTimer(turnId);
    const key = this.turnDedupeKey.get(turnId);
    if (key) {
      this.turnDedupeKey.delete(turnId);
      this.inflightDedupeKeys.delete(key);
    }
    const sinks = this.turnEndSinks.get(turnId);
    if (sinks) {
      this.turnEndSinks.delete(turnId);
      for (const sink of sinks) {
        try {
          sink(end);
        } catch {
          /* a bad sink must not break the stream */
        }
      }
    }
    // A turn that ended will never emit more deltas; drop any orphaned delta sinks for it.
    this.turnDeltaSinks.delete(turnId);
  }

  /** Update the persisted record + broadcast status (store.update emits the `status` ServerEvent). */
  private async setState(
    state: AgentState,
    statusLine: string,
    extra: Partial<Pick<AgentRecord, "current_task" | "target_base_id">> = {},
  ): Promise<void> {
    await store.update(this.agentId, { state, status_line: statusLine, ...extra });
  }

  /**
   * After a successful turn, check whether the agent's worktree has UNCOMMITTED changes and, if so, emit a
   * `pending` gate event (via pr.ts → store bus → WS) so D's HUD shows "awaiting review". This is the
   * pending half of the PR/approve/pending flow on the agent side: the operator can then POST
   * /agents/:id/pr (open a real PR → `awaiting_approval`) and POST /agents/:id/approve to release it.
   *
   * Fully defensive — this is decoration on top of a completed turn and must NEVER affect it:
   *   - bounded `git status --porcelain` with the metered Anthropic vars scrubbed (billing safety holds);
   *   - any failure (non-git worktree, timeout, locked repo) is swallowed → no event, identical to clean.
   * The operator (Ada) runs in a scratch non-git cwd, so this is a clean no-op there.
   */
  /**
   * Publish an anonymized ActivityEvent (DATA_MODEL.md): a content-free work pulse — magnitude + the
   * dotted hierarchy path (group.repo.project.agent) + state — that feeds the Aiven-backed shared world.
   * NO code, diff, or file content is included. magnitude is a clamped, unitless size hint. Best-effort:
   * a missing record or bad value never breaks the turn.
   */
  private emitActivity(state: AgentState, rawMagnitude: number): void {
    try {
      const rec = store.get(this.agentId);
      const levelPath = [rec?.group_id, rec?.repo_id, rec?.project_id ?? rec?.repo_id, this.agentId]
        .filter(Boolean)
        .join(".");
      const magnitude = Math.max(1, Math.min(10, Math.round((rawMagnitude || 0) / 80) || 1));
      const ts = new Date().toISOString();
      store.publish({
        type: "activity",
        agent_id: this.agentId,
        event: { level_path: levelPath, magnitude, state, ts },
      });
      // The "agent emits → Kafka" leg of the activity loop (DATA_MODEL.md): stream the anonymized pulse to
      // agent.coordination so any sidecar (incl. other users' worlds) folds it into coord_events → /world.
      // Fire-and-forget + no-op when Kafka is unconfigured; never blocks or breaks the turn. NO code/diff.
      void produceCoordEvent({ type: "activity", agent_id: this.agentId, detail: `${levelPath} mag=${magnitude}`, ts });
    } catch {
      /* activity is best-effort telemetry; never break a turn */
    }
  }

  /**
   * Parse a localhost URL out of a turn's result text and, if found, publish a `service` ServerEvent so D
   * can surface a clickable "open it" and the voice can announce the server. Best-effort + cheap: a single
   * regex over the summary, no network. NO code/diff is read — only the agent's own answer text. Never
   * throws (decoration on a completed turn). Limitation: only catches a URL the agent actually wrote into
   * its final answer; a server started without naming its URL is missed (a future agent-callable register
   * hook would close that — noted in contract.ts / the result block).
   */
  private emitServiceFromText(text: string): void {
    try {
      const svc = parseLocalhostUrl(text);
      if (!svc) return;
      metrics.inc("service_detected");
      logger.info("turn surfaced a local service", { agent_id: this.agentId, port: svc.port });
      store.publish({
        type: "service",
        agent_id: this.agentId,
        url: svc.url,
        port: svc.port,
        ts: new Date().toISOString(),
      });
    } catch {
      /* service detection is best-effort decoration; never break a turn */
    }
  }

  private async maybeEmitPending(): Promise<void> {
    try {
      const { stdout } = await pexec("git status --porcelain", {
        cwd: this.cwd,
        env: scrubAnthropicEnv() as NodeJS.ProcessEnv,
        maxBuffer: 1 << 20,
        timeout: DIRTY_CHECK_TIMEOUT_MS,
      });
      if (!stdout.trim()) return; // clean worktree (or nothing tracked) — nothing to gate
      const changed = stdout.split("\n").filter((l) => l.trim()).length;
      metrics.inc("turn_pending_uncommitted");
      logger.info("turn left uncommitted changes — emitting pending", {
        agent_id: this.agentId,
        changed,
      });
      // markPending no-ops if the record is gone; it publishes {type:'pending'} on the store bus.
      markPending(this.agentId, `${changed} uncommitted change${changed === 1 ? "" : "s"} awaiting review`);
    } catch {
      /* non-git worktree / locked / timeout — treat as clean (no pending), never disturb the turn */
    }
  }
}

// ---- helpers (pure) ----

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  try {
    const obj = input as Record<string, unknown>;
    const key = obj.file_path ?? obj.path ?? obj.command ?? obj.query ?? obj.pattern;
    if (key != null) return truncate(String(key), 60);
    return truncate(JSON.stringify(input), 60);
  } catch {
    return "";
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Best-effort extraction of a LOCAL dev-server URL from arbitrary text (a turn's result). Matches
 * http(s)://localhost|127.0.0.1|0.0.0.0[:port][/path]. Returns the first match with a derived port
 * (explicit :port, else 80/443 by scheme), or null. Pure + cheap (one regex, no network). Normalizes
 * 0.0.0.0 -> localhost so the surfaced URL is actually clickable. Heuristic only — favors no false
 * positives by anchoring on the localhost hosts rather than any URL.
 */
function parseLocalhostUrl(text: string): { url: string; port: number } | null {
  if (!text) return null;
  const m = text.match(
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{1,5}))?(?:\/[^\s)"'<>]*)?/i,
  );
  if (!m) return null;
  let url = m[0];
  const scheme = url.toLowerCase().startsWith("https") ? "https" : "http";
  // 0.0.0.0 is a bind address, not navigable in a browser — rewrite to localhost so the link works.
  url = url.replace(/(https?:\/\/)0\.0\.0\.0/i, "$1localhost");
  const port = m[1] ? Number(m[1]) : scheme === "https" ? 443 : 80;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { url, port };
}

/**
 * Best-effort recognition of an Aiven coordination tool call so the world can render the beat even
 * before Track D's projection catches up. Returns a CoordEvent or null. Heuristic only.
 */
function asCoordEvent(agentId: string, tool: string, input: unknown): CoordEvent | null {
  const t = tool.toLowerCase();
  // Match the Aiven MCP by its NAMESPACE first (the SDK names MCP tools `mcp__<server>__<tool>`, and we
  // register the server as `aiven` — see start()), then by coordination keywords. The keywords use precise
  // tokens, NOT a bare 2-char "pg" substring (which false-positived on any tool whose name merely contains
  // those letters — "upgrade", "mpgconvert", an MCP slug — emitting spurious `aiven` beats into /world).
  const isAiven =
    t.startsWith("mcp__aiven__") ||
    t.includes("aiven") ||
    t.includes("kafka") ||
    t.includes("postgres") ||
    /(^|_)pg(_|$)/.test(t) ||
    t.includes("lock");
  if (!isAiven) return null;
  const detail = summarizeToolInput(input);
  let type = "coord";
  if (t.includes("claim") || t.includes("lock")) type = "file_claimed";
  else if (t.includes("release")) type = "released";
  else if (t.includes("heartbeat")) type = "heartbeat";
  return { ts: new Date().toISOString(), type, agent_id: agentId, detail };
}
