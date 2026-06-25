/**
 * AgentCraft — HTTP router + shared route utilities (Track A / Brain, plan §3 L3, §7 Phase 1).
 *
 * The Phase-1 refactor split the monolith `server.ts` HTTP handler into per-concern route modules. This
 * module owns the cross-cutting HTTP plumbing every route shares — and ONLY that, so the dispatch table
 * reads as the route map:
 *   - the CORS-preflight OPTIONS -> 204 (headers byte-identical to the pre-refactor server),
 *   - the consistent {error} envelope on any thrown error -> 500,
 *   - the 404 fallthrough for an unmatched route,
 *   - `json` / `readBody` / `safeJson` / `msg` — the shared helpers the route handlers import.
 *
 * CONTRACT INVARIANTS preserved verbatim (frozen for B/C/D):
 *   - every JSON response + the 204 preflight send Access-Control-Allow-Origin:* and the same
 *     Allow-Headers / Allow-Methods (the charter tightens this to localhost LATER, in L4 — NOT here),
 *   - every non-2xx JSON body is exactly {error:string},
 *   - unknown route -> 404 {error: `no route for <method> <path>`}, any throw -> 500 {error}.
 *
 * The dispatch table is just a series of guarded `if`s in the same order as the original server, so the
 * route precedence (and therefore behavior) is unchanged. Each branch delegates to a routes-*.ts handler.
 */
import http from "node:http";

import { HOST, PORT } from "../contract.ts";
import { handleWorld, handleAgents, handleHierarchy, handleWorlds, handleVisitWorld } from "./routes-world.ts";
import {
  handleProjects,
  handleDiff,
  handleContext,
  handlePrompt,
  handleAsk,
  handleTranscript,
  handlePr,
  handleApprove,
  handleProjectMerge,
  handleService,
} from "./routes-agents.ts";
import { handleNewSession, handleSendAway, handleSessions, handleSessionTranscript } from "./routes-characters.ts";
import { handleMissions, handleRun, handleAuthStatus, handleHealth } from "./routes-operator.ts";
import { handleSignedUrl, handleChatCompletionRoute } from "./routes-voice.ts";
import { tryMetaRoute } from "./routes-meta.ts";
import { MAX_BODY_BYTES, clientSafeError } from "./validate.ts";

/** Thrown by readBody when a request body exceeds MAX_BODY_BYTES; mapped to 413 by the router. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

// --------------------------------------------------------------------------------------------------
// Shared HTTP utilities (imported by every routes-*.ts handler).
// --------------------------------------------------------------------------------------------------

/**
 * Drain a request body to a UTF-8 string, BOUNDED to MAX_BODY_BYTES. Without this cap a multi-GB POST
 * buffers entirely in memory and OOMs the process (gap inventory §2 "request size caps"). Two guards:
 *   1) FAST PATH — if a Content-Length header declares > the cap, reject BEFORE reading a byte (so the
 *      router can send a clean 413 and the socket isn't torn down).
 *   2) STREAMING GUARD — for chunked / mis-declared bodies, fail the instant the accumulated size
 *      crosses the cap and destroy the socket (we will NOT keep buffering a hostile payload just to be
 *      polite). A reset connection is the correct, safer outcome for an over-cap stream.
 */
