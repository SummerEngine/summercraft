/**
 * AgentCraft — voice routes (Track A / Brain wiring Track C, plan §3 L3).
 *
 *   GET  /voice/signed-url?agent_id= -> VoiceSignedUrl  (ALWAYS 200; client branches on {configured})
 *   POST /v1/chat/completions        -> OpenAI SSE (text/event-stream)  [ElevenLabs custom-LLM]
 *
 * /voice/signed-url NEVER returns non-200 — the native Godot voice client branches on the {configured}
 * discriminant, not on HTTP status. Preserving that is a hard contract invariant (a non-200 here breaks
 * the voice client). The ELEVENLABS_API_KEY lives ONLY in this process and is intentionally NOT scrubbed
 * (scrubAnthropicEnv strips only ANTHROPIC_*); the game only ever receives a short-lived signed URL.
 *
 * /v1/chat/completions delegates ALL SSE framing to openai-shim.ts (Track C); we only wire
 * sessionManager.runAgentTurn in as deps.runAgentTurn so the shim streams real Claude turns.
 */
import http from "node:http";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { VoiceSignedUrl } from "../contract.ts";
import { sessionManager } from "../session-manager.ts";
import { handleChatCompletion } from "../openai-shim.ts";
import { json, readBody, safeJson, msg } from "./router.ts";

/**
 * ElevenLabs config, read LAZILY (not at module load). The bootstrap loads sidecar/.env inside main(),
 * which runs AFTER this module is imported — so capturing these at import time would read empty even with
 * keys in .env. Reading per-call fixes that. The key lives ONLY in this process and is never scrubbed; the
 * game only ever receives a short-lived signed URL.
 */
function elevenLabsApiKey(): string {
  return (process.env.ELEVENLABS_API_KEY ?? "").trim();
}

/**
 * The ElevenLabs agent id: env first, else fall back to voice-web/.agent-id (written by the voice-tune
 * skill — it holds a real agent id), so voice works out of the box without re-pasting the id into .env.
 */
function elevenLabsAgentId(): string {
  const fromEnv = (process.env.ELEVENLABS_AGENT_ID ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../voice-web/.agent-id");
    return fsSync.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Mint a short-lived ElevenLabs Conversational-AI signed URL for the native Godot voice client.
 * The API key never leaves this process. Returns a discriminated { configured } union (always HTTP
 * 200) so the client can branch without parsing error codes:
 *   - key + agent set, ElevenLabs OK -> { configured:true, signed_url, agent_id }
 *   - key or agent unset             -> { configured:false, reason }  (clean local fallback)
 *   - ElevenLabs rejects/unreachable -> { configured:false, reason }  (never crash /voice/signed-url)
 * The caller may pass ?agent_id= to override ELEVENLABS_AGENT_ID (one-agent-per-character fallback).
 */
export async function mintVoiceSignedUrl(agentIdParam: string | null): Promise<VoiceSignedUrl> {
  const apiKey = elevenLabsApiKey();
  const agentId = (agentIdParam && agentIdParam.trim()) || elevenLabsAgentId();
  if (!apiKey) return { configured: false, reason: "ELEVENLABS_API_KEY not set" };
  if (!agentId) return { configured: false, reason: "ELEVENLABS_AGENT_ID not set (and voice-web/.agent-id missing)" };

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      console.error(`[sidecar] voice signed-url failed: ${r.status} ${detail}`);
      return { configured: false, reason: `elevenlabs ${r.status}` };
    }
    const data = (await r.json()) as { signed_url?: string };
    if (!data?.signed_url) return { configured: false, reason: "no signed_url in elevenlabs response" };
    return { configured: true, signed_url: data.signed_url, agent_id: agentId };
  } catch (e) {
    console.error("[sidecar] voice signed-url error:", msg(e));
    return { configured: false, reason: msg(e) };
  }
}

/**
 * GET /voice/signed-url?agent_id= -> VoiceSignedUrl. ALWAYS 200 (the client branches on {configured}).
 * Returns { configured:false } (200) when unconfigured so the client falls back gracefully rather than
 * hanging on a 500.
 */
export async function handleSignedUrl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  json(res, 200, await mintVoiceSignedUrl(url.searchParams.get("agent_id")));
}

/**
 * POST /v1/chat/completions -> OpenAI SSE (voice shim). Delegated to Track C's handleChatCompletion; we
 * wire the shim to real Claude turns via the session manager's async-iterable. The shim owns ALL SSE
 * framing and writes the response itself (including the unconditional terminal `data: [DONE]`).
 *
 * VALIDATION EXEMPTION (intentional): unlike every other client-reachable path, this route does NOT run
 * the body through validate.ts (validateId/validatePrompt) before delegating. That is deliberate, not an
 * oversight — and is bounded:
 *   - The openai-shim signature is a frozen Track-C seam; the shim owns the FULL SSE lifecycle (framing +
 *     terminal `[DONE]`). Short-circuiting a rejection here would mean re-implementing that framing in the
 *     route to stay protocol-valid for ElevenLabs — duplicating the shim and risking a divergent stream.
 *   - characterId (= body.character_id ?? body.model) is used only as a `store.get` key inside the shim;
 *     a bad/garbage id is a safe miss (no path traversal, no spawn), so there is nothing to guard against.
 *   - The prompt is loosely bounded by the readBody MAX_BODY_BYTES (256 KiB) cap below — the request can't
 *     OOM the process even without validatePrompt's char cap.
 * So this surface is bounded by readBody + a store.get-miss, NOT by the charset/length guard the other
 * prompt paths enforce. If the shim is ever refactored to expose a pre-stream hook, validate there.
 */
export async function handleChatCompletionRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req).then(safeJson);
  // Wire the shim to real Claude turns via the session manager's async-iterable.
  await handleChatCompletion(body, res, {
    runAgentTurn: (characterId, prompt) => sessionManager.runAgentTurn(characterId, prompt),
  });
}
