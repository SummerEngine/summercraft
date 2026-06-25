#!/usr/bin/env node
/**
 * AgentCraft — apply voice.config.mjs to the ElevenLabs agent (Track C).
 *
 * Single command that makes the live agent match voice.config.mjs:
 *   - creates/reuses the client tools (by name),
 *   - creates the agent on first run (and remembers its id in voice-web/.agent-id, gitignored),
 *   - UPDATES it (PATCH) on every later run, so editing the config + re-running is the whole flow.
 *
 *   ELEVENLABS_API_KEY=sk_... node voice-web/setup-agent.mjs
 *
 * Nothing secret is written to disk (only the non-secret agent id). The /voice-tune skill edits the
 * config for you; this just applies it.
 *
 * Force a fresh agent: AGENT_ID="" FORCE_CREATE=1 node voice-web/setup-agent.mjs
 * Target a specific agent: AGENT_ID=agent_... node voice-web/setup-agent.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cfg from "./voice.config.mjs";

const API = "https://api.elevenlabs.io/v1/convai";
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("ERROR: set ELEVENLABS_API_KEY (sk_...) in env first.");
  process.exit(1);
}
const ID_FILE = fileURLToPath(new URL("./.agent-id", import.meta.url));

async function el(path, body, method = "POST") {
  const r = await fetch(API + path, {
    method,
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);
  return data;
}

// Drop null-valued optional fields recursively (e.g. reasoning_effort/thinking_budget) so a model that
// doesn't accept an explicit null on a field can't 422 the whole apply.
function stripNulls(o) {
  if (Array.isArray(o)) return o.map(stripNulls);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return o;
}

const tName = (t) => t?.name || t?.tool_config?.name || "";
const tId = (t) => t?.id || t?.tool_id || t?.tool_config?.id;

async function existingToolsByName() {
  try {
    const list = await el("/tools", null, "GET");
    const arr = Array.isArray(list) ? list : list.tools || [];
    const map = {};
    for (const t of arr) if (tName(t)) map[tName(t)] = tId(t);
    return map;
  } catch {
    return {};
  }
}

async function ensureTools() {
  const existing = await existingToolsByName();
  const ids = [];
  for (const t of cfg.TOOLS) {
    let id = existing[t.name];
    if (id) {
      console.log(`  tool ${t.name.padEnd(13)} -> ${id} (reused)`);
    } else {
      const tool_config = { type: "client", name: t.name, description: t.description, expects_response: true, response_timeout_secs: 30 };
      if (t.parameters) tool_config.parameters = t.parameters;
      const created = await el("/tools", { tool_config });
      id = tId(created);
      if (!id) throw new Error(`tool ${t.name}: no id in response: ${JSON.stringify(created)}`);
      console.log(`  tool ${t.name.padEnd(13)} -> ${id}`);
    }
    ids.push(id);
  }
  return ids;
}

function readSavedId() {
  if (process.env.AGENT_ID !== undefined) return process.env.AGENT_ID || null;
  if (process.env.FORCE_CREATE) return null;
  return existsSync(ID_FILE) ? readFileSync(ID_FILE, "utf8").trim() || null : null;
}

async function main() {
  // 1) tools, then fold their ids into the prompt
  const toolIds = await ensureTools();
  const conversation_config = structuredClone(cfg.conversation_config);
  conversation_config.agent.prompt.tool_ids = toolIds;

  const body = stripNulls({ name: cfg.NAME, conversation_config, platform_settings: cfg.platform_settings });

  // 2) create on first run, update (PATCH) thereafter
  const existingId = readSavedId();
  let agentId;
  if (existingId) {
    await el(`/agents/${existingId}`, body, "PATCH");
    agentId = existingId;
    console.log(`\n  updated agent ${agentId}`);
  } else {
    const created = await el("/agents/create", body);
    agentId = created.agent_id || created.id;
    if (!agentId) throw new Error(`agent created but no id: ${JSON.stringify(created)}`);
    writeFileSync(ID_FILE, agentId + "\n", { mode: 0o644 });
    console.log(`\n  created agent ${agentId}  (saved to voice-web/.agent-id)`);
  }

  const p = conversation_config;
  console.log(`  llm=${p.agent.prompt.llm}  tts=${p.tts.model_id}/${p.tts.voice_id}  turn_timeout=${p.turn.turn_timeout}s  tools=${toolIds.length}`);
  console.log("\nPoint the sidecar at it:");
  console.log(`  export ELEVENLABS_AGENT_ID="${agentId}"`);
}

main().catch((e) => {
  console.error("\nApply failed:\n" + e.message);
  process.exit(1);
});
