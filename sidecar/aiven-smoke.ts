/**
 * AgentCraft — Aiven coordination smoke (Track A / Brain). Proves the AUTHORITATIVE lock model + the
 * /world projection end-to-end against a real Aiven Postgres, independent of the MCP. This is the D6
 * "two agents contend for one file, one wins, one visibly blocks" beat verified at the data layer.
 *
 * Run once Mathias provides the Postgres URL:
 *     AIVEN_PG_URI='postgres://...:.../defaultdb?sslmode=require' \
 *     AIVEN_PG_CA=/path/to/aiven-ca.pem \
 *     npx tsx aiven-smoke.ts
 *
 * Exit 0 = PASS (or cleanly SKIPPED when AIVEN_PG_URI is unset). Exit 1 = a real assertion failed.
 * Uses throwaway agent ids under repo "/smoke" and cleans up after itself.
 */
import { initPg, applySchema, getPg, closePg, pingPg, type PgLike } from "./aiven/pg.ts";
import { worldProjection } from "./aiven/projection.ts";
import { listMissions, resolveMissionPrompt } from "./aiven/operator.ts";

const REPO = "/smoke";
const FILE = "shared.ts";
const A = "smoke_a";
const B = "smoke_b";

function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}
let failures = 0;

async function claim(pg: PgLike, agent: string): Promise<boolean> {
  const { rows } = await pg.query("SELECT world_state.claim_file($1,$2,$3) AS got", [agent, REPO, FILE]);
  return rows[0]?.got === true;
}

async function cleanup(pg: PgLike): Promise<void> {
  await pg.query("DELETE FROM world_state.file_locks WHERE repo_path = $1", [REPO]).catch(() => {});
  await pg.query("DELETE FROM world_state.agents WHERE agent_id = ANY($1)", [[A, B]]).catch(() => {});
}

let skipped = false;

