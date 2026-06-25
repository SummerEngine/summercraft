# How AgentCraft Voice Works (Track C — canonical)

The one-line mental model:

> **You are not talking to Claude. You are talking to a realtime voice that is a mouthpiece and
> dispatcher for a real Claude Code session.** It speaks instantly, and when you want something done or
> looked into, it asks its session (the real worker) and relays the answer.

This is the *only* architecture that's actually possible — and it's the right one. Here's why, and how.

---

## The three layers (keep them straight)

| Layer | What it is | Can it read your code? |
|---|---|---|
| **Speech engine** | ElevenLabs: **Scribe** (realtime STT, hears you) + **Flash v2** (TTS, the voice you hear). | no — it's audio in/out |
| **Conversational brain** | The ElevenLabs agent's LLM (**Gemini Flash**). Runs the *conversation* — fast, chatty, low-latency. | **no** — it has no file/shell tools |
| **The worker** | The real **Claude Code session** the sidecar spawns locally, on your subscription, in the repo's worktree. Full toolset (Read/Write/Edit/Bash/MCP). | **yes — this is the one that does everything** |

The crucial point: **the conversational brain (Gemini) physically cannot look into things.** It can only
*talk* and *call tools*. The tools reach the worker (Claude), which does the reading, thinking, and editing.
So "realtime voice with Claude" really means "realtime voice → asks Claude → relays Claude."

---

## The full flow

```
   you speak                                          ┌─────────────── your machine ───────────────┐
      │  mic 16kHz PCM                                 │                                             │
      ▼                                                │                                             │
┌──────────────┐   audio over WS    ┌──────────────────────────┐   client tool call   ┌─────────────────────┐
│ Godot client │ ─────────────────▶ │  ElevenLabs cloud         │ ───────────────────▶ │ local sidecar :8787 │
│ VoiceWebSocket│ ◀───────────────── │  Scribe STT + Gemini +    │ ◀─────────────────── │  POST /agents/:id/* │
│  + MicCapture │   TTS audio back   │  Flash v2 TTS             │   tool result        └──────────┬──────────┘
└──────┬────────┘                    └──────────────────────────┘                                  │ spawns / prompts
       │ plays the voice from the                                                                  ▼
       │ clicked character (AgentVoicePlayer)                                          ┌─────────────────────┐
       │                                                                               │ real Claude session  │
       └── captions / speaking tell ─▶ the world                                       │ (full tools, worktree)│
                                                                                        └─────────────────────┘
```

**No tunnel, no custom-LLM.** The tool call comes *back to the client* (the game, which runs on your
machine) and the client calls `127.0.0.1`. ElevenLabs' cloud never has to reach your laptop. (The
abandoned alternative — pointing the agent's LLM at `127.0.0.1` as a "custom LLM" — would require a public
tunnel, which is why we don't do it.)

### Walkthrough
1. **Dive in.** B calls `VoiceWebSocket.start_dive(agent_id, npc)`. C fetches the agent's `/context`,
   injects it, opens the ElevenLabs conversation, and opens the mic.
2. **The agent greets**, already knowing (from injected context) what this character's session was doing.
3. **You speak.** Scribe transcribes → Gemini decides what to do.
4. **Gemini calls a tool** (below). The client handles it against the local sidecar and returns a result
   string, which Gemini speaks.
