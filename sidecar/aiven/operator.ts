/**
 * AgentCraft — the Autonomous Data Operator (Track A / Brain, plan §4-A "the data-operator beat").
 *
 * This is the Aiven MAIN-track scoring differentiator: an agent that uses the **Aiven MCP** to actually
 * OPERATE data infrastructure live on stage — provision a service, deploy pgvector, read logs/metrics,
 * triage "what's wrong with my Postgres" — not just coordinate file locks. It is a normal AgentCraft
 * NPC ("Ada", the data operator) with two differences:
 *   1) its system prompt makes it an infra operator that works THROUGH the Aiven MCP, and
 *   2) the Aiven MCP is attached to its session explicitly (per-session URL), so the operator works even
 *      if ordinary coordination is off.
 *
 * HARDENING (lane L2, plan §2 L2 — "dry-run, captured results, idempotency, per-mission verify, audit"):
 *   - DRY-RUN: every mission can run with dry_run=true. The dispatched prompt is then rewritten to a
 *     read/plan-only instruction (inspect via the MCP, describe the action, take NO mutating step) so a
 *     demo can rehearse safely. The 5 missions phrase their real Aiven MCP capabilities (direct SQL,
 *     pgvector, Kafka produce/read, list_services/get_service_details/metrics/logs).
 *   - PER-MISSION VERIFY: each mission carries an explicit verify instruction appended to the prompt so
 *     Ada confirms the operation actually landed (re-read the metric / \dx the extension / list topics)
 *     and reports the verified state — the operation isn't "done" until it's verified.
 *   - CAPTURED RESULTS: instead of fire-and-forget, the operator subscribes to Ada's result/error stream
 *     for THIS run, writes the captured summary into Ada's transcript AND the audit row, so a run leaves
 *     a durable record of what actually happened (not just whatever scrolled past on WS).
 *   - IDEMPOTENCY: each run has an op_id (caller-supplied or generated). A run already in flight for the
 *     same op_id is a no-op success, and the audit log is upserted on op_id so a double-clicked
 *     /operator/run can't fork a duplicate row. The non-idempotent missions (deploy_pgvector, kafka_topic)
 *     are phrased "ensure … exists (IF NOT EXISTS / create-if-missing)" so re-running them is safe.
 *   - AUDIT LOG: every run is recorded in world_state.operations_audit (who/what/when/dry-run/result/
 *     verify) — the durable operation audit trail §2 calls out as a gap.
 *
 * Reproducibility: the missions below are fixed, named prompts (GET /operator/missions). Running one
 * (POST /operator/run) dispatches it to Ada's live session; her tool calls + results stream over the
 * normal WS bus, so the world shows the operation happening. Requires a configured Aiven MCP URL — if
 * none is set, runMission refuses cleanly (no dead-MCP hang).
 *
 * STABLE SEAM: runMission(input) + listMissions() + operatorReady() keep their signatures. The input
 * object gains OPTIONAL dry_run/op_id fields (additive — existing callers pass neither), and RunResult
 * gains OPTIONAL fields; no existing field changes shape.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { sessionManager } from "../session-manager.ts";
import { store } from "../session-store.ts";
import { RUNTIME_DIR } from "../session-store.ts";
import { logger } from "../logger.ts";
import { metrics } from "../metrics.ts";
import { getPg, queryWithRetry, syncAgentTask } from "./pg.ts";
import type { ServerEvent } from "../contract.ts";

/**
 * The Aiven MCP endpoint the operator works through (same env the coordination agents use). Read LAZILY
 * (not captured at module-load) so it matches pg.ts's connString()/aivenConfigured() pattern — a future
 * programmatic env setup / dotenv-after-import won't permanently wedge operatorReady() to false.
 */
function aivenMcpUrl(): string {
  return (process.env.AGENTCRAFT_AIVEN_MCP_URL ?? "").trim();
}

/** Ada — the data operator NPC. Stands in the "Aiven Ops" building in the world. */
export const OPERATOR_AGENT_ID = "ada";
const OPERATOR_REPO_ID = "aiven-ops";
const OPERATOR_LABEL = "Ada";
const OPERATOR_KIND = "wizard" as const;
/** Ada doesn't edit a code repo — she operates infra. A scratch cwd keeps worktree-prep happy (it falls
 *  back to this dir since it isn't a git repo). */
const OPERATOR_CWD = path.join(RUNTIME_DIR, "ops");

