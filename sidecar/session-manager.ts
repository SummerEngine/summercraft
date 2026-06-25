/**
 * AgentCraft — session manager (Track A, plan §7 Phase 1).
 *
 * Owns the registry of live AgentSessions and the policy around them:
 *   - spawn(): create + start a session for a character, behind a HARD concurrency cap of 3 live
 *     sessions (Max subscription rate-limit ceiling, plan §3 / §8 risk #2). Extra spawns are refused
 *     with a clear error; the world renders those characters idle.
 *   - command()/interrupt()/list(): drive and inspect sessions.
 *   - runAgentTurn(characterId, prompt): the async-iterable the OpenAI voice shim consumes. It maps a
 *     `model === characterId` voice turn onto a real Claude turn and streams the assistant text back.
 *
 * The manager resolves a worktree per character (falling back to repo cwd) and creates the persisted
 * store record before starting the SDK session, so /world has the agent the instant it spawns.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentSession } from "./agent-session.ts";
import { store, type AgentRecord } from "./session-store.ts";
import {
  prepareWorktree,
  cleanupWorktree,
  reclaimOrphanWorktrees,
  mainRepoOf,
  useMainTree,
  WORKTREE_SUBDIR,
  type WorktreeResult,
} from "./worktree-manager.ts";
import { supervisor } from "./supervisor.ts";
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";
import type { AgentState, CharacterKind } from "./contract.ts";

/** Plan §3/§8: cap concurrent LIVE sessions to protect the Max rate limit. */
export const MAX_LIVE_SESSIONS = 3;

/** How long a `done` pulse dwells before the manager bounces the agent back to waiting (ms). */
const DONE_DWELL_MS = 2500;

/**
 * How long a voice turn waits for an in-flight (typed) turn to finish before it gives up and refuses,
 * rather than overlapping turns on one session. Buffer line covers this wait on stage.
 */
const BUSY_WAIT_MS = 20_000;

export interface SpawnArgs {
  agentId?: string; // optional; defaults to repoId
  repoId: string;
  repoPath: string;
  characterKind?: CharacterKind;
  label?: string;
  /** Per-session system-prompt override (e.g. the Autonomous Data Operator persona). */
  systemPrompt?: string;
  /** Per-session Aiven MCP URL override (attaches the Aiven MCP for this one session). */
  aivenMcpUrl?: string;
}

export interface SpawnResult {
  ok: boolean;
  agentId: string;
  error?: string;
  /** informational: did the agent get an isolated worktree, or the repo-cwd fallback? */
  worktree?: { isolated: boolean; path: string; note?: string };
}

interface ManagedSession {
  session: AgentSession;
  worktree: WorktreeResult;
  /** The repo ROOT the worktree was cut from (NOT the worktree dir). Needed to clean up on stop — the
   *  record's repo_path is the worktree dir (where diffs run), so it can't double as the cleanup root. */
  repoRoot: string;
  /**
   * The id of the CURRENT Session (one Claude Code run) this agent is on (character-session model). Minted
   * fresh on every spawn and on every newSession(); archived to the character's history when the run ends
   * (newSession replacement / sendAway). character_id == agentId in the current model. See characters.ts.
   */
  sessionId: string;
  /** ISO 8601 the current session started — carried into the archived SessionSummary. */
  sessionStartedAt: string;
}

const KIND_DEFAULT: CharacterKind = "viking";

