/**
 * Unit tests — the billing-safety env scrub (env-scrub.mjs).
 *
 * This is THE load-bearing safety rule (plan §2): every Claude child the sidecar spawns must run with
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL DELETED, or it silently bills the metered
 * key instead of the user's subscription. These tests pin the exact behavior so a future refactor can't
 * weaken it without going red:
 *   - all three metered vars are removed,
 *   - non-Anthropic vars are preserved verbatim,
 *   - the source env object is NOT mutated (we return a copy),
 *   - scrubbedVarsPresent() reports exactly which metered vars are currently set (ignoring empties).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANTHROPIC_METERED_VARS,
  scrubAnthropicEnv,
  scrubbedVarsPresent,
} from "../env-scrub.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = path.resolve(__dirname, "..");

test("scrubAnthropicEnv removes every metered Anthropic var", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-secret",
    ANTHROPIC_AUTH_TOKEN: "tok-secret",
    ANTHROPIC_BASE_URL: "https://gateway.example/v1",
    PATH: "/usr/bin",
    HOME: "/home/x",
  };
  const out = scrubAnthropicEnv(env);
  for (const k of ANTHROPIC_METERED_VARS) {
    assert.equal(out[k], undefined, `${k} must be stripped`);
    assert.ok(!(k in out), `${k} key must not be present at all`);
  }
});

test("scrubAnthropicEnv preserves all non-metered vars unchanged", () => {
  const env = { PATH: "/usr/bin:/bin", HOME: "/home/x", FOO: "bar", ELEVENLABS_API_KEY: "el-key" };
  const out = scrubAnthropicEnv(env);
  assert.equal(out.PATH, "/usr/bin:/bin");
  assert.equal(out.HOME, "/home/x");
  assert.equal(out.FOO, "bar");
  // The ElevenLabs key is intentionally NOT scrubbed (contract.ts note): only ANTHROPIC_* go.
  assert.equal(out.ELEVENLABS_API_KEY, "el-key");
});

test("scrubAnthropicEnv does NOT mutate the source env (returns a copy)", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/usr/bin" };
  const out = scrubAnthropicEnv(env);
  // The source still has the key — only the returned copy is scrubbed.
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-secret");
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.notEqual(out, env);
});

test("scrubAnthropicEnv on an env with no metered vars is a clean copy", () => {
  const env = { PATH: "/usr/bin" };
  const out = scrubAnthropicEnv(env);
  assert.deepEqual(out, { PATH: "/usr/bin" });
  assert.notEqual(out, env);
});

test("ANTHROPIC_METERED_VARS is exactly the three billing-relevant vars", () => {
  assert.deepEqual(
    [...ANTHROPIC_METERED_VARS].sort(),
    ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].sort(),
  );
});

test("scrubbedVarsPresent reports the set metered vars, ignoring empty/unset", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant",
    ANTHROPIC_AUTH_TOKEN: "", // empty -> treated as not present
    // ANTHROPIC_BASE_URL unset
    PATH: "/usr/bin",
  };
  const present = scrubbedVarsPresent(env);
  assert.deepEqual(present, ["ANTHROPIC_API_KEY"]);
});

test("scrubbedVarsPresent on a clean env returns an empty list", () => {
  assert.deepEqual(scrubbedVarsPresent({ PATH: "/usr/bin" }), []);
});

// --------------------------------------------------------------------------------------------------
// Spawn-site regression guard (the one rule that bills money).
//
// The pure scrub above is necessary but NOT sufficient: it only protects billing if every child the
// sidecar spawns is actually GIVEN scrubAnthropicEnv() as its `env`. A refactor that swaps
// `env: scrubAnthropicEnv()` for `env: process.env` at a spawn site leaves all the pure-function tests
// green while silently billing the metered key. So we pin the call sites by source assertion (zero
// quota, no live spawn): in every module that spawns a child, each child `env:` binding must be
// scrubAnthropicEnv() and NEVER bare process.env. This closes the loop the pure tests can't.
// --------------------------------------------------------------------------------------------------

/**
 * Modules that spawn/exec a child process whose env could carry the metered Anthropic key.
 * INCLUDES auth.ts: its `claude -p` probe (auth.ts:36) is a real, metered Claude child — exactly the
 * billing surface this guard exists to protect — so it MUST be scanned, not just the agent/git spawners.
 * (agent-context.ts / worktree-manager.ts also bind a scrubbed env but only run git, never Claude — not
 * a billing risk, so they are out of scope for this money-specific guard.)
 */