/**
 * Boot seed for Ada so the data-operator NPC is visible in /world, /agents and /projects BEFORE her first
 * mission (A-1: the headline Aiven-main-track NPC was previously invisible until runMission() first spawned
 * her). This is a RECORD only — lazy-spawn is preserved: no live Claude session exists until runMission()
 * dispatches a mission, so booting still burns no quota. repo_path is OPERATOR_CWD (a scratch dir under
 * runtime/), never a real repo root, so agent-context's index-mutation gate also leaves the live tree alone.
 */
export const OPERATOR_SEED = {
  agent_id: OPERATOR_AGENT_ID,
  repo_id: OPERATOR_REPO_ID,
  repo_path: OPERATOR_CWD,
  character_kind: OPERATOR_KIND,
  label: OPERATOR_LABEL,
  /** Idle until a mission runs; surfaced in /world so the operator beat has an on-screen anchor. */
  status_line: "idle — awaiting a data op",
} as const;

/** How long we listen for Ada's captured result before closing the capture (the run keeps streaming). */
const CAPTURE_WINDOW_MS = 120_000;

/**
 * Boot-reconcile horizon: a non-terminal audit row (`dispatched`/`dry_run`) older than this is presumed
 * orphaned by a sidecar restart mid-run (its in-memory capture timer died with the old process) and is
 * flipped to `failed`. Comfortably past CAPTURE_WINDOW_MS so we never race a still-streaming run of the
 * CURRENT process — only the dead previous process's rows are reconciled.
 */
const AUDIT_RECONCILE_AFTER_MS = CAPTURE_WINDOW_MS + 60_000;
/** Once-guard so the boot reconcile runs at most once per process, no matter how it's triggered. */
let auditReconciled = false;

/** Size cap on a free-form operator prompt (chars). The named missions are exempt — they're fixed text. */
const MAX_FREEFORM_PROMPT_CHARS = 4096;

const OPERATOR_SYSTEM_PROMPT = [
  "You are Ada, the SummerCraft data operator. You operate the team's Aiven infrastructure THROUGH the",
  "`aiven` MCP server. The REAL tools are: aiven_pg_read / aiven_pg_write (direct SQL, incl. pgvector),",
  "aiven_kafka_topic_message_produce / aiven_kafka_topic_message_list (+ aiven_kafka_topic_list / _create),",
  "and the control plane aiven_service_list / aiven_service_get / aiven_service_metrics_fetch /",
  "aiven_project_get_service_logs. Use these exact tool names.",
  "When given a task: inspect real state via the MCP first, explain what you see in one line, take the",
  "smallest concrete action that satisfies the task, then VERIFY the result via the MCP and report it.",
  "Prefer real operations (query, configure, read metrics/logs) over describing them.",
  "Be careful and reversible; never drop data or delete a service unless explicitly told to. Keep replies",
  "short and action-oriented — this is narrated live on stage.",
  // World schema baked in so a FREE-FORM spoken ask ("what's happening across the worlds?") lands the real
  // numbers deterministically — without it Ada has no table/column names and would guess (information_schema
  // discovery / wrong predicates), so the spoken Aiven #2 beat wouldn't reliably return the live counts.
  // Mirrors the world_pulse mission's exact three queries (operator.ts OPERATOR_MISSIONS[world_pulse]).
  "The shared SummerCraft world lives in this Aiven Postgres, schema world_state. Key tables:",
  "world_state.world_snapshots(world_id,last_seen), world_state.agents(agent_id,state,last_seen),",
  "world_state.coord_events(ts,type,agent_id). When asked \"what's happening across the worlds\", run via",
  "aiven_pg_read exactly: SELECT count(*) FROM world_state.world_snapshots WHERE last_seen > now() -",
  "interval '30 seconds'; SELECT count(*) FROM world_state.agents WHERE state='working'; SELECT count(*)",
  "FROM world_state.coord_events WHERE ts > now() - interval '1 hour'; and answer exactly like",
  "'N worlds online, M agents working, K events this hour.'",
].join(" ");

