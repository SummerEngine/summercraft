/**
 * AgentCraft — agent routes (Track A / Brain, plan §3 L3).
 *
 *   GET  /projects               -> ProjectView[]
 *   GET  /agents/:id/diff        -> AgentDiff | 404 {error:`unknown agent: <id>`}
 *   GET  /agents/:id/context     -> AgentContext | 404 {error:`unknown agent: <id>`}
 *   POST /agents/:id/prompt      -> 202 {accepted,agent_id} | 400 {error:'missing prompt'} | 404/503 {error}
 *   POST /agents/:id/ask {question} -> 200 {answer} | 400 {error} | 404/503 {error}  (synchronous; voice ask_claude)
 *
 * dispatchPrompt() is the shared "resolve a prompt to a live session" path used by BOTH this POST route
 * and the WS `command` frame — kept verbatim so the spawn/command behavior + status codes are unchanged.
 */
import http from "node:http";

import { store } from "../session-store.ts";
import { sessionManager } from "../session-manager.ts";
import { processRegistry } from "../process-registry.ts";
import { listProjects } from "../projects.ts";
import { agentDiff, agentContext, agentTranscript } from "../agent-context.ts";
import { openPr, approveAgent } from "../pr.ts";
import { json, readBody, safeJson } from "./router.ts";
import {
  validateId,
  validatePrompt,
  validateOptionalText,
  parseLimit,
  parseOffset,
  MAX_PROMPT_CHARS,
} from "./validate.ts";

/**
 * Resolve a prompt to a live session, spawning one from the store record if needed. Returns a tagged
 * result the caller maps to an HTTP status (404 unknown agent, 503 spawn/dispatch failure). Shared by the
 * POST /agents/:id/prompt route and the WS `command` frame.
 */
export async function dispatchPrompt(
  agentId: string,
  prompt: string,
): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
  if (!sessionManager.has(agentId)) {
    const rec = store.get(agentId);
    if (!rec) {
      return { ok: false, code: 404, error: `unknown agent: ${agentId}` };
    }
    // ADA-ONLY MCP: Ada (the data operator) MUST spawn with her persona + the Aiven MCP attached,
    // regardless of entry point. This is the COMMITTED voice path (voice_bridge.gd run_task/send_message
    // -> POST /agents/<id>/prompt -> here), so a bare voice-first spawn would be sticky (runMission only
    // attaches the MCP when no session exists yet) and silently break the headline Aiven #2 beat when you
    // TALK to her. Converge her on operatorSpawnArgs() so this path and runAgentTurn bring up ONE
    // MCP-attached Ada. The normal coding agents (a1/a2/a3) keep the bare record spawn — they NEVER get
    // the Aiven MCP, so there's no MCP-attach hang risk on the typed/voice coding path. Lazy import avoids
    // the routes <-> operator import edge.
    let spawnArgs = {
      agentId: rec.agent_id,
      repoId: rec.repo_id,
      repoPath: rec.repo_path,
      characterKind: rec.character_kind,
      label: rec.label,
    };
    try {
      const op = await import("../aiven/operator.ts");
      if (agentId === op.OPERATOR_AGENT_ID) spawnArgs = op.operatorSpawnArgs();
    } catch {
      /* operator module unavailable — fall back to the bare record spawn */
    }
    const spawned = await sessionManager.spawn(spawnArgs);
    if (!spawned.ok) return { ok: false, code: 503, error: spawned.error ?? "spawn failed" };
  }
  if (!sessionManager.command(agentId, prompt)) {
    return { ok: false, code: 503, error: `could not dispatch to ${agentId}` };
  }
  return { ok: true };
}

/** GET /projects -> ProjectView[]  (project = repo + name + its agents' live views). */
export async function handleProjects(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  json(res, 200, await listProjects());
}

/** GET /agents/:id/diff -> AgentDiff | 404 {error}  (D's diff section; B fetches). */
export async function handleDiff(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const d = await agentDiff(id);
  if (!d) {
    json(res, 404, { error: `unknown agent: ${id}` });
    return;
  }
  json(res, 200, d);
}

