/**
 * AgentCraft — session store + in-proc event bus (Track A, plan §7 Phase 1).
 *
 * Two responsibilities:
 *   1) Persist each session as a JSON record (runtime/sessions/<agent_id>.json) plus an append-only
 *      JSONL transcript (runtime/sessions/<agent_id>.jsonl) so a session survives a sidecar restart
 *      and the transcript can be replayed.
 *   2) Be the single in-proc event bus. agent-session.ts publishes ServerEvents here; server.ts (WS)
 *      subscribes and fans them out to connected clients. Nothing in this track talks to WS directly —
 *      everything broadcasts through this bus, so the projection/store/socket stay decoupled.
 *
 * This file owns the on-disk shape of an AgentRecord. The /world + /agents read endpoints build their
 * AgentView responses from these records merged with the Aiven projection.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger.ts";
import type {
  AgentState,
  AgentView,
  CharacterKind,
  ServerEvent,
} from "./contract.ts";

/** Where runtime artifacts live (token, session JSON + JSONL). Resolved from the sidecar cwd. */
export const RUNTIME_DIR = path.resolve(process.cwd(), "runtime");
const SESSIONS_DIR = path.join(RUNTIME_DIR, "sessions");

/** How many transcript lines we keep hot in memory / surface in transcript_tail. */
const TRANSCRIPT_TAIL_LEN = 8;

/**
 * Hard cap on a single agent's transcript JSONL (bytes). appendTranscript() grows the file unbounded,
 * so a long-lived/looping agent could fill the disk. When the file crosses this, we compact it to the
 * most-recent tail (keeping the JSONL replayable) rather than truncating mid-line. Generous so an
 * ordinary demo never compacts. (gap: "no transcript JSONL size cap/compaction".)
 */
const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
/** When compacting, keep at most this many trailing lines (cheap to re-read, plenty of history). */
const TRANSCRIPT_KEEP_LINES = 2000;

/** The persisted, authoritative-on-this-host record for one agent character. */
export interface AgentRecord {
  agent_id: string;
  repo_id: string;
  repo_path: string; // worktree (or repo cwd fallback) the session runs in
  character_kind: CharacterKind;
  label: string;
  state: AgentState;
  status_line: string;
  current_task: string | null;
  target_base_id: string | null;
  /** Hierarchy parent links (DATA_MODEL.md). Set at seed time; surfaced on AgentView for B/D. */
  project_id?: string;
  group_id?: string | null;
  /** epoch ms of the last status/heartbeat update — drives heartbeat_age_s. */
  last_seen_ms: number;
  /** in-memory ring of the most recent transcript lines (full history is in the JSONL). */
  transcript_tail: string[];
  created_at: string; // ISO 8601
}

/** One transcript line as written to the JSONL (full, unbounded history). */
export interface TranscriptEntry {
  ts: string; // ISO 8601
  role: "user" | "agent" | "tool" | "system";
  text: string;
}

type StoreEvents = {
  /** a ServerEvent ready to be broadcast to WS clients */
  event: (e: ServerEvent) => void;
  /** a record changed (created/updated/removed) — used for liveness/debug */
  record: (rec: AgentRecord) => void;
};

/**
 * In-proc store + bus. Single instance per process (exported as `store`).
 * EventEmitter is the bus; the Maps are the hot cache; disk is the durable mirror.
 */
class SessionStore extends EventEmitter {
  private records = new Map<string, AgentRecord>();
  private ready: Promise<void>;