export interface OperatorMission {
  id: string;
  title: string;
  /** what the operator is told to do — fixed for reproducibility */
  prompt: string;
  /**
   * the explicit verify step appended to the prompt so Ada confirms the operation landed (re-read the
   * metric / \dx the extension / list topics) and reports the verified state. Kept on the mission so the
   * contract OperatorMission shape (id/title/prompt) is unchanged — verify is internal to operator.ts.
   */
  verify: string;
  /** true for missions that mutate infra (so dry-run rewrites them to read/plan-only). */
  mutating: boolean;
  /**
   * ADDITIVE. The Aiven MCP tools this mission actually needs. The LOCAL shim (mcp-aiven-local.mjs) serves
   * only aiven_pg_read + aiven_pg_write; the Kafka/service-control tools exist only on the hosted Aiven MCP.
   * This is what lets us honestly mark which missions the *currently configured* MCP can serve instead of
   * advertising tools that aren't there (the demo's local-shim path can run only the SQL-only missions).
   */
  requiresTools: string[];
}

/** Tools the bundled local shim (mcp-aiven-local.mjs) actually registers. The hosted Aiven MCP has more. */
export const LOCAL_SHIM_TOOLS = ["aiven_pg_read", "aiven_pg_write"] as const;

/**
 * Whether a mission is fully servable by the LOCAL shim (every tool it needs is in LOCAL_SHIM_TOOLS).
 * ADDITIVE/pure. Used to honestly flag, on /operator/missions, which missions the bundled demo path can run
 * vs which need the hosted Aiven MCP (Kafka/service-control) — so we never advertise a tool that isn't there.
 */
export function missionServableByLocalShim(m: OperatorMission): boolean {
  return m.requiresTools.every((t) => (LOCAL_SHIM_TOOLS as readonly string[]).includes(t));
}

/**
 * Whether the configured MCP is the bundled local shim (a loopback :8765 URL). When true, /operator/missions
 * can flag the Kafka/service-control missions as unsupported. When false (hosted Aiven MCP), all missions are
 * assumed servable. Heuristic on the URL — the shim always binds 127.0.0.1; a real Aiven MCP is remote.
 */
export function usingLocalShim(): boolean {
  const u = aivenMcpUrl();
  return /:\/\/(127\.0\.0\.1|localhost)\b/.test(u);
}

/**
 * The reproducible operator missions. Each is a real Aiven operation phrased to the MCP's actual
 * capabilities (direct SQL, pgvector, Kafka produce/read, list_services/get_service_details/metrics/logs).
 * They are intentionally phrased as outcomes, leaving the MCP tool choice to the agent, and the mutating
 * ones use IF NOT EXISTS / create-if-missing so a re-run is idempotent.
 */
