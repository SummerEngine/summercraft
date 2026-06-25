/**
 * OpenAI-compatible /v1/chat/completions SSE shim for ElevenLabs custom-LLM voice.
 *
 * TRACK C. ElevenLabs (custom-LLM mode) POSTs an OpenAI chat-completions body to this route and
 * reads the reply as a stream. We proxy each turn to the character's LIVE Claude AgentSession
 * (deps.runAgentTurn) and re-emit its text as strict OpenAI SSE so the voice you hear is the
 * working agent.
 *
 * CHARACTER ROUTING (was a blocker — read carefully):
 *   With a custom LLM, ElevenLabs sets the OpenAI `model` field from the agent's dashboard Model ID,
 *   which is a fixed placeholder — it is NOT lifted from a per-call client field. The SDK forwards
 *   per-call identifiers as EXTRA body fields via `customLlmExtraBody` (they appear as top-level keys
 *   on the request body, e.g. `body.character_id`). So the real per-character route is an extra-body
 *   key, and we read it FIRST, falling back to `model` only for the curl/manual path:
 *       characterId = body.character_id ?? body.model
 *   voice-web/client.js sends `customLlmExtraBody: { character_id: <id> }` and updates it on
 *   character change (see README "Character routing").
 *
 * WIRE SHAPE IS STRICT (ElevenLabs hangs SILENTLY otherwise):
 *   - Content-Type: text/event-stream
 *   - each chunk:  `data: {json}\n\n`
 *   - terminate:   `data: [DONE]\n\n`
 * A malformed chunk or a missing [DONE] freezes the voice turn forever. So:
 *   - we wrap every write so a serialize/transport error can never throw mid-stream;
 *   - we emit "buffer / think-cover" words FIRST to cover Claude's first-token latency;
 *   - on ANY error we emit a hardcoded fallback chunk and still close with [DONE];
 *   - [DONE] is emitted in `finally` — it is unconditional.
 *
 * Keep this curl-testable — the curl below always validates the SSE framing. NOTE: server.ts wires
 * deps.runAgentTurn unconditionally, so against the live sidecar this exercises the LIVE path (the
 * canned " Working on that right now." reply only runs when handleChatCompletion is called with NO
 * runAgentTurn, e.g. a unit harness). Either way the wire shape is identical:
 *   curl -N http://127.0.0.1:8787/v1/chat/completions \
 *     -H 'content-type: application/json' \
 *     -d '{"model":"a1","stream":true,"messages":[{"role":"user","content":"hi"}]}'
 *
 * DO NOT change the exported signature handleChatCompletion(body, res, deps) — server.ts imports it.
 */
import type { ServerResponse } from "node:http";

export interface ShimDeps {
  /**
   * Track A wires this to the session manager: stream a real Claude turn for a character.
   * Yields incremental assistant text. The shim owns ALL SSE framing — this only yields text.
   */
  runAgentTurn?: (characterId: string, prompt: string) => AsyncIterable<string>;

  /**
   * Optional per-character buffer/think-cover line spoken while Claude's first token is in flight.
   * Defaults to BUFFER_WORDS. Track C/B can override per character if distinct voices ship.
   */
  bufferLine?: (characterId: string) => string;

  /** Optional hook so the sidecar can log shim turns; never throws into the stream. */
  onTurn?: (characterId: string, prompt: string) => void;
}

/**
 * Think-cover words emitted before the first real Claude token. Short, natural, and broken into
 * small deltas so TTS starts speaking immediately (latency mitigation — the agent is never silent).
 */
const BUFFER_WORDS = ["On", " it", "—", " let", " me", " take", " a", " look."];

/** Hardcoded fallback line if the live turn errors mid-stream, so the turn NEVER hangs. */
const FALLBACK_LINE = " Sorry, I hit a snag on that one — give me a moment and try again.";

function defaultBufferLine(_characterId: string): string {
  return BUFFER_WORDS.join("");
}

export async function handleChatCompletion(body: any, res: ServerResponse, deps: ShimDeps = {}) {
  // Route the character from the custom-LLM extra-body key first (the real per-call route), then
  // fall back to the OpenAI `model` field (dashboard placeholder / curl path). See header note.
  const characterId = String(body?.character_id ?? body?.model ?? "unknown");
  const userMsg =
    (Array.isArray(body?.messages) ? body.messages : [])
      .filter((m: any) => m?.role === "user")
      .map((m: any) => (typeof m?.content === "string" ? m.content : stringifyContent(m?.content)))
      .pop() ?? "";

  // Headers must be written before any chunk. ElevenLabs requires text/event-stream.
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // defeat any proxy buffering that would delay first audio
    });
  }

  const id = "chatcmpl-" + characterId + "-" + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  let closed = false;

  // Single guarded writer: a JSON.stringify or socket error here must never escape and orphan
  // the stream without [DONE]. Returns false if the channel is already gone.
  const writeChunk = (delta: string | null, finish: string | null): boolean => {
    if (closed || res.writableEnded) return false;
    try {
      const payload = {
        id,
        object: "chat.completion.chunk",
        created,
        model: characterId,
        choices: [
          {
            index: 0,
            delta: finish ? {} : { content: delta ?? "" },
            finish_reason: finish,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  // First role chunk: OpenAI clients expect an initial delta with role to open the message.
  const openStream = (): boolean => {
    if (closed || res.writableEnded) return false;
    try {
      const payload = {
        id,
        object: "chat.completion.chunk",
        created,
        model: characterId,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  try {
    deps.onTurn?.(characterId, String(userMsg));

    openStream();

    // 1) Cover think-time with buffer words FIRST. Even if Claude is slow or absent, audio starts.
    const bufferLine = (deps.bufferLine ?? defaultBufferLine)(characterId);
    for (const w of splitForSpeech(bufferLine)) {
      if (!writeChunk(w, null)) break;
    }

    // 2) Stream the real Claude turn, or a canned reply if nothing is wired yet.
    if (deps.runAgentTurn) {
      writeChunk(" ", null); // small seam between buffer words and the real answer
      let gotReal = false;
      for await (const chunk of deps.runAgentTurn(characterId, String(userMsg))) {
        if (chunk == null || chunk === "") continue;
        gotReal = true;
        if (!writeChunk(chunk, null)) break;
      }
      if (!gotReal) {
        // Live session produced nothing (rate-limit / empty result) — speak the fallback, don't hang.
        writeChunk(FALLBACK_LINE, null);
      }
    } else {
      // Canned fallback so voice is demoable with no Claude wired yet (curl-testable path).
      for (const w of [" Working", " on", " that", " right", " now."]) {
        if (!writeChunk(w, null)) break;
        await sleep(50);
      }
    }

    writeChunk(null, "stop");
  } catch {
    // Any unexpected error: emit the hardcoded fallback chunk + a clean stop so the turn closes.
    writeChunk(FALLBACK_LINE, null);
    writeChunk(null, "stop");
  } finally {
    // [DONE] is UNCONDITIONAL — without it ElevenLabs waits forever.
    closed = true;
    try {
      if (!res.writableEnded) res.write("data: [DONE]\n\n");
    } catch {
      /* socket already gone; nothing to terminate */
    }
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* already ended */
    }
  }
}

/** Break a line into small word-sized deltas so TTS can start mid-line (lower perceived latency). */
function splitForSpeech(line: string): string[] {
  if (!line) return [];
  // Keep leading spaces on each token so re-concatenation reproduces the original spacing.
  return line.match(/\s*\S+/g) ?? [line];
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // OpenAI multi-part content: pull text parts.
    return content
      .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