class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  /** Repo roots we've already run the boot-time orphan-worktree GC against (run once per root). */
  private gcDoneRoots = new Set<string>();
  /**
   * Spawn args remembered per agent so the supervisor can RESPAWN an agent (from its store record) after a
   * crash, with the exact same persona/MCP wiring it had. Cleared on a clean stop().
   */
  private lastSpawnArgs = new Map<string, SpawnArgs>();
  /** Pending done-dwell auto-resolve timer per agent, so a flappy `done` doesn't stack timers. */
  private dwellTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    // Watch records so a `done` pulse auto-resolves back to `waiting` after the demo beat.
    store.onRecord((rec) => this.onRecord(rec));
    // Wire the supervisor's restart hooks. dispose() frees the dead session's slot WITHOUT tearing down its
    // worktree (so a restart re-attaches it); respawn() brings the agent back from its remembered args.
    supervisor.setHooks({
      dispose: (id) => this.disposeDead(id),
      respawn: (id) => this.respawn(id),
    });
  }

  /**
   * Boot-time orphan-worktree GC for a repo root, run AT MOST ONCE per root. Reclaims `.agentcraft-worktrees/<id>`
   * dirs + `agentcraft/<id>` branches left by a prior crash for agents that won't re-attach — keeping only the
   * ids still seeded/live in the store. Triggered lazily on first spawn into a root (since boot is L3-owned and
   * not ours to edit) and also exposed for an explicit boot call. Best-effort; never throws. (gap: orphan GC.)
   */
  async reclaimOrphans(repoRoot: string): Promise<void> {
    const root = path.resolve(repoRoot);
    if (this.gcDoneRoots.has(root)) return;
    this.gcDoneRoots.add(root);
    try {
      // Keep the UNION of every agent the store knows about (seeded + rehydrated) AND every currently-live
      // manager session — so a live voice-spawned agent whose store record was removed can never have its
      // in-use worktree reclaimed out from under a running bypassPermissions child. Only truly orphaned
      // per-agent worktrees/branches are reclaimed.
      const keep = new Set<string>([...store.list().map((r) => r.agent_id), ...this.sessions.keys()]);
      await reclaimOrphanWorktrees(root, keep);
    } catch (e) {
      logger.warn("orphan GC failed (non-fatal)", { root, error: msg(e) });
    }
  }

  /**
   * EXPLICIT boot-time orphan GC, to be called once during the boot sequence AFTER store.whenReady() +
   * seedProjects() (so every seeded/rehydrated record is in the keep-set). Closes the "GC only runs lazily
   * on first spawn" gap: a sidecar that boots, serves /world, and is never spawned into (voice-only / idle
   * demo / a repo merely displayed) would otherwise leave a prior crash's worktrees/branches accumulating
   * inside the REAL repo forever. Iterates the DISTINCT repo roots of all seeded records and GCs each once.
   *
   * Self-contained + boot-only: it reuses reclaimOrphans() (per-root once-guard, never throws). The single
   * call site lives in the L3-owned server boot; this entrypoint is additive so wiring it is one line there.
   */
  async reclaimOrphansAtBoot(): Promise<void> {
    const roots = new Set<string>();
    for (const rec of store.list()) {
      const root = repoRootOf(rec.repo_path);
      if (root) roots.add(root);
    }
    for (const root of roots) {
      await this.reclaimOrphans(root);
    }
  }

  /** Number of currently live sessions (for the concurrency cap + status). */
  get liveCount(): number {
    return this.sessions.size;
  }

  has(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  /**
   * Create + start a session for a character. Enforces the concurrency cap. Idempotent per agentId
   * (re-spawning an existing agent is a no-op success). Never throws — returns {ok:false, error}.
   */
  async spawn(args: SpawnArgs): Promise<SpawnResult> {
    const agentId = args.agentId ?? args.repoId;

    if (this.sessions.has(agentId)) {
      return { ok: true, agentId }; // already live
    }
    if (this.sessions.size >= MAX_LIVE_SESSIONS) {
      return {
        ok: false,
        agentId,
        error: `concurrency cap reached (${MAX_LIVE_SESSIONS} live sessions); character renders idle`,
      };
    }

    // DEFAULT: the FIRST agent on a repo works DIRECTLY on its main working tree / current branch — like a
    // normal Claude Code session, so its edits are visible LIVE in your files (your localhost reloads; you
    // watch it happen). Only a SECOND agent sharing the SAME repo gets an isolated worktree (collision
    // avoidance). repoRoot is the RESOLVED main tree, so two agents on one repo are detected as sharing even
    // through stale/worktree paths.
    const repoRoot = await mainRepoOf(args.repoPath);
    const repoBusy = [...this.sessions.values()].some((m) => m.repoRoot === repoRoot);
    let worktree: WorktreeResult;
    if (repoBusy) {
      // A 2nd+ agent on this repo: GC stale leftovers, then cut an isolated worktree. Refuse if a REAL repo
      // couldn't be isolated — a bypassPermissions agent must never collide inside another agent's live tree.
      await this.reclaimOrphans(args.repoPath);
      worktree = await prepareWorktree(agentId, args.repoPath);
      if (worktree.unsafe) {
        await store.update(agentId, {
          status_line: `couldn't isolate ${path.basename(args.repoPath)} — not editing the live tree`,
        });
        return {
          ok: false,
          agentId,
          error: `refused: could not create an isolated worktree for ${args.repoPath}; not editing the live tree`,
        };
      }
    } else {
      worktree = await useMainTree(args.repoPath);
    }
    const characterKind = args.characterKind ?? KIND_DEFAULT;
    const label = args.label ?? agentId;

    // Persist the record FIRST so /world surfaces the agent immediately, even before its first turn.
    const rec: AgentRecord = {
      agent_id: agentId,
      repo_id: args.repoId,
      repo_path: worktree.path,
      character_kind: characterKind,
      label,
      state: "waiting",
      status_line: worktree.isolated ? "ready (isolated worktree)" : "ready (repo cwd)",
      current_task: null,
      target_base_id: args.repoId,
      last_seen_ms: Date.now(),
      transcript_tail: [],
      created_at: new Date().toISOString(),
    };
    await store.create(rec);

    let session: AgentSession;
    try {
      session = new AgentSession({
        agentId,
        repoId: args.repoId,
        cwd: worktree.path,
        characterKind,
        label,
        systemPrompt: args.systemPrompt,
        aivenMcpUrl: args.aivenMcpUrl,
      });
      session.start();
    } catch (e) {
      await cleanupWorktree(args.repoPath, worktree);
      await store.update(agentId, { state: "waiting", status_line: `spawn failed: ${msg(e)}` });
      return { ok: false, agentId, error: `failed to start session: ${msg(e)}` };
    }

    const sessionId = mintSessionId();
    this.sessions.set(agentId, {
      session,
      worktree,
      repoRoot,
      sessionId,
      sessionStartedAt: new Date().toISOString(),
    });
    // Remember the exact args so the supervisor can respawn this agent after a crash, persona + MCP intact.
    this.lastSpawnArgs.set(agentId, { ...args, agentId });
    // Hand the live session to the supervisor for dead/rate-limit/timeout watching + bounded restart.
    supervisor.watch(agentId, session);
    metrics.setGauge("live_sessions", this.sessions.size);

    return {
      ok: true,
      agentId,
      worktree: {
        isolated: worktree.isolated,
        path: worktree.path,
        note: worktree.error, // non-fatal fallback explanation, if any
      },
    };
  }

  /**
   * Send a prompt to an agent as its next turn. Auto-spawns nothing — the caller (server) decides
   * whether to spawn. Returns false if the agent isn't live, is dead (awaiting supervisor restart), or its
   * rate-limit circuit breaker is OPEN — so a prompt isn't queued onto a corpse or used to hammer a throttle.
   * (Signature unchanged: callers still map a false to their 503/"could not dispatch" path.)
   */
  command(agentId: string, prompt: string): boolean {
    const m = this.sessions.get(agentId);
    if (!m) return false;
    if (m.session.isDead) {
      store.publish({ type: "error", agent_id: agentId, message: "agent is restarting — try again shortly" });
      return false;
    }
    if (m.session.isBreakerOpen) {
      const secs = Math.ceil(m.session.breakerCooldownRemainingMs / 1000);
      store.publish({ type: "error", agent_id: agentId, message: `rate-limited — retry in ${secs}s` });
      metrics.inc("command_refused_breaker_open");
      return false;
    }
    m.session.prompt(prompt);
    return true;
  }

  /** Interrupt an agent's in-flight turn. Returns false if unknown. */
  async interrupt(agentId: string): Promise<boolean> {
    const m = this.sessions.get(agentId);
    if (!m) return false;
    await m.session.interrupt();
    return true;
  }

  /** Live session status snapshot (manager-level; the full AgentView comes from the store). */
  list(): Array<{ agentId: string; busy: boolean; isolated: boolean; cwd: string }> {
    return [...this.sessions.entries()].map(([agentId, m]) => ({
      agentId,
      busy: m.session.isBusy,
      isolated: m.worktree.isolated,
      cwd: m.worktree.path,
    }));
  }

  /** Stop one session and clean up its worktree. A clean stop — no auto-restart (supervisor forgets it). */
  async stop(agentId: string): Promise<void> {
    const m = this.sessions.get(agentId);
    if (!m) return;
    // Tell the supervisor this is intentional BEFORE close() (whose stream-end would otherwise look dead).
    supervisor.forget(agentId);
    this.lastSpawnArgs.delete(agentId);
    this.sessions.delete(agentId);
    metrics.setGauge("live_sessions", this.sessions.size);
    await m.session.close();
    // Use the tracked repo ROOT, not the record's repo_path (which is the worktree dir itself).
    await cleanupWorktree(m.repoRoot, m.worktree);
  }

  /** The id of the live Session this agent is currently on, or null if it has no live session. */
  currentSessionId(agentId: string): string | null {
    return this.sessions.get(agentId)?.sessionId ?? null;
  }

  /** ISO 8601 the agent's current live session started, or null if it has none. */
  currentSessionStartedAt(agentId: string): string | null {
    return this.sessions.get(agentId)?.sessionStartedAt ?? null;
  }

  /**
   * START A FRESH CHAT for a character ("New chat with Ada"). Tears down the current Claude Code run and
   * replaces it with a brand-new one: a NEW session_id, a fresh SDK `query()`, lifecycle -> working. The
   * caller (characters.ts) archives the prior transcript to history BEFORE calling this (it reads the old
   * session_id via currentSessionId). The agent's isolated WORKTREE is intentionally KEPT (close() here does
   * not clean it) so in-progress work isn't thrown away across a new chat — the new run re-attaches it.
   *
   * Returns the new session_id, or null if the agent has no live session AND no store record to spawn from
   * (unknown agent). If the agent is known but not currently live, this spawns a fresh session for it.
   */
  async newSession(agentId: string): Promise<string | null> {
    const m = this.sessions.get(agentId);
    if (m) {
      // Replace the live run in place, keeping the worktree. Tell the supervisor this teardown is
      // intentional (forget) so close()'s stream-end isn't mistaken for a crash that triggers a restart.
      supervisor.forget(agentId);
      this.sessions.delete(agentId);
      metrics.setGauge("live_sessions", this.sessions.size);
      try {
        await m.session.close();
      } catch (e) {
        logger.warn("newSession: closing prior session failed (non-fatal)", { agent_id: agentId, error: msg(e) });
      }
      // Re-create a fresh session on the SAME worktree (re-attach), new id, supervised like a spawn.
      const args = this.lastSpawnArgs.get(agentId);
      const rec = store.get(agentId);
      const characterKind = args?.characterKind ?? rec?.character_kind ?? KIND_DEFAULT;
      const label = args?.label ?? rec?.label ?? agentId;
      let session: AgentSession;
      try {
        session = new AgentSession({
          agentId,
          repoId: args?.repoId ?? rec?.repo_id ?? agentId,
          cwd: m.worktree.path,
          characterKind,
          label,
          systemPrompt: args?.systemPrompt,
          aivenMcpUrl: args?.aivenMcpUrl,
        });
        session.start();
      } catch (e) {
        // Couldn't bring the fresh run up — leave the worktree for a later retry; mark the record idle.
        await store.update(agentId, { state: "waiting", status_line: `new chat failed: ${msg(e)}` });
        return null;
      }
      const sessionId = mintSessionId();
      this.sessions.set(agentId, {
        session,
        worktree: m.worktree,
        repoRoot: m.repoRoot,
        sessionId,
        sessionStartedAt: new Date().toISOString(),
      });
      supervisor.watch(agentId, session);
      metrics.setGauge("live_sessions", this.sessions.size);
      // Clear transcript_tail too: the card re-ingests transcript_tail on every /world poll, so without
      // this the OLD chat re-appears ~1s after start_fresh_chat() clears the card — THE "New chat does
      // nothing" bug. The prior session's transcript is already archived to history before we reach here.
      await store.update(agentId, { state: "waiting", status_line: "new chat", transcript_tail: [] });
      metrics.inc("character_new_session");
      return sessionId;
    }

    // Not live: a "new chat" with a sleeping character is just a fresh spawn from its record.
    const rec = store.get(agentId);
    if (!rec) return null;
    const spawnArgs: SpawnArgs = this.lastSpawnArgs.get(agentId) ?? {
      agentId: rec.agent_id,
      repoId: rec.repo_id,
      repoPath: rec.repo_path,
      characterKind: rec.character_kind,
      label: rec.label,
    };
    const r = await this.spawn(spawnArgs);
    if (!r.ok) return null;
    metrics.inc("character_new_session");
    return this.currentSessionId(agentId);
  }

  /**
   * SEND THE CHARACTER AWAY: end + archive the active Session, the character goes to sleep at home. There is
   * no "kill" (ratified design). This fully STOPS the run and cleans its worktree (a clean shutdown — the
   * supervisor forgets it, no restart), then sets the record idle/asleep. The caller (characters.ts) archives
   * the transcript first (reading the old session_id) and flips lifecycle/active_session_id in its registry.
   * Returns true if there was a live session to send away, false if the character was already asleep.
   */
  async sendAway(agentId: string): Promise<boolean> {
    if (!this.sessions.has(agentId)) return false;
    await this.stop(agentId); // clean shutdown: supervisor.forget + close + cleanupWorktree
    await store.update(agentId, { state: "waiting", status_line: "asleep (sent away)", current_task: null });
    metrics.inc("character_send_away");
    return true;
  }

  /**
   * Supervisor hook: dispose a DEAD session and free its live slot, WITHOUT tearing down its worktree (so a
   * restart re-attaches the same isolated worktree and keeps the agent's in-progress diff). Does not restart.
   * Best-effort; never throws. (gap: "the dead Query is never disposed/removed from the manager's map".)
   */
  private async disposeDead(agentId: string): Promise<void> {
    const m = this.sessions.get(agentId);
    if (!m) return;
    this.sessions.delete(agentId);
    metrics.setGauge("live_sessions", this.sessions.size);
    try {
      await m.session.close();
    } catch (e) {
      logger.warn("disposeDead: close failed (non-fatal)", { agent_id: agentId, error: msg(e) });
    }
    // Worktree is intentionally LEFT in place for the restart to re-attach; it's reclaimed on a clean stop()
    // or by the boot-time orphan GC if the agent never comes back.
  }

  /**
   * Supervisor hook: respawn a crashed agent from its remembered spawn args (persona + MCP intact). Returns
   * whether the new session came up. Re-uses spawn() so the concurrency cap, worktree re-attach, supervision,
   * and record are all handled exactly as a fresh spawn. The slot was already freed by disposeDead().
   */
  private async respawn(agentId: string): Promise<boolean> {
    const args = this.lastSpawnArgs.get(agentId);
    if (!args) {
      logger.warn("respawn: no remembered args; cannot restart", { agent_id: agentId });
      return false;
    }
    const r = await this.spawn(args);
    return r.ok;
  }

  /** Stop every session (process shutdown). */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  /**
   * The async-iterable the OpenAI voice shim consumes (deps.runAgentTurn). Resolves the character by
   * id (== OpenAI `model`), ensures a live session exists (auto-spawning a minimal one for voice if
   * needed), pushes the prompt as a turn, and yields assistant text deltas until the turn completes.
   *
   * The shim relies ONLY on this signature: (characterId, prompt) => AsyncIterable<string>.
   */
  async *runAgentTurn(characterId: string, prompt: string): AsyncIterable<string> {
    let m = this.sessions.get(characterId);

    // Voice may address a character that isn't spawned yet. Try to bring it up from its store record.
    if (!m) {
      const rec = store.get(characterId);
      if (rec) {
        // Ada (the data operator) MUST spawn with her persona + the Aiven MCP attached, regardless of entry
        // point. A bare voice-first spawn (no persona, no MCP) would be sticky — runMission() only attaches
        // the MCP when no session exists yet — silently breaking the headline Aiven #2 beat. Resolve her
        // canonical spawn args from operator.ts so voice-first and mission-first converge on one MCP-attached
        // Ada. Lazy import avoids the session-manager <-> operator import cycle.
        let spawnArgs: SpawnArgs = {
          agentId: rec.agent_id,
          repoId: rec.repo_id,
          repoPath: rec.repo_path,
          characterKind: rec.character_kind,
          label: rec.label,
        };
        try {
          const op = await import("./aiven/operator.ts");
          if (characterId === op.OPERATOR_AGENT_ID) spawnArgs = op.operatorSpawnArgs();
        } catch {
          /* operator module unavailable — fall back to the bare record spawn */
        }
        const spawned = await this.spawn(spawnArgs);
        if (spawned.ok) m = this.sessions.get(characterId);
      }
    }

    if (!m) {
      // Nothing we can stream from — yield a short buffer line so the voice turn never hangs.
      yield "I'm not connected to that repo right now.";
      return;
    }

    const session = m.session;

    // LIFECYCLE GATES (mirror command()): the voice path must refuse exactly what the typed path refuses,
    // or it becomes the one surface that streams a prompt into a corpse / hammers a throttle. A session can
    // also DIE between the auto-spawn above and here, so we check the resolved session, not the spawn result.
    //   - isDead: the SDK Query is a corpse (awaiting supervisor restart) — queuing onto it routes a prompt
    //     into a dead child that will never run it (the exact "route prompts into a corpse" failure).
    //   - isBreakerOpen: the rate-limit breaker is OPEN — a live on-stage voice retry is the most likely to
    //     pound a throttled Max account, defeating the breaker on the worst surface. Refuse with the cooldown.
    // Both yield a short spoken buffer line (never hang the voice turn) and return, leaving the (characterId,
    // prompt)=>AsyncIterable<string> shape the shim depends on unchanged.
    if (session.isDead) {
      yield "I'm restarting — ask me again in a moment.";
      return;
    }
    if (session.isBreakerOpen) {
      const secs = Math.ceil(session.breakerCooldownRemainingMs / 1000);
      metrics.inc("command_refused_breaker_open");
      yield `I'm rate-limited right now — try again in ${secs}s.`;
      return;
    }

    // TURN-ISOLATION GATE: if the character is already mid-turn (e.g. a typed prompt from the
    // InteractionPanel is in flight), do NOT kick the voice prompt yet — otherwise the voice turn
    // would tap the PRIOR turn's deltas and resolve on the PRIOR turn's result (speaking the wrong
    // content and ending early). Cover the think-time with a buffer line, then wait for idle. If the
    // prior turn won't finish in time, refuse cleanly rather than overlap.
    if (session.isBusy) {
      yield "One sec, let me finish what I'm on.";
      const becameIdle = await this.waitForIdle(session, BUSY_WAIT_MS);
      if (!becameIdle) {
        yield "Still wrapping that up — ask me again in a moment.";
        return;
      }
    }

    // Bridge THIS turn's per-turn delta sink to an async queue we can iterate. Deltas and the terminal
    // end are scoped to the exact turn id we kick below, so nothing from another turn can leak in.
    const chunks: string[] = [];
    let waiter: (() => void) | null = null;
    let parkTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    // Wake the parked loop and clear the park timer so we never leak a timer per iteration.
    const wake = () => {
      if (parkTimer) {
        clearTimeout(parkTimer);
        parkTimer = null;
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    };

    // Kick the turn FIRST so we have its id, then scope the taps to it.
    const turnId = session.prompt(prompt);

    const offDelta = session.onDelta(turnId, (text) => {
      chunks.push(text);
      wake();
    });

    // Resolve only when THIS turn ends (its own result/error) — never a sibling turn's terminal event.
    const offEnd = session.onTurnEnd(turnId, () => {
      done = true;
      wake();
    });

    // Safety timeout so a stalled/long turn can't wedge a live voice turn on stage. NOTE: this only bounds
    // how long the VOICE waits — it deliberately does NOT interrupt the underlying turn. A legitimate agent
    // turn (multi-tool edits) can run minutes (TURN_TIMEOUT_MS); interrupting here would destroy that real
    // in-progress work just because voice gave up. The per-turn watchdog remains the authority over the turn
    // itself; here we just stop waiting and tell the user it's continuing in the background.
    const HARD_TIMEOUT_MS = 90_000;
    const startedAt = Date.now();
    let timedOut = false;

    try {
      let emittedAny = false;
      while (true) {
        if (chunks.length === 0 && !done) {
          if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
            timedOut = true;
            break;
          }
          // Park until a delta/end wakes us; the park timer bounds the wait so the loop re-checks the
          // hard timeout. wake() clears the timer, so no timer leaks across iterations.
          await new Promise<void>((resolve) => {
            waiter = resolve;
            parkTimer = setTimeout(() => {
              parkTimer = null;
              waiter = null;
              resolve();
            }, 1000);
          });
        }
        while (chunks.length) {
          const c = chunks.shift()!;
          if (c) {
            emittedAny = true;
            yield c;
          }
        }
        if (done) break;
      }
      if (timedOut) {
        // Voice gave up waiting but the turn is STILL RUNNING (not interrupted). Say so plainly rather than
        // leaving dead air or implying it finished; the turn keeps going and its watchdog still governs it.
        yield emittedAny
          ? " — still working on the rest; I'll keep at it in the background."
          : "This one's taking a while — I'll keep working on it in the background.";
      } else if (!emittedAny) {
        // Turn produced no assistant text (pure tool work / error) — give the voice something to say.
        yield "On it.";
      }
    } finally {
      offDelta();
      offEnd();
    }
  }

  /** Resolve true once `session` is idle (no turn in flight), or false if `timeoutMs` elapses first. */
  private async waitForIdle(session: AgentSession, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (session.isBusy) {
      if (Date.now() - startedAt > timeoutMs) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    return true;
  }

  // ---- internal ----

  /**
   * Bounce a `done` pulse back to `waiting` after the demo dwell, so the cheer animation resolves. The timer
   * is unref()'d (consistent with every other timer in this lane) so a `done` landing right before shutdown
   * can't hold the event loop open, and it's deduped per agent so a flappy agent can't stack timers.
   */
  private onRecord(rec: AgentRecord): void {
    if (rec.state !== "done") return;
    const id = rec.agent_id;
    const prior = this.dwellTimers.get(id);
    if (prior) clearTimeout(prior);
    const t = setTimeout(() => {
      this.dwellTimers.delete(id);
      const cur = store.get(id);
      if (cur && cur.state === "done" && this.sessions.has(id) && !this.sessions.get(id)!.session.isBusy) {
        void store.update(id, { state: "waiting", status_line: "idle" });
      }
    }, DONE_DWELL_MS);
    if (typeof t.unref === "function") t.unref();
    this.dwellTimers.set(id, t);
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Mint a fresh, unique Session id (one Claude Code run). Stable, opaque, safe for a JSON id. */
function mintSessionId(): string {
  return "s_" + randomUUID().slice(0, 12);
}

/**
 * Recover the repo ROOT from a record's `repo_path`. A seeded record's repo_path IS the root; a record that
 * was previously spawned (rehydrated after a crash) has repo_path == `<root>/.agentcraft-worktrees/<id>`, so
 * we strip that suffix back to the root. Returns the resolved root, or "" for an empty/garbage path.
 */
function repoRootOf(repoPath: string): string {
  if (!repoPath) return "";
  const resolved = path.resolve(repoPath);
  const marker = `${path.sep}${WORKTREE_SUBDIR}${path.sep}`;
  const at = resolved.indexOf(marker);
  return at >= 0 ? resolved.slice(0, at) : resolved;
}

/** The single process-wide session manager. */
export const sessionManager = new SessionManager();
export type { ManagedSession };
