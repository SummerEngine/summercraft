# AgentCraft voice — ElevenLabs agent config (native Godot pipeline)

The voice path is the **native voice pipeline ported into Godot** (mic_capture.gd +
voice_websocket.gd + agent_voice_player.gd), NOT a browser flow. ElevenLabs does STT + turn-taking +
TTS in the cloud; the **brain** is swapped from Bob to the live AgentCraft Claude session by pointing
ONE ElevenLabs agent's LLM at this sidecar's custom-LLM shim.

## One agent, custom-LLM brain = the sidecar

In the ElevenLabs dashboard, configure a single Conversational-AI agent:

- **LLM**: `Custom LLM`
- **Server URL**: `http://127.0.0.1:8787/v1/chat/completions`  (the sidecar OpenAI-shim; see `openai-shim.ts`)
- **Model ID**: any placeholder (e.g. `agentcraft`). The shim ignores it unless used as the
  one-agent-per-character fallback (mechanism (b) below).
- **TTS**: Flash v2.5 (low latency).
- **First message / greeting**: optional; the native client sends `conversation_initiation_client_data`
  to trigger the opener.

The voice you hear is the live Claude `AgentSession` for whichever character the player clicked — the
shim proxies each turn to `sessionManager.runAgentTurn(characterId, prompt)`. No code change is needed
on the sidecar to swap the brain; it is a dashboard setting.

## Per-character routing (which clicked agent answers)

The shim resolves the character as `characterId = body.character_id ?? body.model`. Two mechanisms,
**both need ZERO sidecar changes**:

- **(a) preferred** — one ElevenLabs agent. Godot's `start_conversation(elevenlabs_agent_id, character_id)`
  puts `character_id` into `conversation_initiation_client_data.dynamic_variables`, and the agent is
  configured to forward it to the custom-LLM as `customLlmExtraBody` so it lands as top-level
  `body.character_id`. Enable extra-body forwarding under the agent's **Security / custom-LLM**
  settings. (OPEN: confirm ElevenLabs forwards dynamic_variables into the custom-LLM body with a 5-min
  curl test before committing to (a).)
- **(b) fallback** — one ElevenLabs agent PER character, each with **Model ID = `<character_id>`**, all
  pointing at the same Server URL. The shim falls back to `body.model`. No dashboard extra-body feature
  required.

## Secrets + the signed-url relay (key never reaches the game)

The native client fetches a short-lived signed URL from the sidecar — AgentCraft is self-contained:

- `GET http://127.0.0.1:8787/voice/signed-url?agent_id=<elevenlabs_agent_id>`
  → `{ "configured": true, "signed_url": "...", "agent_id": "..." }`
- The `ELEVENLABS_API_KEY` lives **only** in the sidecar env and is **never** scrubbed
  (`scrubAnthropicEnv` strips only `ANTHROPIC_*`). The game receives the signed URL, never the key.
- If the key or agent id is unset, the route returns `{ "configured": false, "reason": "..." }` with
  HTTP 200 so Godot can fall back cleanly instead of hanging.

### Env

```
export ELEVENLABS_API_KEY=sk_...          # required for live voice; sidecar-only, never scrubbed
export ELEVENLABS_AGENT_ID=agent_...      # the single shared agent (mechanism (a)); or pass ?agent_id=
```

In `scripts/voice_websocket.gd`, point `SIGNED_URL_ENDPOINT` at
`http://127.0.0.1:8787/voice/signed-url` (instead of summerengine.com). Handle the
`{configured:false}` branch by surfacing a "voice not configured" caption rather than connecting.

## Captions + speaking tells back into the world (relay seam)

ElevenLabs `agent_response` / `audio` / `user_transcript` frames are observed natively in
`voice_websocket.gd`. To make the in-world speaking animation + floating caption appear on the clicked
agent for *every* connected viewer, the voice client re-emits them through the sidecar WS using the
additive `relay` command (contract.ts):

```
{ "type": "relay", "event": { "type": "speaking", "agent_id": "<id>", "speaking": true } }
{ "type": "relay", "event": { "type": "caption",  "agent_id": "<id>", "text": "..." } }
```

The sidecar (`server.ts` `handleCommand` → `case "relay"`) re-publishes the event on the store bus so
it fans out to all subscribed clients. Only `speaking` / `caption` / `status` events are accepted, and
only after hello-auth. A single-viewer demo can skip the relay and drive the tell locally; the relay
exists so multiple viewers stay in sync.
