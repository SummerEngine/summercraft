/**
 * Unit tests — agent diff/branch/context parsing (agent-context.ts), against a REAL throwaway git repo.
 *
 * agent-context.ts is read-only git introspection: branch resolution, the `--numstat` pass that yields the
 * changed-file list + the binary set, the binary EXCLUSION from the textual diff (so raw bytes never reach
 * the UI), and the intent-to-add that makes brand-new untracked files appear as additions. Those are git
 * behaviors, so the honest unit test is a tiny real repo (created + torn down in a tmp dir, < 2s) rather
 * than a mock. We pin:
 *   - branch is resolved (non-null, not "HEAD"),
 *   - a brand-new untracked text file shows up in files + the diff (intent-to-add),
 *   - a committed-then-edited tracked file shows in the diff,
 *   - a binary file appears in `files` but its bytes are NOT dumped into the textual diff,
 *   - agentContext() returns branch/base/diff/files for the same agent,
 *   - an unknown agent id -> null (no throw).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { store, RUNTIME_DIR, type AgentRecord } from "../session-store.ts";
import { agentDiff, agentContext } from "../agent-context.ts";

// Unique per run, and prefixed so it can never collide with a real seeded agent (a1/a2/a3) in the
// shared on-disk store. This test deliberately uses the REAL store singleton because agent-context.ts
// resolves repo_path through it; the after() hook removes the record on normal completion.
const AGENT_ID = "ctx_test_" + Date.now();
let repo = "";

/**
 * Abort-safety net: after() only runs on normal test completion. If the test throws or the process is
 * SIGINT'd mid-run, the ctx_test_* record would otherwise be left in cwd/runtime/sessions and get
 * rehydrated into a REAL sidecar boot's /world. This synchronous, idempotent sweep force-removes the
 * record's .json + .jsonl on process exit so an aborted run never poisons the shared store. (Adding a
 * RUNTIME_DIR override to sandbox the store dir belongs to session-store.ts, which is out of L5's lane.)
 */
function sweepRecordSync(): void {
  for (const ext of [".json", ".jsonl"]) {
    rmSync(path.join(RUNTIME_DIR, "sessions", AGENT_ID + ext), { force: true });
  }
}
process.once("exit", sweepRecordSync);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    sweepRecordSync();
    process.exit(130);
  });
}

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

before(async () => {
  await store.whenReady();
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "agentcraft-ctx-"));
  // Seed a real repo with one committed tracked file.
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@local"]);
  git(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "tracked.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  // Now make changes the diff should surface: edit the tracked file, add a new text file, add a binary.
  await fs.writeFile(path.join(repo, "tracked.ts"), "export const x = 2; // changed\n");
  await fs.writeFile(path.join(repo, "new.ts"), "export const y = 'brand new file';\n");
  // A binary file: raw bytes including a NUL so git classifies it as binary.
  await fs.writeFile(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 254, 7, 9]));

  // Register a store record pointing the agent at this repo (agentDiff resolves repo_path from the store).
  const rec: AgentRecord = {
    agent_id: AGENT_ID,
    repo_id: "ctxtest",
    repo_path: repo,
    character_kind: "viking",
    label: "Ctx",
    state: "working",
    status_line: "editing",
    current_task: "diff test",
    target_base_id: "ctxtest",
    last_seen_ms: Date.now(),
    transcript_tail: ["user: do the thing"],
    created_at: new Date().toISOString(),
  };
  await store.create(rec);
});

after(async () => {
  await store.remove(AGENT_ID);
  if (repo) await fs.rm(repo, { recursive: true, force: true });
});

test("agentDiff resolves the branch (non-null, not raw HEAD)", async () => {
  const d = await agentDiff(AGENT_ID);
  assert.ok(d);
  assert.equal(d!.agent_id, AGENT_ID);
  assert.equal(d!.branch, "main");
});

test("a brand-new untracked text file appears via intent-to-add", async () => {
  const d = await agentDiff(AGENT_ID);
  assert.ok(d!.files.includes("new.ts"), `files: ${d!.files.join(", ")}`);
  assert.match(d!.diff, /brand new file/);
});

test("an edited tracked file shows in the textual diff", async () => {
  const d = await agentDiff(AGENT_ID);
  assert.ok(d!.files.includes("tracked.ts"));
  assert.match(d!.diff, /changed/);
});

test("a binary file is listed but its bytes are NOT dumped into the diff", async () => {
  const NUL = String.fromCharCode(0);
  const d = await agentDiff(AGENT_ID);
  assert.ok(d!.files.includes("blob.bin"), "binary path should still appear in files");
  // The diff notes the binary file by name but must not contain its raw byte payload.
  assert.match(d!.diff, /binary file changed: blob\.bin/);
  // No NUL byte should ever reach the textual diff string (the raw blob held a NUL).
  assert.equal(d!.diff.includes(NUL), false);
});

test("agentContext returns branch/base/diff/files for the agent", async () => {
  const c = await agentContext(AGENT_ID);
  assert.ok(c);
  assert.equal(c!.agent_id, AGENT_ID);
  assert.equal(c!.branch, "main");
  assert.equal(c!.repo_id, "ctxtest");
  assert.ok(Array.isArray(c!.files) && c!.files.length >= 2);
  assert.equal(typeof c!.diff, "string");
  // transcript_tail is carried from the store record (a copy, not the live array).
  assert.deepEqual(c!.transcript_tail, ["user: do the thing"]);
});

test("an unknown agent id yields null (no throw)", async () => {
  assert.equal(await agentDiff("nope_" + Date.now()), null);
  assert.equal(await agentContext("nope_" + Date.now()), null);
});
