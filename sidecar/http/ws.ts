/**
 * AgentCraft — WebSocket server: ServerEvent stream + ClientCommand frames (Track A / Brain, plan §3 L3).
 *
 * Moved VERBATIM out of the pre-refactor server.ts. The ONLY change is that the per-launch AUTH_TOKEN is
 * now PASSED IN via attachWebSocket(server, authToken) — the bootstrap owns the token — instead of a
 * shared module global. Behavior, frame shapes, and the protocol are otherwise unchanged.
 *
 * WS PROTOCOL (frozen, contract.ts ServerEvent/ClientCommand unions):
 *   - endpoint '/' on the same http.Server.
 *   - the connection is MUTE until a valid {type:'hello',token} frame (token == the per-launch token);
 *     a bad/absent token -> {type:'error',message} then ws.close(4001,'unauthorized'); a 5s hello timeout
 *     closes the socket.
 *   - on successful hello: emit {type:'status',agent_id:'_server',state:'waiting',status_line:'connected'}
 *     then replay one {type:'status'} per store record.
 *   - accepted client commands after auth: hello | spawn | command | interrupt | subscribe | list | relay.
 *   - 'subscribe' sets a per-socket agent_id filter; 'relay' re-publishes ONLY speaking/caption/status.
 *   - invalid JSON frame -> {type:'error',message:'invalid JSON frame'}.
 *   - fan-out: store.onEvent -> every authed OPEN socket, honoring the subscribe filter.
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import type { AgentState, ClientCommand, ServerEvent } from "../contract.ts";
import { store } from "../session-store.ts";
import { sessionManager } from "../session-manager.ts";
import { dispatchPrompt } from "./routes-agents.ts";
import { originAllowed } from "../security.ts";
import {
  validateId,
  validatePrompt,
  validateOptionalText,
  validatePath,
  MAX_WS_FRAME_BYTES,
  MAX_LABEL_CHARS,
} from "./validate.ts";

/** The AgentState union (contract.ts), as a runtime set so a relayed `status` can't smuggle a bogus state. */
const AGENT_STATES = new Set(["waiting", "moving", "working", "blocked", "done"]);

/**
 * Per-socket rate limit (gap inventory §2 "WS … per-socket rate limit"): a sliding window of how many
 * command frames a single socket may send. Once a socket is authed it could otherwise flood
 * spawn/command/relay frames; this caps the burst. Exceeding it drops the frame with an {error} rather
 * than closing the socket (a transient burst shouldn't kill a legit client).
 */
const RATE_WINDOW_MS = 1_000;
const RATE_MAX_FRAMES = 20;

interface SocketState {
  authed: boolean;
  /** if set, only forward events for this agent_id; otherwise forward all */
  subscribed: string | null;
  /** timestamps (epoch ms) of recent frames, for the sliding-window rate limit. */
  frameTimes: number[];
}

/** Returns true if the socket is UNDER its rate limit (and records the frame); false if it must drop. */
function underRateLimit(st: SocketState): boolean {
  const now = Date.now();
  st.frameTimes = st.frameTimes.filter((t) => now - t < RATE_WINDOW_MS);
  if (st.frameTimes.length >= RATE_MAX_FRAMES) return false;
  st.frameTimes.push(now);
  return true;
}

/**
 * Attach the WS server to the shared http.Server. `authToken` is the per-launch hello token (the
 * bootstrap mints + persists it). Sets up the single store.onEvent fan-out + the per-connection handler.
 */
