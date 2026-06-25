/**
 * AgentCraft voice — browser PROOF HARNESS (Track C).
 *
 * Same committed path as the native Godot client (voice_websocket.gd + voice_bridge.gd), just in a
 * browser so you can prove the whole loop WITHOUT launching the game:
 *
 *   ElevenLabs Conversational AI agent (its OWN cloud LLM does the talking)
 *     --> calls the `run_task` CLIENT TOOL when you ask for work
 *       --> this page POSTs http://127.0.0.1:8787/agents/<character_id>/prompt { prompt }
 *         --> the real local Claude session does the work on your subscription.
 *
 * There is NO custom-LLM and NO tunnel: the tool is handled HERE (the client), which can reach
 * 127.0.0.1 directly, so ElevenLabs' cloud never needs to reach your machine.
 *
 * The ElevenLabs agent must be configured (once, in the dashboard) with a `run_task` client tool and
 * a system prompt that calls it for dev work — see README.md "ElevenLabs agent configuration".
 *
 * The API KEY IS NEVER IN THIS FILE. Connect via a short-lived signed URL minted by the local sidecar
 * (GET /voice/signed-url, key stays server-side) or a public agent id. See README.
 */

import { Conversation } from "@elevenlabs/client";

// ---- Config injected by index.html (window.AGENTCRAFT_VOICE_CONFIG) -------------------------
const CFG = Object.assign(
  {
    agentId: "", // ElevenLabs agent id (public-agent path); leave "" to use the signed URL
    // Local sidecar signed-url relay. Returns { configured, signed_url, agent_id }; key stays server-side.
    signedUrlEndpoint: "http://127.0.0.1:8787/voice/signed-url",
    sidecarHttp: "http://127.0.0.1:8787", // run_task / get_status target (tokenless on localhost)
    sidecarWsUrl: "ws://127.0.0.1:8787/",
    sidecarToken: "", // per-launch token from runtime/auth.token (only needed for the relay)
    defaultCharacterId: "a1",
    defaultCharacterLabel: "Vinny",
    // Mirror caption/speaking to the sidecar so other viewers see the in-world tell. Off by default —
    // the spoken voice + real work do NOT depend on it.
    relayEnabled: false,
  },
  window.AGENTCRAFT_VOICE_CONFIG || {},
);

// ---- DOM ------------------------------------------------------------------------------------
const els = {
  talk: document.getElementById("talk"),
  status: document.getElementById("status"),
  character: document.getElementById("character"),
  transcript: document.getElementById("transcript"),
};

let conversation = null;
let connecting = false;
let activeCharacterId = CFG.defaultCharacterId;
let activeCharacterLabel = CFG.defaultCharacterLabel;