5. **Speaking/captions** flow back into the world (the character's speaking tell + floating caption).

---

## The tools (what Gemini can call)

| Tool | Use it for | Sync? | What happens |
|---|---|---|---|
| **`run_task(task)`** | **CHANGE** things ("fix the bug", "add an endpoint") | async | POST `/agents/:id/prompt` → the session works → "on it"; the result lands later via *result-back-to-voice* |
| **`ask_claude(question)`** | **LEARN** things ("what does X do?", "did tests pass?") | sync¹ | POST `/agents/:id/ask` → the session looks/answers → **its real words are spoken back** |
| **`get_status`** | "what are you working on?" | sync | reads `/world` → state / current task |
| **`commit_work`** | "commit that" | async | POST `/agents/:id/prompt` with a commit instruction |

The rule baked into the prompt: **`run_task` to change things, `ask_claude` to learn things. The voice
never reads code itself — it asks its session and relays.**

¹ `ask_claude` is sync **once A ships `POST /agents/:id/ask`**. Until then it auto-falls-back to async
(`/prompt`), and the answer arrives via result-back-to-voice — so questions work today, just with a beat
of delay ("lemme look… here's what it says").

---

## Context & memory — "does it know what the session was doing?"

**Yes, in two layers — and it is NOT a fresh, memoryless chat:**

1. **The worker session persists.** Each character = one real Claude session that keeps its full context
   across turns (in its worktree). It remembers everything it did.
2. **On the dive, C injects a catch-up summary** from the sidecar's `/agents/:id/context`:
   `branch · PR · diff · current task · recent transcript`. So the voice opens already grounded in where
   the session left off. (Injected two ways: ElevenLabs **dynamic variables** fill the prompt's
   `{{placeholders}}`, and a **contextual_update** carries the recent-history catch-up.)

**What the voice does NOT have:** the session's *raw full context window*. You can't pour 100k tokens into a
realtime voice LLM — different model, different context. You don't need to: the voice gets a **summary up
front** and **queries the session live** (`ask_claude` / `get_status`) for anything deeper. The session has
the full memory; the voice fetches on demand.

> Fidelity ceiling: how good "catch me up" feels = how rich `/context` is. Today it returns the last few
> transcript lines + diff. A richer `/context` (a session-generated work summary, more history) makes it
> better — that's an A-side enhancement; C injects whatever `/context` returns automatically.

---

## Ownership & seams

**C owns:** `scripts/voice_websocket.gd` (the `VoiceWebSocket` autoload — ElevenLabs transport, mic, audio,
context injection), `scripts/voice_bridge.gd` (tool dispatch → sidecar + result-back-to-voice; a child of
the autoload), `scripts/mic_capture.gd`, `scripts/agent_voice_player.gd`, and `voice-web/**` (config, setup
script, browser proof harness, init-check).

**C calls A's sidecar HTTP** (`/voice/signed-url`, `/agents/:id/prompt`, `/agents/:id/context`,
`/agents/:id/ask`) and emits WS `relay` frames.

**The B seam (the dive)** — B calls, C handles the rest:
```gdscript
VoiceWebSocket.start_dive(agent_id, agent_voice_player)   # fetch /context + talk + open mic
VoiceWebSocket.end_conversation()                          # on exit
VoiceWebSocket.prime_mic()                                 # once at boot: fire the mic-permission dialog
# B renders these signals: caption(text), speaking_changed(on)
```

---

## Setup (one command)

The agent config (prompt, tools, models, dynamic-var defaults) lives in `voice-web/voice.config.mjs` and is
applied with:
```bash
ELEVENLABS_API_KEY=sk_… node voice-web/setup-agent.mjs        # creates/updates the agent, prints its id
```
The sidecar needs `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` in its env; it mints a short-lived signed URL
(`/voice/signed-url`) so the **key never reaches the game**. Open-source users run the same one command with
their own key → their own agent. Tune behavior with the `/voice-tune` skill. Full operational detail:
`voice-web/README.md`.

---

## What's live vs pending

- ✅ **Live:** realtime talk, `run_task` (real edits on your subscription), `ask_claude` (async today),
  `get_status`, `commit_work`, context catch-up injection, result-back-to-voice, positional audio,
  speaking/captions, the full failure-mode hardening below. Verified in-engine + handshake-proven.
- ⏳ **Pending A (upgrades, not blockers):** `POST /agents/:id/ask` (makes `ask_claude` synchronous);
  a richer `/context` work-summary (makes "catch me up" deeper).

---

## Failure modes (hardened so it never dies on stage)

- **Mic permission denied** → a watchdog detects a silent bus and says "check microphone permission"
  (and `prime_mic()` fires the OS prompt at boot, not mid-demo).
- **ElevenLabs error / rate-limit / quota / auth** → error-frame + close-code handlers speak a short
  friendly caption instead of going silent.
- **Sidecar down / agent busy / 404** → spoken-friendly reasons, not raw status codes.
- **Voice not configured** (no key/agent) → an actionable caption, not a confusing socket close.
- **Best-effort everywhere** → if the sidecar or context fetch fails, the dive still works visually;
  voice never blocks the world.

---

*This is the conceptual reference. `voice-web/README.md` = setup/run detail; code comments = line-level specifics.*