export const OPERATOR_MISSIONS: OperatorMission[] = [
  {
    // THE headline live-data beat: a deterministic live readout of the whole world — which
    // lives in this very Aiven Postgres — so the stage line "what's happening across the worlds?" has a real
    // code path and returns real numbers, not an LLM improvisation. Read-only; the exact SQL is fixed.
    id: "world_pulse",
    title: "What's happening across the worlds?",
    prompt:
      "Give a LIVE readout of the whole SummerCraft world, which lives in this very Aiven Postgres. Using " +
      "the aiven MCP's aiven_pg_read (read-only SQL), run exactly these three queries and report the three " +
      "numbers in one sentence: " +
      "(1) worlds online: SELECT count(*) FROM world_state.world_snapshots WHERE last_seen > now() - interval '30 seconds'; " +
      "(2) agents working: SELECT count(*) FROM world_state.agents WHERE state = 'working'; " +
      "(3) activity this hour: SELECT count(*) FROM world_state.coord_events WHERE ts > now() - interval '1 hour'. " +
      "Answer exactly like: 'N worlds online, M agents working, K events this hour.'",
    verify:
      "Re-run the worlds-online query via aiven_pg_read and confirm the count matches the number you reported.",
    mutating: false,
    requiresTools: ["aiven_pg_read"],
  },
  {
    id: "triage_pg",
    title: "What's wrong with my Postgres?",
    prompt:
      "Triage our Aiven Postgres service: read its current metrics (aiven_service_metrics_fetch) and recent " +
      "logs (aiven_project_get_service_logs) via the aiven MCP, identify the single most notable issue or " +
      "risk (connections, disk, slow queries, replication), and report it in one or two lines with the " +
      "concrete number you saw.",
    verify:
      "Verify by re-reading the specific metric you flagged and quote its exact current value.",
    mutating: false,
    requiresTools: ["aiven_service_metrics_fetch", "aiven_project_get_service_logs"],
  },
  {
    id: "deploy_pgvector",
    title: "Deploy pgvector",
    prompt:
      "Enable vector search on our Aiven Postgres via the MCP's direct SQL: run " +
      "CREATE EXTENSION IF NOT EXISTS vector, then CREATE TABLE IF NOT EXISTS a small demo table with an " +
      "embedding vector column, and run one similarity query against it. Report what you did.",
    verify:
      "Verify with SELECT extname FROM pg_extension WHERE extname='vector' (must return one row) and " +
      "confirm the demo table exists; report both.",
    mutating: true,
    requiresTools: ["aiven_pg_read", "aiven_pg_write"],
  },
  {
    id: "service_status",
    title: "Service health sweep",
    prompt:
      "List our Aiven services via the MCP's aiven_service_list and report each service's name, type, and " +
      "state (RUNNING/REBUILDING/etc) as a short bullet list, flagging anything not RUNNING.",
    verify:
      "Verify by re-fetching aiven_service_get for any service you flagged as not RUNNING and confirm " +
      "its state.",
    mutating: false,
    requiresTools: ["aiven_service_list", "aiven_service_get"],
  },
  {
    id: "kafka_topic",
    title: "Provision the coordination topic",
    prompt:
      "Ensure the Kafka topic `agent.coordination` exists on our Aiven Kafka service (1 partition, short " +
      "retention ~10 min). Create it only if missing (idempotent). Then produce one test " +
      "coordination message to it and read it back to confirm the round-trip.",
    verify:
      "Verify by listing the Kafka topics and confirming `agent.coordination` is present with 1 partition.",
    mutating: true,
    requiresTools: [
      "aiven_kafka_topic_list",
      "aiven_kafka_topic_create",
      "aiven_kafka_topic_message_produce",
      "aiven_kafka_topic_message_list",
    ],
  },
  {
    id: "metrics_snapshot",
    title: "Infra metrics snapshot",
    prompt:
      "Read current CPU, memory, and disk usage for our primary Aiven service via aiven_service_metrics_fetch " +
      "and report the three numbers in one line, noting anything above 80%.",
    verify:
      "Verify by confirming all three metric reads returned a value (no nulls) and restate them.",
    mutating: false,
    requiresTools: ["aiven_service_metrics_fetch"],
  },
];

export function listMissions(): OperatorMission[] {
  return OPERATOR_MISSIONS;
}

/**
 * Resolve a mission id to the exact prompt that WOULD be dispatched, without a live session or MCP
 * (ADDITIVE, pure — existing callers unaffected). This is the prompt-composition layer runMission() uses
 * (mission lookup + dry-run/verify rewrite via composePrompt), exposed so the operator dry-run path can be
 * proven deterministically (aiven-smoke.ts) even when no Aiven MCP is configured. A dry-run of a mutating
 * mission yields a read/plan-only instruction; verify is always appended. Returns null for an unknown id.
 */
export function resolveMissionPrompt(
  missionId: string,
  opts: { dryRun?: boolean } = {},
): { mission_id: string; title: string; dry_run: boolean; mutating: boolean; prompt: string } | null {
  const m = OPERATOR_MISSIONS.find((x) => x.id === missionId);
  if (!m) return null;
  const dryRun = opts.dryRun === true;
  return {
    mission_id: m.id,
    title: m.title,
    dry_run: dryRun,
    mutating: m.mutating,
    prompt: composePrompt(m.prompt, m.verify, dryRun, m.mutating),
  };
}

/** True when the operator can run (an Aiven MCP endpoint is configured). */
export function operatorReady(): boolean {
  return aivenMcpUrl() !== "";
}

/**
 * The EXACT spawn args for Ada, so every entry point brings her up identically — persona + (when configured)
 * the Aiven MCP attached. Mission-first (runMission) and voice-first (session-manager.runAgentTurn) MUST
 * converge on this, or a voice-first contact spawns a bare MCP-less Ada that then sticks (runMission only
 * attaches the MCP when no session exists yet), silently breaking the headline Aiven #2 beat.
 *
 * The aivenMcpUrl is only attached when operatorReady() — i.e. an endpoint is configured. If it isn't, Ada
 * still spawns (with her persona) but without the MCP; runMission() independently refuses with a clean 503,
 * and attaching a "" URL is a no-op in AgentSession (it only attaches a non-empty URL). So this never
 * attaches a dead endpoint.
 */
