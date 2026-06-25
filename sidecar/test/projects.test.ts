/**
 * Unit tests — project-config parse + validation (projects.ts loadProjects()).
 *
 * The project model is "project = repo + name + N agents". loadProjects() resolves it from, in order:
 * AGENTCRAFT_PROJECTS env JSON > runtime/projects.json > DEFAULT_PROJECTS, and NEVER throws on malformed
 * input (a bad override degrades to the next source). parseProjects() is private, so we exercise it through
 * the env path (which short-circuits before any filesystem read when the JSON is valid). We pin:
 *   - a valid array of projects parses through with repo_path resolved to absolute,
 *   - the { projects: [...] } wrapper form is accepted,
 *   - per-item validation drops items missing id/repo_path/agents and agents missing agent_id,
 *   - name/label default to the id, and an unknown character_kind coerces to a valid kind,
 *   - invalid JSON / a non-array / an empty array degrades (never throws) to the default config.
 *
 * Every test save/restores process.env.AGENTCRAFT_PROJECTS so they don't leak into each other.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { loadProjects, DEFAULT_PROJECTS } from "../projects.ts";

/**
 * loadProjects() falls through AGENTCRAFT_PROJECTS -> runtime/projects.json -> DEFAULT_PROJECTS, and
 * RUNTIME_DIR is resolved from process.cwd() at import time (session-store.ts). The "degrades to
 * DEFAULT_PROJECTS" assertions are therefore only true when no runtime/projects.json sits in cwd — but
 * the README invites writing one as a stage override, so a rehearsal would spuriously red these tests.
 * Move any existing runtime/projects.json aside for the duration so the fall-through target is
 * deterministic regardless of machine state, then restore it byte-for-byte after.
 */
const RUNTIME_PROJECTS = path.resolve(process.cwd(), "runtime", "projects.json");
const STASHED = RUNTIME_PROJECTS + ".test-stash";
let stashed = false;

before(async () => {
  try {
    await fs.rename(RUNTIME_PROJECTS, STASHED);
    stashed = true;
  } catch {
    /* no override file present — the clean-checkout case; nothing to stash */
  }
});

after(async () => {
  if (stashed) await fs.rename(STASHED, RUNTIME_PROJECTS).catch(() => {});
});

/** Run `fn` with AGENTCRAFT_PROJECTS set to `json`, always restoring the prior value. */
async function withEnvProjects<T>(json: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AGENTCRAFT_PROJECTS;
  if (json === undefined) delete process.env.AGENTCRAFT_PROJECTS;
  else process.env.AGENTCRAFT_PROJECTS = json;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AGENTCRAFT_PROJECTS;
    else process.env.AGENTCRAFT_PROJECTS = prev;
  }
}

test("a valid AGENTCRAFT_PROJECTS array parses with repo_path resolved to absolute", async () => {
  const cfg = [
    { id: "web", name: "Web Platform", repo_path: "/tmp/web", agents: [{ agent_id: "w1", label: "Vinny", character_kind: "viking" }] },
  ];
  const out = await withEnvProjects(JSON.stringify(cfg), () => loadProjects());
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "web");
  assert.equal(out[0].name, "Web Platform");
  assert.equal(out[0].repo_path, path.resolve("/tmp/web"));
  assert.equal(out[0].agents[0].agent_id, "w1");
  assert.equal(out[0].agents[0].character_kind, "viking");
});

test("the { projects: [...] } wrapper form is accepted", async () => {
  const cfg = { projects: [{ id: "eng", repo_path: "/tmp/eng", agents: [{ agent_id: "e1" }] }] };
  const out = await withEnvProjects(JSON.stringify(cfg), () => loadProjects());
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "eng");
});

