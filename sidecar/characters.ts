/**
 * AgentCraft — CHARACTER layer (Track A / Brain). The persistent-NPC half of the ratified character-session
 * model (the persistent-NPC / ephemeral-session design).
 *
 * The model: a persistent CHARACTER (the NPC — name, persona, home project, lifecycle asleep|working) OWNS
 * ephemeral SESSIONS (each = one Claude Code run / chat). One active session at a time. This module is the
 * seam between the frozen Character/SessionSummary contract shapes and the live machinery that already exists:
 *
 *   - Each known agent RECORD (session-store) IS a character. character_id == agent_id. buildCharacters()
 *     projects the records into Character[] for /world: `working` with a live `active_session_id` when the
 *     session-manager is running a session for it, else `asleep` with active_session_id=null.
 *   - "NEW CHAT" (startNewSession): archive the current session's transcript to history, then ask the
 *     session-manager to replace the live Claude run with a fresh one (new session_id) — lifecycle->working.
 *   - "SEND AWAY" (sendAwayCharacter): archive the active session, stop the run, lifecycle->asleep.
 *   - "LIST SESSIONS": a character's history of SessionSummary, newest first (the live one included, ended_at
 *     null), persisted in world_state.sessions (migration 0004) when Aiven is on, with an in-memory mirror so
 *     history works WITHOUT Aiven too (single-player). The in-memory mirror is the source of truth this
 *     process can always read; Postgres is the cross-restart durable copy.
 *
 * Persistence is BEST-EFFORT: every DB write is fire-and-forget-guarded so a Postgres hiccup never breaks a
 * new-chat / send-away. NEVER touches billing safety (no env handling here at all).
 */
import { sessionManager } from "./session-manager.ts";
import { store } from "./session-store.ts";
import { getPg } from "./aiven/pg.ts";
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";
import { OPERATOR_AGENT_ID } from "./aiven/operator.ts";
import { agentTranscriptWindow } from "./agent-context.ts";
import type { Character, SessionSummary, SessionTranscript } from "./contract.ts";

/**
 * In-memory mirror of every session we've started/archived this process, keyed by character_id, newest
 * last. This is the always-available history (works with NO Aiven); Postgres (when on) is the durable
 * cross-restart copy that listSessions() reads first and falls back FROM to this mirror.
 */
const sessionHistory = new Map<string, SessionSummary[]>();

/** Append (or replace by session_id) a summary in the in-memory mirror. */
function rememberSession(s: SessionSummary): void {
  const list = sessionHistory.get(s.character_id) ?? [];
  const idx = list.findIndex((x) => x.session_id === s.session_id);
  if (idx >= 0) list[idx] = s;
  else list.push(s);
  sessionHistory.set(s.character_id, list);
}

/** A short, code-free persona line for a character. Ada has a real role; coding NPCs get a kind line. */
function personaFor(agentId: string, kind: string, label: string): string {
  if (agentId === OPERATOR_AGENT_ID) {
    return "Ada — the data operator. Operates the team's Aiven infrastructure (Postgres + Kafka).";
  }
  const role: Record<string, string> = {
    viking: "a steadfast coding agent who charges through the backlog",
    wizard: "a methodical coding agent who refactors with care",
    dwarf: "a dependable coding agent who digs into the hard problems",
    barbarian: "a relentless coding agent who clears blockers by force",
  };
  return `${label} — ${role[kind] ?? "a SummerCraft coding agent"}.`;
}

/**
 * Project the known agent records into the world's Character[]. ONE character per record (character_id ==
 * agent_id). `working` with the live session_id when the session-manager is running a session for it; else
 * `asleep` (active_session_id=null). `home_project_id` is the record's project_id (its HOUSE), falling back
 * to repo_id (in the demo project_id == repo_id). Pure read — never mutates state. Safe when nothing is live.
 */