export async function readBody(req: http.IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy(); // stop reading; don't buffer a hostile payload
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Write a JSON response with the frozen CORS headers. Godot's HTTPRequest + the local voice page both
 * poll this; the headers are kept permissive for localhost and IDENTICAL to the pre-refactor server.
 */
export function json(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    // Godot's HTTPRequest + the local voice page both poll this; keep CORS permissive for localhost.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

/** Parse a JSON body string, returning {} on empty/invalid (never throws). */
export function safeJson(s: string): any {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Normalize an unknown error to a message string. */
export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --------------------------------------------------------------------------------------------------
// Router — the single request entrypoint the bootstrap mounts.
// --------------------------------------------------------------------------------------------------

/**
 * Build the request handler. Returns the `(req,res)` function `http.createServer` is given. Identical
 * dispatch order + behavior to the pre-refactor `handleHttp`: OPTIONS-204, then the route table, then a
 * 404 fallthrough, with any throw caught into a 500 {error} envelope.
 */
export function createRouter(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => void handle(req, res);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  try {
    // Observability seam (L4 owns these handlers; the L3 router mounts them). /metrics, /ready, /live.
    // tryMetaRoute writes its own response + returns true when it handled the path; false falls through.
    if (await tryMetaRoute(req, res, url)) return;

    // GET /world -> WorldSnapshot (Aiven projection overlaid with this host's live records)
    if (method === "GET" && url.pathname === "/world") {
      await handleWorld(req, res);
      return;
    }

    // GET /agents -> AgentView[]
    if (method === "GET" && url.pathname === "/agents") {
      await handleAgents(req, res);
      return;
    }

    // GET /projects -> ProjectView[]  (project = repo + name + its agents' live views)
    if (method === "GET" && url.pathname === "/projects") {
      await handleProjects(req, res);
      return;
    }

    // GET /hierarchy -> HierarchySnapshot  (Agent→Project→Repo→Group tree; B renders, D navigates)
    if (method === "GET" && url.pathname === "/hierarchy") {
      await handleHierarchy(req, res);
      return;
    }

    // GET /worlds -> { you, worlds }  (multiplayer directory: every shared world that has published)
    if (method === "GET" && url.pathname === "/worlds") {
      await handleWorlds(req, res);
      return;
    }

    // GET /worlds/:id -> SharedWorldSnapshot  (visit a world — anonymized; no code/paths/transcripts)
    const visitMatch = url.pathname.match(/^\/worlds\/([^/]+)$/);
    if (method === "GET" && visitMatch) {
      await handleVisitWorld(req, res, decodeURIComponent(visitMatch[1]));
      return;
    }

    // GET /agents/:id/diff -> { agent_id, diff, files, ... }  (D's diff section; B fetches)
    const diffMatch = url.pathname.match(/^\/agents\/([^/]+)\/diff$/);
    if (method === "GET" && diffMatch) {
      await handleDiff(req, res, decodeURIComponent(diffMatch[1]));
      return;
    }

    // GET /agents/:id/context -> AgentContext  (branch/base/PR/task/diff for the voice dive)
    const ctxMatch = url.pathname.match(/^\/agents\/([^/]+)\/context$/);
    if (method === "GET" && ctxMatch) {
      await handleContext(req, res, decodeURIComponent(ctxMatch[1]));
      return;
    }

    // GET /operator/missions -> { ready, missions }  (the reproducible Autonomous Data Operator beats)
    if (method === "GET" && url.pathname === "/operator/missions") {
      handleMissions(req, res);
      return;
    }

    // POST /operator/run {mission_id?|prompt?} -> 202  (run a data-operator mission via the Aiven MCP)
    if (method === "POST" && url.pathname === "/operator/run") {
      await handleRun(req, res);
      return;
    }

    // GET /auth/status -> { mode }
    if (method === "GET" && url.pathname === "/auth/status") {
      handleAuthStatus(req, res);
      return;
    }

    // GET /voice/signed-url?agent_id= -> { configured, signed_url, agent_id }  [native voice relay]
    if (method === "GET" && url.pathname === "/voice/signed-url") {
      await handleSignedUrl(req, res);
      return;
    }

    // GET /health -> liveness (handy for the Godot bridge to detect the sidecar)
    if (method === "GET" && url.pathname === "/health") {
      handleHealth(req, res);
      return;
    }

    // POST /agents/:id/prompt {prompt} -> 202
    const promptMatch = url.pathname.match(/^\/agents\/([^/]+)\/prompt$/);
    if (method === "POST" && promptMatch) {
      await handlePrompt(req, res, decodeURIComponent(promptMatch[1]));
      return;
    }

    // POST /agents/:id/ask {question} -> 200 {answer}  (synchronous ask for the voice ask_claude tool)
    const askMatch = url.pathname.match(/^\/agents\/([^/]+)\/ask$/);
    if (method === "POST" && askMatch) {
      await handleAsk(req, res, decodeURIComponent(askMatch[1]));
      return;
    }

    // GET /agents/:id/transcript?limit=&offset= -> TranscriptPage  (paginated transcript; ADDITIVE)
    const transcriptMatch = url.pathname.match(/^\/agents\/([^/]+)\/transcript$/);
    if (method === "GET" && transcriptMatch) {
      await handleTranscript(req, res, decodeURIComponent(transcriptMatch[1]), url);
      return;
    }

    // POST /agents/:id/pr {title?,body?} -> PrResult  (open a real PR via gh; best-effort; ADDITIVE)
    const prMatch = url.pathname.match(/^\/agents\/([^/]+)\/pr$/);
    if (method === "POST" && prMatch) {
      await handlePr(req, res, decodeURIComponent(prMatch[1]));
      return;
    }

    // POST /agents/:id/approve {by?} -> ApproveResult  (release a pending/awaiting agent; ADDITIVE)
    const approveMatch = url.pathname.match(/^\/agents\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
      await handleApprove(req, res, decodeURIComponent(approveMatch[1]));
      return;
    }

    // POST /agents/:id/service { url, port?, pid? } -> ServiceRegistration  (Lane A: register a dev server
    // the agent spun up so the sidecar tracks its pid+port, emits the `service` ServerEvent, and kills it on
    // teardown). ADDITIVE — no existing shape changed.
    const serviceMatch = url.pathname.match(/^\/agents\/([^/]+)\/service$/);
    if (method === "POST" && serviceMatch) {
      await handleService(req, res, decodeURIComponent(serviceMatch[1]));
      return;
    }

    // POST /agents/:id/new-session -> { character_id, session_id }  (start a fresh chat; ADDITIVE).
    // Character-session model: archive the current run + replace it with a brand-new Claude session.
    const newSessionMatch = url.pathname.match(/^\/agents\/([^/]+)\/new-session$/);
    if (method === "POST" && newSessionMatch) {
      await handleNewSession(req, res, decodeURIComponent(newSessionMatch[1]));
      return;
    }

    // POST /agents/:id/send-away -> { character_id, was_active }  (archive + sleep; ADDITIVE).
    const sendAwayMatch = url.pathname.match(/^\/agents\/([^/]+)\/send-away$/);
    if (method === "POST" && sendAwayMatch) {
      await handleSendAway(req, res, decodeURIComponent(sendAwayMatch[1]));
      return;
    }

    // GET /agents/:id/sessions/:session_id/transcript -> SessionTranscript  (one session's archived chat;
    // ADDITIVE). MUST sit ABOVE the bare /sessions branch — both are anchored, but keep specific-first.
    const sessionTranscriptMatch = url.pathname.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/transcript$/);
    if (method === "GET" && sessionTranscriptMatch) {
      await handleSessionTranscript(
        req,
        res,
        decodeURIComponent(sessionTranscriptMatch[1]),
        decodeURIComponent(sessionTranscriptMatch[2]),
        url,
      );
      return;
    }

    // GET /agents/:id/sessions -> SessionSummary[]  (a character's session history; ADDITIVE).
    const sessionsMatch = url.pathname.match(/^\/agents\/([^/]+)\/sessions$/);
    if (method === "GET" && sessionsMatch) {
      await handleSessions(req, res, decodeURIComponent(sessionsMatch[1]));
      return;
    }

    // POST /projects/:id/merge {by?} -> { project_id, ok, merged, agents }  (HUD Merge button; ADDITIVE).
    // Was a 404 black hole — the game's merge_requested -> bridge.merge POSTs here. Releases each agent
    // in the project (fans out to approveAgent). MUST stay BELOW the GET /projects branch above.
    const mergeMatch = url.pathname.match(/^\/projects\/([^/]+)\/merge$/);
    if (method === "POST" && mergeMatch) {
      await handleProjectMerge(req, res, decodeURIComponent(mergeMatch[1]));
      return;
    }

    // POST /v1/chat/completions -> OpenAI SSE (voice shim). Delegated to Track C's handler.
    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletionRoute(req, res);
      return;
    }

    json(res, 404, { error: `no route for ${method} ${url.pathname}` });
  } catch (e) {
    // A too-large body is the client's fault (413), not a 500.
    if (e instanceof BodyTooLargeError) {
      json(res, 413, { error: e.message });
      return;
    }
    // Any other throw: log the real detail server-side, return a CLIENT-SAFE message (no raw exception
    // text / internal paths — gap inventory §2 "consistent error envelope" + "secrets never sent").
    console.error(`[sidecar] 500 on ${method} ${url.pathname}:`, msg(e));
    json(res, 500, { error: clientSafeError(e) });
  }
}