test("name defaults to id, agent label defaults to agent_id", async () => {
  const cfg = [{ id: "proj", repo_path: "/tmp/p", agents: [{ agent_id: "x9" }] }];
  const out = await withEnvProjects(JSON.stringify(cfg), () => loadProjects());
  assert.equal(out[0].name, "proj"); // name omitted -> id
  assert.equal(out[0].agents[0].label, "x9"); // label omitted -> agent_id
});

test("an unknown character_kind coerces to a valid kind", async () => {
  const cfg = [{ id: "p", repo_path: "/tmp/p", agents: [{ agent_id: "a", character_kind: "ninja" }] }];
  const out = await withEnvProjects(JSON.stringify(cfg), () => loadProjects());
  // "ninja" isn't in VALID_KINDS -> coerced to the safe default "viking".
  assert.equal(out[0].agents[0].character_kind, "viking");
});

test("items missing id/repo_path/agents are dropped; agents missing agent_id are dropped", async () => {
  const cfg = [
    { name: "no id", repo_path: "/tmp/x", agents: [{ agent_id: "a" }] }, // dropped: no id
    { id: "noPath", agents: [{ agent_id: "a" }] }, // dropped: no repo_path
    { id: "noAgentsArr", repo_path: "/tmp/y", agents: "nope" }, // dropped: agents not an array
    {
      id: "good",
      repo_path: "/tmp/good",
      agents: [{ agent_id: "keep" }, { label: "no agent_id" }], // 2nd agent dropped
    },
  ];
  const out = await withEnvProjects(JSON.stringify(cfg), () => loadProjects());
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "good");
  assert.equal(out[0].agents.length, 1);
  assert.equal(out[0].agents[0].agent_id, "keep");
});

test("invalid JSON in AGENTCRAFT_PROJECTS degrades to the default config (never throws)", async () => {
  const out = await withEnvProjects("{ this is not json", () => loadProjects());
  // Falls through env -> runtime/projects.json (stashed away by the before() hook) -> DEFAULT_PROJECTS.
  assert.deepEqual(out, DEFAULT_PROJECTS);
});

test("a non-array / empty-array override degrades to the default config", async () => {
  const outObj = await withEnvProjects(JSON.stringify({ not: "projects" }), () => loadProjects());
  assert.deepEqual(outObj, DEFAULT_PROJECTS);
  const outEmpty = await withEnvProjects(JSON.stringify([]), () => loadProjects());
  assert.deepEqual(outEmpty, DEFAULT_PROJECTS);
});

test("DEFAULT_PROJECTS sandboxes a1/a2/a3 under runtime/demo-repos — never the live AgentCraft repo", async () => {
  // The Godot tracks (B/C/D) are built against a1/a2/a3 — pin them so a refactor can't silently rename.
  const ids = DEFAULT_PROJECTS.flatMap((p) => p.agents.map((a) => a.agent_id));
  assert.deepEqual(ids.sort(), ["a1", "a2", "a3"]);

  // SAFETY (finding #1): every default agent must work in a DISPOSABLE sandbox under runtime/demo-repos —
  // ensureDemoRepos() auto-provisions those and treats anything else as a real repo it must NOT touch. The
  // old default pointed at REPO_ROOT (the live AgentCraft checkout), so a typed "add X" mutated the demo's
  // own source on stage. Pin the sandbox invariant so that can't regress — including on a fresh clone where
  // the gitignored runtime/projects.json override is absent and THIS in-code default is what's in effect.
  const demoRoot = path.resolve(process.cwd(), "runtime", "demo-repos");
  const repoRoot = path.resolve(process.cwd(), ".."); // sidecar/.. == the AgentCraft checkout
  for (const p of DEFAULT_PROJECTS) {
    const resolved = path.resolve(p.repo_path);
    assert.ok(
      resolved.startsWith(demoRoot + path.sep),
      `default project "${p.id}" repo_path must be under ${demoRoot}, got ${resolved}`,
    );
    assert.notEqual(resolved, repoRoot, `default project "${p.id}" must NOT point at the live AgentCraft repo`);
  }
});
