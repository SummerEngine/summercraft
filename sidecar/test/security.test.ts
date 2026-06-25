/**
 * Unit tests — the two most safety-critical helpers in security.ts: redact() (keep secrets out of every
 * log line + error envelope) and assertBillingSafe() (the boot hard-stop on a leaked metered key). Both
 * sit on a hot/safety path and had zero coverage. We exercise behavior WITHOUT touching security.ts.
 *
 * NOTE on signed_url: redact() DELIBERATELY does not name-redact `signed_url` — it is the short-lived
 * voice signed URL the client needs as payload, not a stored credential (see security.ts:120). We assert
 * that exclusion holds alongside the five field names that ARE scrubbed, so the deliberate carve-out is
 * pinned and can't silently regress.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { redact, assertBillingSafe } from "../security.ts";

// --------------------------------------------------------------------------------------------------
// redact()
// --------------------------------------------------------------------------------------------------

test("redact scrubs a known ELEVENLABS_API_KEY value by substring", () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "el_secret_value_0123456789"; // >=8 chars so it is redacted by value
  try {
    const out = redact("upstream error talking to el_secret_value_0123456789 service") as string;
    assert.ok(!out.includes("el_secret_value_0123456789"), "the key value must be gone");
    assert.ok(out.includes("***"), "replaced with ***");
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  }
});

test("redact masks a postgres URI password but keeps the host (and user)", () => {
  const out = redact(
    "pg read failed: postgres://admin:superSecretPw@db.aiven.io:5432/defaultdb",
  ) as string;
  assert.ok(!out.includes("superSecretPw"), "password masked");
  assert.ok(out.includes("***"), "masked with ***");
  assert.ok(out.includes("db.aiven.io"), "host kept (useful for ops)");
  assert.ok(out.includes("admin"), "user kept");
});

test("redact scrubs Authorization: Bearer and xi-api-key header strings", () => {
  const bearer = redact("Authorization: Bearer abcDEF1234567890token") as string;
  assert.ok(!bearer.includes("abcDEF1234567890token"), "bearer token gone");
  assert.ok(/bearer\s+\*\*\*/i.test(bearer), "kept the Bearer prefix, masked the token");

  const xi = redact("xi-api-key: abcDEF1234567890key") as string;
  assert.ok(!xi.includes("abcDEF1234567890key"), "xi-api-key value gone");
  assert.ok(xi.includes("***"), "masked with ***");
});

test("redact scrubs an sk-ant- key", () => {
  const out = redact("leaked sk-ant-api03-AAAA1111BBBB2222CCCC here") as string;
  assert.ok(!out.includes("sk-ant-api03-AAAA1111BBBB2222CCCC"), "the ant key is gone");
  assert.ok(out.includes("sk-ant-***"), "collapsed to sk-ant-***");
});

test("redact name-redacts sensitive field names but preserves signed_url", () => {
  const input = {
    token: "abc123def456",
    password: "hunter2pw",
    secret: "s3cr3tvalue",
    api_key: "k3yvalue123",
    authorization: "Bearer something",
    signed_url: "https://api.elevenlabs.io/convai?sig=keepme",
    note: "plain text",
  };
  const out = redact(input) as Record<string, unknown>;
  assert.equal(out.token, "***");
  assert.equal(out.password, "***");
  assert.equal(out.secret, "***");
  assert.equal(out.api_key, "***");
  assert.equal(out.authorization, "***");
  // signed_url is DELIBERATELY excluded from name-redaction (it is voice payload, not a stored secret).
  assert.notEqual(out.signed_url, "***", "signed_url must NOT be name-redacted");
  assert.ok(String(out.signed_url).includes("elevenlabs.io"), "signed_url kept");
  assert.equal(out.note, "plain text", "non-sensitive fields pass through");
});

test("redact returns a NEW value and never mutates its input", () => {
  const input = { token: "abc123def456", nested: { password: "pw_value_123" } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = redact(input);
  assert.notEqual(out, input, "a new object is returned");
  assert.deepEqual(input, snapshot, "the original object is unchanged");
});

test("redact never throws on a cyclic object and caps depth at […]", () => {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o; // build a cycle
  let out: unknown;
  assert.doesNotThrow(() => {
    out = redact(o);
  });
  // Past the depth-6 cap, the graph collapses to the sentinel instead of recursing forever.
  assert.ok(JSON.stringify(out).includes("[…]"), "deep/cyclic graph collapses to […]");
});

test("redact truncates an over-long string (>8KB)", () => {
  const big = "x".repeat(9000);
  const out = redact(big) as string;
  assert.ok(out.length < big.length, "truncated below the input length");
  assert.ok(out.includes("truncated"), "marks the truncation");
});

// --------------------------------------------------------------------------------------------------
// assertBillingSafe() — always {exit:false} so the test runner survives the apikey path
// --------------------------------------------------------------------------------------------------

/** Capture logError/logWarn calls instead of hitting the real console. */
function spies() {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    opts: {
      exit: false,
      logError: (m: string) => errors.push(m),
      logWarn: (m: string) => warns.push(m),
    },
    errors,
    warns,
  };
}

test("assertBillingSafe: subscription returns true with no log", () => {
  const s = spies();
  const ok = assertBillingSafe({ mode: "subscription" }, s.opts);
  assert.equal(ok, true);
  assert.equal(s.errors.length, 0, "no error logged");
  assert.equal(s.warns.length, 0, "no warning logged");
});

test("assertBillingSafe: unknown returns true and warns (inconclusive, not a hard stop)", () => {
  const s = spies();
  const ok = assertBillingSafe({ mode: "unknown" }, s.opts);
  assert.equal(ok, true);
  assert.equal(s.errors.length, 0);
  assert.equal(s.warns.length, 1, "logs the inconclusive warning");
});

test("assertBillingSafe: apikey with no override returns false and logs an error", () => {
  const prev = process.env.AGENTCRAFT_ALLOW_APIKEY;
  delete process.env.AGENTCRAFT_ALLOW_APIKEY; // ensure the hard-stop path
  try {
    const s = spies();
    const ok = assertBillingSafe({ mode: "apikey" }, s.opts);
    assert.equal(ok, false, "unsafe -> false");
    assert.equal(s.errors.length, 1, "logs the hard-stop error");
    assert.equal(s.warns.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENTCRAFT_ALLOW_APIKEY;
    else process.env.AGENTCRAFT_ALLOW_APIKEY = prev;
  }
});

test("assertBillingSafe: apikey with AGENTCRAFT_ALLOW_APIKEY=1 returns false and warns (override)", () => {
  const prev = process.env.AGENTCRAFT_ALLOW_APIKEY;
  process.env.AGENTCRAFT_ALLOW_APIKEY = "1";
  try {
    const s = spies();
    const ok = assertBillingSafe({ mode: "apikey" }, s.opts);
    assert.equal(ok, false, "still unsafe -> false, just allowed to continue");
    assert.equal(s.warns.length, 1, "logs the override warning");
    assert.equal(s.errors.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENTCRAFT_ALLOW_APIKEY;
    else process.env.AGENTCRAFT_ALLOW_APIKEY = prev;
  }
});
