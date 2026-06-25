/**
 * AgentCraft — sidecar bootstrap (Track A, plan §7 Phase 1 + §5 S2/S3/S7).
 *
 * One process, one port: http://127.0.0.1:8787 serves HTTP routes, the OpenAI voice shim, and the WS
 * endpoint. Bound to 127.0.0.1 only (this is the local agent host; nothing here is exposed publicly).
 *
 * This file is now the THIN bootstrap only — boot sequence + listen + graceful shutdown. The HTTP routes
 * live in http/router.ts (which dispatches to http/routes-*.ts), the WS server in http/ws.ts, and the
 * billing-honesty auth probe in auth.ts. The public contract + behavior are unchanged by that split.
 *
 * Routes (frozen contract, sidecar/contract.ts §"HTTP routes"):
 *   GET  /world                      -> WorldSnapshot   (Godot polls @1s — the demo-default transport)
 *   GET  /agents                     -> AgentView[]
 *   POST /agents/:id/prompt {prompt} -> 202 Accepted
 *   POST /v1/chat/completions        -> OpenAI SSE (model = characterId) [ElevenLabs custom-LLM]
 *   GET  /auth/status                -> { mode: subscription | apikey | unknown }
 *   WS   /                           -> ServerEvent stream; accepts ClientCommand frames
 *
 * Security: a per-launch random token is written to runtime/auth.token. The WS connection is dead
 * until it sends a valid `{type:"hello",token}` frame (plan §5 S3). HTTP routes are localhost-only.
 *
 * Billing honesty (plan §2): /auth/status runs the same scrubbed-env probe as billing-check (auth.ts) —
 * if `claude` answers with the metered ANTHROPIC_* vars removed, it must be on the Pro/Max subscription.
 * `mode:"apikey"` is a HARD STOP the UI surfaces.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { HOST, PORT } from "./contract.ts";
import { store, RUNTIME_DIR } from "./session-store.ts";
import { sessionManager } from "./session-manager.ts";
import { processRegistry } from "./process-registry.ts";
import { initPg, applySchema, getPg, aivenConfigured, registerAgent, closePg } from "./aiven/pg.ts";
import { startCoordinationConsumer, stopCoordinationConsumer, kafkaConfigured } from "./aiven/kafka.ts";
import { seedProjects } from "./projects.ts";
import { publishWorldSnapshot, getWorldId, getWorldName } from "./multiplayer.ts";
import { OPERATOR_SEED, operatorReady } from "./aiven/operator.ts";
import { authMode, probeAuthMode } from "./auth.ts";
import { assertBillingSafe } from "./security.ts";
import { loadValidated } from "./config.ts";
import { createRouter } from "./http/router.ts";
import { attachWebSocket } from "./http/ws.ts";

const AUTH_TOKEN_PATH = path.join(RUNTIME_DIR, "auth.token");

/** Per-launch WS auth token. Written to runtime/auth.token; the client reads it and sends it on hello. */
const AUTH_TOKEN = randomUUID();

// --------------------------------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------------------------------

async function writeAuthToken(): Promise<void> {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.writeFile(AUTH_TOKEN_PATH, AUTH_TOKEN, { encoding: "utf8", mode: 0o600 });
}

let fakeStatusTimer: ReturnType<typeof setInterval> | null = null;
/** Multiplayer: how often this world re-publishes its anonymized snapshot to the shared directory. */
const WORLD_PUBLISH_MS = 8000;
let worldPublishTimer: ReturnType<typeof setInterval> | null = null;

function startFakeStatusTimer(): void {
  // Scaffold S3: heartbeat scaffold/idle records on a timer so Track B can build against a live socket
  // even before any agent is spawned. A record with a LIVE session heartbeats itself off the SDK
  // stream, so we skip those here — this timer must not churn disk for real sessions every 5s.
  //
  // SEMANTICS (A-7): because this bumps every NON-live record every 5s, an idle SEEDED record's
  // heartbeat_age_s stays ~0-5s and never goes stale. So heartbeat_age_s (>15s = stale, per contract) is a
  // liveness signal ONLY for agents with a live session — it does NOT distinguish "idle seeded record" from
  // "live and healthy". B/D should treat a seeded idle agent as present-but-not-running via `state`
  // (`waiting`/`idle status_line`), not via heartbeat_age_s. This is deliberate: the Aiven projection's
  // stale/self-heal gate is driven by the SCOPED Postgres heartbeat (pg.ts startHeartbeat, live ids only),
  // which DOES let a crashed live agent's row go stale so its lock is reaped — that path is unaffected here.
  fakeStatusTimer = setInterval(() => {
    for (const rec of store.list()) {
      if (sessionManager.has(rec.agent_id)) continue; // real session drives its own heartbeat
      void store.heartbeat(rec.agent_id);
    }
  }, 5000);
}

