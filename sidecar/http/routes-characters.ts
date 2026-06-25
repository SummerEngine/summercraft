/**
 * AgentCraft — CHARACTER routes (Track A / Brain). The HTTP surface of the ratified character-session model
 * (the ratified character-session model). All ADDITIVE — no existing shape or
 * route changes.
 *
 *   POST /agents/:id/new-session  -> 200 { character_id, session_id } | 404 {error:`unknown agent: <id>`}
 *   POST /agents/:id/send-away    -> 200 { character_id, was_active }  | 404 {error:`unknown agent: <id>`}
 *   GET  /agents/:id/sessions     -> SessionSummary[]                  | 404 {error:`unknown agent: <id>`}
 *   GET  /agents/:id/sessions/:session_id/transcript?limit= -> SessionTranscript
 *                                                            | 404 {error} (unknown agent OR unknown session)
 *
 * character_id == agent_id in the current model (each known agent IS a character). The :id path segment is
 * the character/agent id, charset/length-validated like every other agent route before it reaches the layer.
 */
import http from "node:http";

import { startNewSession, sendAwayCharacter, listSessions, sessionTranscript } from "../characters.ts";
import { json } from "./router.ts";
import { validateId, parseLimit } from "./validate.ts";

/**
 * POST /agents/:id/new-session -> 200 { character_id, session_id } | 404 unknown.
 * Start a FRESH chat for the character: archive the current session's transcript to history, replace the
 * live Claude run with a brand-new one (new session_id), lifecycle -> working. 404 only for an unknown
 * character (no record). A null session_id (couldn't bring the run up) surfaces as a 503.
 */
export async function handleNewSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const sessionId = await startNewSession(idCheck.value);
  if (sessionId == null) {
    // Distinguish unknown character (404) from a known character whose fresh run failed to start (503).
    const known = (await listSessions(idCheck.value)) != null;
    if (!known) {
      json(res, 404, { error: `unknown agent: ${idCheck.value}` });
      return;
    }
    json(res, 503, { error: `could not start a new session for ${idCheck.value}` });
    return;
  }
  json(res, 200, { character_id: idCheck.value, session_id: sessionId });
}

/**
 * POST /agents/:id/send-away -> 200 { character_id, was_active } | 404 unknown.
 * Archive the active session + put the character to sleep at home (lifecycle -> asleep). `was_active` is
 * false when the character was already asleep (no live session). There is NO hard delete — the record + its
 * session history survive.
 */
export async function handleSendAway(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  // listSessions(id) doubles as the "known character?" gate (null only for an unknown record).
  if ((await listSessions(idCheck.value)) == null) {
    json(res, 404, { error: `unknown agent: ${idCheck.value}` });
    return;
  }
  const wasActive = await sendAwayCharacter(idCheck.value);
  json(res, 200, { character_id: idCheck.value, was_active: wasActive });
}

/**
 * GET /agents/:id/sessions -> SessionSummary[] | 404 unknown.
 * The character's session history, newest first (a still-live session sorts first with ended_at=null).
 * Durable via Postgres when Aiven is on, with an in-memory mirror so it works single-player too.
 */
export async function handleSessions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const sessions = await listSessions(idCheck.value);
  if (sessions == null) {
    json(res, 404, { error: `unknown agent: ${idCheck.value}` });
    return;
  }
  json(res, 200, sessions);
}

/**
 * GET /agents/:id/sessions/:session_id/transcript?limit= -> SessionTranscript | 404 unknown.
 * The archived (or live) transcript of ONE session — D's History "view archived chat". 404 for an unknown
 * character AND for a known character that has no session with that session_id (distinct error messages).
 * Reconstructs the session from its [started_at, ended_at] window (the per-agent JSONL has no session_id);
 * lines are oldest-first, bounded by ?limit (default 500, max 2000), keeping the tail on overflow.
 */
export async function handleSessionTranscript(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const sidCheck = validateId(sessionId, "session_id");
  if (!sidCheck.ok) {
    json(res, 400, { error: sidCheck.error });
    return;
  }
  // limit default 500 / max 2000 / min 1 (a transcript view always wants at least one line).
  const limit = parseLimit(url.searchParams.get("limit"), 500, 2000, 1);
  const result = await sessionTranscript(idCheck.value, sidCheck.value, limit);
  if (result == null) {
    json(res, 404, { error: `unknown agent: ${idCheck.value}` });
    return;
  }
  if (!result.found) {
    json(res, 404, { error: `unknown session: ${sidCheck.value}` });
    return;
  }
  json(res, 200, result.transcript);
}