export function attachWebSocket(server: http.Server, authToken: string): void {
  // Origin check (charter §2 Security "WS origin check"): reject a cross-origin browser handshake before
  // the socket is even accepted. originAllowed() (L4/security.ts) passes absent/localhost/"null" origins
  // (native Godot + curl send no Origin; file:// sends "null") and rejects any present non-localhost
  // browser origin, so a malicious web page can't open a control socket to the localhost sidecar. The
  // hello token still gates every command; this is defense-in-depth at the handshake. (The per-socket
  // rate limit is already enforced by underRateLimit below — not duplicated here.)
  const wss = new WebSocketServer({ server, verifyClient: ({ origin }) => originAllowed(origin) });
  const sockets = new Map<WebSocket, SocketState>();

  // Single bus subscription fans every ServerEvent out to all authed sockets.
  store.onEvent((event: ServerEvent) => {
    for (const [ws, st] of sockets) {
      if (!st.authed || ws.readyState !== WebSocket.OPEN) continue;
      if (st.subscribed && "agent_id" in event && event.agent_id !== st.subscribed) continue;
      safeSend(ws, event);
    }
  });

  wss.on("connection", (ws) => {
    const st: SocketState = { authed: false, subscribed: null, frameTimes: [] };
    sockets.set(ws, st);

    // The connection is mute until a valid hello frame arrives (plan §5 S3).
    ws.on("message", (raw) => {
      const text = raw.toString();
      // Frame size cap: a hostile multi-MB frame must not buffer/parse. Reject before JSON.parse.
      if (Buffer.byteLength(text) > MAX_WS_FRAME_BYTES) {
        safeSend(ws, { type: "error", message: "frame too large" } satisfies ServerEvent);
        return;
      }
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(text) as ClientCommand;
      } catch {
        safeSend(ws, { type: "error", message: "invalid JSON frame" } satisfies ServerEvent);
        return;
      }
      // Rate limit everything EXCEPT hello (so the auth handshake is never throttled). Once authed, a
      // flood of spawn/command/relay frames is dropped with an {error} rather than acted on.
      if ((cmd as { type?: string })?.type !== "hello" && !underRateLimit(st)) {
        safeSend(ws, { type: "error", message: "rate limit exceeded" } satisfies ServerEvent);
        return;
      }
      void handleCommand(ws, st, cmd, authToken);
    });

    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => sockets.delete(ws));

    // Reject silent freeloaders: if no valid hello in 5s, close.
    setTimeout(() => {
      if (!st.authed && ws.readyState === WebSocket.OPEN) {
        safeSend(ws, { type: "error", message: "hello timeout: no valid token" } satisfies ServerEvent);
        ws.close(4001, "unauthorized");
      }
    }, 5000);
  });
}