/** Stop the scaffold heartbeat timer (called once a real session is live / on shutdown). */
function stopFakeStatusTimer(): void {
  if (fakeStatusTimer) {
    clearInterval(fakeStatusTimer);
    fakeStatusTimer = null;
  }
}

/**
 * Run the boot billing assertion once the background auth probe settles. probeAuthMode() (auth.ts) is
 * fire-and-forget and can take up to ~60s; we poll the cached mode and assert the moment it resolves (or
 * warn-and-continue after a 65s ceiling, which assertBillingSafe treats as inconclusive). `apikey` mode
 * HARD-STOPS the process (exit 87) unless AGENTCRAFT_ALLOW_APIKEY=1 — the charter §0 billing hard-stop.
 */
function assertBillingWhenProbed(): void {
  const startedAt = Date.now();
  const tick = setInterval(() => {
    if (authMode().mode !== "unknown" || Date.now() - startedAt > 65_000) {
      clearInterval(tick);
      assertBillingSafe(authMode());
    }
  }, 2000);
  tick.unref?.(); // never keep the process alive just for this poll
}

/**
 * Best-effort load of sidecar/.env (Aiven URIs, tokens, Kafka creds) before anything reads process.env.
 * Uses Node's native loader (≥20.12, our engines floor) so there's no dotenv dependency. Missing/unreadable
 * .env is fine — env vars exported in the shell still win. Documented in docs/AIVEN_SETUP.md.
 */
function loadDotEnv(): void {
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(
      path.join(process.cwd(), ".env"),
    );
  } catch {
    /* no .env / unreadable — rely on the ambient environment */
  }
}