export function operatorSpawnArgs(): {
  agentId: string;
  repoId: string;
  repoPath: string;
  characterKind: typeof OPERATOR_KIND;
  label: string;
  systemPrompt: string;
  aivenMcpUrl?: string;
} {
  return {
    agentId: OPERATOR_AGENT_ID,
    repoId: OPERATOR_REPO_ID,
    repoPath: OPERATOR_CWD,
    characterKind: OPERATOR_KIND,
    label: OPERATOR_LABEL,
    systemPrompt: OPERATOR_SYSTEM_PROMPT,
    ...(operatorReady() ? { aivenMcpUrl: aivenMcpUrl() } : {}),
  };
}

export type RunResult =
  | {
      ok: true;
      agent_id: string;
      mission_id: string | null;
      prompt: string;
      /** the idempotency key for this run (caller-supplied or generated). */
      op_id: string;
      /** whether this run is read/plan-only (no mutating MCP action). */
      dry_run: boolean;
    }
  | { ok: false; code: number; error: string };

/** op_ids currently in flight, so a same-id re-dispatch is a no-op success (idempotency guard). */
const inFlight = new Set<string>();
/**
 * SINGLE-FLIGHT: the op_id of the one Ada run currently streaming, or null when idle. Ada is a single
 * shared "ada" session, and the captured-result listener correlates a terminal result/error to a run ONLY
 * by agent_id (ServerEvent result/error carry no op_id — contract.ts is frozen/additive-only, so we can't
 * add one). If two different op_ids ran concurrently, Ada's first `result` would resolve BOTH captures and
 * corrupt the audit log. We therefore allow exactly one active Ada run at a time: a second overlapping
 * non-idempotent dispatch gets a clean 409 busy refusal instead of cross-resolving the in-flight run.
 */
let activeOpId: string | null = null;

/**
 * Run an operator mission. Resolves a prompt from `missionId` (preferred) or a free-form `prompt`,
 * ensures Ada's live session exists (attaching the Aiven MCP + operator persona), and dispatches the
 * task. Events stream over the WS bus; the result is also CAPTURED into Ada's transcript + the audit log.
 * Returns 202-style success or a clean refusal.
 *
 * Additive optional input: `dryRun` (read/plan-only) and `opId` (idempotency key). Existing callers that
 * pass only { missionId } / { prompt } are unaffected.
 */