const CHILD_SPAWNING_SOURCES = ["agent-session.ts", "auth.ts", "pr.ts", "projects.ts"];

/**
 * Strip comments before scanning. A JSDoc line like `* spawns with env: scrubAnthropicEnv()` is
 * executable-irrelevant — matching it gives FALSE confidence (a real spawn site could regress while the
 * comment keeps the regex green). Drop block-comment body lines (`*`, `/*`, `*​/`) and `//` line comments
 * so the scan only sees code. (Coarse but sufficient: these sources have no `env:` inside a string literal.)
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/") || t.startsWith("//"));
    })
    .join("\n");
}

for (const src of CHILD_SPAWNING_SOURCES) {
  test(`${src}: every child env binding is scrubAnthropicEnv(), never bare process.env`, () => {
    const code = stripComments(readFileSync(path.join(SIDECAR_DIR, src), "utf8"));

    // 1) Every `env:` passed to a spawn/exec options object must be built from scrubAnthropicEnv().
    //    Match `env:` followed (allowing a cast/whitespace) by something other than scrubAnthropicEnv.
    const envBindings = code.match(/\benv\s*:\s*[^,\n}]+/g) ?? [];
    assert.ok(envBindings.length > 0, `${src} should bind a child env at least once`);
    for (const b of envBindings) {
      assert.match(
        b,
        /scrubAnthropicEnv\(\)/,
        `${src} has a child env binding that is NOT scrubAnthropicEnv() — billing leak risk: ${b.trim()}`,
      );
    }

    // 2) Belt-and-braces: no child env binding may be bare process.env (the exact billing trap), whether
    //    written inline (`env: process.env`) or via a `const env = process.env` backing an `env,` shorthand.
    assert.ok(
      !/\benv\s*:\s*process\.env\b/.test(code),
      `${src} passes bare process.env as a child env — this bills the metered key`,
    );
    assert.ok(
      !/\bconst\s+env\s*=\s*process\.env\b/.test(code),
      `${src} builds its child env from bare process.env — this bills the metered key`,
    );
  });
}

/**
 * agent-session.ts feeds the Agent SDK `query()` its env via OBJECT SHORTHAND (`env,` at :293), backed by
 * `const env = scrubAnthropicEnv()` (:276) — the single most billing-critical spawn site. The generic
 * `env:` regex above CANNOT see a shorthand `env,`, so without this the SDK turn would be unguarded and
 * breaking :276 to `const env = process.env` would leave every test green. Pin the actual SDK-env path:
 * the backing const MUST be scrubAnthropicEnv(), and the shorthand MUST be handed to the query options.
 */
test("agent-session.ts: the SDK query env is built from scrubAnthropicEnv() (shorthand-backed path)", () => {
  const code = stripComments(readFileSync(path.join(SIDECAR_DIR, "agent-session.ts"), "utf8"));

  // The billing-critical backing const: `const env = scrubAnthropicEnv()` (a cast after it is allowed).
  assert.match(
    code,
    /\bconst\s+env\s*=\s*scrubAnthropicEnv\(\)/,
    "agent-session.ts must build its SDK env from `const env = scrubAnthropicEnv()` — the metered-key scrub",
  );
  // ...and that scrubbed const must actually reach the SDK options via the `env,` shorthand (not dropped).
  assert.match(
    code,
    /^\s*env,\s*(\/\/.*)?$/m,
    "agent-session.ts must pass the scrubbed `env` to the SDK query options via the `env,` shorthand",
  );
});
