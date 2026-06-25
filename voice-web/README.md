# AgentCraft — Voice (Track C)

> **New here? Read [`docs/VOICE_ARCHITECTURE.md`](../docs/VOICE_ARCHITECTURE.md) first** — the canonical
> "how the voice actually works" (the three layers, ask-vs-do, context catch-up, what's live vs pending).
> This file is the setup/run detail.

**The committed path: client tool, no custom-LLM, no tunnel.**

The ElevenLabs agent uses its **own cloud LLM** for the conversation (fast). It does **not** do the
coding. When the player asks for real work, the agent calls the **`run_task` client tool**. A client
tool is handled **in the client** (the Godot game, or this browser harness) — so the dispatch reaches
the **local** sidecar directly. The sidecar runs the real Claude Code session on your subscription.

```
ElevenLabs cloud (STT + its own LLM + Flash v2 TTS)
        ▲  realtime audio + the run_task tool call
        │
  CLIENT (native Godot voice_websocket.gd  OR  this voice-web page)
        │  run_task -> POST http://127.0.0.1:8787/agents/<character_id>/prompt { prompt }
        ▼
  local sidecar (127.0.0.1:8787) ──> that character's live Claude Code session ──> real diff
```

Why no tunnel: the tool is handled on the client, which already runs on your machine, so ElevenLabs'
cloud never has to reach `127.0.0.1`. (The older custom-LLM design pointed the agent's LLM at
`127.0.0.1:8787/v1/chat/completions`, which only works if ElevenLabs' servers can reach your laptop —
i.e. a public tunnel. That path is abandoned; the shim still exists in `sidecar/` but is unused here.)

## Files (Track C owns all of these)

| File | Role |
|---|---|
| `scripts/voice_websocket.gd` | **`VoiceWebSocket` autoload.** Native ElevenLabs transport (ported from Walk-with-Bob): mic stream, audio playback, the frame switch, and the contract seam `start_conversation(character_id, context)` / `end_conversation()` / signals `caption` · `speaking_changed` · `tool_called`. Connects via the local sidecar signed URL. |
| `scripts/voice_bridge.gd` | Game-side glue (a **child** of `VoiceWebSocket`, no autoload entry needed). Dispatches `run_task` / `get_status` / `commit_work` to the sidecar HTTP API and answers the tool; optional speaking/caption relay. |
| `scripts/mic_capture.gd` | Native mic capture (16 kHz PCM16) — verbatim Bob port. |
| `scripts/agent_voice_player.gd` | Positional 3D voice playback + speaking tell, child of the clicked character — distilled from Bob. |
| `voice-web/{index.html,client.js}` | Browser **proof harness** — the same client-tool loop without launching Godot. |
| `voice-web/smoke.sh` | No-voice proof: curls the sidecar layers `run_task` depends on. |

## ElevenLabs agent setup — config-driven (one file, one command)

The agent is **declarative**: [`voice-web/voice.config.mjs`](voice.config.mjs) is the single source of
truth (system prompt, first message, LLM, voice, ASR, turn-taking, tools, privacy — every knob, in
ElevenLabs' own shape, commented). `setup-agent.mjs` applies it:

```bash
ELEVENLABS_API_KEY=sk_... node voice-web/setup-agent.mjs
```

- **First run** creates the agent + the `run_task` / `send_message` / `get_status` / `commit_work`
  client tools, and remembers the id in `voice-web/.agent-id` (gitignored).
- **Every later run** UPDATEs the same agent to match the config (PATCH). So the whole customization
  loop is: edit `voice.config.mjs` → re-run. Tools are reused by name (no duplicates).
- Force a new agent with `FORCE_CREATE=1`; target a specific one with `AGENT_ID=agent_...`.

**Tune it without editing the file yourself:** the [`voice-tune`](../.claude/skills/voice-tune/SKILL.md)
skill edits `voice.config.mjs` from plain English ("it interrupts me", "it mishears Aiven", "talk
slower", "use a different voice") and re-applies. Every user tunes the agent to how *they* talk.

The config is open-source-safe: it contains no secrets (the key stays in env). Downstream users run the
same one command with their own key.

## ElevenLabs agent configuration (the manual way, in the dashboard)

One shared **template agent** serves every character — per-character routing is just the
`character_id` we send per conversation. Do **not** make one agent per character.

1. **Create one Conversational AI agent.** Name it e.g. `AgentCraft`.
2. **LLM:** any normal model (e.g. Gemini Flash / GPT-4o-mini / Claude Haiku — pick for latency).
   **NOT** Custom LLM. This LLM only runs the *conversation*; the coding happens via `run_task`.
3. **System prompt** (paste, tune to taste):
   > You are {{label}}, a coding agent inside a game world. The player walks up and talks to you.
   > You are working in repo {{repo}} on branch {{branch}}; your current task is {{task}}.
   > Keep replies short and spoken-natural. When the player asks you to write code, change something,
   > fix a bug, run a command, or do any development work, CALL the `run_task` tool with a clear,
   > self-contained task description — do not pretend to do it yourself. After calling it, tell the
   > player you're on it. Use `get_status` if they ask what you're doing. Use `commit_work` if they
   > ask you to commit.
4. **First message** (optional): `Hey — {{label}} here. What do you need?`  (`{{label}}` is injected.)
5. **Client tools** — add these (Tools → Add tool → **Client**). Names/params must match exactly:

   - **`run_task`** — *Dispatch a development task to my real coding session.*
     - `task` *(string, required)* — A clear, self-contained description of the work to do.
   - **`get_status`** *(optional)* — *Report what I'm currently working on.* — no params.
   - **`commit_work`** *(optional)* — *Commit my current changes.* — no params.

   The client (game / this page) returns each tool's result string; the agent reads it back.
6. **Dynamic variables:** declare `label`, `repo`, `branch`, `task` (and `persona`, `pr`,
   `diff_summary` if you use them) so the `{{...}}` placeholders resolve. The client supplies them per
   conversation; unset ones fall back to the agent defaults.
7. **TTS:** `Flash v2` (`eleven_flash_v2`) — lowest-latency English model (the API rejects the
   multilingual `eleven_flash_v2_5` for English-only agents). Load-bearing for a live demo.

> No dashboard "Security / extra-body" toggle is needed anymore — that was only for the custom-LLM
> route. Client tools are first-class.

## Sidecar env (the key lives ONLY here, never in the game)

```bash
export ELEVENLABS_API_KEY="sk_..."      # required for live voice; sidecar-only, never scrubbed
export ELEVENLABS_AGENT_ID="agent_..."  # the shared template agent
# then start the sidecar (Track A): npm run sidecar   (serves HTTP + WS on 127.0.0.1:8787)
```

`GET /voice/signed-url` mints a short-lived ElevenLabs signed URL from these. If either is unset it
returns `{ "configured": false, "reason": ... }` (HTTP 200) and the client surfaces "voice not
configured" instead of hanging.

## Prove the loop WITHOUT voice first (do this before touching the mic)

`run_task` only needs two tokenless localhost routes. Prove them in one command:

```bash
bash voice-web/smoke.sh            # defaults to character a1
bash voice-web/smoke.sh <agent_id> # target a specific agent from GET /world
```

It checks `/health`, prints `/voice/signed-url` (shows whether ElevenLabs env is set), lists `/world`
agents, then POSTs a real `run_task` prompt to `/agents/<id>/prompt` and asserts a `202`. A `202`
means the exact call the voice tool makes reaches a live Claude session. (Watch the sidecar log / the
world feed to see the agent actually work.)

## Run the browser harness (fastest end-to-end proof)

1. Sidecar up with the env above (`/health` returns ok, `/voice/signed-url` returns `configured:true`).
2. Configure the template agent (above).
3. Serve `voice-web/` over http (mic needs a secure context; `127.0.0.1` qualifies):
   ```bash
   npx serve voice-web        # or: python3 -m http.server --directory voice-web 5173
   ```
4. Open the page, pick a character, **hold Talk** (or hold `Space`) and say e.g.
   *"Add a /health endpoint that returns ok."* The agent calls `run_task`, the page POSTs the sidecar,
   and that character's Claude session does the real work. The transcript pane logs the `run_task` call.

## Native Godot voice (the in-game dive — what Track B calls)

`VoiceWebSocket` is the seam. On the first-person dive, Track B:

```gdscript
# point the voice at the clicked character's positional audio sink, then start with context
VoiceWebSocket.set_target_npc(clicked_agent_voice_player)   # an AgentVoicePlayer child of the NPC
VoiceWebSocket.start_conversation(agent_id, {
    "label": "Vinny", "repo": "my-app",
    "branch": "agentcraft/build", "task": "add a health endpoint",
})
# render the tell + captions straight off the voice signals (no relay needed single-machine):
VoiceWebSocket.speaking_changed.connect(_on_voice_speaking)   # bool
VoiceWebSocket.caption.connect(_on_voice_caption)             # String
# on exit:
VoiceWebSocket.end_conversation()
```

`context` is injected two ways: as ElevenLabs **dynamic variables** (fills the `{{...}}` prompt
placeholders) and as a non-spoken **contextual_update** sent right after connect (so the agent opens
grounded in the branch/task/diff even if the dashboard prompt has no placeholders). Recognized context
keys: `label, persona, repo, branch, task, diff_summary, pr` — all optional.

Recording is push-to-talk: call `VoiceWebSocket.start_recording()` while the talk button is held and
`stop_recording()` on release (kills stage echo / false barge-in). `set_muted(true)` is the soft path.

## Optional: in-world captions for OTHER viewers (the relay)

Single-machine demos don't need this — Track B reads `VoiceWebSocket`'s `caption`/`speaking_changed`
directly. For multiple viewers, `voice_bridge.gd` can mirror those events to the sidecar via the
additive `relay` ClientCommand (`{ "type":"relay", "event": {type:"caption"|"speaking", agent_id, ...} }`),
which the sidecar re-broadcasts to every subscribed client. Set `relay_enabled = true` on the
`VoiceBridge` child (and in the browser harness, `relayEnabled: true` + paste `runtime/auth.token`).
The relay needs the per-launch WS token; the run_task path does not.

## Latency / echo mitigations (all real, all in this track)

- **Flash v2 TTS** — lowest-latency English ElevenLabs model, set on the agent.
- **Pre-warmed sockets** — the relay socket opens on `_ready`; the ElevenLabs socket opens on the
  first Talk.
- **Push-to-talk** — hold to speak (no open-mic VAD), removing speaker echo / false barge-in on a live
  stage. Headset recommended.
- **Async dispatch** — `run_task` returns `202` immediately and the agent says "on it"; the world
  animation + the agent's follow-up reflect completion, so the voice turn never blocks on Claude.