export async function runMission(input: {
  missionId?: string | null;
  prompt?: string | null;
  dryRun?: boolean | null;
  opId?: string | null;
}): Promise<RunResult> {
  if (!operatorReady()) {
    return {
      ok: false,
      code: 503,
      error: "Aiven MCP not configured (set AGENTCRAFT_AIVEN_MCP_URL to a reachable endpoint).",
    };
  }

  let missionId: string | null = null;
  let title = "custom op";
  let basePrompt: string;
  let verify = "";
  let mutating = true; // a free-form prompt is treated as mutating (conservative for dry-run rewriting)

  if (input.missionId) {
    const m = OPERATOR_MISSIONS.find((x) => x.id === input.missionId);
    if (!m) return { ok: false, code: 404, error: `unknown mission: ${input.missionId}` };
    // HONESTY GATE (matches /operator/missions' `servable` flag): on the bundled local-shim demo path the
    // shim serves only the SQL tools, so refuse a Kafka/service-control mission cleanly here instead of
    // dispatching Ada to flail on tools that don't exist. Point AGENTCRAFT_AIVEN_MCP_URL at the hosted Aiven
    // MCP to run these. (A free-form prompt is the power-user path and is NOT gated.)
    if (usingLocalShim() && !missionServableByLocalShim(m)) {
      return {
        ok: false,
        code: 501,
        error:
          `mission '${m.id}' needs the hosted Aiven MCP (tools: ${m.requiresTools.join(", ")}); ` +
          `the bundled local shim only serves the SQL missions (world_pulse, deploy_pgvector). ` +
          `Set AGENTCRAFT_AIVEN_MCP_URL to the hosted Aiven MCP to run it.`,
      };
    }
    missionId = m.id;
    title = m.title;
    basePrompt = m.prompt;
    verify = m.verify;
    mutating = m.mutating;
  } else if (input.prompt && input.prompt.trim()) {
    // The free-form arm is the one UNDER-validated entry point into a live-infra-operating agent (the named
    // missions are fixed + reproducible). Charter §2 mandates input validation + size caps on every route:
    // cap the prompt so an arbitrarily large/hostile instruction can't reach Ada's MCP-attached session.
    const trimmed = input.prompt.trim();
    if (trimmed.length > MAX_FREEFORM_PROMPT_CHARS) {
      return {
        ok: false,
        code: 400,
        error: `prompt too large (${trimmed.length} > ${MAX_FREEFORM_PROMPT_CHARS} chars)`,
      };
    }
    basePrompt = trimmed;
  } else {
    return { ok: false, code: 400, error: "provide mission_id or prompt" };
  }

  const dryRun = input.dryRun === true;
  const opId = (input.opId && input.opId.trim()) || randomUUID();

  // IDEMPOTENCY: a run already in flight for this op_id is a no-op success (a double-click can't double-run).
  if (inFlight.has(opId)) {
    return { ok: true, agent_id: OPERATOR_AGENT_ID, mission_id: missionId, prompt: basePrompt, op_id: opId, dry_run: dryRun };
  }

  // SINGLE-FLIGHT: a DIFFERENT op_id while another Ada run is still streaming would install a second
  // capture listener that Ada's next terminal event resolves ambiguously (result/error carry no op_id).
  // Refuse cleanly so the audit log can't be cross-resolved/duplicated — the caller retries when Ada frees.
  if (activeOpId !== null) {
    metrics.inc("operator_missions_busy_refused");
    return {
      ok: false,
      code: 409,
      error: `operator busy with op ${activeOpId} — only one Ada run at a time; retry when it completes.`,
    };
  }

  // Compose the dispatched prompt: dry-run rewrite (read/plan-only) for mutating ops, plus the verify step.
  const prompt = composePrompt(basePrompt, verify, dryRun, mutating);

  // Ensure Ada exists as a live session with the Aiven MCP + operator persona attached. Spawn via the SAME
  // canonical args the voice path uses (operatorSpawnArgs) so mission-first and voice-first converge on ONE
  // MCP-attached Ada. (operatorReady() above guarantees an MCP URL is configured, so these args carry it.)
  if (!sessionManager.has(OPERATOR_AGENT_ID)) {
    await fs.mkdir(OPERATOR_CWD, { recursive: true }).catch(() => {});
    const spawned = await sessionManager.spawn(operatorSpawnArgs());
    if (!spawned.ok) {
      await audit({ opId, missionId, title, prompt, dryRun, status: "failed", result: spawned.error ?? "spawn failed" });
      return { ok: false, code: 503, error: spawned.error ?? "operator spawn failed" };
    }
  }

  // Record the dispatch in the audit log up-front (best-effort) so even a mid-run crash leaves a trail.
  // Claim the single-flight slot here (this is now THE one active Ada run); finish() releases it.
  inFlight.add(opId);
  activeOpId = opId;
  await audit({ opId, missionId, title, prompt, dryRun, status: dryRun ? "dry_run" : "dispatched", verify });

  // Subscribe to Ada's result/error BEFORE dispatching. If we dispatched first and a terminal event landed
  // before the listener attached (a cached/instant refusal can resolve ~synchronously), it would slip
  // through and the capture window would later audit a SUCCEEDED run as 'failed'. Attaching first closes
  // that gap; the returned handle lets the dispatch-failure path finalize through the SAME listener so the
  // audit row + single-flight slot converge exactly once (no double-audit race).
  const capture = captureResult(opId, missionId, title, prompt, dryRun, verify);

  if (!sessionManager.command(OPERATOR_AGENT_ID, prompt)) {
    await capture.finish("failed", "could not dispatch");
    return { ok: false, code: 503, error: "could not dispatch to operator" };
  }
  metrics.inc("operator_missions_dispatched");

  // Reflect the mission on the record so /world shows what Ada is doing.
  const taskLine = missionId ?? "custom op";
  const statusLine = `${dryRun ? "dry-run" : "op"}: ${missionId ?? "custom"}`;
  await store.update(OPERATOR_AGENT_ID, {
    current_task: taskLine,
    status_line: statusLine,
    state: "working",
  });
  // Also push the task into the Aiven projection so a DIFFERENT process reading /world sees Ada's real
  // current_task/state (not null) — the operator beat must stay legible cross-process (A-4). Best-effort.
  await syncAgentTask({
    agent_id: OPERATOR_AGENT_ID,
    current_task: taskLine,
    target_base_id: OPERATOR_REPO_ID,
    status_line: statusLine,
    state: "working",
  });

  return { ok: true, agent_id: OPERATOR_AGENT_ID, mission_id: missionId, prompt, op_id: opId, dry_run: dryRun };
}