/** GET /agents/:id/context -> AgentContext | 404 {error}  (branch/base/PR/task/diff for the voice dive). */
export async function handleContext(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const c = await agentContext(id);
  if (!c) {
    json(res, 404, { error: `unknown agent: ${id}` });
    return;
  }
  json(res, 200, c);
}

/**
 * POST /agents/:id/prompt {prompt} -> 202 | 400 missing/invalid prompt | 404/503 dispatch failure.
 *
 * HARDENED: the path id is charset/length-validated and the prompt is length-bounded (MAX_PROMPT_CHARS)
 * BEFORE it reaches the session layer. The "missing prompt" 400 message is preserved verbatim so any
 * client that matched on it still works.
 */
export async function handlePrompt(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const body = await readBody(req).then(safeJson);
  const promptCheck = validatePrompt(body?.prompt);
  if (!promptCheck.ok) {
    json(res, 400, { error: promptCheck.error });
    return;
  }
  const dispatched = await dispatchPrompt(idCheck.value, promptCheck.value);
  if (!dispatched.ok) {
    json(res, dispatched.code, { error: dispatched.error });
    return;
  }
  json(res, 202, { accepted: true, agent_id: idCheck.value });
}

/**
 * Synchronous ask: how long we BLOCK for the agent's final answer. Kept under the ElevenLabs client-tool
 * timeout (30s) so the voice's `ask_claude` always gets a reply — on overrun we return a graceful "still
 * working" answer rather than a hung tool. The full result still lands in the transcript either way.
 */
const ASK_TIMEOUT_MS = 24_000;

/**
 * POST /agents/:id/ask { question } -> 200 { answer } | 400 invalid | 404/503 dispatch failure.
 *
 * The SYNCHRONOUS counterpart to /prompt, for the voice `ask_claude` tool: run ONE turn in the agent's real
 * Claude session and BLOCK for the final assistant text, so the voice can speak the agent's ACTUAL answer in
 * one breath ("what does auth.ts do?", "did the tests pass?"). /prompt stays fire-and-forget (202) for "do"
 * tasks; this is the "learn" path. The turn may use the agent's tools (read files, run things) before it
 * answers.
 *
 * Bounded by ASK_TIMEOUT_MS: on overrun we resolve 200 with a "still working" answer (the run keeps going,
 * the result lands in the transcript) instead of hanging the voice. Correlation is by agent_id — ServerEvent
 * result/error carry no request id (contract.ts is frozen/additive) — so concurrent asks on the SAME agent
 * could cross answers; the voice asks one at a time, and the typed /prompt path never waits, so this is safe.
 */
export async function handleAsk(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const body = await readBody(req).then(safeJson);
  // Accept {question} (the ask_claude tool) or {prompt} as an alias, validated like any other prompt.
  const raw = typeof body?.question === "string" ? body.question : body?.prompt;
  const qCheck = validatePrompt(raw);
  if (!qCheck.ok) {
    json(res, 400, { error: qCheck.error });
    return;
  }
  const agentId = idCheck.value;

  // Subscribe to THIS agent's terminal result BEFORE dispatching, so a fast turn can't complete in the gap
  // between dispatch and subscribe (the same race the operator's captureResult closes). The listener resolves
  // on the agent's `result`/`error` event; a bounded timer guarantees we always reply.
  const out = await new Promise<{ status: number; payload: Record<string, unknown> }>((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (status: number, payload: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (off) off();
      resolve({ status, payload });
    };
    off = store.onEvent((e) => {
      if ((e as { agent_id?: string }).agent_id !== agentId) return;
      if (e.type === "result") {
        settle(200, { answer: String(e.summary ?? "").slice(0, 4000) });
      } else if (e.type === "error") {
        settle(200, { answer: `I ran into an error: ${String(e.message ?? "unknown").slice(0, 500)}` });
      }
    });
    timer = setTimeout(
      () => settle(200, { answer: "Still working on that one — give me a moment and ask me again." }),
      ASK_TIMEOUT_MS,
    );
    timer.unref?.();
    // Dispatch AFTER the listener is attached. A dispatch failure (unknown agent / spawn fail) replies now.
    void dispatchPrompt(agentId, qCheck.value).then((d) => {
      if (!d.ok) settle(d.code, { error: d.error });
    });
  });
  json(res, out.status, out.payload);
}

