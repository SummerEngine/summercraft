/**
 * Unit tests — Autonomous Data Operator prompt composition (aiven/operator.ts).
 *
 * The operator beat (Aiven MAIN track) hinges on resolveMissionPrompt(): the PURE, MCP-free layer that
 * turns a named mission into the exact prompt runMission() would dispatch — so the dry-run path is
 * provable deterministically (aiven-smoke.ts uses this). We pin:
 *   - the 5 reproducible missions are exposed and stably identified,
 *   - a DRY-RUN of a mutating mission is rewritten to read/plan-only (no mutating action) yet still carries
 *     the real operation it would plan,
 *   - a live (non-dry-run) mutating mission appends the idempotency instruction,
 *   - the verify step is always appended,
 *   - an unknown mission id resolves to null (clean refusal, no throw).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  listMissions,
  resolveMissionPrompt,
  operatorSpawnArgs,
  operatorReady,
  usingLocalShim,
  missionServableByLocalShim,
  OPERATOR_AGENT_ID,
  LOCAL_SHIM_TOOLS,
} from "../aiven/operator.ts";

test("the operator exposes at least the 5 reproducible missions, each with id/title/prompt", () => {
  const missions = listMissions();
  assert.ok(missions.length >= 5, `expected >= 5 missions, got ${missions.length}`);
  for (const m of missions) {
    assert.equal(typeof m.id, "string");
    assert.equal(typeof m.title, "string");
    assert.equal(typeof m.prompt, "string");
    assert.ok(m.id.length > 0 && m.prompt.length > 0);
  }
  // The named beats the demo runbook references must exist.
  const ids = new Set(missions.map((m) => m.id));
  for (const id of ["triage_pg", "deploy_pgvector", "service_status", "kafka_topic", "metrics_snapshot"]) {
    assert.ok(ids.has(id), `missing mission: ${id}`);
  }
});

test("a dry-run of a mutating mission is rewritten to read/plan-only", () => {
  const r = resolveMissionPrompt("deploy_pgvector", { dryRun: true });
  assert.ok(r);
  assert.equal(r!.mission_id, "deploy_pgvector");
  assert.equal(r!.dry_run, true);
  assert.equal(r!.mutating, true);
  // No mutating action allowed in a dry run…
  assert.match(r!.prompt, /dry run/i);
  assert.match(r!.prompt, /do not take any mutating action/i);
  // …but the real operation it WOULD plan is still present.
  assert.match(r!.prompt, /create extension if not exists vector/i);
});

test("a live mutating mission appends the idempotency instruction (not a dry run)", () => {
  const r = resolveMissionPrompt("deploy_pgvector", { dryRun: false });
  assert.ok(r);
  assert.equal(r!.dry_run, false);
  // Live mutating ops are made re-runnable.
  assert.match(r!.prompt, /idempotent|IF NOT EXISTS|create-if-missing/i);
  // A live run must NOT carry the dry-run guard text.
  assert.doesNotMatch(r!.prompt, /do not take any mutating action/i);
});

test("the verify step is always appended", () => {
  const live = resolveMissionPrompt("triage_pg");
  assert.ok(live);
  // triage_pg.verify mentions re-reading the flagged metric.
  assert.match(live!.prompt, /verify/i);
});

test("a read-only mission is flagged non-mutating", () => {
  const r = resolveMissionPrompt("service_status");
  assert.ok(r);
  assert.equal(r!.mutating, false);
});

test("an unknown mission id resolves to null (clean refusal, no throw)", () => {
  assert.equal(resolveMissionPrompt("does_not_exist"), null);
  assert.equal(resolveMissionPrompt("does_not_exist", { dryRun: true }), null);
});

test("listMissions returns the same stable mission objects (reproducibility)", () => {
  const a = listMissions().map((m) => m.id);
  const b = listMissions().map((m) => m.id);
  assert.deepEqual(a, b);
});

// --------------------------------------------------------------------------------------------------
// Ada spawn-args convergence + MCP-attach honesty (the critical voice-first / hang-risk fixes).
// --------------------------------------------------------------------------------------------------

test("operatorSpawnArgs always carries Ada's id + persona, regardless of MCP config", () => {
  const prev = process.env.AGENTCRAFT_AIVEN_MCP_URL;
  try {
    delete process.env.AGENTCRAFT_AIVEN_MCP_URL;
    const a = operatorSpawnArgs();
    assert.equal(a.agentId, OPERATOR_AGENT_ID);
    assert.equal(typeof a.systemPrompt, "string");
    assert.ok(a.systemPrompt.length > 0, "Ada must always spawn with her operator persona");
  } finally {
    if (prev === undefined) delete process.env.AGENTCRAFT_AIVEN_MCP_URL;
    else process.env.AGENTCRAFT_AIVEN_MCP_URL = prev;
  }
});

test("operatorSpawnArgs attaches the MCP ONLY when configured (no dead-endpoint attach)", () => {
  const prev = process.env.AGENTCRAFT_AIVEN_MCP_URL;
  try {
    // No MCP configured -> aivenMcpUrl is omitted entirely (so AgentSession attaches nothing).
    delete process.env.AGENTCRAFT_AIVEN_MCP_URL;
    assert.equal(operatorReady(), false);
    assert.equal("aivenMcpUrl" in operatorSpawnArgs(), false);

    // MCP configured -> the URL is carried so Ada's session attaches the Aiven MCP.
    process.env.AGENTCRAFT_AIVEN_MCP_URL = "http://127.0.0.1:8765/mcp";
    assert.equal(operatorReady(), true);
    assert.equal(operatorSpawnArgs().aivenMcpUrl, "http://127.0.0.1:8765/mcp");
  } finally {
    if (prev === undefined) delete process.env.AGENTCRAFT_AIVEN_MCP_URL;
    else process.env.AGENTCRAFT_AIVEN_MCP_URL = prev;
  }
});

test("missions are honestly flagged servable: only the SQL beats run on the bundled local shim", () => {
  // The shim serves exactly aiven_pg_read + aiven_pg_write — so world_pulse (read) and deploy_pgvector
  // (read+write) are servable; the Kafka/service-control beats are NOT (they need the hosted Aiven MCP).
  const byId = new Map(listMissions().map((m) => [m.id, m]));
  assert.equal(missionServableByLocalShim(byId.get("world_pulse")!), true);
  assert.equal(missionServableByLocalShim(byId.get("deploy_pgvector")!), true);
  assert.equal(missionServableByLocalShim(byId.get("kafka_topic")!), false);
  assert.equal(missionServableByLocalShim(byId.get("service_status")!), false);
  assert.equal(missionServableByLocalShim(byId.get("triage_pg")!), false);
  // The shim's tool set is exactly the two SQL tools (guards against silently widening the claim).
  assert.deepEqual([...LOCAL_SHIM_TOOLS].sort(), ["aiven_pg_read", "aiven_pg_write"]);
});

test("usingLocalShim distinguishes a loopback shim URL from a hosted Aiven MCP", () => {
  const prev = process.env.AGENTCRAFT_AIVEN_MCP_URL;
  try {
    process.env.AGENTCRAFT_AIVEN_MCP_URL = "http://127.0.0.1:8765/mcp";
    assert.equal(usingLocalShim(), true);
    process.env.AGENTCRAFT_AIVEN_MCP_URL = "https://mcp.aiven.live/mcp";
    assert.equal(usingLocalShim(), false);
    delete process.env.AGENTCRAFT_AIVEN_MCP_URL;
    assert.equal(usingLocalShim(), false);
  } finally {
    if (prev === undefined) delete process.env.AGENTCRAFT_AIVEN_MCP_URL;
    else process.env.AGENTCRAFT_AIVEN_MCP_URL = prev;
  }
});