/**
 * Compose the dispatched prompt. For a DRY-RUN of a mutating mission, the action is rewritten to read/
 * plan-only so nothing infra-changing happens. The verify step is always appended (a dry-run verifies its
 * PLAN, a real run verifies the result). End with the op_id so the run is self-identifying in the logs.
 */
function composePrompt(base: string, verify: string, dryRun: boolean, mutating: boolean): string {
  const parts: string[] = [];
  if (dryRun) {
    parts.push(
      "DRY RUN — do NOT take any mutating action. Inspect the real current state via the aiven MCP, then",
      "describe the exact action you WOULD take (the SQL / topic config / service change) and why, without",
      "executing it.",
    );
    parts.push(base);
    if (verify) parts.push(`Then state how you would verify it: ${verify}`);
  } else {
    parts.push(base);
    if (verify) parts.push(verify);
  }
  if (mutating && !dryRun) {
    parts.push("Make the operation idempotent (IF NOT EXISTS / create-if-missing) so a re-run is safe.");
  }
  return parts.join(" ");
}

/**
 * Capture Ada's result/error for one run and fold it into the transcript + audit log. Best-effort and
 * fully detached — a capture failure must never affect the dispatched run. Listens on the store bus for
 * Ada's terminal `result`/`error` event, bounded by CAPTURE_WINDOW_MS so the listener can't leak.
 *
 * MUST be installed BEFORE the dispatch so no terminal event can slip through between dispatch and subscribe
 * (a ~synchronous cached refusal would otherwise be missed and later mis-audited as a timed-out failure).
 * Returns a `{ finish }` handle so the dispatch-failure path can finalize through this SAME listener — the
 * `settled` guard makes finish() idempotent, so the slot/audit converge exactly once regardless of which
 * path (terminal event, timeout, or dispatch failure) settles it first.
 */
function captureResult(
  opId: string,
  missionId: string | null,
  title: string,
  prompt: string,
  dryRun: boolean,
  verify: string,
): { finish: (status: "succeeded" | "failed", summary: string) => Promise<void> } {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let off: (() => void) | null = null;

  const finish = async (status: "succeeded" | "failed", summary: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (off) off();
    inFlight.delete(opId);
    // Release the single-flight slot so the next Ada run can dispatch (only clear if WE hold it).
    if (activeOpId === opId) activeOpId = null;
    // Fold a one-line record into Ada's transcript so /world + the panel show the captured outcome.
    await store
      .appendTranscript(OPERATOR_AGENT_ID, {
        ts: new Date().toISOString(),
        role: "system",
        text: `op ${missionId ?? "custom"} (${dryRun ? "dry-run" : "live"}) ${status}: ${summary}`.slice(0, 800),
      })
      .catch(() => {});
    await audit({ opId, missionId, title, prompt, dryRun, status, result: summary, verify });
    metrics.inc(status === "succeeded" ? "operator_missions_succeeded" : "operator_missions_failed");
    // Settle Ada back to idle locally AND in the Aiven projection so a cross-process /world doesn't show her
    // pinned to a finished task. Best-effort; the local update broadcasts a status event, the pg sync keeps
    // the projected row legible for other processes (A-4).
    const doneLine = `op ${missionId ?? "custom"} ${status}`;
    await store
      .update(OPERATOR_AGENT_ID, { current_task: null, status_line: doneLine, state: "waiting" })
      .catch(() => {});
    await syncAgentTask({
      agent_id: OPERATOR_AGENT_ID,
      status_line: doneLine,
      state: "waiting",
      clearTask: true,
    }).catch(() => {});
  };

  off = store.onEvent((e: ServerEvent) => {
    if ((e as any).agent_id !== OPERATOR_AGENT_ID) return;
    // Single-flight guarantees this is the only live capture, but gate on the active op too so a stray late
    // terminal event from a PRIOR turn can't resolve this run before its own result lands.
    if (activeOpId !== opId) return;
    if (e.type === "result") {
      void finish("succeeded", String(e.summary ?? "").slice(0, 800));
    } else if (e.type === "error") {
      void finish("failed", String(e.message ?? "error").slice(0, 800));
    }
  });

  // Bound the listener: if no terminal event arrives in the window, close out as a soft timeout so the
  // audit row isn't left 'dispatched' forever and the in-flight guard is released.
  timer = setTimeout(() => {
    void finish("failed", "no result captured within window (run may still be streaming)");
  }, CAPTURE_WINDOW_MS);
  // unref so a mid-capture run can't hold the event loop open for up to CAPTURE_WINDOW_MS past a requested
  // SIGINT/SIGTERM shutdown (shutdown() doesn't reach this internal timer). Matches the lane's convention
  // (pg.ts heartbeat, server.ts billing poll, session dwell timers are all unref'd). finish() still clears
  // it on the normal route; unref only covers the shutdown-mid-run case.
  timer.unref?.();

  // Expose finish() so the dispatch-failure path can finalize through THIS listener (idempotent via settled).
  return { finish };
}

