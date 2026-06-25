/**
 * AgentCraft — agent-child supervisor (Track A / Brain, plan §2 Reliability, lane L1, charter §3).
 *
 * The session-manager owns the registry of live AgentSessions; this module owns the POLICY that keeps
 * that registry honest when a child misbehaves. Without it, a session whose SDK stream throws is flipped
 * to `waiting` but its dead Query stays in the manager's map (`has()==true`) forever — dispatchPrompt then
 * routes prompts into a corpse. The supervisor closes that gap:
 *
 *   - DEAD DETECTION: it subscribes to each session's internal lifecycle signals (AgentSession.onSignal:
 *     "dead" | "rate_limited" | "turn_timeout"). On "dead" it disposes the corpse and applies a bounded
 *     auto-restart policy. On "rate_limited" it records a backoff so a restart doesn't immediately respawn
 *     into the same throttle.
 *   - RESTART POLICY: bounded. Up to MAX_RESTARTS within RESTART_WINDOW_MS, with exponential backoff; past
 *     that the agent is left dead (surfaced via the existing `error` ServerEvent — the world shows it idle
 *     rather than flapping). The cap protects the Max rate limit (a crash-looping child must not hammer it).
 *
 * SEAMS (kept narrow so the manager stays the registry owner and this stays pure policy):
 *   - The manager calls `supervisor.watch(agentId, session)` right after it starts a session, and
 *     `supervisor.forget(agentId)` when it stops one (clean shutdown — no restart).
 *   - The supervisor calls back through a `RestartHooks` the manager provides (dispose + respawn) instead
 *     of importing the manager (avoids a circular import; the manager wires the hooks once at construction).
 *
 * Defensive: every callback is wrapped so a faulty hook can never crash a session or /world; all timers are
 * unref()'d so a pending restart never keeps the process alive on shutdown. NEVER touches billing safety.
 */
import type { AgentSession, SessionSignal } from "./agent-session.ts";
import { store } from "./session-store.ts";
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";

/** Max restarts allowed for one agent inside RESTART_WINDOW_MS before we give up (anti-crash-loop). */
const MAX_RESTARTS = 3;
/** Sliding window over which restarts are counted; a quiet agent's count decays back to 0. */
const RESTART_WINDOW_MS = 5 * 60_000;
/** Base backoff before a restart; grows exponentially per restart in the window (capped). */
const RESTART_BASE_BACKOFF_MS = 2_000;
const RESTART_MAX_BACKOFF_MS = 60_000;
/**
 * Minimum restart backoff for a rate-limit-flavored DEATH. A session that dies on its FIRST rate-limit error
 * has rlConsecutive=1, so the breaker is still CLOSED and breakerCooldownRemainingMs=0 — without a floor the
 * respawn would wait only the base 2s and come straight back up into the same throttle (bounded by
 * MAX_RESTARTS, but defeating the "back off past the throttle" intent). This floor mirrors the breaker's own
 * first-trip cooldown so a death-before-threshold still backs off. Kept local so the supervisor stays the
 * single backoff authority and we don't widen agent-session's exports. */
const RL_DEATH_MIN_BACKOFF_MS = 15_000;

/**
 * Hooks the manager provides so the supervisor can act WITHOUT importing the manager (no circular dep).
 *   - dispose: tear down the dead session + free the live slot (manager removes it from its map). Must
 *     NOT itself restart. Best-effort; may reject — the supervisor swallows it.
 *   - respawn: bring the agent back up from its store record (manager.spawn under the hood). Returns
 *     whether the respawn succeeded so the supervisor can decide whether to count/limit it.
 */
export interface RestartHooks {
  dispose(agentId: string): Promise<void>;
  respawn(agentId: string): Promise<boolean>;
}