// --------------------------------------------------------------------------------------------------
// ADDITIVE routes (L3 Phase-2): paginated transcript, open-PR, approve. None changes an existing shape.
// --------------------------------------------------------------------------------------------------

/** GET /agents/:id/transcript?limit=&offset= -> TranscriptPage | 404 {error}  (paginated, bounded). */
export async function handleTranscript(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const limit = parseLimit(url.searchParams.get("limit"));
  // Distinguish "offset omitted" (-> null -> tail/most-recent page) from an explicit "?offset=N"
  // (-> page from the start). agentTranscript defaults to the tail so a HUD with defaults sees recent
  // activity, not the beginning of history; explicit offsets still walk history forward.
  const rawOffset = url.searchParams.get("offset");
  const offset = rawOffset === null ? null : parseOffset(rawOffset);
  const page = await agentTranscript(idCheck.value, limit, offset);
  if (!page) {
    json(res, 404, { error: `unknown agent: ${idCheck.value}` });
    return;
  }
  json(res, 200, page);
}

/**
 * POST /agents/:id/service { url, port?, pid? } -> 200 ServiceRegistration | 400 invalid | 404 unknown agent.
 *
 * LANE A — the agent-callable REGISTER hook for "spin up localhost". When an agent starts a dev server in a
 * turn (`npm run dev &`), it POSTs the server here with its url (and ideally its pid via `$!` and port) so the
 * sidecar gets a HANDLE on a child that outlives the turn. We:
 *   - normalize 0.0.0.0 -> localhost and derive the port from the URL when not supplied;
 *   - record it in the per-agent process registry ({ pid, port, url, started_at });
 *   - the registry emits the EXISTING `service` ServerEvent (url+port) so D's localhost chip + C's voice
 *     announce light up RELIABLY (not only when the URL happens to land in the final answer text);
 *   - the registered pid is SIGTERM'd on session teardown (AgentSession.close -> processRegistry.killForAgent),
 *     so the server doesn't zombie after send-away / new-chat / crash-dispose.
 *
 * A localhost URL is REQUIRED (we don't track arbitrary external URLs — this is about local dev servers). The
 * pid is optional but recommended: without it we still surface the service, we just can't kill it on teardown.
 */
export async function handleService(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  if (!store.get(idCheck.value)) {
    json(res, 404, { error: `unknown agent: ${idCheck.value}` });
    return;
  }
  const body = await readBody(req).then(safeJson);
  const svc = parseServiceBody(body);
  if (!svc.ok) {
    json(res, 400, { error: svc.error });
    return;
  }
  const entry = processRegistry.register(idCheck.value, svc.value);
  json(res, 200, {
    agent_id: idCheck.value,
    registered: true,
    url: entry.url,
    port: entry.port,
    pid: entry.pid,
    started_at: entry.started_at,
  });
}

/**
 * Validate + normalize a /service body into { url, port, pid }. Requires a localhost(-family) http(s) URL;
 * derives the port from the URL when not given; rewrites 0.0.0.0 -> localhost so the surfaced URL is
 * navigable. pid/port are optional non-negative ints. Never throws.
 */
function parseServiceBody(
  body: any,
): { ok: true; value: { url: string; port: number; pid: number } } | { ok: false; error: string } {
  const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return { ok: false, error: "url is required" };
  if (rawUrl.length > 2048) return { ok: false, error: "url too long" };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "url is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "url must be http(s)" };
  }
  const host = parsed.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  if (!isLocal) return { ok: false, error: "url must be a localhost dev-server URL" };
  // 0.0.0.0 is a bind address, not navigable — rewrite so D's "open it" link works.
  if (host === "0.0.0.0") parsed.hostname = "localhost";

  // Port: explicit body.port wins; else the URL's port; else the scheme default.
  let port = 0;
  if (body?.port != null) {
    const p = Number(body.port);
    if (!Number.isFinite(p) || p < 0 || p > 65535) return { ok: false, error: "port out of range" };
    port = Math.floor(p);
  } else if (parsed.port) {
    port = Number(parsed.port);
  } else {
    port = parsed.protocol === "https:" ? 443 : 80;
  }

  let pid = 0;
  if (body?.pid != null) {
    const n = Number(body.pid);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "pid must be a non-negative integer" };
    pid = Math.floor(n);
  }

  return { ok: true, value: { url: parsed.toString(), port, pid } };
}