async function handleCommand(
  ws: WebSocket,
  st: SocketState,
  cmd: ClientCommand,
  authToken: string,
): Promise<void> {
  // hello is the ONLY command accepted before auth.
  if (cmd.type === "hello") {
    if (cmd.token === authToken) {
      st.authed = true;
      safeSend(ws, { type: "status", agent_id: "_server", state: "waiting", status_line: "connected" });
      // Replay the current world as initial state so a fresh client isn't blank until the next event.
      for (const rec of store.list()) {
        safeSend(ws, {
          type: "status",
          agent_id: rec.agent_id,
          state: rec.state,
          status_line: rec.status_line,
        });
      }
    } else {
      safeSend(ws, { type: "error", message: "bad token" } satisfies ServerEvent);
      ws.close(4001, "unauthorized");
    }
    return;
  }

  if (!st.authed) {
    safeSend(ws, { type: "error", message: "not authenticated (send hello first)" } satisfies ServerEvent);
    return;
  }

  switch (cmd.type) {
    case "spawn": {
      // Validate the untrusted frame: repo_id (slug), repo_path (bounded), optional label. An invalid
      // frame is rejected with an {error} rather than reaching the worktree/session layer.
      const repoCheck = validateId(cmd.repo_id, "repo_id");
      if (!repoCheck.ok) {
        safeSend(ws, { type: "error", message: repoCheck.error });
        return;
      }
      const pathCheck = validatePath(cmd.repo_path);
      if (!pathCheck.ok) {
        safeSend(ws, { type: "error", message: pathCheck.error });
        return;
      }
      const labelCheck = validateOptionalText(cmd.label, 200, "label");
      if (!labelCheck.ok) {
        safeSend(ws, { type: "error", message: labelCheck.error });
        return;
      }
      const r = await sessionManager.spawn({
        repoId: repoCheck.value,
        repoPath: pathCheck.value,
        characterKind: cmd.character_kind,
        label: labelCheck.value,
      });
      if (!r.ok) safeSend(ws, { type: "error", agent_id: r.agentId, message: r.error ?? "spawn failed" });
      return;
    }
    case "command": {
      const idCheck = validateId(cmd.agent_id);
      if (!idCheck.ok) {
        safeSend(ws, { type: "error", message: idCheck.error });
        return;
      }
      const promptCheck = validatePrompt(cmd.prompt);
      if (!promptCheck.ok) {
        safeSend(ws, { type: "error", agent_id: idCheck.value, message: promptCheck.error });
        return;
      }
      const r = await dispatchPrompt(idCheck.value, promptCheck.value);
      if (!r.ok) safeSend(ws, { type: "error", agent_id: idCheck.value, message: r.error });
      return;
    }
    case "interrupt": {
      const idCheck = validateId(cmd.agent_id);
      if (!idCheck.ok) {
        safeSend(ws, { type: "error", message: idCheck.error });
        return;
      }
      const ok = await sessionManager.interrupt(idCheck.value);
      if (!ok) safeSend(ws, { type: "error", agent_id: idCheck.value, message: "no live session" });
      return;
    }
    case "subscribe": {
      st.subscribed = cmd.agent_id ?? null;
      return;
    }
    case "list": {
      for (const rec of store.list()) {
        safeSend(ws, {
          type: "status",
          agent_id: rec.agent_id,
          state: rec.state,
          status_line: rec.status_line,
        });
      }
      return;
    }
    case "relay": {
      // Voice relay: re-broadcast a speaking/caption/status ServerEvent the voice client observed locally
      // so every other subscribed client (the in-world tells) sees it. Reached only after the auth guard
      // above, so only authed sockets can publish — BUT the relayed event is otherwise fully attacker-
      // authored, so it must run the SAME validate.ts gauntlet the HTTP/spawn/command paths do before it
      // touches the contract-typed bus. We never forward the client's object verbatim (that would let it
      // smuggle extra fields, an unbounded status_line/text, a non-AgentState `state`, or a spoofed/
      // traversal agent_id onto every other socket); instead we VALIDATE per type and rebuild a clean,
      // minimal event so only the contract fields with bounded values are fanned out.
      const ev = (cmd as { event?: ServerEvent }).event;
      if (!ev || typeof ev !== "object" || typeof (ev as { type?: unknown }).type !== "string") {
        safeSend(ws, { type: "error", message: "relay missing event payload" });
        return;
      }
      const raw = ev as Record<string, unknown>;
      const t = raw.type as string;

      // agent_id is required + slug-validated for all three relay types (no spoofed/traversal id).
      const idCheck = validateId(raw.agent_id, "agent_id");
      if (!idCheck.ok) {
        safeSend(ws, { type: "error", message: idCheck.error });
        return;
      }
      const agentId = idCheck.value;

      let clean: ServerEvent;
      if (t === "speaking") {
        clean = { type: "speaking", agent_id: agentId, speaking: raw.speaking === true };
      } else if (t === "caption") {
        // Bound the caption text (the only unbounded string on a caption) to the label cap.
        const textCheck = validateOptionalText(raw.text, MAX_LABEL_CHARS, "text");
        if (!textCheck.ok) {
          safeSend(ws, { type: "error", message: textCheck.error });
          return;
        }
        clean = { type: "caption", agent_id: agentId, text: textCheck.value ?? "" };
      } else if (t === "status") {
        // `state` must be a real AgentState; status_line is bounded. A relayed status can otherwise
        // spoof another agent's HUD state (B renders state via _match_clip substring).
        if (typeof raw.state !== "string" || !AGENT_STATES.has(raw.state)) {
          safeSend(ws, { type: "error", message: "relay status: invalid state" });
          return;
        }
        const lineCheck = validateOptionalText(raw.status_line, MAX_LABEL_CHARS, "status_line");
        if (!lineCheck.ok) {
          safeSend(ws, { type: "error", message: lineCheck.error });
          return;
        }
        clean = {
          type: "status",
          agent_id: agentId,
          state: raw.state as AgentState, // guarded by AGENT_STATES.has above
          status_line: lineCheck.value,
        };
      } else {
        safeSend(ws, { type: "error", message: `relay rejects event type: ${t}` });
        return;
      }
      store.publish(clean);
      return;
    }
    default: {
      safeSend(ws, { type: "error", message: `unknown command: ${(cmd as any)?.type}` });
    }
  }
}

function safeSend(ws: WebSocket, event: ServerEvent): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  } catch {
    /* socket went away mid-send */
  }
}