/** Per-agent supervision bookkeeping. */
interface Watch {
  session: AgentSession;
  /** unsubscribe from the session's signal emitter */
  off: () => void;
  /** epoch-ms timestamps of recent restarts (pruned to RESTART_WINDOW_MS) */
  restarts: number[];
  /** a pending restart timer, so we never schedule two for one agent */
  timer: ReturnType<typeof setTimeout> | null;
  /** true while we're tearing this down on purpose (forget) — suppresses restart */
  retiring: boolean;
  /** extra backoff (ms) to add when a death was rate-limit-related */
  rateLimitBackoffUntil: number;
}

class Supervisor {
  private watches = new Map<string, Watch>();
  private hooks: RestartHooks | null = null;

  /** The manager wires its dispose/respawn hooks once at construction. Idempotent (last wins). */
  setHooks(hooks: RestartHooks): void {
    this.hooks = hooks;
  }

  /**
   * Begin supervising a freshly-started session. Replaces any prior watch for the same id (a respawn
   * hands us a new AgentSession). Subscribes to its lifecycle signals.
   */
  watch(agentId: string, session: AgentSession): void {
    // Drop a stale watch for this id (without retiring it — this IS the replacement).
    const prior = this.watches.get(agentId);
    if (prior) {
      try {
        prior.off();
      } catch {
        /* ignore */
      }
      if (prior.timer) clearTimeout(prior.timer);
    }
    const w: Watch = {
      session,
      off: () => {},
      restarts: prior?.restarts ?? [],
      timer: null,
      retiring: false,
      rateLimitBackoffUntil: 0,
    };
    w.off = session.onSignal((signal, detail) => this.onSignal(agentId, signal, detail));
    this.watches.set(agentId, w);
    metrics.setGauge("supervised_sessions", this.watches.size);
  }

  /**
   * Stop supervising an agent (clean shutdown initiated by the manager). Cancels any pending restart and
   * unsubscribes. Does NOT restart. Safe to call for an unknown id.
   */
  forget(agentId: string): void {
    const w = this.watches.get(agentId);
    if (!w) return;
    w.retiring = true;
    try {
      w.off();
    } catch {
      /* ignore */
    }
    if (w.timer) {
      clearTimeout(w.timer);
      w.timer = null;
    }
    this.watches.delete(agentId);
    metrics.setGauge("supervised_sessions", this.watches.size);
  }

  /** Number of agents currently supervised (for /metrics + tests). */
  get size(): number {
    return this.watches.size;
  }

  // ---- internal ----

  private onSignal(agentId: string, signal: SessionSignal, detail: string): void {
    const w = this.watches.get(agentId);
    if (!w || w.retiring) return;
    switch (signal) {
      case "rate_limited":
        // Remember to back off; if a death follows, the restart waits past the throttle.
        w.rateLimitBackoffUntil = Date.now() + w.session.breakerCooldownRemainingMs;
        return;
      case "turn_timeout":
        // A timed-out turn is already failed + interrupted by the session; nothing to restart unless it
        // also goes dead. Just record it.
        metrics.inc("supervisor_turn_timeout");
        return;
      case "dead":
        void this.handleDeath(agentId, detail);
        return;
    }
  }

