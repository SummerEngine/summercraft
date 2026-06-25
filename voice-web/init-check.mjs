#!/usr/bin/env node
/**
 * AgentCraft — ElevenLabs conversation-init handshake proof (Track C). No mic, no game.
 *
 * Proves the layer smoke.sh can't: that the agent ACCEPTS conversation_initiation_client_data with our
 * dynamic variables and returns conversation_initiation_metadata (not a "missing dynamic variable"
 * error). This is exactly where C-1 fails if the {{placeholders}} aren't declared/sent.
 *
 *   ELEVENLABS_API_KEY=sk_... node voice-web/init-check.mjs
 *
 * Uses the agent id from $AGENT_ID or voice-web/.agent-id. Mints the signed URL directly (same call the
 * sidecar makes) so this works even if the sidecar isn't running. Exit 0 = handshake OK, 1 = rejected.
 * Node 18+ (global fetch + global WebSocket on 22+; this repo runs 23).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("ERROR: set ELEVENLABS_API_KEY (sk_...) in env.");
  process.exit(1);
}
if (typeof WebSocket === "undefined") {
  console.error("ERROR: no global WebSocket (need Node 22+). Run with a newer node.");
  process.exit(1);
}

const ID_FILE = fileURLToPath(new URL("./.agent-id", import.meta.url));
const AGENT_ID = process.env.AGENT_ID || (existsSync(ID_FILE) ? readFileSync(ID_FILE, "utf8").trim() : "");
if (!AGENT_ID) {
  console.error("ERROR: no agent id. Set AGENT_ID or run setup-agent.mjs first (writes voice-web/.agent-id).");
  process.exit(1);
}

// Full dynamic variable set — same fallbacks the clients send. The point of the check is that these
// resolve every {{placeholder}} in the prompt so the init is accepted.
const DYNAMIC_VARS = {
  character_id: "a1", label: "Vinny", repo: "my-app",
  branch: "agentcraft/build", task: "add a health endpoint", persona: "", pr: "", diff_summary: "",
};

async function signedUrl() {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(AGENT_ID)}`,
    { headers: { "xi-api-key": KEY } },
  );
  if (!r.ok) throw new Error(`get_signed_url -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  const { signed_url } = await r.json();
  if (!signed_url) throw new Error("no signed_url in response");
  return signed_url;
}

function handshake(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout: no conversation_initiation_metadata within 15s"));
    }, 15000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "conversation_initiation_client_data", dynamic_variables: DYNAMIC_VARS }));
    });
    ws.addEventListener("message", (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "ping") {
        ws.send(JSON.stringify({ pong_event: { event_id: m.ping_event?.event_id ?? 0 } }));
        return;
      }
      if (m.type === "conversation_initiation_metadata") {
        clearTimeout(timer);
        ws.close();
        resolve(m.conversation_initiation_metadata_event?.conversation_id || "(no id)");
      }
      // Some rejections arrive as an error frame rather than a socket close.
      if (m.type === "error" || m.error) {
        clearTimeout(timer);
        ws.close();
        reject(new Error("init rejected: " + JSON.stringify(m).slice(0, 300)));
      }
    });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("ws error: " + (e?.message || e))); });
    ws.addEventListener("close", (e) => {
      // A close BEFORE metadata = rejected init (the C-1 failure mode).
      if (e.code !== 1000 && e.code !== 1005) reject(new Error(`closed before metadata: ${e.code} ${e.reason || ""}`));
    });
  });
}

try {
  console.log(`agent ${AGENT_ID} — minting signed url...`);
  const url = await signedUrl();
  console.log("connecting + sending conversation_initiation_client_data...");
  const convId = await handshake(url);
  console.log(`\nPASS — agent accepted the init. conversation_id: ${convId}`);
  console.log("Dynamic variables resolved; C-1 (missing-placeholder rejection) is clear.");
  process.exit(0);
} catch (e) {
  console.error(`\nFAIL — ${e.message}`);
  console.error("If it's a missing dynamic variable, a {{placeholder}} in the prompt has no value and no");
  console.error("default — add it to conversation_config.agent.dynamic_variables in voice.config.mjs.");
  process.exit(1);
}