async function main(): Promise<void> {
  if (!process.env.AIVEN_PG_URI && !process.env.DATABASE_URL) {
    skipped = true;
    console.log("SKIP: set AIVEN_PG_URI (and AIVEN_PG_CA) to run the Aiven coordination smoke.");
    return;
  }
  initPg();
  const applied = await applySchema(); // now the versioned migration runner (aiven/migrations.ts)
  ok(applied, "migrations applied (world_state)");
  const pg = getPg();
  if (!pg) {
    console.error("FAIL: pool not created despite AIVEN_PG_URI being set.");
    failures++;
    return;
  }

  // Migration runner: 0001_init + 0002_operations_audit must be recorded as applied, and re-running
  // applySchema() must be a clean no-op (idempotency).
  const { rows: migRows } = await pg.query("SELECT version FROM world_state.schema_migrations ORDER BY version");
  const versions = migRows.map((r) => String(r.version));
  ok(versions.includes("0001_init.sql"), "migration 0001_init recorded");
  ok(versions.includes("0002_operations_audit.sql"), "migration 0002_operations_audit recorded");
  const appliedAgain = await applySchema();
  ok(appliedAgain, "re-running migrations is a clean no-op (idempotent)");

  // Operation audit table exists (the operator audit trail).
  const { rows: auditCols } = await pg.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='world_state' AND table_name='operations_audit'",
  );
  ok(auditCols.length === 1, "operations_audit table exists");

  // Operator dry-run: the data-operator mission layer must resolve a named mission to a real, dispatchable
  // prompt and the dry-run rewrite must produce a read/plan-only instruction — WITHOUT a live MCP/session.
  // This proves the operator beat is wired (prompt resolution + dry-run/verify composition) at the data
  // layer, the same level the lock-contention beat above is proven at. (A full live MCP run is exercised
  // separately when AGENTCRAFT_AIVEN_MCP_URL is set; here we prove the deterministic prompt path.)
  ok(listMissions().length >= 5, `operator exposes the reproducible missions (got ${listMissions().length})`);
  const dry = resolveMissionPrompt("deploy_pgvector", { dryRun: true });
  ok(!!dry, "operator resolves mission deploy_pgvector");
  ok(dry?.mutating === true, "deploy_pgvector is flagged mutating");
  ok(
    !!dry && /dry run/i.test(dry.prompt) && /do not take any mutating action/i.test(dry.prompt),
    "dry-run prompt is rewritten to read/plan-only (no mutating action)",
  );
  ok(
    !!dry && /create extension if not exists vector/i.test(dry.prompt),
    "dry-run prompt still carries the real pgvector operation it would plan",
  );
  ok(
    resolveMissionPrompt("does_not_exist") === null,
    "unknown mission id resolves to null (clean refusal)",
  );

  // Healthcheck: a live pool must ping OK with a non-null latency.
  const h = await pingPg();
  ok(h.ok === true && h.latencyMs != null, `pg healthcheck ok (latency ${h.latencyMs}ms)`);

  await cleanup(pg); // start clean

  // Register two agents on the SAME file.
  for (const id of [A, B]) {
    await pg.query(
      `INSERT INTO world_state.agents (agent_id, repo_id, repo_path, label, state, status_line)
       VALUES ($1,'smoke',$2,$1,'waiting','idle')
       ON CONFLICT (agent_id) DO NOTHING`,
      [id, REPO],
    );
  }
  console.log("registered smoke_a + smoke_b");

  // Contention: A claims first (wins), B claims same file (loses).
  const aWon = await claim(pg, A);
  const bWon = await claim(pg, B);
  ok(aWon === true, "smoke_a wins the lock (INSERT succeeds)");
  ok(bWon === false, "smoke_b is denied (unique_violation -> blocked)");

  // The projection must show the loser as visibly blocked.
  const world = await worldProjection({ pg });
  const bView = world.agents.find((a) => a.agent_id === B);
  ok(!!bView, "projection includes smoke_b");
  ok(bView?.state === "blocked", `projection shows smoke_b blocked (got: ${bView?.state})`);
  const lock = world.locks.find((l) => l.file_path === FILE && l.holder_agent_id === A);
  ok(!!lock, "projection shows the lock held by smoke_a");
  const denied = world.events.some((e) => e.type === "file_claim_denied" && e.agent_id === B);
  ok(denied, "projection emits a file_claim_denied event for smoke_b");

  // Release: A frees the file, B can now take it.
  await pg.query("SELECT world_state.release_file($1,$2,$3)", [A, REPO, FILE]);
  const bWonAfter = await claim(pg, B);
  ok(bWonAfter === true, "after release, smoke_b claims the file");

  // ABANDONED-LOCK SELF-HEAL: the resilience guarantee the heartbeat scoping protects (charter §0:
  // "agent-child crash → the file frees, the loser proceeds"). A holder whose session crashed/wedged is no
  // longer heartbeated, so its last_seen goes stale; the projection must then DELETE its lock and emit a
  // `released` event — even while the row still exists. We simulate the crash by forcing the holder's
  // last_seen past STALE_AFTER_S (exactly what a NO-LONGER-BUMPED row looks like once the heartbeat is
  // correctly scoped to live sessions only) and asserting the lock is reaped on the next projection.
  await pg.query("DELETE FROM world_state.file_locks WHERE repo_path = $1", [REPO]).catch(() => {});
  const aWonAgain = await claim(pg, A); // A holds the file again
  ok(aWonAgain === true, "self-heal setup: smoke_a re-claims the file");
  // Force A's row stale: a crashed/wedged session is the ONLY way last_seen ages out under the scoped
  // heartbeat (a live session would still be bumped). 60s back is well past STALE_AFTER_S (15s).
  await pg.query("UPDATE world_state.agents SET last_seen = now() - interval '60 seconds' WHERE agent_id = $1", [A]);
  const healed = await worldProjection({ pg }); // selfHealAbandonedLocks runs first, before the SELECTs
  const aLockGone = !healed.locks.some((l) => l.file_path === FILE && l.holder_agent_id === A);
  ok(aLockGone, "abandoned lock of stale (crashed) holder smoke_a is self-healed (reaped)");
  const releasedEmitted = healed.events.some(
    (e) => e.type === "released" && e.agent_id === A && e.detail.includes("self-heal"),
  );
  ok(releasedEmitted, "self-heal emits a `released` coord_event for the reaped lock");
  // And the freed file is immediately claimable by the loser (the loser proceeds).
  const bClaimsHealed = await claim(pg, B);
  ok(bClaimsHealed === true, "after self-heal, smoke_b claims the freed file (loser proceeds)");

  await cleanup(pg);
  console.log("cleaned up smoke rows");
}

main()
  .catch((e) => {
    console.error("Aiven smoke crashed:", e?.message ?? e);
    failures++;
  })
  .finally(async () => {
    await closePg();
    if (skipped) {
      // No URL provided — a clean SKIP (exit 0) is the contract; don't claim a PASS we didn't run.
      console.log("\nAIVEN_SMOKE_SKIP — no AIVEN_PG_URI; nothing to verify (this is OK).");
      process.exit(0);
    } else if (failures === 0) {
      console.log("\nAIVEN_SMOKE_OK — migrations(idempotent) + operator dry-run + lock contention + projection + release all pass.");
      process.exit(0);
    } else {
      console.error(`\nAIVEN_SMOKE_FAIL — ${failures} assertion(s) failed.`);
      process.exit(1);
    }
  });