// ---- The client tools (this is the spine of the track) --------------------------------------
// ElevenLabs invokes these in the browser; we forward to the LOCAL sidecar. Each returns a short
// string the agent reads back. Real work is async (the POST returns 202) — the world animation +
// the agent's follow-up reflect completion; the tool result just confirms dispatch.
const clientTools = {
  async run_task(params) {
    const task = String(params?.task ?? params?.prompt ?? "").trim();
    const id = String(params?.character_id ?? params?.agent_id ?? activeCharacterId);
    if (!task) return "No task text was provided.";
    logLine(`run_task(${id}): ${task}`);
    try {
      const r = await fetch(`${CFG.sidecarHttp}/agents/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: task }),
      });
      if (r.status === 202) return `Task dispatched to ${id} — it's working on it now.`;
      const detail = await r.text().catch(() => "");
      return `Could not dispatch the task (sidecar ${r.status} ${detail}).`;
    } catch (e) {
      return `Could not reach the sidecar: ${e?.message || e}.`;
    }
  },

  // ask_claude (also handles the legacy "send_message" name): ask the session a question and return its
  // real answer. Tries the synchronous /ask route; falls back to async /prompt if it isn't live yet.
  async ask_claude(params) {
    const q = String(params?.question ?? params?.message ?? params?.task ?? "").trim();
    const id = String(params?.character_id ?? params?.agent_id ?? activeCharacterId);
    if (!q) return "There's nothing to ask yet.";
    logLine(`ask_claude(${id}): ${q}`);
    try {
      const r = await fetch(`${CFG.sidecarHttp}/agents/${encodeURIComponent(id)}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (r.status === 200) {
        const { answer } = await r.json().catch(() => ({}));
        if (answer) return String(answer);
      }
      if (r.status === 404) {
        // /ask not live yet -> async fallback via /prompt; answer arrives via result-back-to-voice.
        const f = await fetch(`${CFG.sidecarHttp}/agents/${encodeURIComponent(id)}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: q }),
        });
        return f.status === 202 ? "Looking into that now — I'll tell you in a sec." : `Couldn't ask (sidecar ${f.status}).`;
      }
      return `Couldn't ask (sidecar ${r.status}).`;
    } catch (e) {
      return `Could not reach the sidecar: ${e?.message || e}.`;
    }
  },
  send_message(params) { return this.ask_claude(params); },

  async get_status(params) {
    const id = String(params?.character_id ?? params?.agent_id ?? activeCharacterId);
    try {
      const r = await fetch(`${CFG.sidecarHttp}/world`);
      const world = await r.json();
      const a = (world.agents || []).find((x) => x.agent_id === id);
      if (!a) return `No status for ${id} yet.`;
      return JSON.stringify({ state: a.state, status_line: a.status_line, current_task: a.current_task });
    } catch (e) {
      return `Could not reach the world state: ${e?.message || e}.`;
    }
  },

  async commit_work(params) {
    const id = String(params?.character_id ?? params?.agent_id ?? activeCharacterId);
    const prompt =
      "Commit your current changes with a clear, concise message, then reply with just the commit subject line.";
    try {
      const r = await fetch(`${CFG.sidecarHttp}/agents/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      return r.status === 202 ? "Commit started — watch the feed for the result." : `Could not start the commit (sidecar ${r.status}).`;
    } catch (e) {
      return `Could not reach the sidecar: ${e?.message || e}.`;
    }
  },
};

// ---- Sidecar WS (optional relay so other viewers see the tell) ------------------------------
let ws = null;

function connectSidecar() {
  if (!CFG.relayEnabled) return;
  try {
    ws = new WebSocket(CFG.sidecarWsUrl);
  } catch (e) {
    logLine("sidecar WS unavailable (relay disabled): " + e);
    return;
  }
  ws.addEventListener("open", () => sendToSidecar({ type: "hello", token: CFG.sidecarToken }));
  ws.addEventListener("close", () => setTimeout(connectSidecar, 1500));
  ws.addEventListener("error", () => {});
}

function sendToSidecar(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* best-effort */
    }
  }
}

function relayEvent(event) {
  if (!CFG.relayEnabled) return;
  sendToSidecar({ type: "relay", event });
}
function emitCaption(text) {
  relayEvent({ type: "caption", agent_id: activeCharacterId, text });
}
function emitSpeaking(speaking) {
  relayEvent({ type: "speaking", agent_id: activeCharacterId, speaking });
}

// ---- ElevenLabs Conversation lifecycle ------------------------------------------------------
async function startConversation() {
  if (conversation || connecting) return;
  connecting = true;
  setStatus("connecting…");

  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});

    const sessionOpts = {
      clientTools,
      // Inject who the agent is + what it's working on into the prompt placeholders ({{label}} etc.).
      dynamicVariables: {
        character_id: activeCharacterId,
        label: activeCharacterLabel,
      },

      onConnect: () => {
        setStatus("connected");
        logLine(`connected as ${activeCharacterLabel}`);
        proactiveOpener();
      },
      onDisconnect: () => {
        setStatus("disconnected");
        emitSpeaking(false);
        conversation = null;
        els.talk.classList.remove("talking");
      },
      onError: (err) => {
        logLine("error: " + (err?.message || err));
        setStatus("error");
      },
      onModeChange: ({ mode }) => {
        const speaking = mode === "speaking";
        emitSpeaking(speaking);
        els.status.dataset.mode = mode;
      },
      onMessage: ({ message, source }) => {
        if (!message) return;
        logLine(`${source === "ai" ? activeCharacterLabel : "you"}: ${message}`);
        if (source === "ai") emitCaption(message);
      },
    };

    if (CFG.agentId) {
      conversation = await Conversation.startSession({ agentId: CFG.agentId, ...sessionOpts });
    } else {
      const signedUrl = await fetchSignedUrl();
      conversation = await Conversation.startSession({ signedUrl, ...sessionOpts });
    }
  } catch (e) {
    logLine("failed to start: " + (e?.message || e));
    setStatus("error");
    conversation = null;
  } finally {
    connecting = false;
  }
}

async function fetchSignedUrl() {
  // The local sidecar holds ELEVENLABS_API_KEY; the browser only ever sees the short-lived signed URL.
  // Shape: { configured:true, signed_url, agent_id } | { configured:false, reason }.
  const sep = CFG.signedUrlEndpoint.includes("?") ? "&" : "?";
  const url = CFG.agentId ? `${CFG.signedUrlEndpoint}${sep}agent_id=${encodeURIComponent(CFG.agentId)}` : CFG.signedUrlEndpoint;
  const r = await fetch(url);
  if (!r.ok) throw new Error("signed-url endpoint " + r.status);
  const data = await r.json();
  if (data.configured === false) throw new Error("voice not configured: " + (data.reason || "?"));
  const signedUrl = data.signed_url || data.signedUrl;
  if (!signedUrl) throw new Error("signed-url endpoint returned no signed_url");
  return signedUrl;
}

function proactiveOpener() {
  try {
    if (conversation?.sendContextualUpdate) {
      conversation.sendContextualUpdate(
        `You are ${activeCharacterLabel}, a coding agent. The player just walked up. Greet them briefly in character and ask what they need. When they ask for development work, call the run_task tool.`,
      );
    } else if (conversation?.sendUserMessage) {
      conversation.sendUserMessage("(player walked up)");
    }
  } catch {
    /* non-fatal — dashboard first_message still covers the opener */
  }
}

async function endConversation() {
  emitSpeaking(false);
  try {
    await conversation?.endSession();
  } catch {
    /* ignore */
  }
  conversation = null;
}

// ---- Push-to-talk wiring --------------------------------------------------------------------
function bindPushToTalk() {
  const down = async (e) => {
    e.preventDefault();
    els.talk.classList.add("talking");
    if (!conversation) await startConversation();
    setStatus("listening…");
    try {
      conversation?.setMicMuted?.(false);
    } catch {}
  };
  const up = (e) => {
    e.preventDefault();
    els.talk.classList.remove("talking");
    setStatus("processing…");
    try {
      conversation?.setMicMuted?.(true);
    } catch {}
  };

  els.talk.addEventListener("pointerdown", down);
  els.talk.addEventListener("pointerup", up);
  els.talk.addEventListener("pointercancel", up);
  els.talk.addEventListener("pointerleave", (e) => {
    if (els.talk.classList.contains("talking")) up(e);
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) down(e);
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") up(e);
  });
}

// ---- Character selection --------------------------------------------------------------------
function bindCharacterSelect() {
  if (!els.character) return;
  els.character.addEventListener("change", async () => {
    const opt = els.character.selectedOptions[0];
    activeCharacterId = els.character.value || CFG.defaultCharacterId;
    activeCharacterLabel = opt?.dataset?.label || opt?.textContent || activeCharacterId;
    // Re-route by restarting the session so the new character_id is in scope for the tools + prompt.
    if (conversation) {
      await endConversation();
      await startConversation();
    }
  });
}

// ---- UI helpers -----------------------------------------------------------------------------
function setStatus(s) {
  if (els.status) els.status.textContent = s;
}
function logLine(line) {
  if (!els.transcript) return;
  const div = document.createElement("div");
  div.className = "line";
  div.textContent = line;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function applyCharacterFromUrl() {
  let id = "";
  try {
    id = new URLSearchParams(window.location.search).get("character") || "";
  } catch {
    return;
  }
  if (!id) return;
  activeCharacterId = id;
  if (els.character) {
    const opt = [...els.character.options].find((o) => o.value === id);
    if (opt) {
      els.character.value = id;
      activeCharacterLabel = opt.dataset?.label || opt.textContent || id;
    } else {
      activeCharacterLabel = id;
    }
  }
}

// ---- Boot -----------------------------------------------------------------------------------
function main() {
  if (!els.talk) return;
  setStatus("idle");
  applyCharacterFromUrl();
  connectSidecar();
  bindPushToTalk();
  bindCharacterSelect();
  window.addEventListener("beforeunload", () => {
    void endConversation();
  });
}

main();

export { startConversation, endConversation };
