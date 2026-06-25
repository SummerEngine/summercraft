/**
 * Unit tests — input validation + error envelope (http/validate.ts).
 *
 * These are the bounds that hold on BOTH the HTTP routes and the WS frames (one source of truth). They
 * must NEVER throw — a validator returns a tagged `{ ok }` result the route maps to a status. We pin:
 *   - id charset/length (no path-traversal / shell metachar smuggling into a git cwd or filename),
 *   - prompt non-empty + bounded,
 *   - optional-text trimming (empty -> undefined),
 *   - pagination clamping (hostile ?limit=-1 / 1e9 / abc can't escape the bounds),
 *   - the client-safe error reducer never leaks internal exception text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateId,
  validatePrompt,
  validateOptionalText,
  validatePath,
  parseLimit,
  parseOffset,
  errorEnvelope,
  clientSafeError,
  MAX_ID_CHARS,
  MAX_PROMPT_CHARS,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} from "../http/validate.ts";

test("validateId accepts a safe slug and trims surrounding whitespace", () => {
  const r = validateId("  a1.b-c_d  ");
  assert.deepEqual(r, { ok: true, value: "a1.b-c_d" });
});

test("validateId rejects non-strings, empties, over-length, and unsafe charsets", () => {
  assert.equal(validateId(123 as unknown).ok, false);
  assert.equal(validateId("").ok, false);
  assert.equal(validateId("   ").ok, false);
  assert.equal(validateId("a".repeat(MAX_ID_CHARS + 1)).ok, false);
  // path-traversal / shell metachars must be refused before they reach a git cwd or filename.
  assert.equal(validateId("../../etc/passwd").ok, false);
  assert.equal(validateId("a; rm -rf /").ok, false);
  assert.equal(validateId("a/b").ok, false);
  assert.equal(validateId("a b").ok, false);
});

test("validateId field name flows into the error message", () => {
  const r = validateId("", "repo_id");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /repo_id/);
});

test("validatePrompt requires non-empty and bounds length", () => {
  assert.deepEqual(validatePrompt("  hello  "), { ok: true, value: "hello" });
  assert.equal(validatePrompt("").ok, false);
  assert.equal(validatePrompt("   ").ok, false);
  assert.equal(validatePrompt(42 as unknown).ok, false);
  assert.equal(validatePrompt("x".repeat(MAX_PROMPT_CHARS + 1)).ok, false);
  // exactly at the cap is allowed.
  assert.equal(validatePrompt("x".repeat(MAX_PROMPT_CHARS)).ok, true);
});

test("validateOptionalText: null/undefined/empty -> ok with undefined; over-length -> error", () => {
  assert.deepEqual(validateOptionalText(undefined), { ok: true, value: undefined });
  assert.deepEqual(validateOptionalText(null), { ok: true, value: undefined });
  assert.deepEqual(validateOptionalText("   "), { ok: true, value: undefined });
  assert.deepEqual(validateOptionalText("  Vinny  "), { ok: true, value: "Vinny" });
  assert.equal(validateOptionalText("x".repeat(5), 4, "label").ok, false);
  assert.equal(validateOptionalText(7 as unknown).ok, false);
});

test("validatePath requires a non-empty bounded string", () => {
  assert.deepEqual(validatePath("  /tmp/repo  "), { ok: true, value: "/tmp/repo" });
  assert.equal(validatePath("").ok, false);
  assert.equal(validatePath(0 as unknown).ok, false);
  assert.equal(validatePath("/" + "a".repeat(5000)).ok, false);
});

test("parseLimit clamps hostile and missing values into [1, MAX]", () => {
  assert.equal(parseLimit(null), DEFAULT_PAGE_LIMIT);
  assert.equal(parseLimit("abc"), DEFAULT_PAGE_LIMIT);
  assert.equal(parseLimit("-1"), 1); // floor at 1
  assert.equal(parseLimit("0"), 1);
  assert.equal(parseLimit("1e9"), MAX_PAGE_LIMIT); // capped
  assert.equal(parseLimit("50"), 50);
  assert.equal(parseLimit("7.9"), 7); // floored
  assert.equal(parseLimit(null, 25, 200), 25); // custom default honored
});

test("parseOffset clamps to a non-negative integer", () => {
  assert.equal(parseOffset(null), 0);
  assert.equal(parseOffset("abc"), 0);
  assert.equal(parseOffset("-5"), 0);
  assert.equal(parseOffset("12.7"), 12);
  assert.equal(parseOffset("1000"), 1000);
});

test("errorEnvelope builds exactly { error }", () => {
  assert.deepEqual(errorEnvelope("nope"), { error: "nope" });
});

test("clientSafeError never echoes internal exception text", () => {
  const e = new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2");
  // The reducer returns the fixed fallback, NOT the raw message (no secret/path leakage to a client).
  assert.equal(clientSafeError(e), "internal error");
  assert.equal(clientSafeError(e, "world projection failed"), "world projection failed");
});
