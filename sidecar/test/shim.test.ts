/**
 * Unit tests — the OpenAI-compatible /v1/chat/completions SSE shim (openai-shim.ts).
 *
 * The charter hard-rule says "Never break the openai-shim signature" — it is a LIVE external contract
 * (ElevenLabs custom-LLM mode). ElevenLabs hangs SILENTLY on a malformed stream, so the wire shape is
 * load-bearing and must have a regression test. We drive handleChatCompletion() with a fake
 * ServerResponse that records every write — fully offline (no runAgentTurn wired -> the canned path,
 * whose framing is identical to the live path) — and pin the exact shape openai-shim.ts documents:
 *   - signature is handleChatCompletion(body, res, deps?) (server.ts imports it positionally),
 *   - Content-Type is text/event-stream,
 *   - every frame is `data: {json}\n\n` and parses (except the terminator),
 *   - the stream is terminated by an UNCONDITIONAL `data: [DONE]\n\n`,
 *   - a finish chunk with finish_reason:"stop" precedes [DONE],
 *   - the character routes from character_id first, then the `model` fallback,
 *   - a thrown serializer can't escape and orphan the stream without [DONE].
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleChatCompletion } from "../openai-shim.ts";

/**
 * Minimal stand-in for node:http ServerResponse capturing exactly what the shim writes. Only the members
 * openai-shim.ts touches are implemented (writeHead/write/end + headersSent/writableEnded).
 */
function fakeRes() {
  const res: any = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    write(s: string) {
      this.chunks.push(s);
      return true;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
  };
  return res;
}

/** Split the accumulated stream into `data: ...` frame payloads (drops the trailing blank line). */
function framesOf(res: ReturnType<typeof fakeRes>): string[] {
  return res.chunks
    .join("")
    .split("\n\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => f.replace(/^data:\s?/, ""));
}

test("handleChatCompletion keeps the (body, res, deps?) signature", () => {
  // arity is 3 with deps defaulted; server.ts calls it positionally — a rename/reorder breaks the import.
  assert.equal(typeof handleChatCompletion, "function");
  assert.equal(handleChatCompletion.length, 2); // (body, res) required; deps has a default
});

test("emits text/event-stream and terminates with an unconditional [DONE]", async () => {
  const res = fakeRes();
  await handleChatCompletion(
    { model: "a1", stream: true, messages: [{ role: "user", content: "hi" }] },
    res as any,
  );

  assert.equal(res.statusCode, 200, "shim must answer 200");
  assert.match(
    String(res.headers["Content-Type"]),
    /text\/event-stream/,
    "Content-Type must be text/event-stream (ElevenLabs requires it)",
  );

  const frames = framesOf(res);
  assert.ok(frames.length > 0, "must emit at least one frame");
  assert.equal(frames.at(-1), "[DONE]", "stream MUST end with the [DONE] terminator");
  assert.ok(res.writableEnded, "response must be ended");
});

test("every non-terminal frame is a valid OpenAI chat.completion.chunk", async () => {
  const res = fakeRes();
  await handleChatCompletion({ model: "a1", messages: [{ role: "user", content: "hi" }] }, res as any);

  const frames = framesOf(res);
  const dataFrames = frames.filter((f) => f !== "[DONE]");
  assert.ok(dataFrames.length > 0, "expected at least one data chunk before [DONE]");
  for (const f of dataFrames) {
    const obj = JSON.parse(f); // must not throw — malformed JSON freezes the voice turn
    assert.equal(obj.object, "chat.completion.chunk");
    assert.ok(Array.isArray(obj.choices) && obj.choices.length === 1, "one choice per chunk");
    assert.equal(obj.model, "a1", "model echoes the routed character id");
  }
});

test("a terminal stop chunk (finish_reason) precedes [DONE]", async () => {
  const res = fakeRes();
  await handleChatCompletion({ model: "a1", messages: [{ role: "user", content: "hi" }] }, res as any);

  const objs = framesOf(res)
    .filter((f) => f !== "[DONE]")
    .map((f) => JSON.parse(f));
  assert.ok(
    objs.some((o) => o.choices[0].finish_reason === "stop"),
    "a finish_reason:'stop' chunk must close the message before [DONE]",
  );
});

test("character routes from character_id first, then falls back to model", async () => {
  // character_id wins (the real custom-LLM extra-body route).
  const a = fakeRes();
  await handleChatCompletion({ character_id: "ada", model: "placeholder", messages: [] }, a as any);
  assert.ok(
    framesOf(a).filter((f) => f !== "[DONE]").every((f) => JSON.parse(f).model === "ada"),
    "character_id must take precedence over model",
  );

  // model is the fallback (curl/manual path).
  const b = fakeRes();
  await handleChatCompletion({ model: "vinny", messages: [] }, b as any);
  assert.ok(
    framesOf(b).filter((f) => f !== "[DONE]").every((f) => JSON.parse(f).model === "vinny"),
    "model is used when character_id is absent",
  );
});

test("a runAgentTurn that throws still closes the stream with [DONE] (never hangs)", async () => {
  const res = fakeRes();
  // A hostile dep that throws on iteration — the shim must catch, emit a fallback, and still terminate.
  async function* boom(): AsyncIterable<string> {
    throw new Error("simulated mid-stream failure");
  }
  await handleChatCompletion(
    { model: "a1", messages: [{ role: "user", content: "hi" }] },
    res as any,
    { runAgentTurn: () => boom() },
  );
  const frames = framesOf(res);
  assert.equal(frames.at(-1), "[DONE]", "[DONE] is unconditional even when the live turn throws");
  assert.ok(res.writableEnded, "response ended despite the error");
});
