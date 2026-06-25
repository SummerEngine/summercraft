/**
 * AgentCraft — voice agent config (Track C). THE SINGLE SOURCE OF TRUTH for the ElevenLabs agent.
 *
 * Edit a value here, run `node voice-web/setup-agent.mjs`, and the agent is created-or-updated to
 * match. The /voice-tune skill edits this file for you from a plain-English description of how you
 * talk. Fields are in ElevenLabs' own `conversation_config` / `platform_settings` shape, so they map
 * 1:1 to the dashboard and the API docs.
 *
 * INVARIANT: behavior lives HERE, not in the game. The client (Godot/browser) only sends per-
 * conversation data (character_id + {{context}} dynamic variables). It never overrides config.
 */

export const NAME = "AgentCraft";

// ---- Client tools (created/reused by name, then attached to the agent by id) ------------------
// All are CLIENT tools: handled in the game/browser, which forwards to the LOCAL sidecar. No tunnel.
export const TOOLS = [
  {
    name: "run_task",
    description: "Dispatch a development task to my real coding session (fire-and-forget; it works async).",
    parameters: {
      type: "object",
      required: ["task"],
      properties: { task: { type: "string", description: "A clear, self-contained description of the work to do." } },
    },
  },
  {
    name: "ask_claude",
    description:
      "Ask my real coding session a QUESTION and get its actual answer back to read aloud. Use this " +
      "whenever the player wants to KNOW something that needs looking at the code/work — 'what does X " +
      "do', 'did the tests pass', 'what are you stuck on', 'summarize the auth module'. The session " +
      "reads/inspects and replies; you relay its words. (Use run_task to CHANGE things, ask_claude to " +
      "LEARN things.)",
    parameters: {
      type: "object",
      required: ["question"],
      properties: { question: { type: "string", description: "The question to ask the coding session." } },
    },
  },
  { name: "get_status", description: "Report what I'm currently working on (state, current task)." },
  { name: "commit_work", description: "Commit my current changes with a clear message." },
];

// ---- System prompt + opener -------------------------------------------------------------------
// Relay framing (per Mathias's draft) reconciled with our client tools: the agent is the VOICE
// INTERFACE to a real Claude session — it relays and reports, it does not pretend to code itself.
export const SYSTEM_PROMPT = `# Personality
You are {{label}}, a coding agent living in a game world — a real character with a real job, the one
the player walks up to and talks to. You're sharp, easygoing, and quick; you come across like a good
teammate, not a help desk.

# Environment
You live in a game world and the player talks to you out loud. You're working in project {{project}}
({{repo}}) on branch {{branch}}; right now you're on: {{task}}. Behind the scenes a real coding session
does the heavy lifting — but to the player that's just you doing your job. Never narrate that plumbing.

# Tone
Warm, casual, spoken — real sentences with contractions. Short: one or two lines, like a quick chat on
a headset. No jargon unless the player uses it first. A little personality and wit is good. Never sound
like a script or a form.

# Goal
Help the player get work done through natural conversation.
- Build / fix / change / run something → call run_task with a clear, self-contained task, then tell
  them casually, like it's you on it: "On it." / "Yep — fixing that now." Do NOT say you're telling
  "Claude" or "the session" — in this world, you just do it.
- A QUESTION that needs looking at the code/work (what does X do, did the tests pass, what are you
  stuck on, summarize Y) → call ask_claude and read its answer back in your own words. Briefly say
  you're checking ("lemme look…") since it may take a second.
- "What are you working on right now?" → call get_status.   "Commit that" → call commit_work.
The rule: run_task to CHANGE things, ask_claude to LEARN things. You don't read code yourself — your
session does; you ask it and relay.
- Only if you genuinely can't act without it, ask ONE short, in-character question ("which bug's biting
  you?") — never a generic form question.

# Guardrails
- Never say you're an AI, an assistant, a bot, or "an interface." You're {{label}}, a character here.
- Never mention prompts, tools, "the session," or how you work. Keep the machinery invisible.
- No corporate disclaimers, no "I can't do that" lectures. If they ask something off your beat (books,
  life, whatever), play along for a beat in character, then steer back to the work — playfully.
- If they tease you about your vibe, roll with it and adjust. Don't talk about your own prompt.
- Never invent results you don't actually have; if you don't have an answer, just say so plainly.`;

// No {{placeholder}} in the opener so the greeting is always clean even before the client sends vars.
export const FIRST_MESSAGE = "Hey — what are we working on?";