/**
 * Upsert one operation-audit row (best-effort — a failed audit write NEVER fails the mission). Keyed on
 * op_id so the dispatch row and the later result/verify update converge to one row (idempotency). No-op
 * when Aiven is OFF (no pg).
 */
async function audit(row: {
  opId: string;
  missionId: string | null;
  title: string;
  prompt: string;
  dryRun: boolean;
  status: "dry_run" | "dispatched" | "succeeded" | "failed";
  result?: string;
  verify?: string;
}): Promise<void> {
  if (!getPg()) return;
  try {
    await queryWithRetry(
      `INSERT INTO world_state.operations_audit
         (op_id, agent_id, mission_id, title, prompt, dry_run, status, result, verify, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (op_id) DO UPDATE
         SET status = EXCLUDED.status,
             result = CASE WHEN EXCLUDED.result <> '' THEN EXCLUDED.result ELSE world_state.operations_audit.result END,
             verify = CASE WHEN EXCLUDED.verify <> '' THEN EXCLUDED.verify ELSE world_state.operations_audit.verify END,
             updated_at = now()`,
      [
        row.opId,
        OPERATOR_AGENT_ID,
        row.missionId,
        row.title,
        row.prompt,
        row.dryRun,
        row.status,
        row.result ?? "",
        row.verify ?? "",
      ],
    );
  } catch (e) {
    logger.warn("[aiven/operator] audit write failed", { op_id: row.opId, error: msg(e) });
  }
}

/**
 * Boot reconciliation for the operator audit trail (mirrors session-store's reconcileOnBoot, charter §0
 * "survives sidecar restart"). The single-flight slot + the CAPTURE_WINDOW_MS timer that flips a row from
 * `dispatched`/`dry_run` to its terminal state are all IN-MEMORY — a restart mid-run loses them, so the row
 * would otherwise sit `dispatched` forever and its op_id's terminal state would be lost. On boot we flip any
 * non-terminal row older than AUDIT_RECONCILE_AFTER_MS to `failed` with a clear reconciled note. The age gate
 * is comfortably past the capture window so a still-streaming run of the CURRENT process is never clobbered —
 * only the dead previous process's stranded rows are reconciled.
 *
 * Best-effort (never throws), once-guarded, and a no-op when Aiven is OFF. Triggered lazily (same pattern as
 * the Kafka consumer / heartbeat) so the L2 lane needs no boot wiring in the L3-owned server.ts.
 */
export async function reconcileOperatorAuditOnBoot(): Promise<void> {
  if (auditReconciled) return;
  auditReconciled = true;
  if (!getPg()) return;
  try {
    const res = await queryWithRetry(
      `UPDATE world_state.operations_audit
          SET status = 'failed',
              result = CASE WHEN result <> '' THEN result
                            ELSE 'reconciled: sidecar restarted mid-run (no terminal result captured)' END,
              updated_at = now()
        WHERE status IN ('dispatched','dry_run')
          AND updated_at < now() - ($1::bigint * interval '1 millisecond')
      RETURNING op_id`,
      [AUDIT_RECONCILE_AFTER_MS],
    );
    const n = res?.rows?.length ?? 0;
    if (n > 0) {
      metrics.inc("operator_audit_reconciled", n);
      logger.info("[aiven/operator] reconciled stranded audit rows on boot", { count: n });
    }
  } catch (e) {
    logger.warn("[aiven/operator] audit boot reconcile failed (non-fatal)", { error: msg(e) });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