  /** Dispose the corpse and schedule a bounded, backed-off restart (or give up past the cap). */
  private async handleDeath(agentId: string, reason: string): Promise<void> {
    const w = this.watches.get(agentId);
    if (!w || w.retiring) return;
    if (w.timer) return; // a restart is already scheduled for this death

    metrics.inc("supervisor_death");
    logger.warn("supervising dead session", { agent_id: agentId, reason });

    // 1) Dispose the dead session so the manager frees the live slot (it can no longer take a turn).
    if (this.hooks) {
      try {
        await this.hooks.dispose(agentId);
      } catch (e) {
        logger.warn("supervisor dispose failed (non-fatal)", { agent_id: agentId, error: errMsg(e) });
      }
    }

    // If a clean shutdown raced in while we were disposing, stop here.
    const still = this.watches.get(agentId);
    if (!still || still.retiring) return;

    // 2) Bounded restart policy. Prune the restart window, then decide.
    const now = Date.now();
    still.restarts = still.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (still.restarts.length >= MAX_RESTARTS) {
      metrics.inc("supervisor_restart_exhausted");
      logger.error("agent restart budget exhausted — leaving dead", {
        agent_id: agentId,
        restarts: still.restarts.length,
      });
      store.publish({
        type: "error",
        agent_id: agentId,
        message: "agent crashed repeatedly — stopped auto-restart (will stay idle)",
      });
      // Reflect reality in the world: the agent is down, not working.
      void store.update(agentId, { state: "waiting", status_line: "stopped after repeated crashes" });
      // Stop watching the corpse; a fresh spawn (manual) re-arms supervision.
      this.forget(agentId);
      return;
    }

    // 3) Schedule a backed-off respawn. Backoff = exponential by restart count, plus any rate-limit wait.
    const idx = still.restarts.length;
    const base = Math.min(RESTART_MAX_BACKOFF_MS, RESTART_BASE_BACKOFF_MS * 2 ** idx);
    // A rate-limit-flavored DEATH before the breaker's threshold leaves rateLimitBackoffUntil at ~now (the
    // breaker never opened), so the "rate_limited" signal's cooldown is 0. Floor it so the respawn still
    // backs off past the throttle instead of bouncing straight back into it. (defect: death-before-threshold.)
    const rlFloor = isRateLimitText(reason) ? RL_DEATH_MIN_BACKOFF_MS : 0;
    const rlWait = Math.max(0, still.rateLimitBackoffUntil - now, rlFloor);
    const backoff = base + rlWait;
    logger.info("scheduling agent restart", { agent_id: agentId, in_ms: backoff, attempt: idx + 1 });
    store.publish({
      type: "status",
      agent_id: agentId,
      state: "waiting",
      status_line: `recovering (restart in ${Math.round(backoff / 1000)}s)`,
    });

    still.timer = setTimeout(() => {
      still.timer = null;
      void this.doRestart(agentId);
    }, backoff);
    if (typeof still.timer.unref === "function") still.timer.unref();
  }

  /** Perform the actual respawn via the manager hook, recording the attempt. */
  private async doRestart(agentId: string): Promise<void> {
    const w = this.watches.get(agentId);
    if (!w || w.retiring || !this.hooks) return;
    w.restarts.push(Date.now());
    metrics.inc("supervisor_restart");
    try {
      const ok = await this.hooks.respawn(agentId);
      if (ok) {
        logger.info("agent restarted", { agent_id: agentId });
        // watch() was re-invoked by the manager on the new session; nothing more to do here.
      } else {
        logger.warn("agent respawn returned not-ok", { agent_id: agentId });
        store.publish({
          type: "error",
          agent_id: agentId,
          message: "auto-restart failed (will stay idle until re-spawned)",
        });
        // Clear the "recovering (restart in Ns)" status handleDeath optimistically set: the respawn did NOT
        // bring the agent back and there is no further timer pending, so without this the world would show a
        // phantom "recovering" forever. Land it on a truthful idle state instead. (Don't forget() — a manual
        // re-spawn should still re-arm supervision via watch().)
        void store.update(agentId, {
          state: "waiting",
          status_line: "idle (auto-restart failed; re-spawn to retry)",
        });
      }
    } catch (e) {
      logger.warn("agent respawn threw (non-fatal)", { agent_id: agentId, error: errMsg(e) });
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Recognize a rate-limit / overload death from its reason text (same heuristic as agent-session's
 * isRateLimitText, kept local so the supervisor stays the single backoff authority without widening
 * agent-session's exports). Drives RL_DEATH_MIN_BACKOFF_MS so a death-before-breaker-threshold still
 * backs off past the throttle.
 */
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

/** The single process-wide supervisor. The session-manager wires its hooks + watch/forget into it. */
export const supervisor = new Supervisor();
export type { Supervisor };
