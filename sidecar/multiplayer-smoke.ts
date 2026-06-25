/**
 * AgentCraft — multiplayer smoke (Track A / Brain, DATA_MODEL.md). Proves "seeing other people's worlds"
 * on real Postgres, and — most importantly — that NOTHING sensitive ever crosses into the shared world.
 *
 * It (1) seeds an agent carrying secrets (repo path, task text, transcript), publishes THIS world's
 * anonymized snapshot, and asserts the published blob contains none of those secrets; (2) plants a second
 * world (simulating another machine); (3) lists the directory and visits the other world, asserting you
 * can render it (ids/states present) and still see no paths/code.
 *
 * Run:  AIVEN_PG_URI='postgres://postgres:summercraft@localhost:5433/summercraft' npx tsx multiplayer-smoke.ts
 * Exit 0 = PASS (or clean SKIP without AIVEN_PG_URI). Exit 1 = a real assertion failed.
 */
process.env.SUMMERCRAFT_WORLD_ID = "world_alpha"; // pin our id before anything reads it
process.env.SUMMERCRAFT_WORLD_NAME = "Alpha's world";

import { initPg, applySchema, getPg, closePg, type PgLike } from "./aiven/pg.ts";
import { store, type AgentRecord } from "./session-store.ts";
import { buildSharedSnapshot, publishWorldSnapshot, listWorlds, getWorldSnapshot } from "./multiplayer.ts";

const SECRET_PATH = "/Users/secret/private-repo";
const SECRET_TASK = "rewrite billing.ts to add the coupon hack";
const SECRET_CODE = "const API_KEY = 'sk-do-not-leak'";
let failures = 0;
let skipped = false;
const ok = (c: boolean, l: string) => (c ? console.log("  ✓ " + l) : (console.error("  ✗ " + l), failures++));

async function main(): Promise<void> {
  if (!process.env.AIVEN_PG_URI && !process.env.DATABASE_URL) {
    skipped = true;
    console.log("SKIP: set AIVEN_PG_URI to run the multiplayer smoke.");
    return;
  }
  initPg();
  await applySchema();
  const pg = getPg() as PgLike | null;
  ok(!!pg, "Postgres connected + schema up (incl. world_snapshots)");
  if (!pg) return;

  await pg.query("DELETE FROM world_state.world_snapshots WHERE world_id IN ('world_alpha','world_beta')").catch(() => {});

  // Seed an agent that is FULL of things that must never be shared.
  const spy: AgentRecord = {
    agent_id: "spy", repo_id: "summercraft", repo_path: SECRET_PATH, character_kind: "viking",
    label: "Vinny", state: "working", status_line: "editing " + SECRET_PATH, current_task: SECRET_TASK,
    target_base_id: "summercraft", last_seen_ms: Date.now(), transcript_tail: [SECRET_CODE],
    created_at: new Date().toISOString(), project_id: "summercraft", group_id: "summer",
  };
  await store.create(spy);

  // 1) Anonymization — the privacy chokepoint.
  const snap = await buildSharedSnapshot();
  const blob = JSON.stringify(snap);
  ok(snap.agents.some((a) => a.agent_id === "spy" && a.state === "working"), "shared snapshot renders the agent (id + state)");
  ok(!blob.includes(SECRET_PATH), "shared snapshot leaks NO repo path");
  ok(!blob.includes(SECRET_TASK), "shared snapshot leaks NO task text");
  ok(!blob.includes(SECRET_CODE), "shared snapshot leaks NO transcript/code");
  ok(!blob.includes("repo_path") && !blob.includes("working_dir") && !blob.includes("transcript"), "shared snapshot omits the sensitive FIELDS entirely");

  // 2) Publish THIS world, and plant a second world (another machine).
  await publishWorldSnapshot();
  await pg.query(
    `INSERT INTO world_state.world_snapshots (world_id, name, last_seen, snapshot)
     VALUES ('world_beta', 'Beta''s world', now(), $1::jsonb)
     ON CONFLICT (world_id) DO UPDATE SET last_seen = now(), snapshot = EXCLUDED.snapshot`,
    [JSON.stringify({
      world_id: "world_beta", name: "Beta's world",
      groups: [{ id: "summer", name: "Summer", parent_group_id: null }],
      repos: [{ id: "engine", name: "Engine", group_id: "summer" }],
      projects: [{ id: "engine", name: "Engine", repo_id: "engine" }],
      agents: [{ agent_id: "b1", label: "Merlin", character_kind: "wizard", state: "working", project_id: "engine", repo_id: "engine", group_id: "summer" }],
    })],
  );

  // 3) The directory + visiting.
  const worlds = await listWorlds();
  const ids = worlds.map((w) => w.world_id);
  ok(ids.includes("world_alpha") && ids.includes("world_beta"), "directory lists both worlds (got: " + ids.join(",") + ")");
  ok(worlds.find((w) => w.world_id === "world_alpha")?.online === true, "our world shows online (fresh publish)");

  const visited = await getWorldSnapshot("world_beta");
  ok(!!visited, "can visit world_beta");
  ok(!!visited && visited.agents.some((a) => a.agent_id === "b1" && a.state === "working"), "visited world renders its agents");
  ok(!!visited && !JSON.stringify(visited).includes("/Users/"), "visited world carries no local paths");
  ok((await getWorldSnapshot("world_nope")) === null, "visiting an unknown world is a clean null (404)");

  await pg.query("DELETE FROM world_state.world_snapshots WHERE world_id IN ('world_alpha','world_beta')").catch(() => {});
  await store.remove("spy").catch(() => {});
}

main()
  .catch((e) => { console.error("multiplayer-smoke crashed:", e?.message ?? e); failures++; })
  .finally(async () => {
    await closePg();
    if (skipped) {
      // No URL provided — a clean SKIP (exit 0) is the contract; don't claim a PASS we didn't run.
      console.log("\nMULTIPLAYER_SMOKE_SKIP — no AIVEN_PG_URI; nothing to verify (this is OK).");
      process.exit(0);
    } else if (failures === 0) {
      console.log("\nMULTIPLAYER_SMOKE_OK — publish + directory + visit work, and nothing sensitive ever crosses.");
      process.exit(0);
    } else {
      console.error(`\nMULTIPLAYER_SMOKE_FAIL — ${failures} assertion(s) failed.`);
      process.exit(1);
    }
  });