async function main(): Promise<void> {
  loadDotEnv(); // before any config/env read below

  // Lane A: wire the process registry's `service` ServerEvent emitter to the store bus, so when an agent
  // registers a dev server (POST /agents/:id/service) the existing `service` event fans out to D's localhost
  // chip + C's voice announce. Injected here (not imported inside the registry) to keep the registry free of
  // a store import cycle. port:0 means "unknown" — D treats it as not-yet-known but still surfaces the URL.
  processRegistry.setEmitter((agent_id, svc) => {
    store.publish({ type: "service", agent_id, url: svc.url, port: svc.port, ts: new Date().toISOString() });
  });

  await store.whenReady();
  await writeAuthToken();

  // Fail-fast config validation (charter §0): a fatal config (non-loopback host, bad port, unreadable
  // Aiven CA, …) refuses to boot with a clear message rather than half-starting. Warnings log + continue.
  await loadValidated(AUTH_TOKEN);

  // Aiven: create the pool (no-op when unconfigured) and run the versioned migrations (idempotent —
  // applySchema() is now the migration runner, see aiven/migrations.ts). On a fresh DB this brings the
  // world_state schema + operations_audit up; on an already-migrated DB it's a recorded no-op. Best-effort:
  // a failure logs + returns false (Aiven degraded), it never crashes boot.
  initPg();
  if (aivenConfigured()) await applySchema();

  // Kafka coordination consumer (topic agent.coordination): wired into the boot sequence here so the live
  // Kafka beat is consumed into coord_events + the /world event feed from the moment the sidecar is up —
  // not only lazily on the first /world poll. OPT-IN + NEVER-HANGS by construction: it no-ops when
  // AIVEN_KAFKA_BROKERS is unset, and when set it connects on a DETACHED promise that can never reject into
  // boot (a dead broker / missing kafkajs degrades cleanly to OFF). Safe to call even when Aiven PG is off.
  if (kafkaConfigured()) startCoordinationConsumer();

  // Project model: seed idle agent records so /world is populated before any prompt (records ≠ live
  // sessions; the live Claude session lazy-spawns on first prompt, so booting burns no quota).
  const projects = await seedProjects();

  // When Aiven is live, mirror the seeded presence into world_state.agents so the Postgres projection
  // shows the same NPCs the local store does (best-effort; never blocks boot).
  if (getPg()) {
    for (const p of projects) {
      for (const seed of p.agents) {
        await registerAgent({
          agent_id: seed.agent_id,
          repo_id: p.id,
          repo_path: p.repo_path,
          character_kind: seed.character_kind,
          label: seed.label,
        });
      }
    }
    // Mirror Ada (the data operator) into the projection too, so the Aiven-main-track NPC shows up in the
    // Postgres-projected /world (not just the local store) before her first mission. Presence-only,
    // best-effort; her coordination columns are filled in when runMission() dispatches.
    await registerAgent({
      agent_id: OPERATOR_SEED.agent_id,
      repo_id: OPERATOR_SEED.repo_id,
      repo_path: OPERATOR_SEED.repo_path,
      character_kind: OPERATOR_SEED.character_kind,
      label: OPERATOR_SEED.label,
      status_line: OPERATOR_SEED.status_line,
    });
  }

  // HEADLINE-BEAT GUARD: if Aiven is on but no operator MCP URL is configured, Ada's
  // live-query beat is DARK — /operator/run returns 503 and "talk to Ada" can't query the world. This is
  // exactly what happens when the presenter launches the obvious way (`npx tsx server.ts` / `npm start`)
  // instead of `npm run demo` (demo.sh starts the shim + exports AGENTCRAFT_AIVEN_MCP_URL). Warn LOUDLY so
  // the dark beat is never a silent surprise on stage. (Not fatal — Aiven #1, the world-on-Aiven beat,
  // still works; only Ada's MCP query needs the shim.)
  if (aivenConfigured() && !operatorReady()) {
    console.warn(
      "[sidecar] ⚠ Aiven is configured but AGENTCRAFT_AIVEN_MCP_URL is UNSET — Ada's live-query beat " +
        "(PITCH Aiven #2) is OFF: /operator/run will 503 and 'ask Ada what's happening across the worlds' " +
        "can't run. Launch with `npm run demo` (bash demo.sh) to start the Aiven MCP shim and wire Ada, or " +
        "set AGENTCRAFT_AIVEN_MCP_URL to a reachable Aiven MCP.",
    );
  }

  // Boot-time orphan-worktree GC (charter §2): reclaim any .agentcraft-worktrees/<id> dirs + agentcraft/<id>
  // branches a prior crash left behind, for the repo roots of the now-seeded records. Runs here (after
  // seedProjects, so every seeded/rehydrated id is in the keep-set) so the no-spawn paths — voice-only,
  // an idle demo, a repo merely shown in /world — still get cleaned; the lazy first-spawn GC shares the
  // same once-guard, so it becomes a no-op. Never throws.
  await sessionManager.reclaimOrphansAtBoot();

  // Multiplayer (DATA_MODEL.md): publish this world's ANONYMIZED snapshot to the shared directory and keep
  // it fresh, so others can see + visit it. No-op without Aiven (single-player). NO code / paths / diffs /
  // transcripts are ever shared — only renderable structure (see multiplayer.buildSharedSnapshot).
  if (getPg()) {
    void publishWorldSnapshot();
    worldPublishTimer = setInterval(() => void publishWorldSnapshot(), WORLD_PUBLISH_MS);
    worldPublishTimer.unref?.();
    console.log(`[sidecar] sharing world "${getWorldName()}" (${getWorldId()}) to the shared directory`);
  }

  const server = http.createServer(createRouter());
  attachWebSocket(server, AUTH_TOKEN);

  server.listen(PORT, HOST, () => {
    console.log(`[sidecar] http+ws listening on http://${HOST}:${PORT}`);
    console.log(`[sidecar] WS auth token -> ${AUTH_TOKEN_PATH}`);
    probeAuthMode(); // kick the billing-honesty check in the background
    assertBillingWhenProbed(); // hard-stop on apikey once the probe settles (charter §0 billing safety)
    startFakeStatusTimer();
  });

  server.on("error", (e) => {
    console.error("[sidecar] server error:", msg(e));
    process.exit(1);
  });

  const shutdown = async (sig: string) => {
    console.log(`[sidecar] ${sig} — shutting down ${sessionManager.liveCount} session(s).`);
    stopFakeStatusTimer();
    if (worldPublishTimer) clearInterval(worldPublishTimer);
    // stopAll() closes each session (which kills that agent's registered services); killAll() is the
    // belt-and-suspenders sweep for any service left tracked under an id without a live session.
    await sessionManager.stopAll();
    processRegistry.killAll();
    await stopCoordinationConsumer(); // disconnect the Kafka consumer before tearing down (bounded, never throws)
    await closePg();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

void main();