export function buildCharacters(): Character[] {
  return store.list().map((rec): Character => {
    const activeSessionId = sessionManager.currentSessionId(rec.agent_id);
    return {
      character_id: rec.agent_id,
      name: rec.label,
      persona: personaFor(rec.agent_id, rec.character_kind, rec.label),
      home_project_id: rec.project_id ?? rec.repo_id,
      lifecycle: activeSessionId ? "working" : "asleep",
      active_session_id: activeSessionId,
    };
  });
}

/** Build a short, code-free summary of a session from the character's transcript tail. */
function summarizeCurrentSession(characterId: string): string {
  const rec = store.get(characterId);
  const tail = rec?.transcript_tail ?? [];
  if (!tail.length) return "(no activity)";
  // The most recent line is the freshest signal of what the session did; keep it short + code-free.
  const last = tail[tail.length - 1] ?? "";
  return last.replace(/\s+/g, " ").trim().slice(0, 200) || "(no activity)";
}

/** UPSERT a session row to Postgres (best-effort; no-op without Aiven). Never throws. */
async function persistSession(s: SessionSummary): Promise<void> {
  const pg = getPg();
  if (!pg) return;
  try {
    await pg.query(
      `INSERT INTO world_state.sessions (session_id, character_id, summary, started_at, ended_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (session_id) DO UPDATE
         SET summary = EXCLUDED.summary, ended_at = EXCLUDED.ended_at`,
      [s.session_id, s.character_id, s.summary, s.started_at, s.ended_at],
    );
  } catch (e) {
    logger.warn("[characters] persist session failed (kept in memory)", {
      character_id: s.character_id,
      error: msg(e),
    });
  }
}

/**
 * Archive the character's CURRENT live session (if any) to history: read its session_id + start time from
 * the session-manager, build a code-free summary from the transcript tail, mark it ended now, and write it to
 * the in-memory mirror + Postgres. No-op (returns null) when the character has no live session. Called by both
 * startNewSession (before the replacement) and sendAwayCharacter (before the stop) so the prior chat is never
 * lost.
 */
async function archiveCurrentSession(characterId: string): Promise<SessionSummary | null> {
  const sessionId = sessionManager.currentSessionId(characterId);
  if (!sessionId) return null;
  const startedAt = sessionManager.currentSessionStartedAt(characterId) ?? new Date().toISOString();
  const summary: SessionSummary = {
    session_id: sessionId,
    character_id: characterId,
    summary: summarizeCurrentSession(characterId),
    started_at: startedAt,
    ended_at: new Date().toISOString(),
  };
  rememberSession(summary);
  await persistSession(summary);
  metrics.inc("character_session_archived");
  return summary;
}

/**
 * START A FRESH CHAT for a character ("New chat with Ada"). Archives the current session's transcript to
 * history, then replaces the live Claude run with a brand-new one (new session_id). The character is left
 * `working` on the fresh session. Returns the NEW session_id, or null for an unknown character (no record).
 * The new (live, not-yet-ended) session is also recorded so listSessions surfaces it with ended_at=null.
 */
export async function startNewSession(characterId: string): Promise<string | null> {
  if (!store.get(characterId)) return null;
  await archiveCurrentSession(characterId);
  const newId = await sessionManager.newSession(characterId);
  if (!newId) return null;
  // Record the fresh, still-live session (ended_at null) so it shows at the top of the history immediately.
  const live: SessionSummary = {
    session_id: newId,
    character_id: characterId,
    summary: "(active chat)",
    started_at: sessionManager.currentSessionStartedAt(characterId) ?? new Date().toISOString(),
    ended_at: null,
  };
  rememberSession(live);
  await persistSession(live);
  return newId;
}

/**
 * SEND THE CHARACTER AWAY: archive the active session, end the run, character goes to sleep at home
 * (lifecycle->asleep, active_session_id->null — both derived by buildCharacters once the session is gone).
 * Returns true if there was a live session to send away, false if the character was already asleep. Unknown
 * characters also return false. There is NO hard delete (ratified): the record + history survive.
 */
