/**
 * Aiven world projection — the read-projection behind GET /world (Track D, plan §7 Phase 3).
 *
 * Builds a WorldSnapshot by SELECT-ing the Aiven Postgres `world_state` schema
 * (agents / file_locks / coord_events):
 *   - heartbeat_age_s is computed from agents.last_seen; an agent is stale when > 15s
 *   - abandoned-lock TTL self-heal: a lock whose holder has gone stale is DELETED so a
 *     crashed agent on stage can't wedge the contention demo (the file frees, the loser proceeds)
 *   - the Postgres file_locks row is the AUTHORITATIVE lock (the UNIQUE index = read-before-write);
 *     Kafka (topic agent.coordination) is only the reaction signal, never the source of truth
 *
 * If no pg connection is supplied (nothing provisioned yet, or a live hiccup on stage) this falls
 * back to MOCK_SNAPSHOT so /world still imports, runs, and animates the world.
 *
 * The Godot game NEVER holds Aiven credentials — it reads THIS projection via the sidecar only.
 * KEEP the exported signature `worldProjection(deps): Promise<WorldSnapshot>` — every track imports it.
 */
import {
  MOCK_SNAPSHOT,
  type WorldSnapshot,
  type AgentView,
  type LockView,
  type CoordEvent,
  type AgentState,
  type CharacterKind,
} from "../contract.ts";
import { startCoordinationConsumer } from "./kafka.ts";
import { startHeartbeat } from "./pg.ts";
import { reconcileOperatorAuditOnBoot } from "./operator.ts";
import { sessionManager } from "../session-manager.ts";

/** Heartbeat older than this (seconds) = the agent is stale / presumed crashed. */
export const STALE_AFTER_S = 15;
/**
 * Minimum on-screen blocked dwell after a lost lock claim (seconds). The projection PINS an
 * agent's state to 'blocked' for this long after its `denied_at`, regardless of how fast the
 * underlying LLM re-routes. This makes the Aiven contention beat (D6) camera-legible without
 * trusting the agent to voluntarily sleep — the loser is visibly held idle while the winner
 * swings, then released back to whatever live state it has moved on to. 2.5s sits inside the
 * plan's "deliberate ~2-3s blocked dwell" window (§7 Phase 3, §8 risk #6).
 */
export const DWELL_S = 2.5;
/** How many recent coord_events to surface in the snapshot. */
export const EVENT_TAIL = 25;

/** Minimal structural type of a `pg` Pool/Client — avoids a hard dep on @types/pg here. */
interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface AivenProjectionDeps {
  /** Track D: a pg Pool/Client. Left optional so the projection runs with nothing provisioned. */
  pg?: PgLike | unknown;
}

const VALID_STATES: AgentState[] = ["waiting", "moving", "working", "blocked", "done"];
const VALID_KINDS: CharacterKind[] = ["viking", "wizard", "dwarf", "barbarian"];

function isPgLike(x: unknown): x is PgLike {
  return !!x && typeof (x as any).query === "function";
}

function asState(s: unknown): AgentState {
  return VALID_STATES.includes(s as AgentState) ? (s as AgentState) : "waiting";
}

function asKind(k: unknown): CharacterKind {
  return VALID_KINDS.includes(k as CharacterKind) ? (k as CharacterKind) : "viking";
}

function isoOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v) return v;
  return new Date().toISOString();
}

/**
 * Self-heal abandoned locks: release any lock whose holder is stale (last_seen older than
 * STALE_AFTER_S). Keyed PURELY on holder staleness — a holder >15s without a heartbeat is already
 * presumed crashed regardless of when it claimed, and a *live* holder keeps last_seen fresh via the
 * 5s heartbeat so it is never stale. (An extra claimed_at age gate would only delay recovery — up to
 * ~20s of on-stage wedge if an agent crashes right after claiming — without adding any safety.)
 * Runs as a single DELETE … USING join so it's one round-trip. Emits a `released` coord_event per
 * healed lock so the world (and the camera) sees the file free up. Done BEFORE the SELECTs so the
 * returned snapshot already reflects the healed state.
 */
async function selfHealAbandonedLocks(pg: PgLike): Promise<void> {
  await pg.query(
    `WITH healed AS (
       DELETE FROM world_state.file_locks fl
       USING world_state.agents a
       WHERE fl.holder_agent_id = a.agent_id
         AND EXTRACT(EPOCH FROM (now() - a.last_seen)) > $1
       RETURNING fl.holder_agent_id, fl.file_path
     )
     INSERT INTO world_state.coord_events (type, agent_id, detail)
     SELECT 'released', holder_agent_id, file_path || ' (abandoned-lock self-heal: holder stale)'
     FROM healed`,
    [STALE_AFTER_S],
  );
}