  constructor() {
    super();
    this.setMaxListeners(64); // many WS clients may subscribe
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    // Best-effort rehydrate any prior session records so a restart keeps the world populated.
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(SESSIONS_DIR, f);
        try {
          const raw = await fs.readFile(full, "utf8");
          const rec = JSON.parse(raw) as AgentRecord;
          if (rec?.agent_id) {
            const changed = this.reconcileOnBoot(rec);
            this.records.set(rec.agent_id, rec);
            // If reconciliation rewrote a stale `working`/`moving` to `waiting`, persist the correction NOW
            // so the DURABLE record converges with reality. Otherwise the disk keeps the stale state until
            // the next update() — an external JSON reader (or a future Aiven boot-reconcile) would see a
            // phantom "working" agent, and a crash before any update() would re-reconcile from stale every
            // boot. Boot-time one-shot write; best-effort (persist() swallows disk errors). (gap fix.)
            if (changed) await this.persist(rec);
          }
        } catch {
          // A truncated/corrupt record (e.g. a crash mid-write before atomic writes landed) must not
          // crash boot. Drop the unreadable file so it can't keep poisoning every restart, and move on.
          await fs.rm(full, { force: true }).catch(() => {});
          logger.warn("dropped unreadable session record on boot", { file: f });
        }
      }
    } catch {
      /* fresh runtime dir */
    }
  }

  /**
   * Boot reconciliation: a record persists the LAST written state before a crash. After a restart there
   * is NO live AgentSession yet (the manager lazy-spawns on first prompt), so any non-idle record
   * (`moving`/`working`/`blocked`/`done`) is describing an agent that is actually dead — /world would show
   * a "working" agent that can never take a turn. Reset such records to a clean `waiting`/`idle` so the
   * world reflects reality. `waiting` records pass through untouched. Mutates `rec` in place and returns
   * whether it changed anything, so init() can persist the correction to disk (durable convergence) instead
   * of only fixing the in-memory view. Never throws. (gap: "rehydrate-on-restart is presence-only".)
   */
  private reconcileOnBoot(rec: AgentRecord): boolean {
    if (rec.state !== "waiting") {
      logger.info("reconciled stale agent record on boot", {
        agent_id: rec.agent_id,
        from: rec.state,
      });
      rec.state = "waiting";
      rec.status_line = "idle (recovered after restart)";
      rec.current_task = null;
      return true;
    }
    return false;
  }

  /** Await this before the first read if you need rehydration to be complete. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  // ---- typed bus helpers (so callers don't stringly-type event names) ----
  onEvent(fn: StoreEvents["event"]): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
  onRecord(fn: StoreEvents["record"]): () => void {
    this.on("record", fn);
    return () => this.off("record", fn);
  }

  /** Broadcast a ServerEvent on the bus. agent-session normalizes SDK output into these. */
  publish(e: ServerEvent): void {
    this.emit("event", e);
  }

  // ---- record lifecycle ----

  has(agentId: string): boolean {
    return this.records.has(agentId);
  }

  get(agentId: string): AgentRecord | undefined {
    return this.records.get(agentId);
  }

  list(): AgentRecord[] {
    return [...this.records.values()];
  }

  /** Create (or replace) a record and persist it. */
  async create(rec: AgentRecord): Promise<AgentRecord> {
    this.records.set(rec.agent_id, rec);
    await this.persist(rec);
    this.emit("record", rec);
    return rec;
  }

  /**
   * Patch fields on a record, bump last_seen, persist, and broadcast a `status` ServerEvent when
   * state/status_line changed. Returns undefined if the agent is unknown.
   */
  async update(
    agentId: string,
    patch: Partial<Omit<AgentRecord, "agent_id">>,
  ): Promise<AgentRecord | undefined> {
    const rec = this.records.get(agentId);
    if (!rec) return undefined;
    const stateChanged =
      (patch.state !== undefined && patch.state !== rec.state) ||
      (patch.status_line !== undefined && patch.status_line !== rec.status_line);
    Object.assign(rec, patch);
    rec.last_seen_ms = Date.now();
    await this.persist(rec);
    this.emit("record", rec);
    if (stateChanged) {
      this.publish({
        type: "status",
        agent_id: rec.agent_id,
        state: rec.state,
        status_line: rec.status_line,
      });
    }
    return rec;
  }

  /** Bump heartbeat only (no state change, no status broadcast). */
  async heartbeat(agentId: string): Promise<void> {
    const rec = this.records.get(agentId);
    if (!rec) return;
    rec.last_seen_ms = Date.now();
    await this.persist(rec);
  }

  /** Append a transcript line: ring-buffer in memory + durable JSONL on disk. */
  async appendTranscript(
    agentId: string,
    entry: TranscriptEntry,
  ): Promise<void> {
    const rec = this.records.get(agentId);
    if (!rec) return;
    rec.transcript_tail.push(`${entry.role}: ${entry.text}`);
    if (rec.transcript_tail.length > TRANSCRIPT_TAIL_LEN) {
      rec.transcript_tail.splice(0, rec.transcript_tail.length - TRANSCRIPT_TAIL_LEN);
    }
    rec.last_seen_ms = Date.now();
    await Promise.all([
      this.persist(rec),
      fs
        .appendFile(this.jsonlPath(agentId), JSON.stringify(entry) + "\n", "utf8")
        // A transcript-append failure must never crash a live turn — the in-memory tail still holds it.
        .catch(() => {}),
    ]);
    // Opportunistically cap the JSONL so a long-running/looping agent can't fill the disk. Fire-and-forget
    // so the hot path doesn't pay the stat/read cost synchronously; it self-throttles (only acts past cap).
    void this.compactTranscriptIfNeeded(agentId);
    this.emit("record", rec);
  }

  /** Remove a session (record + files). */
  async remove(agentId: string): Promise<void> {
    this.records.delete(agentId);
    await Promise.allSettled([
      fs.rm(this.jsonPath(agentId), { force: true }),
      fs.rm(this.jsonlPath(agentId), { force: true }),
    ]);
  }

  /**
   * Project a record into the frozen AgentView shape. heartbeat_age_s is computed here so /world and
   * /agents stay consistent; the Aiven projection (Track D) may overlay lock-derived state on top.
   */
  toView(rec: AgentRecord): AgentView {
    return {
      agent_id: rec.agent_id,
      repo_id: rec.repo_id,
      repo_path: rec.repo_path,
      character_kind: rec.character_kind,
      state: rec.state,
      label: rec.label,
      status_line: rec.status_line,
      current_task: rec.current_task,
      target_base_id: rec.target_base_id,
      heartbeat_age_s: Math.max(0, Math.round((Date.now() - rec.last_seen_ms) / 1000)),
      transcript_tail: [...rec.transcript_tail],
      project_id: rec.project_id,
      group_id: rec.group_id,
      // Character-session model: each known agent IS a character, so the Session's character_id == its
      // agent_id. Explicit so B/D can join a live Session (AgentView) back to its Character in /world's
      // `characters[]` without assuming that identity. Additive — mirrors project_id/group_id above.
      character_id: rec.agent_id,
    };
  }

  // ---- disk paths + writers ----
  private jsonPath(agentId: string): string {
    return path.join(SESSIONS_DIR, `${safe(agentId)}.json`);
  }
  private jsonlPath(agentId: string): string {
    return path.join(SESSIONS_DIR, `${safe(agentId)}.jsonl`);
  }

  /**
   * Persist a record ATOMICALLY: write to a unique temp file in the same dir, then rename over the target.
   * rename(2) is atomic on the same filesystem, so a crash mid-write leaves either the old complete file
   * or the new complete file — never a truncated JSON that init()'s JSON.parse would silently drop. The
   * temp file is best-effort cleaned up on a write error so we never leak `.tmp-*` litter.
   * (gap: "Persisted writes are non-atomic (corruptible records)".)
   */
  private async persist(rec: AgentRecord): Promise<void> {
    const target = this.jsonPath(rec.agent_id);
    const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(rec, null, 2), "utf8");
      await fs.rename(tmp, target);
    } catch {
      // disk hiccup must never crash a live turn; the in-memory record is still authoritative.
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /**
   * Compact an agent's transcript JSONL when it grows past TRANSCRIPT_MAX_BYTES: keep the most-recent
   * TRANSCRIPT_KEEP_LINES lines and atomically rename them over the file. Best-effort and never throws;
   * if anything goes wrong we leave the file as-is (worst case it keeps growing, which is non-fatal).
   */
  private async compactTranscriptIfNeeded(agentId: string): Promise<void> {
    const file = this.jsonlPath(agentId);
    try {
      const st = await fs.stat(file);
      if (st.size <= TRANSCRIPT_MAX_BYTES) return;
      const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
      const kept = lines.slice(-TRANSCRIPT_KEEP_LINES);
      const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
      await fs.writeFile(tmp, kept.join("\n") + "\n", "utf8");
      await fs.rename(tmp, file);
      logger.info("compacted transcript", { agent_id: agentId, kept: kept.length });
    } catch {
      /* leave the transcript as-is on any error — compaction is opportunistic */
    }
  }
}

/** Keep agent ids filesystem-safe (they may come straight from a WS client). */
function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** The single process-wide store + bus. */
export const store = new SessionStore();
export type { StoreEvents };