export async function sendAwayCharacter(characterId: string): Promise<boolean> {
  if (!store.get(characterId)) return false;
  await archiveCurrentSession(characterId);
  return sessionManager.sendAway(characterId);
}

/**
 * A character's session history, newest first (the live session, if any, sorts first with ended_at=null).
 * Reads Postgres when Aiven is on (durable across restarts), unioned with the in-memory mirror so a session
 * archived this process is always present even before/without a DB. Null for an unknown character.
 */
export async function listSessions(characterId: string): Promise<SessionSummary[] | null> {
  if (!store.get(characterId)) return null;
  const byId = new Map<string, SessionSummary>();
  // In-memory mirror first (always available); DB rows overlay (durable copy wins on conflict).
  for (const s of sessionHistory.get(characterId) ?? []) byId.set(s.session_id, s);
  const pg = getPg();
  if (pg) {
    try {
      const { rows } = await pg.query(
        `SELECT session_id, character_id, summary, started_at, ended_at
           FROM world_state.sessions
          WHERE character_id = $1
          ORDER BY started_at DESC`,
        [characterId],
      );
      for (const r of rows) {
        byId.set(String(r.session_id), {
          session_id: String(r.session_id),
          character_id: String(r.character_id),
          summary: String(r.summary ?? ""),
          started_at: toIso(r.started_at),
          ended_at: r.ended_at == null ? null : toIso(r.ended_at),
        });
      }
    } catch (e) {
      logger.warn("[characters] list sessions DB read failed (using in-memory)", {
        character_id: characterId,
        error: msg(e),
      });
    }
  }
  // Newest first; a still-live session (ended_at null) sorts to the very top.
  return [...byId.values()].sort((a, b) => {
    if (a.ended_at == null && b.ended_at != null) return -1;
    if (a.ended_at != null && b.ended_at == null) return 1;
    return b.started_at.localeCompare(a.started_at);
  });
}

/** Default / max number of transcript lines a single session-transcript read returns. */
const SESSION_TRANSCRIPT_DEFAULT_LIMIT = 500;
const SESSION_TRANSCRIPT_MAX_LIMIT = 2000;

/**
 * The archived (or live) transcript of ONE session — the source for D's History "view archived chat".
 * Reconstructs the session from its [started_at, ended_at] window (the per-agent JSONL carries no session_id;
 * see agentTranscriptWindow) and returns that session's transcript lines, oldest-first, bounded by `limit`.
 *
 * Returns:
 *   - null              -> unknown CHARACTER (no record) — the route maps this to 404.
 *   - { found:false }   -> known character but no session with that session_id — the route maps to 404.
 *   - { found:true, transcript } on success.
 *
 * The session window is read via listSessions (in-memory mirror unioned with Postgres when Aiven is on), so
 * a session archived this process is visible even without a DB (single-player), and durable sessions survive
 * a restart. `limit` is clamped to [1, SESSION_TRANSCRIPT_MAX_LIMIT].
 */
export async function sessionTranscript(
  characterId: string,
  sessionId: string,
  limit = SESSION_TRANSCRIPT_DEFAULT_LIMIT,
): Promise<{ found: true; transcript: SessionTranscript } | { found: false } | null> {
  const sessions = await listSessions(characterId);
  if (sessions == null) return null; // unknown character
  const session = sessions.find((s) => s.session_id === sessionId);
  if (!session) return { found: false }; // unknown session for this character
  const cap = Math.max(1, Math.min(SESSION_TRANSCRIPT_MAX_LIMIT, Math.floor(limit) || SESSION_TRANSCRIPT_DEFAULT_LIMIT));
  const lines = await agentTranscriptWindow(characterId, session.started_at, session.ended_at, cap);
  return {
    found: true,
    transcript: {
      agent_id: characterId,
      session_id: sessionId,
      started_at: session.started_at,
      ended_at: session.ended_at,
      limit: cap,
      lines,
    },
  };
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