async function selectAgents(pg: PgLike): Promise<AgentView[]> {
  // heartbeat_age_s computed server-side from last_seen so projection + DB agree on "now".
  const { rows } = await pg.query(
    `SELECT
       a.agent_id, a.repo_id, a.repo_path, a.character_kind, a.state, a.label,
       a.status_line, a.current_task, a.target_base_id,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - a.last_seen)))::float8 AS heartbeat_age_s,
       CASE WHEN a.denied_at IS NULL THEN NULL
            ELSE EXTRACT(EPOCH FROM (now() - a.denied_at))::float8 END AS denied_age_s
     FROM world_state.agents a
     ORDER BY a.registered_at ASC`,
  );
  return rows.map((r): AgentView => {
    const age = Number(r.heartbeat_age_s) || 0;
    const stale = age > STALE_AFTER_S;
    // denied_age_s is NULL when the agent never lost / has since won a lock.
    const deniedAge = r.denied_age_s == null ? null : Number(r.denied_age_s);
    const dwelling = deniedAge != null && deniedAge >= 0 && deniedAge < DWELL_S;
    let state = asState(r.state);
    // A stale (crashed) agent must not keep "working" on stage — present it as blocked/greyed.
    if (stale && state !== "done") state = "blocked";
    // Lost-claim dwell: hold the loser visibly blocked for DWELL_S so the camera always catches
    // the back-off, even if the LLM already re-routed to 'working'/'moving'. Stale wins over this
    // (a crashed agent stays blocked anyway); 'done' is terminal and never overridden.
    if (dwelling && state !== "done") state = "blocked";
    const statusLine = stale
      ? `stale ${Math.round(age)}s — ${r.status_line ?? ""}`.trim()
      : dwelling && state === "blocked" && !String(r.status_line ?? "").toLowerCase().includes("block")
        ? `blocked on lock — ${r.status_line ?? ""}`.trim()
        : String(r.status_line ?? "");
    return {
      agent_id: String(r.agent_id),
      repo_id: String(r.repo_id),
      repo_path: String(r.repo_path),
      character_kind: asKind(r.character_kind),
      state,
      label: String(r.label ?? ""),
      status_line: statusLine,
      current_task: r.current_task != null ? String(r.current_task) : null,
      target_base_id: r.target_base_id != null ? String(r.target_base_id) : null,
      heartbeat_age_s: Math.round(age),
      // INTENTIONALLY EMPTY in Track D's slice: the transcript is NOT Aiven coordination state —
      // it lives in Track A's session-store (session-store.ts buildView). world_state.agents has no
      // transcript column, so this is always []. The sidecar (server.ts) MUST overlay each agent's
      // transcript_tail from the session-store record (keyed by agent_id) after calling
      // worldProjection() rather than serving these agents verbatim. Not a bug — a merge seam.
      transcript_tail: Array.isArray(r.transcript_tail) ? r.transcript_tail.map(String) : [],
    };
  });
}

async function selectLocks(pg: PgLike): Promise<LockView[]> {
  const { rows } = await pg.query(
    `SELECT repo_path, file_path, holder_agent_id, claimed_at
       FROM world_state.file_locks
      ORDER BY claimed_at ASC`,
  );
  return rows.map((r): LockView => ({
    repo_path: String(r.repo_path),
    file_path: String(r.file_path),
    holder_agent_id: String(r.holder_agent_id),
    claimed_at: isoOf(r.claimed_at),
  }));
}

async function selectEvents(pg: PgLike): Promise<CoordEvent[]> {
  const { rows } = await pg.query(
    `SELECT ts, type, agent_id, detail
       FROM world_state.coord_events
      ORDER BY ts DESC, id DESC
      LIMIT $1`,
    [EVENT_TAIL],
  );
  // Reverse to chronological order for the ticker (oldest → newest).
  return rows
    .map((r): CoordEvent => ({
      ts: isoOf(r.ts),
      type: String(r.type),
      agent_id: String(r.agent_id),
      detail: String(r.detail ?? ""),
    }))
    .reverse();
}

export async function worldProjection(deps: AivenProjectionDeps = {}): Promise<WorldSnapshot> {
  const pg = deps.pg;
  // Lazily light up the Kafka coordination consumer the first time /world is read with Aiven live. This
  // is idempotent + detached (no-op when already running or AIVEN_KAFKA_BROKERS is unset), so it never
  // affects this projection's timing or result, and the bootstrap needs no extra wiring in its lane. Once
  // running it folds agent.coordination beats into coord_events, which selectEvents() below then reads.
  startCoordinationConsumer();
  // No live Aiven? Fall back to the mock so /world always answers and the world keeps animating.
  if (!isPgLike(pg)) {
    return MOCK_SNAPSHOT;
  }
  // Aiven is live: lazily start the last_seen heartbeat (idempotent) so the agents whose in-process session
  // is LIVE never trip the stale/self-heal gate below between beats. The provider scopes the bump to live
  // sessions only — a crashed/wedged session's row (and any external agent's row) is deliberately left to go
  // stale so selfHealAbandonedLocks reaps its abandoned lock (charter §0). Mirrors the Kafka consumer's lazy
  // start — no extra bootstrap wiring in the L2 lane, and registerAgent()'s one-shot boot bump is no longer
  // the only writer of last_seen.
  startHeartbeat(() => sessionManager.list().map((s) => s.agentId));
  // One-shot, detached boot reconcile of the operator audit trail: flip any row left `dispatched`/`dry_run`
  // by a prior sidecar that died mid-run to `failed` (the in-memory capture timer died with that process).
  // Once-guarded + best-effort inside operator.ts; detached here so it never affects this projection's timing.
  void reconcileOperatorAuditOnBoot();
  try {
    // Heal first so the snapshot below already reflects freed-up abandoned locks.
    await selfHealAbandonedLocks(pg);
    const [agents, locks, events] = await Promise.all([
      selectAgents(pg),
      selectLocks(pg),
      selectEvents(pg),
    ]);
    // characters[] is a LOCAL projection (built from this host's records in routes-world.buildWorld), not the
    // Aiven snapshot — the DB carries Sessions/agents, not the persistent-NPC layer. Default [] here so the
    // frozen WorldSnapshot shape is satisfied; buildWorld overlays the real characters on top.
    return { agents, locks, events, characters: [] };
  } catch (err) {
    // Live hiccup on stage — never freeze the world. Log and serve the mock snapshot.
    console.error("[aiven/projection] read failed, serving MOCK_SNAPSHOT:", err);
    return MOCK_SNAPSHOT;
  }
}