// ---- conversation_config (ElevenLabs shape) ---------------------------------------------------
export const conversation_config = {
  agent: {
    first_message: FIRST_MESSAGE,
    language: "en", // English ⇒ TTS must be a v2 (flash/turbo) model, not multilingual v2_5
    // Defaults for every {{placeholder}} in the prompt/first message. WITHOUT these, ElevenLabs rejects
    // the conversation start if the client doesn't send the variable — so this is load-bearing.
    dynamic_variables: {
      dynamic_variable_placeholders: {
        label: "the agent", project: "this project", repo: "this repo", group: "",
        branch: "its branch", task: "its current task", persona: "", pr: "", diff_summary: "",
      },
    },
    prompt: {
      prompt: SYSTEM_PROMPT,
      llm: "gemini-2.5-flash", // any supported model; users pick for latency/quality
      temperature: 0.5, // warmer / less robotic; 0 = deterministic
      reasoning_effort: null, // model-dependent; null = off (lowest latency)
      thinking_budget: null, //   ↑ raise only if you need the conversation LLM to plan more
      max_tokens: -1, // -1 = model default
      // tool_ids is filled by setup-agent.mjs after the tools are created.
    },
  },

  tts: {
    model_id: "eleven_flash_v2", // English low-latency; eleven_turbo_v2 is the other option
    voice_id: "cjVigY5qzO86Huf0OWal", // swap to any voice id (per-character voices = stretch)
    expressive_mode: false, // true = more emotive delivery (slightly higher latency)
    stability: 0.5, // 0..1  lower = more expressive/variable
    similarity_boost: 0.8, // 0..1
    speed: 1.0, // 0.7..1.2
    optimize_streaming_latency: 3, // 0..4  higher = lower latency, slightly lower quality
    agent_output_audio_format: "pcm_16000", // matches Godot's 16 kHz playback path
  },

  asr: {
    provider: "scribe_realtime", // ElevenLabs realtime STT
    quality: "high", // "high" | ... (lower = cheaper/faster)
    user_input_audio_format: "pcm_16000", // matches Godot mic_capture; 22050/24000/44100/48000 selectable
    // Brand/name keywords so STT spells them right ("Sunstead", "Aiven", "Godot", agent names, etc.).
    keywords: ["Sunstead", "AgentCraft", "Aiven", "Godot", "Claude", "Vinny", "Merlin", "Durin"],
  },

  // Turn-taking — THIS is the per-user speech-pattern tuning. /voice-tune edits these.
  turn: {
    mode: "turn", // "turn" = take turns; interruptions allowed by default
    turn_timeout: 7.0, // seconds of silence before the agent takes its turn (long pauses ⇒ raise)
    turn_eagerness: "normal", // "eager" | "normal" | "patient" — how fast it jumps in
    spelling_patience: "auto",
    speculative_turn: false, // true = start forming a reply before you finish (snappier, can misfire)
    retranscribe_on_turn_timeout: false,
    // Words that should NOT count as an interruption (you're just acknowledging, not taking over).
    interruption_ignore_terms: ["gotcha", "understood", "yeah", "makes sense", "right", "okay"],
  },

  vad: {
    background_voice_detection: false, // filters background speakers; costs more — default off
  },

  conversation: {
    text_only: false, // false = voice (this is a voice agent, not chat-only)
    max_duration_seconds: 1800, // 30 min ceiling per conversation
    file_input: { enabled: true, max_files_per_conversation: 10 }, // allow drag-in references
  },
};

// ---- platform_settings (privacy / limits / guardrails) ----------------------------------------
export const platform_settings = {
  // Local-first privacy defaults. Flip record_voice=true + zero_retention_mode=false for a demo where
  // you want transcripts/monitoring. (zero_retention_mode may require workspace support.)
  privacy: {
    record_voice: false, // don't store the player's audio
    retention_days: 0, // 0 = don't retain; -1 = forever
    delete_audio: true,
    zero_retention_mode: false, // set true for strict no-storage (needs workspace support)
  },
  // Guardrails off for v1 — this is a dev tool, not a public-facing bot.
  guardrails: { focus: { is_enabled: false }, prompt_injection: { is_enabled: false } },
};

// MCP is intentionally NOT set on the agent (mcp_server_ids stays empty): MCP lives on the LOCAL
// Claude side (reached via run_task), so nothing has to tunnel into your machine and no code leaves it.

export default { NAME, TOOLS, SYSTEM_PROMPT, FIRST_MESSAGE, conversation_config, platform_settings };