/**
 * POST /agents/:id/pr {title?,body?} -> PrResult (ALWAYS 200; client branches on `opened`) | 404 unknown
 * agent. Best-effort: opening a PR via gh is a no-op (opened:false, reason) when gh is absent — never an
 * error status (same pattern as /voice/signed-url).
 */
export async function handlePr(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  if (!store.get(idCheck.value)) {
    json(res, 404, { error: `unknown agent: ${idCheck.value}` });
    return;
  }
  const body = await readBody(req).then(safeJson);
  const titleCheck = validateOptionalText(body?.title, 200, "title");
  if (!titleCheck.ok) {
    json(res, 400, { error: titleCheck.error });
    return;
  }
  const bodyCheck = validateOptionalText(body?.body, MAX_PROMPT_CHARS, "body");
  if (!bodyCheck.ok) {
    json(res, 400, { error: bodyCheck.error });
    return;
  }
  json(res, 200, await openPr(idCheck.value, { title: titleCheck.value, body: bodyCheck.value }));
}

/** POST /agents/:id/approve {by?} -> ApproveResult | 404 unknown agent. Releases a parked agent. */
export async function handleApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id);
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const body = await readBody(req).then(safeJson);
  const byCheck = validateOptionalText(body?.by, 200, "by");
  if (!byCheck.ok) {
    json(res, 400, { error: byCheck.error });
    return;
  }
  const result = await approveAgent(idCheck.value, byCheck.value);
  if (!result.ok) {
    json(res, 404, { error: `unknown agent: ${idCheck.value}` });
    return;
  }
  json(res, 200, result);
}

/**
 * POST /projects/:id/merge {by?} -> { project_id, ok, merged, agents } | 404 unknown project.
 *
 * The HUD's "Merge" button (hud.gd merge_requested -> world_manager._on_hud_merge -> bridge.merge ->
 * POST /projects/:id/merge) previously hit a route that DID NOT EXIST, so every Merge click 404'd
 * silently (the Godot bridge's _post ignores the response body). This is the missing endpoint.
 *
 * Project-level merge is defined as "release every agent in the project" — it fans out to approveAgent
 * (the same per-agent release the per-agent Approve route uses), since a project is a repo + its agents
 * and there is no separate worktree-graph merge primitive in the brain. Each agent's `approved` event
 * still broadcasts so D's HUD updates per agent. `by` is the optional approver (bounded like /approve).
 * 404 only when the project id is unknown; an empty project is a clean ok:true with merged:0.
 */
export async function handleProjectMerge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  const idCheck = validateId(id, "project_id");
  if (!idCheck.ok) {
    json(res, 400, { error: idCheck.error });
    return;
  }
  const body = await readBody(req).then(safeJson);
  const byCheck = validateOptionalText(body?.by, 200, "by");
  if (!byCheck.ok) {
    json(res, 400, { error: byCheck.error });
    return;
  }

  const projects = await listProjects();
  const project = projects.find((p) => p.id === idCheck.value);
  if (!project) {
    json(res, 404, { error: `unknown project: ${idCheck.value}` });
    return;
  }

  // Release each agent in the project (best-effort per agent; a single unknown/failed agent doesn't
  // fail the whole merge). approveAgent broadcasts the per-agent `approved` event D's HUD consumes.
  const agents = await Promise.all(
    project.agents.map(async (a) => {
      const r = await approveAgent(a.agent_id, byCheck.value);
      return { agent_id: a.agent_id, approved: r.ok && r.approved };
    }),
  );
  const merged = agents.filter((a) => a.approved).length;
  json(res, 200, { project_id: idCheck.value, ok: true, merged, agents });
}
