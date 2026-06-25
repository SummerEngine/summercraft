/**
 * AgentCraft — process registry (Lane A: make "spin up localhost" REAL via process supervision).
 *
 * THE PROBLEM (exec audit gaps 1-2): an agent can run `npm run dev` inside its turn, but the sidecar has
 * NO handle on that child. When the turn ends the dev server is orphaned — its port is never tracked, and
 * nothing kills it on session teardown, so every "spin up the app" leaves a zombie listening on a port for
 * the life of the host. There was also no structured signal that a server came up, so D's localhost chip and
 * C's voice announce had only the best-effort URL-in-the-answer regex (emitServiceFromText) to go on.
 *
 * THE FIX (this module): a per-agent registry of child processes that should OUTLIVE the turn. An agent
 * EXPLICITLY registers a server it started (via POST /agents/:id/service -> registerService, see
 * http/routes-agents.ts) with its pid+port+url. We:
 *   1) record it keyed by agent_id ({ pid, port, url, started_at });
 *   2) emit the EXISTING `service` ServerEvent on register (url+port) so D's chip + C's voice light up;
 *   3) on session close()/sendAway()/stop()/new-session, SIGTERM every tracked pid so servers don't zombie.
 *
 * Why EXPLICIT registration and not blind Bash-child interception: the SDK runs the agent's Bash tool in a
 * shell the sidecar does not own, and `npm run dev` spawns a tree (npm -> node -> vite/next ...). Tracking
 * "every Bash child" would be fragile and capture transient `git`/`ls` children we'd then wrongly kill.
 * Registering the ACTUAL server the agent brought up (it knows its own pid via `$!` / its URL from the dev
 * server banner) is the reliable seam. AUTOMATIC detection of an UN-registered server is explicitly the
 * DEFERRED part of this lane (see Lane A item 1) — the agent must call the register hook (or print the URL,
 * which agent-session's emitServiceFromText still surfaces as a `service` event, just without a killable pid).
 *
 * This module owns ONLY the registry + the kill. It never spawns anything itself and never touches billing
 * safety. The store-publish dependency is injected (setEmitter) so this stays free of an import cycle with
 * session-store / agent-session.
 */
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";

/** One tracked server an agent started that should outlive the turn. */
export interface ServiceProcess {
  /** OS pid of the server process, when the agent knew it (registered via `$!`). 0 = unknown (no kill). */
  pid: number;
  /** TCP port the server listens on (derived from the URL when not given). 0 = unknown. */
  port: number;
  /** The navigable localhost URL (0.0.0.0 normalized to localhost by the caller). */
  url: string;
  /** ISO 8601 the server was registered. */
  started_at: string;
}

/**
 * The `service` ServerEvent emit seam, injected by the bootstrap (server.ts) / wired to store.publish.
 * Kept as an injected function so this module doesn't import session-store (which imports the contract,
 * which the agent-session that drives this also imports) — avoids a cycle and keeps the registry pure.
 */
type ServiceEmitter = (agentId: string, svc: { url: string; port: number }) => void;

class ProcessRegistry {
  /** agent_id -> the servers that agent has registered (most-recent last). */
  private byAgent = new Map<string, ServiceProcess[]>();
  private emit: ServiceEmitter | null = null;

  /** Wire the `service` ServerEvent emitter once at boot. Idempotent (last wins). */
  setEmitter(emit: ServiceEmitter): void {
    this.emit = emit;
  }

  /**
   * Register a server an agent brought up. Records it under the agent and emits the `service` ServerEvent
   * (url+port) so D's localhost chip + C's voice announce fire reliably — NOT only when the agent happens
   * to print the URL into its final answer. De-dupes on (pid,port,url) so a double POST doesn't stack. A
   * pid of 0 (unknown) is allowed — we still track + surface it; it just can't be killed on teardown.
   * Never throws (a bad emitter listener can't break the caller).
   */
  register(agentId: string, svc: { pid?: number; port?: number; url: string }): ServiceProcess {
    const entry: ServiceProcess = {
      pid: Number.isFinite(svc.pid) && (svc.pid as number) > 0 ? Math.floor(svc.pid as number) : 0,
      port: Number.isFinite(svc.port) && (svc.port as number) > 0 ? Math.floor(svc.port as number) : 0,
      url: svc.url,
      started_at: new Date().toISOString(),
    };
    const list = this.byAgent.get(agentId) ?? [];
    // De-dupe: an agent (or a retried POST) re-registering the same server shouldn't stack rows.
    const dup = list.find((p) => p.url === entry.url && p.port === entry.port && p.pid === entry.pid);
    if (!dup) {
      list.push(entry);
      this.byAgent.set(agentId, list);
      metrics.inc("service_registered");
      logger.info("registered agent service", { agent_id: agentId, port: entry.port, pid: entry.pid });
    }
    // Emit the service event regardless (a re-register still re-lights D's chip / re-announces).
    try {
      this.emit?.(agentId, { url: entry.url, port: entry.port });
    } catch {
      /* a faulty emitter listener must never break registration */
    }
    return entry;
  }

  /** All servers currently tracked for an agent (empty array if none). */
  getForAgent(agentId: string): ServiceProcess[] {
    return [...(this.byAgent.get(agentId) ?? [])];
  }

  /** Total tracked servers across all agents (for /metrics + tests). */
  get size(): number {
    let n = 0;
    for (const list of this.byAgent.values()) n += list.length;
    return n;
  }

  /**
   * Kill every tracked child process for an agent (SIGTERM) and drop its registry entries. Called from
   * AgentSession.close() — which is the single teardown path for stop()/sendAway()/new-session/dispose —
   * so a dev server an agent started is reaped instead of zombied. Best-effort + never throws:
   *   - pid 0 (unknown) is skipped (nothing to kill);
   *   - an already-dead pid (ESRCH) is ignored;
   *   - we SIGTERM (graceful) so the dev server can close its socket; we do NOT SIGKILL (a wedged child is
   *     a rare edge and SIGKILL risks orphaning ITS children — SIGTERM is the right default for `npm run dev`).
   * Returns the number of pids we signalled (for tests/observability).
   */
  killForAgent(agentId: string): number {
    const list = this.byAgent.get(agentId);
    if (!list || list.length === 0) return 0;
    let killed = 0;
    for (const p of list) {
      if (p.pid <= 0) continue;
      try {
        process.kill(p.pid, "SIGTERM");
        killed += 1;
        metrics.inc("service_killed");
        logger.info("killed agent service on teardown", { agent_id: agentId, pid: p.pid, port: p.port });
      } catch (e) {
        // ESRCH = already gone (the agent's server exited on its own) — that's fine, not an error.
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== "ESRCH") {
          logger.warn("failed to SIGTERM agent service (non-fatal)", { agent_id: agentId, pid: p.pid, error: msg(e) });
        }
      }
    }
    this.byAgent.delete(agentId);
    return killed;
  }

  /** Drop an agent's tracked services WITHOUT killing them (e.g. the agent reported they exited). */
  forget(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  /** SIGTERM every tracked service across all agents (process shutdown). Best-effort. */
  killAll(): number {
    let killed = 0;
    for (const agentId of [...this.byAgent.keys()]) killed += this.killForAgent(agentId);
    return killed;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The single process-wide registry. AgentSession kills on close; the HTTP route registers. */
export const processRegistry = new ProcessRegistry();
export type { ProcessRegistry };
